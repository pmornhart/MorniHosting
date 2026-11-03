import { randomBytes } from 'node:crypto';
import {
  MAIL_TEST_FINAL,
  mailTestRunSchema,
  type Locale,
  type MailTestRecipient,
  type MailTestRun,
  type MailTestRunInput,
  type MailTestSpam,
} from '@mornihosting/shared';
import type { AppContext } from '../context.js';
import { AppError, errorMessage } from '../lib/errors.js';
import { fetchResponse } from '../lib/http-client.js';
import { MS_PER_DAY, MS_PER_MINUTE, MS_PER_SECOND } from '../lib/units.js';
import type { StalwartClient, StalwartQueuedRecipient } from '../stalwart/client.js';
import type { MailService } from './service.js';

/**
 * Mail tests: one test mail to several addresses (and optionally to mail-tester.com), followed live. With Stalwart
 * connected the panel reads its outgoing queue (and log, if there is one) and shows what the receiving server
 * answered; without it only "the mail server took it" is known. The last runs are kept in the settings.
 */

const SETTINGS_KEY = 'mail_tests';
const KEEP_RUNS = 20;
const DETAIL_MAX = 300;
/** A message missing from the queue this soon may simply not be listed yet. */
const QUEUE_GRACE_SECONDS = 20;
const QUEUE_GRACE_MS = QUEUE_GRACE_SECONDS * MS_PER_SECOND;
/** Runs older than this are no longer followed. */
const FOLLOW_FOR_DAYS = 2;
const FOLLOW_FOR_MS = FOLLOW_FOR_DAYS * MS_PER_DAY;
/** mail-tester needs a moment; after this the result page is offered instead. */
const SPAM_WAIT_MINUTES = 3;
const SPAM_WAIT_MS = SPAM_WAIT_MINUTES * MS_PER_MINUTE;
/** Mails from the panel queued a little before the run started still belong to it. */
const CLOCK_SLACK_MS = MS_PER_MINUTE;
const SPAM_ID_LENGTH = 9;
const SPAM_MAX = 10;
const MAIL_TESTER_DOMAIN = 'srv1.mail-tester.com';
const MAIL_TESTER = 'https://www.mail-tester.com';
// Stalwart's id in "250 2.0.0 Message queued with id 4b2b54509600a01." Matches "queued with id 4b2b54509600a01",
// "queued as ABC123"; rejects "250 OK".
// https://regex101.com/?flavor=javascript&regex=queued%20(%3F%3Awith%20id%7Cas)%20(%5B0-9a-zA-Z%5D%2B)&flags=i&testString=250%202.0.0%20Message%20queued%20with%20id%204b2b54509600a01.%0A250%20OK
const QUEUE_ID = /queued (?:with id|as) ([0-9a-zA-Z]+)/i;
// Log events that end a delivery. Matches "delivery.delivered", "delivery.rcpt-to-rejected"; rejects "delivery.connect".
// https://regex101.com/?flavor=javascript&regex=delivered%7Crejected%7Cfailed&testString=delivery.delivered%0Adelivery.rcpt-to-rejected%0Adelivery.connect
const LOG_DONE = /delivered|rejected|failed/;
// Score in mail-tester's display text. Matches "9.4/10" and "10/10"; rejects "abc".
// https://regex101.com/?flavor=javascript&regex=(-%3F%5Cd%2B(%3F%3A%5B.%2C%5D%5Cd%2B)%3F)%5Cs*%5C%2F%5Cs*10&testString=9.4%2F10%0A10%2F10%0Aabc
const SCORE_TEXT = /(-?\d+(?:[.,]\d+)?)\s*\/\s*10/;

interface StoredRecipient extends MailTestRecipient {
  readonly queueId: string | null;
}
interface StoredRun extends Omit<MailTestRun, 'recipients'> {
  readonly recipients: readonly StoredRecipient[];
}

