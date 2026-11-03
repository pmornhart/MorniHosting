/**
 * steamcmd tells how far a game download is: "Update state (0x61) downloading, progress: 45.23 (27123456789 /
 * 60000000000)". The panel turns that into percent, gigabytes, speed and time left.
 */

// steamcmd download line. Captures percent, bytes done and bytes total from
// "Update state (0x61) downloading, progress: 45.23 (27123456789 / 60000000000)"; rejects "Success! App '730' fully installed."
// https://regex101.com/?flavor=javascript&regex=progress%3A%20(%5Cd%2B(%3F%3A%5C.%5Cd%2B)%3F)%20%5C((%5Cd%2B)%20%5C%2F%20(%5Cd%2B)%5C)&testString=Update%20state%20(0x61)%20downloading%2C%20progress%3A%2045.23%20(27123456789%20%2F%2060000000000)%0ASuccess!%20App%20'730'%20fully%20installed.
const STEAM_PROGRESS = /progress: (\d+(?:\.\d+)?) \((\d+) \/ (\d+)\)/;
const MS_PER_SECOND = 1000;
/** Speed is averaged over this long, steamcmd reports in bursts. */
const SPEED_WINDOW_MS = 30_000;

export interface DownloadProgress {
  readonly percent: number;
  readonly doneBytes: number;
  readonly totalBytes: number;
  /** null until two samples are there. */
  readonly bytesPerSecond: number | null;
}

interface Sample {
  readonly at: number;
  readonly done: number;
}

export function readSteamProgress(line: string): { percent: number; done: number; total: number } | null {
  const m = STEAM_PROGRESS.exec(line);
  if (!m) return null;
  const total = Number(m[3]);
  if (!total) return null;
  return { percent: Number(m[1]), done: Number(m[2]), total };
}

/** Keeps a few samples per server and works out the speed. */
export function createDownloadMeter(): (line: string, now?: number) => DownloadProgress | null {
  let samples: Sample[] = [];
  return (line, now = Date.now()) => {
    const read = readSteamProgress(line);
    if (!read) return null;
    // A new download (or a restart) begins below the last value: start over.
    if (samples.length && read.done < (samples.at(-1)?.done ?? 0)) samples = [];
    samples = [...samples, { at: now, done: read.done }].filter((s) => now - s.at <= SPEED_WINDOW_MS);
    const first = samples[0];
    const seconds = first ? (now - first.at) / MS_PER_SECOND : 0;
    const speed = first && seconds > 0 ? (read.done - first.done) / seconds : null;
    return { percent: read.percent, doneBytes: read.done, totalBytes: read.total, bytesPerSecond: speed };
  };
}
