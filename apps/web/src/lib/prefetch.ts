import { useEffect } from 'react';

/**
 * Once the panel is idle, the pages people open most load in the background, so a click shows them at once
 * instead of waiting for the download. Skipped when the browser asks to save data.
 */

/** Give the first page time to settle before anything else loads. */
const START_DELAY_MS = 1500;
/** Fallback for browsers without requestIdleCallback (Safari). */
const IDLE_FALLBACK_MS = 200;

const PAGES: readonly (() => Promise<unknown>)[] = [
  () => import('@/features/servers/ConsoleHome'),
  () => import('@/features/servers/create/CreateServerPage'),
  () => import('@/features/servers/settings/SettingsTab'),
  () => import('@/features/servers/players/PlayersTab'),
  () => import('@/features/servers/files/FilesTab'),
  () => import('@/features/servers/content/ContentTab'),
  () => import('@/features/servers/backups/BackupsTab'),
  () => import('@/features/admin/AccountPage'),
];

function saveData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function whenIdle(run: () => void): void {
  if ('requestIdleCallback' in window) window.requestIdleCallback(run);
  else setTimeout(run, IDLE_FALLBACK_MS);
}

/** One after another, each when the browser has nothing else to do. */
async function loadAll(): Promise<void> {
  await PAGES.reduce(async (previous, load) => {
    await previous;
    await new Promise<void>((resolve) => whenIdle(resolve));
    try {
      await load();
    } catch {
      // Offline or the panel was just updated: the page loads normally when it is opened.
    }
  }, Promise.resolve());
}

export function usePrefetchPages(): void {
  useEffect(() => {
    if (saveData()) return undefined;
    const timer = setTimeout(() => void loadAll(), START_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}
