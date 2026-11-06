import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  ChangeItem,
  ChangeKind,
  Changelog,
  UpdateChange,
  UpdateInfo,
  UpdateRun,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { conflict } from '../lib/errors.js';
import { createCache, fetchJson, UpstreamError } from '../lib/http-client.js';
import { HTTP_NOT_FOUND } from '../lib/http-status.js';
import { MS_PER_HOUR, MS_PER_MINUTE, nowIso } from '../lib/units.js';

/**
 * Updates follow the update branch on GitHub (main): the panel knows the commit it was built from and asks
 * GitHub which changes came since. The panel cannot update its own container, so it drops a request file
 * into the data volume; the host updater from install.sh (a systemd path unit) sees it and runs update.sh,
 * which reports its step in status.json and its output in log.txt. The updater announces itself with
 * agent.json.
 */

const SHORT_SHA = 7;
const MAX_CHANGES = 30;
const LOG_LINES = 60;
/** The host updater removes the request within seconds; much later it is not listening. */
const STUCK_AFTER_MINUTES = 2;
const STUCK_AFTER_MS = STUCK_AFTER_MINUTES * MS_PER_MINUTE;
/** "Update finished" stays visible for a while after the panel came back. */
const DONE_SHOWN_MS = MS_PER_HOUR;
/** A failed check (no internet, GitHub's limit of 60 questions an hour) is not repeated at once. */
const FAILED_CHECK_MINUTES = 10;
const FAILED_CHECK_MS = FAILED_CHECK_MINUTES * MS_PER_MINUTE;
const MERGE_PREFIX = 'Merge ';
/** The escape character that starts a terminal colour code. */
const ESC = '\u001b';
// Colour codes in the updater's output: "\x1b[32m" and "\x1b[0m" match, plain text does not.
// https://regex101.com/?flavor=javascript&regex=%5Cx1b%5C%5B%5B0-9%3B%5D*m&flags=g&testString=%1B%5B32m%E2%9C%94%1B%5B0m%20Fertig
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
// A version that is a commit: "b886c33" matches; "1.2.0" and "dev" do not.
// https://regex101.com/?flavor=javascript&regex=%5E%5B0-9a-f%5D%7B7%2C40%7D%24&testString=b886c33%0A1.2.0%0Adev
const COMMIT = /^[0-9a-f]{7,40}$/;
// "git describe" after a release: "v1.2.0-3-gb886c33" gives "b886c33"; "v1.2.0" does not match.
// https://regex101.com/?flavor=javascript&regex=-g(%5B0-9a-f%5D%7B7%2C40%7D)%24&testString=v1.2.0-3-gb886c33%0Av1.2.0
const DESCRIBED = /-g([0-9a-f]{7,40})$/;
// A release: "1.2.0" and "v1.2.0" match (number without "v"); "1.2" and "dev" do not.
// https://regex101.com/?flavor=javascript&regex=%5Ev%3F(%5Cd%2B%5C.%5Cd%2B%5C.%5Cd%2B)%24&testString=1.2.0%0Av1.2.0%0A1.2%0Adev
const RELEASE = /^v?(\d+\.\d+\.\d+)$/;
// The release in front of "git describe": "v1.2.0-3-gb886c33" gives "1.2.0"; "b886c33" does not match.
// https://regex101.com/?flavor=javascript&regex=%5Ev%3F(%5Cd%2B%5C.%5Cd%2B%5C.%5Cd%2B)-%5Cd%2B-g&testString=v1.2.0-3-gb886c33%0Ab886c33
const DESCRIBED_RELEASE = /^v?(\d+\.\d+\.\d+)-\d+-g/;
/** How many changes "What's new" lists (merge commits left out). */
const CHANGELOG_SIZE = 15;
const VERSION_PARTS = 3;
const DIGIT_BASE = 10;
/** Commits fetched for it; some of them are merges. */
const CHANGELOG_FETCH = 30;

const commitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: z.string() }).nullable(),
  }),
});
const compareSchema = z.object({
  ahead_by: z.number(),
  html_url: z.string(),
  commits: z.array(commitSchema),
});
const requestSchema = z.object({ requestedAt: z.string() });
const statusSchema = z.object({
  state: z.enum(['running', 'done', 'failed']),
  step: z.enum(['pull', 'build', 'restart']).nullable().optional(),
  at: z.string(),
});

type Commit = z.infer<typeof commitSchema>;

