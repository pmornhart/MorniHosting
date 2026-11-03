import { z } from 'zod';
import type { CrashInfo } from './api.js';

/**
 * What the crash helper can repair by itself. The panel works out which repairs fit a crash (and the server's
 * state: is there a backup, which plugin file is it …) and offers them as buttons – in the panel and in Discord.
 */
export const CRASH_FIXES = [
  'raise-memory',
  'set-java',
  'free-port',
  'accept-eula',
  'disable-plugin',
  'restore-backup',
  'reset-world',
  'retry',
] as const;
export type CrashFixId = (typeof CRASH_FIXES)[number];

export interface CrashFixOffer {
  readonly id: CrashFixId;
  /** Values for the button text, e.g. the new memory or the plugin file. */
  readonly params: Readonly<Record<string, string>>;
  /** Deletes or replaces data: asked again in the panel, never offered as a Discord button. */
  readonly danger: boolean;
}

export interface CrashHelp {
  readonly crash: CrashInfo;
  readonly fixes: readonly CrashFixOffer[];
}

export const crashFixSchema = z.object({
  fix: z.enum(CRASH_FIXES),
  /** Start the server again right after the repair. */
  start: z.boolean().default(true),
});
export type CrashFixInput = z.infer<typeof crashFixSchema>;

/** Button texts outside the web app (Discord). */
export const CRASH_FIX_LABELS: Readonly<Record<CrashFixId, string>> = {
  'raise-memory': 'Mehr RAM ({{toGb}} GB) + Neustart',
  'set-java': 'Java {{java}} einstellen + Neustart',
  'free-port': 'Freien Port {{port}} nehmen + Neustart',
  'accept-eula': 'EULA akzeptieren + Neustart',
  'disable-plugin': '{{file}} ausschalten + Neustart',
  'restore-backup': 'Backup vom {{when}} zurückspielen',
  'reset-world': 'Welt neu erstellen',
  retry: 'Nochmal starten',
};
