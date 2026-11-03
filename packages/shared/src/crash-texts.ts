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
      text: '{{plugin}} braucht {{dependency}}, das ist aber nicht installiert.',
      fix: 'Installiere {{dependency}} über den Marktplatz oder entferne {{plugin}}.',
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
      text: '{{plugin}} needs {{dependency}}, which is not installed.',
      fix: 'Install {{dependency}} from the marketplace or remove {{plugin}}.',
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
