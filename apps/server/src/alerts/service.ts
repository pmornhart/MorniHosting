import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alertKind, type AlertEvent, type AlertStatus } from '@mornihosting/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { formatWhen } from '../mail/templates.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../lib/units.js';
import type { NotifyService } from '../notify/service.js';

/**
 * One place for "something is wrong": every problem goes to the admins at once by Discord (and mail, as each
 * person chose), always saying what happened, whether it fixes itself, and – if not – what to do, with the command.
 *
 * Sources: the panel itself (servers, NetBird exit …) and the two watchdogs outside the panel – scripts/guard.sh in
 * the container and proxmox/dauerbetrieb.sh on the Proxmox host. They append one JSON line per event to
 * <data>/guard/events.jsonl; the panel reads new lines every few seconds (also the ones written while it was down).
 *
 * Every alert that goes out (and every all-clear) is also an event on the bus: /api/ws hands it to admins who
 * subscribed to "alerts" – an app that runs the panel as its motor (no Discord or mail of its own) tells its team
 * there. The last ones are kept, so a connection that was gone for a moment gets what it missed.
 */

export type { AlertStatus };

export interface Alert {
  /** Same key within the quiet time → not sent again (e.g. "exit", "server:<id>"). */
  readonly key: string;
  /** Who noticed it; the panel itself unless a watchdog wrote it. */
  readonly source?: AlertEvent['source'];
  readonly title: string;
  readonly what: string;
  readonly status: AlertStatus;
  readonly action?: string;
  readonly command?: string;
}

export interface AlertService {
  readonly alert: (alert: Alert) => void;
  /** All clear for a key that was alerted before (sent only when there was an alert). */
  readonly resolved: (key: string, title: string, what: string, source?: AlertEvent['source']) => void;
  /** Alerts sent since `after` (an alert id; unknown = all kept ones), oldest first. */
  readonly since: (after: string) => AlertEvent[];
  readonly start: () => void;
  readonly stop: () => void;
  /** Reads new watchdog events now (also used by tests). */
  readonly readEvents: () => void;
}

const QUIET_MINUTES = 30;
const QUIET_MS = QUIET_MINUTES * MS_PER_MINUTE;
const READ_EVERY_SECONDS = 10;
const OFFSET_KEY = 'guard_events_offset';
const MAX_LINE_CHARS = 2000;
const MAX_KEY_CHARS = 100;
const MAX_TITLE_CHARS = 200;
const DISCORD_RED = 0xe5484d;
const DISCORD_AMBER = 0xf59e0b;
const DISCORD_GREEN = 0x10b981;
/** How many alerts are kept for a connection that was gone for a moment. */
const KEEP_ALERTS = 100;
const RUN_ID_BYTES = 4;

const STATUS_TEXT: Readonly<Record<AlertStatus, string>> = {
  fixed: '✅ Ja – ist schon behoben, du musst nichts tun.',
  fixing: '🔄 Ja – wird gerade automatisch repariert. Du musst nichts tun.',
  action: '❌ Nein – du musst etwas tun (siehe unten).',
};
const COLOUR: Readonly<Record<AlertStatus, number>> = {
  fixed: DISCORD_GREEN,
  fixing: DISCORD_AMBER,
  action: DISCORD_RED,
};
const ICON: Readonly<Record<AlertStatus, string>> = { fixed: '🛠️', fixing: '🔄', action: '🚨' };

const eventSchema = z.object({
  at: z.string().optional(),
  source: z.enum(['host', 'container']).default('container'),
  key: z.string().max(MAX_KEY_CHARS),
  title: z.string().max(MAX_TITLE_CHARS),
  what: z.string().max(MAX_LINE_CHARS),
  status: z.enum(['fixed', 'fixing', 'action', 'ok']),
  action: z.string().max(MAX_LINE_CHARS).optional(),
  command: z.string().max(MAX_LINE_CHARS).optional(),
});