export interface MailTests {
  readonly list: () => Promise<MailTestRun[]>;
  readonly run: (input: MailTestRunInput, locale: Locale, vars: { name: string }) => Promise<MailTestRun>;
}

const recipientView = ({ queueId: _queueId, ...rest }: StoredRecipient): MailTestRecipient => rest;
const runView = (run: StoredRun): MailTestRun => ({ ...run, recipients: run.recipients.map(recipientView) });
// Runs of whitespace (line breaks in server answers). Matches "\r\n  " in "a\r\n  b"; leaves "ab" alone.
// https://regex101.com/?flavor=javascript&regex=%5Cs%2B&flags=g&testString=a%0D%0A%20%20b
const WHITESPACE = /\s+/g;
const short = (text: string): string => text.replace(WHITESPACE, ' ').trim().slice(0, DETAIL_MAX);

const STATE_FROM_QUEUE: Readonly<Record<StalwartQueuedRecipient['status'], StoredRecipient['state']>> = {
  Scheduled: 'queued',
  Completed: 'delivered',
  TemporaryFailure: 'retrying',
  PermanentFailure: 'rejected',
};

/** mail-tester's JSON is loose; take the score and the rules that cost points, whatever fits. */
function readSpamResult(raw: unknown): { score: number; problems: string[] } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const direct = typeof data['mark'] === 'number' ? data['mark'] : null;
  const shown = typeof data['displayedMark'] === 'string' ? SCORE_TEXT.exec(data['displayedMark']) : null;
  const score = direct ?? (shown?.[1] ? Number(shown[1].replace(',', '.')) : null);
  if (score === null || Number.isNaN(score)) return null;
  const spam = data['spamAssassin'];
  const rules =
    typeof spam === 'object' && spam !== null && Array.isArray((spam as Record<string, unknown>)['rules'])
      ? ((spam as Record<string, unknown>)['rules'] as unknown[])
      : [];
  const problems = rules.flatMap((rule) => {
    if (typeof rule !== 'object' || rule === null) return [];
    const r = rule as Record<string, unknown>;
    const cost = typeof r['score'] === 'number' ? r['score'] : Number(r['score']);
    const text = typeof r['description'] === 'string' ? r['description'] : String(r['code'] ?? '');
    return cost > 0 && text ? [`${text} (−${cost})`] : [];
  });
  return { score, problems };
}

