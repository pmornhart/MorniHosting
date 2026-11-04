import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  CRASH_FIX_LABELS,
  JAVA_TAGS,
  crashText,
  type CrashFixId,
  type CrashFixOffer,
  type CrashHelp,
  type CrashInfo,
  type JavaTag,
  type ServerPermission,
} from '@mornihosting/shared';
import { SYSTEM_ACTOR, type Actor } from '../audit/service.js';
import type { UserRow } from '../auth/context.js';
import type { BackupService } from '../backups/service.js';
import type { AppContext } from '../context.js';
import { serverAccess, servers, users } from '../db/schema.js';
import type { FileService } from '../files/service.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import type { NotifyService } from '../notify/service.js';
import { readPropertiesFile } from '../servers/properties-file.js';
import type { ServerService } from '../servers/service.js';

/**
 * The crash helper: after a crash it explains the cause (console, Discord, mail, a popup in the panel) and
 * offers repairs that fit – more memory, the right Java, a free port, switching a plugin off, the last backup,
 * a new world. A repair clears the crash and starts the server again.
 */

const MB_PER_GB = 1024;
const MEMORY_STEP_MB = 512;
const DISCORD_RED = 0xe5484d;
// steamcmd's well-known first-run error: "ERROR! Failed to install app '1690800' (Missing configuration)" matches,
// "Missing configuration file server.cfg" does not.
// https://regex101.com/?flavor=javascript&regex=Failed%20to%20install%20app%20'%5Cd%2B'%20%5C(Missing%20configuration%5C)&testString=ERROR!%20Failed%20to%20install%20app%20'1690800'%20(Missing%20configuration)%0AMissing%20configuration%20file%20server.cfg
const STEAM_MISSING_CONFIG = /Failed to install app '\d+' \(Missing configuration\)/;
/** One quiet retry per server in this time; a second failure is a real problem and shown as one. */
const STEAM_RETRY_MINUTES = 15;
const STEAM_RETRY_WINDOW_MS = STEAM_RETRY_MINUTES * 60_000;
const PLUGIN_DIRS = ['plugins', 'mods'] as const;
const JAR = '.jar';
const WORLD_SUFFIXES = ['', '_nether', '_the_end'] as const;
const DISCORD_SAFE = new Set<CrashFixId>([
  'raise-memory',
  'set-java',
  'free-port',
  'accept-eula',
  'disable-plugin',
  'retry',
]);

/** Rights a repair needs on the server, besides starting it. */
const NEEDS: Readonly<Record<CrashFixId, readonly ServerPermission[]>> = {
  'raise-memory': ['config'],
  'set-java': ['config'],
  'free-port': ['config'],
  'accept-eula': ['config'],
  'disable-plugin': ['plugins'],
  'restore-backup': ['backups'],
  'reset-world': ['backups', 'files'],
  retry: [],
};

export interface CrashHelpService {
  readonly help: (serverId: string) => CrashHelp | null;
  readonly fix: (
    serverId: string,
    fix: CrashFixId,
    start: boolean,
    user: UserRow,
    actor: Actor,
  ) => Promise<string>;
}

// Everything but letters and digits. "Essentials-2.21.jar" → "essentials221jar".
// https://regex101.com/?flavor=javascript&regex=%5B%5Ea-z0-9%5D&flags=g&testString=essentials-2.21.jar
const NOT_ALNUM = /[^a-z0-9]/g;
// A trailing ".jar". Matches ".jar" in "Shop.jar"; leaves "Shop" alone.
// https://regex101.com/?flavor=javascript&regex=%5C.jar%24&flags=i&testString=Shop.jar%0AShop
const JAR_SUFFIX = /\.jar$/i;
// Placeholders in button texts. Matches "{{toGb}}" (captures "toGb") in "Mehr RAM ({{toGb}} GB)".
// https://regex101.com/?flavor=javascript&regex=%5C%7B%5C%7B(%5Cw%2B)%5C%7D%5C%7D&flags=g&testString=Mehr%20RAM%20(%7B%7BtoGb%7D%7D%20GB)
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const normalise = (s: string): string => s.toLowerCase().replace(NOT_ALNUM, '');
const fillLabel = (offer: CrashFixOffer): string =>
  CRASH_FIX_LABELS[offer.id].replace(PLACEHOLDER, (_m, k: string) => offer.params[k] ?? '');