/** What the running version is called on GitHub: a commit, a release tag, or unknown ("dev"). */
function baseRef(version: string): string | null {
  if (COMMIT.test(version)) return version;
  const described = DESCRIBED.exec(version)?.[1];
  if (described) return described;
  const release = RELEASE.exec(version)?.[1];
  return release ? `v${release}` : null;
}

// A bullet line of a commit message: "- Neu: Impressum-Seite" gives "Neu: Impressum-Seite"; "Verfasst …" does not.
// https://regex101.com/?flavor=javascript&regex=%5E%5Cs*%5B-*%E2%80%A2%5D%5Cs%2B(.%2B)%24&testString=-%20Neu%3A%20Impressum-Seite%0AVerfasst%20mit%20Claude
const BULLET = /^\s*[-*•]\s+(.+)$/;
// An explicit kind in front: "Behoben: Bedrock-Port" gives "Behoben" and "Bedrock-Port".
// https://regex101.com/?flavor=javascript&regex=%5E(neu%7Cbehoben%7Cverbessert%7Centfernt%7Cge%C3%A4ndert)%5Cs*%3A%5Cs*(.%2B)%24&flags=i&testString=Behoben%3A%20Bedrock-Port%0ANeu%3A%20Impressum
const LABELLED = /^(neu|behoben|verbessert|entfernt|geändert)\s*:\s*(.+)$/i;
const LABEL_KINDS: Readonly<Record<string, ChangeKind>> = {
  neu: 'new',
  behoben: 'fixed',
  verbessert: 'improved',
  entfernt: 'removed',
  geändert: 'other',
};
// Words that tell the kind of an unlabelled line, e.g. "… behoben", "Fehler …", "… entfernt", "neue Seite".
// https://regex101.com/?flavor=javascript&regex=%5Cb(behoben%7Cfix%7Crepariert%7Cfehler%7Ching%7Cging%20nicht%7Ckam%20nicht)&flags=i&testString=Bedrock%20kam%20nicht%20rein
const FIXED_WORDS = /\b(behoben|fix|repariert|fehler|hing|ging nicht|kam nicht)/i;
// https://regex101.com/?flavor=javascript&regex=%5Cb(entfernt%7Cgel%C3%B6scht%7Cweg%7Craus%7Cabgeschaltet)%5Cb&flags=i&testString=Men%C3%BCpunkt%20entfernt
const REMOVED_WORDS = /\b(entfernt|gelöscht|weg|raus|abgeschaltet)\b/i;
// https://regex101.com/?flavor=javascript&regex=%5Cb(neu%7Cneue%7Cneuer%7Cneues%7Chinzu%7Ckann%20jetzt)%5Cb&flags=i&testString=Neue%20Impressum-Seite
const NEW_WORDS = /\b(neu|neue|neuer|neues|hinzu|kann jetzt)\b/i;
// https://regex101.com/?flavor=javascript&regex=%5Cb(schneller%7Cbesser%7Cweniger%7Cstabiler%7Cklarer)%5Cb&flags=i&testString=Start%20ist%20schneller
const IMPROVED_WORDS = /\b(schneller|besser|weniger|stabiler|klarer)\b/i;
const GUESSES: readonly (readonly [RegExp, ChangeKind])[] = [
  [FIXED_WORDS, 'fixed'],
  [REMOVED_WORDS, 'removed'],
  [NEW_WORDS, 'new'],
  [IMPROVED_WORDS, 'improved'],
];
/** Lines that are not part of the change itself (signature lines). */
const SKIP_PREFIXES = ['Verfasst mit Claude', 'Co-Authored-By:', 'Claude-Session:'];

/** One bullet line as a change item: an explicit "Neu:"/"Behoben:" … wins, else the kind is guessed from words. */
export function changeItem(line: string): ChangeItem {
  const labelled = LABELLED.exec(line);
  if (labelled)
    return { kind: LABEL_KINDS[(labelled[1] ?? '').toLowerCase()] ?? 'other', text: labelled[2] ?? '' };
  const guessed = GUESSES.find(([words]) => words.test(line))?.[1] ?? 'other';
  return { kind: guessed, text: line };
}

/** The bullet lines of a commit message, each with its kind. */
export function changeItems(message: string): ChangeItem[] {
  return message
    .split('\n')
    .slice(1)
    .filter((line) => !SKIP_PREFIXES.some((prefix) => line.trim().startsWith(prefix)))
    .map((line) => BULLET.exec(line)?.[1]?.trim() ?? '')
    .filter(Boolean)
    .map(changeItem);
}