export function createMailTests(
  ctx: AppContext,
  mail: MailService,
  stalwart: () => StalwartClient | null,
): MailTests {
  const stored = (): StoredRun[] => ctx.settings.getValue<StoredRun[]>(SETTINGS_KEY) ?? [];
  const save = (runs: readonly StoredRun[]): void =>
    ctx.settings.setValue(SETTINGS_KEY, runs.slice(0, KEEP_RUNS));

  /** Where one recipient's mail is now, from Stalwart's queue and (if available) its log. */
  const followRecipient = async (
    run: StoredRun,
    recipient: StoredRecipient,
    client: StalwartClient,
    queue: Awaited<ReturnType<StalwartClient['queue']>>,
  ): Promise<StoredRecipient> => {
    if (MAIL_TEST_FINAL.includes(recipient.state)) return recipient;
    const since = Date.parse(run.at) - CLOCK_SLACK_MS;
    const inQueue = queue
      .filter((m) => Date.parse(m.createdAt) >= since)
      .flatMap((m) => m.recipients)
      .find((r) => r.address === recipient.to.toLowerCase());
    if (inQueue)
      return {
        ...recipient,
        state: STATE_FROM_QUEUE[inQueue.status],
        remoteHost: inQueue.remoteHost,
        detail: short(inQueue.message),
        nextRetry: inQueue.status === 'TemporaryFailure' ? inQueue.retryDue : null,
      };
    const lines = recipient.queueId ? await client.logs(recipient.queueId) : [];
    const end = lines.filter((l) => LOG_DONE.test(l.event)).at(-1);
    if (end)
      return {
        ...recipient,
        state: end.event.includes('delivered') ? 'delivered' : 'rejected',
        detail: short(end.details),
        nextRetry: null,
      };
    const settled = Date.now() - Date.parse(run.at) > QUEUE_GRACE_MS;
    return settled ? { ...recipient, state: 'left', nextRetry: null } : recipient;
  };

  const followSpam = async (spam: MailTestSpam, at: string): Promise<MailTestSpam> => {
    if (spam.state !== 'waiting') return spam;
    try {
      const response = await fetchResponse(`${spam.url}&format=json`, {
        headers: { accept: 'application/json' },
      });
      const result = readSpamResult(await response.json().catch(() => null));
      if (result) return { ...spam, state: 'done', score: result.score, problems: result.problems };
    } catch (err) {
      ctx.log.debug({ err }, 'mail-tester not answering yet');
    }
    return Date.now() - Date.parse(at) > SPAM_WAIT_MS ? { ...spam, state: 'open' } : spam;
  };

  const follow = async (run: StoredRun, client: StalwartClient | null): Promise<StoredRun> => {
    if (Date.now() - Date.parse(run.at) > FOLLOW_FOR_MS) return run;
    const queue = client ? await client.queue().catch(() => []) : [];
    const recipients = client
      ? await Promise.all(run.recipients.map((r) => followRecipient(run, r, client, queue)))
      : run.recipients;
    const spam = run.spam ? await followSpam(run.spam, run.at) : null;
    return { ...run, recipients, spam, tracked: client !== null };
  };

  const list: MailTests['list'] = async () => {
    const runs = stored();
    const open = (run: StoredRun): boolean =>
      run.recipients.some((r) => !MAIL_TEST_FINAL.includes(r.state)) || run.spam?.state === 'waiting';
    if (!runs.some(open)) return runs.map(runView);
    const client = stalwart();
    const next = await Promise.all(runs.map((run) => (open(run) ? follow(run, client) : run)));
    save(next);
    return next.map(runView);
  };

  const run: MailTests['run'] = async (rawInput, locale, vars) => {
    const input = mailTestRunSchema.parse(rawInput);
    const spamId = `test-${randomBytes(SPAM_ID_LENGTH).toString('hex').slice(0, SPAM_ID_LENGTH)}`;
    const spamAddress = `${spamId}@${MAIL_TESTER_DOMAIN}`;
    const targets = [
      ...[...new Set(input.recipients)].map((to) => ({ to, spamTest: false })),
      ...(input.spamScore ? [{ to: spamAddress, spamTest: true }] : []),
    ];
    const at = new Date().toISOString();
    const recipients = await Promise.all(
      targets.map(async ({ to, spamTest }): Promise<StoredRecipient> => {
        const base = { to, spamTest, remoteHost: '', nextRetry: null };
        try {
          const accepted = await mail.send(to, 'test', locale, vars);
          return {
            ...base,
            state: 'queued',
            accepted,
            detail: '',
            queueId: QUEUE_ID.exec(accepted)?.[1] ?? null,
          };
        } catch (err) {
          // The mail server's own words ("550 5.1.1 …") rather than just "mail_failed".
          const said = err instanceof AppError ? err.params['message'] : undefined;
          const detail = short(said === undefined ? errorMessage(err) : String(said));
          return { ...base, state: 'failed', accepted: '', detail, queueId: null };
        }
      }),
    );
    const spam: MailTestSpam | null = input.spamScore
      ? {
          address: spamAddress,
          url: `${MAIL_TESTER}/${spamId}`,
          state: 'waiting',
          score: null,
          max: SPAM_MAX,
          problems: [],
        }
      : null;
    const created: StoredRun = {
      id: randomBytes(SPAM_ID_LENGTH).toString('hex'),
      at,
      recipients,
      spam,
      tracked: stalwart() !== null,
    };
    save([created, ...stored()]);
    return runView(created);
  };

  return { list, run };
}
