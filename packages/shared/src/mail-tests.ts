import { z } from 'zod';
import { emailSchema } from './api.js';

/**
 * Mail tests in the admin area: send a test mail to several addresses at once, follow each one live (through
 * Stalwart when it is connected) and, if wanted, get a spam score from mail-tester.com.
 */

const MAX_RECIPIENTS = 5;

export const mailTestRunSchema = z
  .object({
    recipients: z.array(emailSchema).max(MAX_RECIPIENTS).default([]),
    /** Also send to a fresh mail-tester.com address and fetch the score. */
    spamScore: z.boolean().default(false),
  })
  .refine((input) => input.recipients.length > 0 || input.spamScore, { message: 'mail_test_empty' });
export type MailTestRunInput = z.input<typeof mailTestRunSchema>;

/**
 * Where a test mail is: handed to the mail server, still on its way (or being retried), delivered,
 * refused by the receiving server, not sent at all, or no longer visible without knowing how it ended.
 */
export const MAIL_TEST_STATES = [
  'sending',
  'queued',
  'retrying',
  'delivered',
  'rejected',
  'failed',
  'left',
] as const;
export type MailTestState = (typeof MAIL_TEST_STATES)[number];

export interface MailTestRecipient {
  readonly to: string;
  readonly state: MailTestState;
  /** The answer of the panel's mail server when the mail was handed over ("250 … queued with id …"). */
  readonly accepted: string;
  /** Server that answered last (e.g. gmail-smtp-in.l.google.com) and what it said or what went wrong. */
  readonly remoteHost: string;
  readonly detail: string;
  readonly nextRetry: string | null;
  /** The mail-tester.com address of this run. */
  readonly spamTest: boolean;
}

export interface MailTestSpam {
  readonly address: string;
  /** The result page on mail-tester.com. */
  readonly url: string;
  readonly state: 'waiting' | 'done' | 'open';
  readonly score: number | null;
  readonly max: number;
  /** Points lost, in mail-tester's own words. */
  readonly problems: readonly string[];
}

export interface MailTestRun {
  readonly id: string;
  readonly at: string;
  readonly recipients: readonly MailTestRecipient[];
  readonly spam: MailTestSpam | null;
  /** Without a Stalwart connection the panel only sees that its mail server took the mail. */
  readonly tracked: boolean;
}

export const MAIL_TEST_FINAL: readonly MailTestState[] = ['delivered', 'rejected', 'failed', 'left'];