const toChange = (c: Commit): UpdateChange => ({
  sha: c.sha.slice(0, SHORT_SHA),
  title: c.commit.message.split('\n')[0] ?? '',
  date: c.commit.committer?.date ?? '',
  items: changeItems(c.commit.message),
});

/** "1.0.84" of the running panel ("v1.0.84-0-gb886c33" or "v1.0.84"), else null. */
const versionOf = (built: string): string | null =>
  DESCRIBED_RELEASE.exec(built)?.[1] ?? RELEASE.exec(built)?.[1] ?? null;
/**
 * Version numbers count the updates, one digit per place: update 84 is "0.8.4", after "0.0.9" comes "0.1.0",
 * after "0.9.9" comes "1.0.0". The next version: each update merged into the branch counts one up.
 */
export function versionFromCount(count: number): string {
  const patch = count % DIGIT_BASE;
  const minor = Math.floor(count / DIGIT_BASE) % DIGIT_BASE;
  const major = Math.floor(count / (DIGIT_BASE * DIGIT_BASE));
  return `${major}.${minor}.${patch}`;
}
const countFromVersion = (version: string): number | null => {
  const parts = version.split('.').map(Number);
  if (parts.length !== VERSION_PARTS || parts.some(Number.isNaN)) return null;
  const [major = 0, minor = 0, patch = 0] = parts;
  return major * DIGIT_BASE * DIGIT_BASE + minor * DIGIT_BASE + patch;
};
const bumped = (version: string | null, steps: number): string | null => {
  const count = version === null ? null : countFromVersion(version);
  return count === null ? null : versionFromCount(count + steps);
};

interface Latest {
  readonly latest: string | null;
  readonly latestVersion: string | null;
  readonly latestDate: string | null;
  readonly available: boolean;
  readonly behind: number;
  readonly changes: readonly UpdateChange[];
  readonly url: string | null;
  readonly checkedAt: string;
  readonly checkFailed: boolean;
}