export function createAlertService(ctx: AppContext, notify: NotifyService): AlertService {
  const sentAt = new Map<string, number>();
  const open = new Set<string>();
  const run: { timer: NodeJS.Timeout | null; count: number } = { timer: null, count: 0 };
  const runId = randomBytes(RUN_ID_BYTES).toString('hex');
  const kept: AlertEvent[] = [];
  const eventsFile = path.join(ctx.config.dataDir, 'guard', 'events.jsonl');
  const containerName = `${ctx.config.brand}-Container`;

  /** Out on the bus (and kept for a while): /api/ws hands it to admins who listen for alerts. */
  const publish = (event: Omit<AlertEvent, 'id' | 'at' | 'kind'>): void => {
    run.count += 1;
    const full: AlertEvent = {
      ...event,
      id: `${runId}-${run.count}`,
      at: new Date().toISOString(),
      kind: alertKind(event.key),
    };
    kept.push(full);
    kept.splice(0, Math.max(0, kept.length - KEEP_ALERTS));
    ctx.events.emit('alert', full);
  };

  const alert: AlertService['alert'] = (a) => {
    const last = sentAt.get(a.key) ?? 0;
    open.add(a.key);
    if (Date.now() - last < QUIET_MS) return;
    sentAt.set(a.key, Date.now());
    ctx.log.warn({ key: a.key, title: a.title, status: a.status }, 'alert');
    publish({
      key: a.key,
      status: a.status,
      title: a.title,
      what: a.what,
      action: a.action ?? null,
      command: a.command ?? null,
      source: a.source ?? 'panel',
    });
    notify.tell(
      notify.admins(),
      'crashes',
      (person) => ({
        mail: {
          kind: 'alert',
          vars: {
            title: a.title,
            what: a.what,
            status: STATUS_TEXT[a.status],
            action: a.action ?? null,
            command: a.command ?? null,
            when: formatWhen(person.locale === 'en' ? 'en' : 'de', new Date()),
          },
        },
        discord: {
          title: `${ICON[a.status]} ${a.title}`,
          text: [
            `**Was ist los:** ${a.what}`,
            `**Behebt sich selbst?** ${STATUS_TEXT[a.status]}`,
            a.action ? `**Du musst:** ${a.action}` : '',
            a.command ? `\`\`\`\n${a.command}\n\`\`\`` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          colour: COLOUR[a.status],
        },
      }),
      alertKind(a.key),
    );
  };

  const resolved: AlertService['resolved'] = (key, title, what, source = 'panel') => {
    if (!open.delete(key)) return;
    sentAt.delete(key);
    publish({ key, status: 'ok', title, what, action: null, command: null, source });
    notify.tell(
      notify.admins(),
      'crashes',
      () => ({
        mail: { kind: 'alert_ok', vars: { title, what } },
        discord: { title: `✅ ${title}`, text: what, colour: DISCORD_GREEN },
      }),
      alertKind(key),
    );
  };

  /** New lines since the last read; a smaller file means the watchdog started a new one. */
  const readEvents: AlertService['readEvents'] = () => {
    const size = (() => {
      try {
        return fs.statSync(eventsFile).size;
      } catch {
        return null;
      }
    })();
    if (size === null) return;
    const stored = ctx.settings.getValue<number>(OFFSET_KEY) ?? 0;
    const from = stored > size ? 0 : stored;
    if (from === size) return;
    const fd = fs.openSync(eventsFile, 'r');
    try {
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      const text = buffer.toString('utf8');
      const complete = text.lastIndexOf('\n') + 1;
      ctx.settings.setValue(OFFSET_KEY, from + Buffer.byteLength(text.slice(0, complete)));
      text
        .slice(0, complete)
        .split('\n')
        .filter(Boolean)
        .forEach((line) => {
          try {
            const event = eventSchema.parse(JSON.parse(line));
            const where = event.source === 'host' ? 'Proxmox-Host' : containerName;
            if (event.status === 'ok')
              resolved(event.key, event.title, `${event.what} (${where})`, event.source);
            else
              alert({
                key: event.key,
                source: event.source,
                title: event.title,
                what: `${event.what} (${where})`,
                status: event.status,
                action: event.action,
                command: event.command,
              });
          } catch (err) {
            ctx.log.debug({ err, line: line.slice(0, MAX_LINE_CHARS) }, 'unreadable watchdog event');
          }
        });
    } finally {
      fs.closeSync(fd);
    }
  };

  const since: AlertService['since'] = (after) => {
    const at = kept.findIndex((a) => a.id === after);
    return kept.slice(at + 1);
  };

  return {
    alert,
    resolved,
    since,
    readEvents,
    start: () => {
      run.timer = setInterval(() => {
        try {
          readEvents();
        } catch (err) {
          ctx.log.debug({ err }, 'reading watchdog events failed');
        }
      }, READ_EVERY_SECONDS * MS_PER_SECOND);
      run.timer.unref();
    },
    stop: () => {
      if (run.timer) clearInterval(run.timer);
    },
  };
}