export function createCrashHelpService(
  ctx: AppContext,
  deps: {
    readonly servers: ServerService;
    readonly backups: BackupService;
    readonly files: FileService;
    readonly notify: NotifyService;
  },
): CrashHelpService {
  const { db } = ctx;
  const { servers: serverService, backups, files, notify } = deps;

  /** The jar in plugins/ or mods/ that belongs to a plugin or mod name ("Essentials" → "EssentialsX-2.21.0.jar"). */
  const pluginFile = (serverId: string, name: string): string | null => {
    const wanted = normalise(name.replace(JAR_SUFFIX, ''));
    if (!wanted) return null;
    const dir = serverService.dir(serverId);
    const jars = PLUGIN_DIRS.flatMap((folder) => {
      try {
        return fs
          .readdirSync(path.join(dir, folder))
          .filter((f) => f.toLowerCase().endsWith(JAR))
          .map((f) => `${folder}/${f}`);
      } catch {
        return [];
      }
    });
    return (
      jars.find((f) => normalise(path.basename(f)).startsWith(wanted)) ??
      jars.find((f) => normalise(f).includes(wanted)) ??
      null
    );
  };

  const latestBackup = (serverId: string) =>
    backups
      .list(serverId)
      .filter((b) => b.status === 'done')
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

  const javaTagFor = (java: string): JavaTag | null => {
    const wanted = Number(java);
    const tags = JAVA_TAGS.map((tag) => ({ tag, version: Number(tag.replace('java', '')) }));
    return tags.filter((t) => t.version >= wanted).toSorted((a, b) => a.version - b.version)[0]?.tag ?? null;
  };

  const offers = (serverId: string, crash: CrashInfo): CrashFixOffer[] => {
    const row = serverService.row(serverId);
    const offer = (id: CrashFixId, params: Record<string, string> = {}, danger = false): CrashFixOffer => ({
      id,
      params,
      danger,
    });
    const plugin = (name: string | undefined): CrashFixOffer[] => {
      const named = crash.params?.['file'];
      const exact = named && fs.existsSync(path.join(serverService.dir(serverId), named)) ? named : null;
      const file = exact ?? (name ? pluginFile(serverId, name) : null);
      return file ? [offer('disable-plugin', { file: path.basename(file) })] : [];
    };
    const backup = latestBackup(serverId);
    const byRule: Readonly<Record<string, () => CrashFixOffer[]>> = {
      'out-of-memory': () => {
        const toMb =
          Math.ceil((row.memoryMb + Math.max(MB_PER_GB, row.memoryMb / 2)) / MEMORY_STEP_MB) * MEMORY_STEP_MB;
        return [offer('raise-memory', { toMb: String(toMb), toGb: String(toMb / MB_PER_GB) })];
      },
      'wrong-java': () => {
        const tag = javaTagFor(crash.params?.['java'] ?? '');
        return tag ? [offer('set-java', { java: tag.replace('java', ''), tag })] : [];
      },
      'port-in-use': () => [offer('free-port', { port: String(serverService.nextFreePort(serverId)) })],
      eula: () => [offer('accept-eula')],
      'missing-dependency': () => plugin(crash.params?.['plugin']),
      'plugin-error': () => plugin(crash.params?.['plugin']),
      'plugin-incompatible': () => plugin(crash.params?.['plugin']),
      'config-broken-plugin': () => plugin(crash.params?.['plugin']),
      'watchdog-plugin': () => plugin(crash.params?.['plugin']),
      'world-broken': () => [
        ...(backup
          ? [
              offer(
                'restore-backup',
                { backupId: String(backup.id), when: backup.createdAt.slice(0, 16).replace('T', ' ') },
                true,
              ),
            ]
          : []),
        offer('reset-world', {}, true),
      ],
    };
    const specific = (() => {
      try {
        return byRule[crash.ruleId]?.() ?? [];
      } catch {
        return [];
      }
    })();
    return [...specific, offer('retry')];
  };

  const help: CrashHelpService['help'] = (serverId) => {
    const crash = serverService.row(serverId).crash;
    return crash ? { crash, fixes: offers(serverId, crash) } : null;
  };

  const may = (user: UserRow, serverId: string, fix: CrashFixId): void => {
    ['control' as const, ...NEEDS[fix]].forEach((permission) =>
      ctx.access.assert(user, serverId, permission),
    );
  };

  const fix: CrashHelpService['fix'] = async (serverId, fixId, start, user, actor) => {
    may(user, serverId, fixId);
    const current = help(serverId);
    if (!current) throw conflict('crash_gone');
    const offer = current.fixes.find((f) => f.id === fixId);
    if (!offer) throw notFound('crash_fix_unknown');
    const dir = serverService.dir(serverId);
    const level = readPropertiesFile(dir).values['level-name'] || 'world';
    const repairs: Readonly<Record<CrashFixId, () => Promise<void>>> = {
      'raise-memory': async () => {
        serverService.update(serverId, { memoryMb: Number(offer.params['toMb']) }, actor);
      },
      'set-java': async () => {
        serverService.update(serverId, { javaTag: offer.params['tag'] as JavaTag }, actor);
      },
      'free-port': async () => {
        serverService.update(serverId, { port: Number(offer.params['port']) }, actor);
      },
      'accept-eula': async () => {
        fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
      },
      'disable-plugin': async () => {
        const file = pluginFile(serverId, offer.params['file'] ?? '');
        if (!file) throw notFound('crash_fix_unknown');
        fs.renameSync(path.join(dir, file), path.join(dir, `${file}.disabled`));
      },
      'restore-backup': async () => {
        await backups.restore(serverId, Number(offer.params['backupId']), actor);
      },
      'reset-world': async () => {
        await backups.create(serverId, 'before-restore', actor);
        const worlds = WORLD_SUFFIXES.map((s) => `${path.basename(level)}${s}`).filter((w) =>
          fs.existsSync(path.join(dir, w)),
        );
        files.remove(serverId, worlds);
      },
      retry: async () => undefined,
    };
    await repairs[fixId]();
    db.update(servers).set({ crash: null }).where(eq(servers.id, serverId)).run();
    serverService.note(serverId, `Absturz-Helfer: „${fillLabel(offer)}“ erledigt.`);
    ctx.audit.record(actor, 'server.crash_fix', serverId, { fix: fixId });
    if (start) await serverService.start(serverId, actor);
    return fixId;
  };

  /** Who hears about a crash: admins and everyone with access to the server. */
  const peopleFor = (serverId: string): UserRow[] => {
    const members = db
      .select({ user: users })
      .from(serverAccess)
      .innerJoin(users, eq(users.id, serverAccess.userId))
      .where(eq(serverAccess.serverId, serverId))
      .all()
      .map((r) => r.user);
    return [...notify.admins(), ...members].filter((u, i, all) => all.findIndex((x) => x.id === u.id) === i);
  };

  const label = fillLabel;

  // steamcmd's first run of a new game often stops with "Missing configuration"; the second run installs fine
  // (seen with Satisfactory). So the panel quietly tries once more instead of calling it a crash.
  const steamRetries = new Map<string, number>();
  const steamHiccup = (serverId: string, excerpt: readonly string[] | undefined): boolean => {
    if (!excerpt?.some((line) => STEAM_MISSING_CONFIG.test(line))) return false;
    const last = steamRetries.get(serverId) ?? 0;
    if (Date.now() - last < STEAM_RETRY_WINDOW_MS) return false;
    steamRetries.set(serverId, Date.now());
    return true;
  };

  ctx.events.on('server.crashed', ({ serverId, crash }) => {
    const row = db.select().from(servers).where(eq(servers.id, serverId)).get();
    if (!row) return;
    const template = row.template;
    if (steamHiccup(serverId, crash.excerpt)) {
      serverService.note(
        serverId,
        'Steam hat sich beim ersten Laden verschluckt („Missing configuration“) – starte gleich noch einmal …',
      );
      void (async () => {
        try {
          await serverService.start(serverId, SYSTEM_ACTOR);
        } catch (err) {
          ctx.log.warn({ err, serverId }, 'steam retry failed');
        }
      })();
      return;
    }
    // A preload template has no players and nobody to tell; the admin area shows its state.
    if (template) return;
    // Always-on (servers/service.ts keepAlive) starts it again by itself when "start automatically" is on.
    const restarting = row.autoStart;
    const text = crashText('de', crash.ruleId, crash.params);
    // In the console, so whoever looks there sees the cause and what to do.
    serverService.note(serverId, `⚠ Absturz erkannt: ${text.title}`);
    if (text.text) serverService.note(serverId, `Ursache: ${text.text}`);
    if (text.fix) serverService.note(serverId, `Lösung: ${text.fix}`);
    const fixes = (() => {
      try {
        return offers(serverId, crash);
      } catch {
        return [];
      }
    })();
    serverService.note(serverId, 'Im Panel: Absturz-Helfer oben auf der Konsole – ein Klick behebt es.');
    notify.tell(
      peopleFor(serverId),
      'crashes',
      () => ({
        discord: {
          title: `⚠️ „${row.name}“ ist abgestürzt: ${text.title}`,
          text: [
            `• **Was:** ${text.title}`,
            text.text ? `• **Ursache:** ${text.text}` : '',
            text.fix ? `• **Lösung:** ${text.fix}` : '',
            restarting ? '• **Dauerbetrieb:** Der Server startet gleich von selbst neu.' : '',
            fixes.some((f) => DISCORD_SAFE.has(f.id))
              ? '• **Schnell:** Knopf unten drücken – der Server startet danach neu.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          colour: DISCORD_RED,
          fields: crash.excerpt?.length
            ? [
                {
                  name: 'Letzte Zeilen',
                  value: `\`\`\`\n${crash.excerpt.slice(-6).join('\n').slice(0, 900)}\n\`\`\``,
                },
              ]
            : [],
          buttons: fixes
            .filter((f) => DISCORD_SAFE.has(f.id))
            .slice(0, 3)
            .map((f) => ({
              label: label(f),
              id: notify.actionId('crashfix', `${serverId}~${f.id}`),
              style: 'approve' as const,
            })),
        },
      }),
      'server-crash',
    );
  });

  notify.onAction('crashfix', async (target, by) => {
    const [serverId = '', fixId = ''] = target.split('~');
    const known = help(serverId)?.fixes.find((f) => f.id === fixId);
    if (!known) return { title: 'Schon erledigt', text: 'Für diesen Absturz gibt es nichts mehr zu tun.' };
    if (!DISCORD_SAFE.has(known.id)) throw forbidden('crash_fix_panel_only');
    await fix(serverId, known.id, true, by, { userId: by.id, username: by.username, ip: null });
    return { title: '✅ Erledigt', text: `${label(known)} – der Server startet gerade neu.` };
  });

  return { help, fix };
}
