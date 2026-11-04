import fs from 'node:fs';
import path from 'node:path';
import { alertKind } from '@mornihosting/shared';
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
 */

/** fixed = already repaired by itself, fixing = repairs itself (retrying), action = a person must do something. */
export type AlertStatus = 'fixed' | 'fixing' | 'action';

export interface Alert {
  /** Same key within the quiet time → not sent again (e.g. "exit", "server:<id>"). */
  readonly key: string;
  readonly title: string;
  readonly what: string;
  readonly status: AlertStatus;
  readonly action?: string;
  readonly command?: string;
}

export interface AlertService {
  readonly alert: (alert: Alert) => void;
  /** All clear for a key that was alerted before (sent only when there was an alert). */
  readonly resolved: (key: string, title: string, what: string) => void;
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
  const run: { timer: NodeJS.Timeout | null } = { timer: null };
  const eventsFile = path.join(ctx.config.dataDir, 'guard', 'events.jsonl');

  const alert: AlertService['alert'] = (a) => {
    const last = sentAt.get(a.key) ?? 0;
    open.add(a.key);
    if (Date.now() - last < QUIET_MS) return;
    sentAt.set(a.key, Date.now());
    ctx.log.warn({ key: a.key, title: a.title, status: a.status }, 'alert');
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

  const resolved: AlertService['resolved'] = (key, title, what) => {
    if (!open.delete(key)) return;
    sentAt.delete(key);
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
            const where = event.source === 'host' ? 'Proxmox-Host' : 'MorniHosting-Container';
            if (event.status === 'ok') resolved(event.key, event.title, `${event.what} (${where})`);
            else
              alert({
                key: event.key,
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

  return {
    alert,
    resolved,
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
