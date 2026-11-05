/**
 * The browser's developer console: in the real panel it only says "nothing to see here" plus a warning against
 * pasting code someone sent you (that is how accounts get stolen). Everything else the page would print there is
 * silenced. For debugging: localStorage "mh:debug" = "1" keeps the console as it is.
 */

const DEBUG_KEY = 'mh:debug';
const SILENCED = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'table', 'dir'] as const;
const TITLE_STYLE = 'font-size:28px;font-weight:800;color:#10b981;text-shadow:0 1px 0 #064e3b;padding:8px 0;';
const TEXT_STYLE = 'font-size:14px;color:#9ca3af;';
const WARN_STYLE = 'font-size:14px;font-weight:700;color:#ef4444;';

const debugWanted = (): boolean => {
  try {
    return localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
};

export function showConsoleNotice(): void {
  if (!import.meta.env.PROD || debugWanted()) return;
  const print = console.log.bind(console);
  try {
    console.clear();
  } catch {
    // Some browsers do not allow it; the notice still comes.
  }
  print('%cHier gibt es nichts zu sehen 👀', TITLE_STYLE);
  print('%cDas ist MorniHosting – hier gibt es nichts für dich.', TEXT_STYLE);
  print(
    '%cAchtung: Füge hier nichts ein, was dir jemand geschickt hat. Damit kann man dein Konto übernehmen.',
    WARN_STYLE,
  );
  SILENCED.forEach((method) => {
    console[method] = (): void => undefined;
  });
}
