import type { AppContext } from '../context.js';
import type { ServerService } from '../servers/service.js';
import type { AlertService } from './service.js';

/** Game servers that cannot come back by themselves, and failed backups, as alerts. */

// Not reached at all (no login problem): "connect EHOSTUNREACH 10.0.0.5:465", "ECONNREFUSED", "ETIMEDOUT" match; "535 Authentication failed" does not.
// https://regex101.com/?flavor=javascript&regex=EHOSTUNREACH%7CECONNREFUSED%7CETIMEDOUT%7CENOTFOUND%7CENETUNREACH%7CEAI_AGAIN&testString=connect%20EHOSTUNREACH%2010.0.0.5%3A465%0A535%20Authentication%20failed
const MAIL_UNREACHABLE = /EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EAI_AGAIN/;
const CONTAINER_HINT = 'pct set <ID> --memory 32768';
/** Problems always-on cannot solve alone: what the person has to do. */
const NEEDS_PERSON: Readonly<Record<string, (p: Readonly<Record<string, unknown>>) => string>> = {
  host_memory_full: (p) =>
    `Es ist nicht genug RAM frei (braucht ${String(p['need'] ?? '?')} MB, frei ${String(p['free'] ?? '?')} MB). Gib dem Server weniger RAM, stoppe einen anderen oder gib dem Rechner mehr RAM.`,
  host_disk_full: (p) =>
    `Die Festplatte ist fast voll (${String(p['free'] ?? '?')} MB frei). Lösche alte Backups oder Dateien.`,
  disk_limit_reached: () =>
    'Der Server hat sein Speicher-Limit erreicht. Lösche Dateien oder erhöhe das Limit.',
  game_files_missing: (p) =>
    `Es fehlen Spieldateien (${String(p['files'] ?? '')}). Lade sie in den Server-Einstellungen hoch.`,
};

export function watchServerAlerts(ctx: AppContext, servers: ServerService, alerts: AlertService): void {
  const nameOf = (id: string): string => {
    try {
      return servers.row(id).name;
    } catch {
      return id;
    }
  };

  ctx.events.on('server.revive', ({ serverId, tries, reason, code, params }) => {
    const key = `server:${serverId}`;
    const name = nameOf(serverId);
    if (tries === 0) {
      alerts.resolved(key, `„${name}“ läuft wieder`, 'Der Server läuft seit 10 Minuten stabil.');
      return;
    }
    const person = code ? NEEDS_PERSON[code] : undefined;
    alerts.alert({
      key,
      title: `„${name}“ startet nicht`,
      what: `Der Server ist aus und sollte laufen. Neustart ${tries} hat nicht geklappt: ${reason ?? 'unbekannt'}`,
      status: person ? 'action' : 'fixing',
      ...(person
        ? {
            action: person(params ?? {}),
            ...(code === 'host_memory_full' ? { command: `${CONTAINER_HINT}   # auf dem Proxmox-Host` } : {}),
          }
        : {}),
    });
  });

  ctx.events.on('mail.failed', ({ error }) => {
    const unreachable = MAIL_UNREACHABLE.test(error);
    alerts.alert({
      key: 'mail',
      title: unreachable ? 'Mailserver nicht erreichbar' : 'Mail konnte nicht verschickt werden',
      what: `Das Panel konnte eine Mail nicht abgeben: ${error}`,
      status: 'action',
      action: unreachable
        ? 'Läuft der Mailserver (z. B. der Stalwart-Container)? Auf dem Proxmox-Host prüfen und ggf. starten:'
        : 'Zugangsdaten im Panel unter Admin → E-Mail prüfen (bzw. „Stalwart verbinden“ noch einmal).',
      ...(unreachable ? { command: 'pct list   # dann: pct start <ID>' } : {}),
    });
  });

  ctx.events.on('backup.failed', ({ serverId, error }) => {
    alerts.alert({
      key: `backup:${serverId}`,
      title: `Backup von „${nameOf(serverId)}“ fehlgeschlagen`,
      what: error,
      status: 'action',
      action: 'Prüfe den freien Speicherplatz und starte das Backup unter „Backups“ noch einmal.',
    });
  });
}
