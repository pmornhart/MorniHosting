/**
 * Crash explanations for messages outside the web app (Discord, mail, console). Same words as the web app's
 * texts (crash.<rule>.title/.text/.fix), with {{name}} placeholders.
 */
export interface CrashText {
  readonly title: string;
  readonly text: string;
  readonly fix: string;
}

export const CRASH_TEXTS: Readonly<Record<'de' | 'en', Readonly<Record<string, CrashText>>>> = {
  de: {
    'out-of-memory': {
      title: 'Zu wenig Arbeitsspeicher',
      text: 'Der Server hatte {{memoryMb}} MB und brauchte mehr. Das passiert oft mit Modpacks oder vielen Spielern.',
      fix: 'Gib dem Server mehr Arbeitsspeicher (z. B. 2 GB mehr) und starte ihn neu.',
    },
    'wrong-java': {
      title: 'Falsche Java-Version',
      text: 'Ein Teil des Servers braucht Java {{java}}, gestartet wurde aber eine andere Version.',
      fix: 'Stelle in den Einstellungen die Java-Version auf „Automatisch“ oder Java {{java}}.',
    },
    'missing-dependency': {
      title: 'Es fehlt ein benötigtes Plugin oder Mod',
      text: '{{plugin}} braucht {{dependency}}, das ist aber nicht installiert. {{plugin}} selbst ist in Ordnung.',
      fix: 'Installiere {{dependency}} – mit dem Knopf (passend zu deiner Version) oder über den Marktplatz.',
    },
    'port-in-use': {
      title: 'Der Port ist schon belegt',
      text: 'Ein anderes Programm oder ein anderer Server nutzt diesen Port bereits.',
      fix: 'Wähle in den Einstellungen einen freien Port (z. B. 25566) und starte neu.',
    },
    eula: {
      title: 'Minecraft-EULA nicht akzeptiert',
      text: 'Ohne Zustimmung zur EULA startet der Server nicht.',
      fix: 'Starte den Server erneut; MorniHosting setzt die Zustimmung automatisch.',
    },
    'version-not-found': {
      title: 'Diese Version gibt es nicht',
      text: 'Die gewählte Spielversion konnte nicht geladen werden.',
      fix: 'Wähle in den Einstellungen eine andere Version.',
    },
    'mod-version-mismatch': {
      title: 'Mods passen nicht zur Spielversion',
      text: 'Mindestens eine Mod ist für eine andere Minecraft-Version gebaut.',
      fix: 'Prüfe die Mods im Marktplatz auf Updates oder entferne die unpassende Mod.',
    },
    'world-broken': {
      title: 'Die Welt lässt sich nicht laden',
      text: 'Die Weltdateien scheinen beschädigt zu sein.',
      fix: 'Spiele ein Backup zurück. Unter „Backups“ geht das mit einem Klick.',
    },
    'plugin-error': {
      title: 'Ein Plugin macht Probleme',
      text: 'Beim Start von {{plugin}} ist ein Fehler aufgetreten.',
      fix: 'Aktualisiere {{plugin}} oder schalte es unter „Plugins“ vorerst aus.',
    },
    'start-failed': {
      title: 'Der Server konnte nicht starten',
      text: 'Docker meldet: {{message}}',
      fix: 'Prüfe, ob Docker läuft, und versuche es erneut.',
    },
    unknown: {
      title: 'Unbekannte Ursache',
      text: 'Der Server wurde unerwartet beendet (Code {{exitCode}}). Die letzten Zeilen unten geben meist einen Hinweis.',
      fix: 'Starte den Server neu. Wenn es wieder passiert, sieh dir die Konsole genau an.',
    },
    'download-failed': {
      title: 'Spieldateien konnten nicht geladen werden',
      text: 'Beim ersten Start lädt der Server die Spieldateien aus dem Internet. Das hat nicht geklappt.',
      fix: 'Prüfe die Internetverbindung des Servers (DNS, Firewall) und starte ihn erneut.',
    },
    'disk-full': {
      title: 'Die Festplatte ist voll',
      text: 'Der Server konnte nichts mehr speichern: Auf dem Rechner ist kein Platz mehr frei.',
      fix: 'Lösche alte Backups oder Dateien (Papierkorb leeren) oder gib dem Rechner mehr Speicherplatz.',
    },
    'host-out-of-memory': {
      title: 'Der Rechner hatte keinen Arbeitsspeicher mehr',
      text: 'Der Server ({{memoryMb}} MB) wurde hart beendet, weil der ganze Rechner keinen Arbeitsspeicher mehr frei hatte – meist laufen zu viele Server oder einer hat mehr RAM als der Rechner.',
      fix: 'Gib dem Server weniger RAM, stoppe andere Server oder gib dem Rechner mehr RAM (Proxmox: pct set <ID> --memory …).',
    },
    'plugin-incompatible': {
      title: '{{plugin}} passt nicht zu dieser Server-Version',
      text: '{{plugin}} wurde für eine andere Minecraft-Version gebaut und ruft Dinge auf, die es hier nicht gibt.',
      fix: 'Aktualisiere {{plugin}} unter „Plugins“ oder schalte es aus, bis es ein Update gibt.',
    },
    'world-locked': {
      title: 'Die Welt ist schon geöffnet',
      text: 'Ein anderer Vorgang hält die Welt noch offen (z. B. ein alter Server-Prozess oder ein zweiter Server mit derselben Welt).',
      fix: 'Warte kurz und starte neu. Passiert es wieder, lösche die Datei session.lock im Welt-Ordner.',
    },
    'config-broken': {
      title: 'Eine Einstellungsdatei hat einen Fehler',
      text: 'Eine Konfigurationsdatei (YAML/JSON) ist kaputt, oft ein Tab, ein fehlendes Leerzeichen oder Anführungszeichen.',
      fix: 'Öffne die zuletzt geänderte Datei unter „Dateien“ und korrigiere die Zeile aus dem Fehler unten.',
    },
    'config-broken-plugin': {
      title: 'Die Einstellungen von {{plugin}} sind kaputt',
      text: 'In einer Konfigurationsdatei von {{plugin}} ist ein Schreibfehler (oft ein Tab oder fehlende Anführungszeichen).',
      fix: 'Öffne unter „Dateien“ den Ordner plugins/{{plugin}} und korrigiere die Datei, oder schalte {{plugin}} vorerst aus.',
    },
    watchdog: {
      title: 'Der Server hat sich aufgehängt',
      text: 'Ein Spieltick dauerte so lange, dass der Wachhund den Server beendet hat (zu viel los, Endlosschleife oder zu wenig CPU).',
      fix: 'Starte neu. Passiert es öfter, reduziere Farmen/Entities oder gib dem Server mehr Prozessor.',
    },
    'watchdog-plugin': {
      title: '{{plugin}} hat den Server aufgehängt',
      text: 'Der Wachhund hat den Server beendet, weil {{plugin}} zu lange gerechnet hat.',
      fix: 'Aktualisiere {{plugin}} oder schalte es aus und starte neu.',
    },
    'permission-denied': {
      title: 'Keine Berechtigung für Dateien',
      text: 'Der Server durfte eine Datei nicht lesen oder schreiben.',
      fix: 'Starte den Server neu; MorniHosting setzt die Rechte dabei. Lade Dateien nur über das Panel hoch.',
    },
    'unknown-error': {
      title: 'Der Server ist mit einem Fehler abgestürzt',
      text: 'Fehler: {{error}}',
      fix: 'Starte neu. Kommt der Fehler wieder, such nach der Fehlermeldung oder schalte zuletzt installierte Plugins/Mods aus.',
    },
  },
  en: {
    'out-of-memory': {
      title: 'Not enough memory',
      text: 'The server had {{memoryMb}} MB and needed more. This often happens with modpacks or many players.',
      fix: 'Give the server more memory (e.g. 2 GB more) and restart it.',
    },
    'wrong-java': {
      title: 'Wrong Java version',
      text: 'Part of the server needs Java {{java}}, but a different version was started.',
      fix: 'Set the Java version to “Automatic” or Java {{java}} in the settings.',
    },
    'missing-dependency': {
      title: 'A required plugin or mod is missing',
      text: '{{plugin}} needs {{dependency}}, which is not installed. {{plugin}} itself is fine.',
      fix: 'Install {{dependency}} – with the button (matching your version) or from the marketplace.',
    },
    'port-in-use': {
      title: 'The port is already in use',
      text: 'Another program or server already uses this port.',
      fix: 'Pick a free port in the settings (e.g. 25566) and restart.',
    },
    eula: {
      title: 'Minecraft EULA not accepted',
      text: 'The server does not start without agreeing to the EULA.',
      fix: 'Start the server again; MorniHosting sets the agreement automatically.',
    },
    'version-not-found': {
      title: 'This version does not exist',
      text: 'The selected game version could not be downloaded.',
      fix: 'Pick a different version in the settings.',
    },
    'mod-version-mismatch': {
      title: 'Mods do not match the game version',
      text: 'At least one mod was built for a different Minecraft version.',
      fix: 'Check the mods for updates in the marketplace or remove the mismatching mod.',
    },
    'world-broken': {
      title: 'The world cannot be loaded',
      text: 'The world files seem to be damaged.',
      fix: 'Restore a backup. Under “Backups” that takes one click.',
    },
    'plugin-error': {
      title: 'A plugin is causing trouble',
      text: '{{plugin}} failed while starting.',
      fix: 'Update {{plugin}} or switch it off under “Plugins” for now.',
    },
    'start-failed': {
      title: 'The server could not start',
      text: 'Docker says: {{message}}',
      fix: 'Check that Docker is running and try again.',
    },
    unknown: {
      title: 'Unknown cause',
      text: 'The server stopped unexpectedly (code {{exitCode}}). The last lines below usually give a hint.',
      fix: 'Restart the server. If it happens again, take a close look at the console.',
    },
    'download-failed': {
      title: 'Game files could not be downloaded',
      text: 'On its first start the server downloads the game files from the internet. That failed.',
      fix: "Check the server's internet connection (DNS, firewall) and start it again.",
    },
    'disk-full': {
      title: 'The disk is full',
      text: 'The server could not save anything: there is no free space left on the machine.',
      fix: 'Delete old backups or files (empty the trash) or give the machine more disk space.',
    },
    'host-out-of-memory': {
      title: 'The machine ran out of memory',
      text: 'The server ({{memoryMb}} MB) was killed because the whole machine had no memory left – usually too many servers or one with more RAM than the machine.',
      fix: 'Give the server less RAM, stop other servers or give the machine more RAM (Proxmox: pct set <ID> --memory …).',
    },
    'plugin-incompatible': {
      title: '{{plugin}} does not fit this server version',
      text: '{{plugin}} was built for another Minecraft version and calls things that do not exist here.',
      fix: 'Update {{plugin}} under “Plugins” or switch it off until there is an update.',
    },
    'world-locked': {
      title: 'The world is already open',
      text: 'Something else still holds the world open (an old server process or a second server with the same world).',
      fix: 'Wait a moment and restart. If it happens again, delete session.lock in the world folder.',
    },
    'config-broken': {
      title: 'A settings file has an error',
      text: 'A config file (YAML/JSON) is broken, often a tab, a missing space or quote.',
      fix: 'Open the last changed file under “Files” and fix the line from the error below.',
    },
    'config-broken-plugin': {
      title: 'The settings of {{plugin}} are broken',
      text: 'A config file of {{plugin}} has a typo (often a tab or missing quotes).',
      fix: 'Open the folder plugins/{{plugin}} under “Files” and fix the file, or switch {{plugin}} off for now.',
    },
    watchdog: {
      title: 'The server froze',
      text: 'One game tick took so long that the watchdog stopped the server (too much going on, an endless loop or too little CPU).',
      fix: 'Restart. If it happens often, reduce farms/entities or give the server more CPU.',
    },
    'watchdog-plugin': {
      title: '{{plugin}} froze the server',
      text: 'The watchdog stopped the server because {{plugin}} took too long.',
      fix: 'Update {{plugin}} or switch it off and restart.',
    },
    'permission-denied': {
      title: 'No permission for files',
      text: 'The server was not allowed to read or write a file.',
      fix: 'Restart the server; MorniHosting fixes the permissions. Only upload files through the panel.',
    },
    'unknown-error': {
      title: 'The server crashed with an error',
      text: 'Error: {{error}}',
      fix: 'Restart. If the error comes back, search for the message or switch off recently installed plugins/mods.',
    },
  },
};

// Placeholders in the texts. Matches "{{memoryMb}}" (captures "memoryMb"); leaves "{memoryMb}" alone.
// https://regex101.com/?flavor=javascript&regex=%5C%7B%5C%7B(%5Cw%2B)%5C%7D%5C%7D&flags=g&testString=%7B%7BmemoryMb%7D%7D%20MB%0A%7BmemoryMb%7D
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** The explanation of a crash rule in plain words, placeholders filled in. */
export function crashText(
  locale: 'de' | 'en',
  ruleId: string,
  params: Readonly<Record<string, string>>,
): CrashText {
  const texts = CRASH_TEXTS[locale];
  const raw = texts[ruleId] ?? texts['unknown'] ?? { title: ruleId, text: '', fix: '' };
  const fill = (s: string): string => s.replace(PLACEHOLDER, (_m, key: string) => params?.[key] ?? '');
  return { title: fill(raw.title), text: fill(raw.text), fix: fill(raw.fix) };
}