export interface UpdateService {
  readonly info: () => Promise<UpdateInfo>;
  /** Asks GitHub again right now instead of waiting for the hourly check. */
  readonly check: () => Promise<UpdateInfo>;
  readonly request: (actor: Actor) => Promise<UpdateInfo>;
  /** The running version and the changes up to it (for "What's new"). */
  readonly changelog: () => Promise<Changelog>;
}

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function createUpdateService(ctx: AppContext): UpdateService {
  const dir = path.join(ctx.config.dataDir, 'update');
  const requestFile = path.join(dir, 'request.json');
  const agentFile = path.join(dir, 'agent.json');
  const statusFile = path.join(dir, 'status.json');
  const logFile = path.join(dir, 'log.txt');
  const cache = createCache<Latest>(MS_PER_HOUR);
  const failedCache = createCache<Latest>(FAILED_CHECK_MS);
  const { updateRepo: repo, updateBranch: branch } = ctx.config;
  const api = `https://api.github.com/repos/${repo}`;
  const headers = { accept: 'application/vnd.github+json' };

  const ask = async (): Promise<Latest> => {
    const head = commitSchema.parse(await fetchJson(`${api}/commits/${branch}`, { headers }));
    const current = versionOf(ctx.config.version);
    const newest = {
      latest: head.sha.slice(0, SHORT_SHA),
      latestVersion: current,
      latestDate: head.commit.committer?.date ?? null,
      checkedAt: nowIso(),
      checkFailed: false,
    };
    const base = baseRef(ctx.config.version);
    const unknown = {
      ...newest,
      behind: 0,
      changes: [],
      url: `https://github.com/${repo}/commits/${branch}`,
    };
    // Built without knowing its commit ("dev"): any version from GitHub is worth offering.
    if (!base) return { ...unknown, latestVersion: null, available: true };
    if (head.sha.startsWith(base)) return { ...unknown, available: false };
    try {
      const diff = compareSchema.parse(await fetchJson(`${api}/compare/${base}...${head.sha}`, { headers }));
      // Every update arrives as one merge into the branch: that is the step of the version number.
      const merges = diff.commits.filter((c) => c.commit.message.startsWith(MERGE_PREFIX)).length;
      const steps = diff.ahead_by > 0 ? Math.max(merges, 1) : 0;
      return {
        ...newest,
        latestVersion: bumped(current, steps),
        available: diff.ahead_by > 0,
        behind: diff.ahead_by,
        changes: diff.commits
          .filter((c) => !c.commit.message.startsWith(MERGE_PREFIX))
          .map(toChange)
          .reverse()
          .slice(0, MAX_CHANGES),
        url: diff.html_url,
      };
    } catch (err) {
      // A commit GitHub does not know (built from a local change): offer the newest version anyway.
      if (err instanceof UpstreamError && err.status === HTTP_NOT_FOUND)
        return { ...unknown, latestVersion: null, available: true };
      throw err;
    }
  };

  const latest = async (force: boolean): Promise<Latest> => {
    const hit = force ? undefined : (cache.get('latest') ?? failedCache.get('latest'));
    if (hit) return hit;
    try {
      const fresh = await ask();
      cache.set('latest', fresh);
      return fresh;
    } catch (err) {
      ctx.log.warn({ err }, 'update check failed');
      const failed: Latest = {
        latest: null,
        latestVersion: null,
        latestDate: null,
        available: false,
        behind: 0,
        changes: [],
        url: null,
        checkedAt: nowIso(),
        checkFailed: true,
      };
      failedCache.set('latest', failed);
      return failed;
    }
  };

  const log = (): string[] => {
    if (!fs.existsSync(logFile)) return [];
    return fs
      .readFileSync(logFile, 'utf8')
      .replaceAll(ANSI, '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-LOG_LINES);
  };

  const run = (): UpdateRun | null => {
    const request = readJson(requestFile, requestSchema);
    if (request) {
      const waiting = Date.now() - Date.parse(request.requestedAt);
      return {
        state: waiting > STUCK_AFTER_MS ? 'stuck' : 'requested',
        step: null,
        at: request.requestedAt,
        log: log(),
      };
    }
    const status = readJson(statusFile, statusSchema);
    if (!status) return null;
    if (status.state === 'done' && Date.now() - Date.parse(status.at) > DONE_SHOWN_MS) return null;
    return { state: status.state, step: status.step ?? null, at: status.at, log: log() };
  };

  const info = async (force = false): Promise<UpdateInfo> => {
    const current = run();
    const base = {
      current: ctx.config.version,
      currentVersion: versionOf(ctx.config.version),
      canSelfUpdate: fs.existsSync(agentFile),
      updating: current?.state === 'requested' || current?.state === 'running',
      run: current,
    };
    if (!ctx.settings.get().checkUpdates) {
      return {
        ...base,
        latest: null,
        latestVersion: null,
        latestDate: null,
        available: false,
        behind: 0,
        changes: [],
        url: null,
        checkedAt: null,
        checkFailed: false,
      };
    }
    return { ...base, ...(await latest(force)) };
  };

  const changelogCache = createCache<Changelog>(MS_PER_HOUR);
  const changelog = async (): Promise<Changelog> => {
    const hit = changelogCache.get('log');
    if (hit) return hit;
    const version = ctx.config.version;
    const base = baseRef(version);
    const release = RELEASE.exec(version)?.[1] ?? DESCRIBED_RELEASE.exec(version)?.[1] ?? null;
    const commit =
      (COMMIT.test(version) ? version : DESCRIBED.exec(version)?.[1])?.slice(0, SHORT_SHA) ?? null;
    const own = { release, commit };
    try {
      const commits = z
        .array(commitSchema)
        .parse(
          await fetchJson(`${api}/commits?sha=${base ?? branch}&per_page=${CHANGELOG_FETCH}`, { headers }),
        );
      const fresh: Changelog = {
        ...own,
        changes: commits
          .filter((c) => !c.commit.message.startsWith(MERGE_PREFIX))
          .slice(0, CHANGELOG_SIZE)
          .map(toChange),
        url: `https://github.com/${repo}/commits/${base ?? branch}`,
        failed: false,
      };
      changelogCache.set('log', fresh);
      return fresh;
    } catch (err) {
      ctx.log.warn({ err }, 'changelog failed');
      // Not cached: the next opening tries again.
      return { ...own, changes: [], url: `https://github.com/${repo}/commits/${branch}`, failed: true };
    }
  };

  return {
    changelog,
    info: () => info(),
    check: () => info(true),
    request: async (actor) => {
      const current = await info();
      if (!current.canSelfUpdate) throw conflict('self_update_unavailable');
      if (current.updating) return current;
      if (!current.available) throw conflict('update_unavailable');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        requestFile,
        JSON.stringify({ requestedAt: nowIso(), by: actor.username, version: current.latest }),
      );
      ctx.audit.record(actor, 'panel.update', null, { from: current.current, to: current.latest });
      return info();
    },
  };
}
