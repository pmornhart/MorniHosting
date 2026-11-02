import { z } from 'zod';
import { emailSchema, passwordSchema, usernameSchema } from './api.js';

/** Mail settings, sign-up, "password forgotten" and address confirmation. */

export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

const HOST_MAX = 253;
const PORT_MAX = 65535;
const CREDENTIAL_MAX = 200;
const FROM_MAX = 200;
const TOKEN_MAX = 200;
const LOCALES = ['de', 'en'] as const;
// Sender: a bare address or "Name <address>". Matches "noreply@mornihosting.de", "MorniHosting <noreply@mornihosting.de>";
// rejects line breaks (header injection) and "no at sign".
// https://regex101.com/?flavor=javascript&regex=%5E%28%5B%5E%3C%3E%22%5Cr%5Cn%5D%2B%20%3C%5B%5E%20%40%3C%3E%22%5Cr%5Cn%5D%2B%40%5B%5E%20%40%3C%3E%22%5Cr%5Cn%5D%2B%3E%7C%5B%5E%20%40%3C%3E%22%5Cr%5Cn%5D%2B%40%5B%5E%20%40%3C%3E%22%5Cr%5Cn%5D%2B%29%24&flags=gm&testString=noreply%40mornihosting.de%0AMorniHosting%20%3Cnoreply%40mornihosting.de%3E%0Ano%20at%20sign%0Aa%40b.de%0D%0ABcc%3A%20x%40y.de
const SENDER_PATTERN = /^([^<>"\r\n]+ <[^ @<>"\r\n]+@[^ @<>"\r\n]+>|[^ @<>"\r\n]+@[^ @<>"\r\n]+)$/;

export const mailSettingsSchema = z.object({
  host: z.string().trim().min(1).max(HOST_MAX),
  /**
   * Optional address the panel really connects to (e.g. 192.168.178.116 for a mail server in the home network).
   * The certificate is still checked against `host`, so TLS stays fully verified.
   */
  internalHost: z.string().trim().max(HOST_MAX).default(''),
  port: z.number().int().min(1).max(PORT_MAX),
  security: z.enum(MAIL_SECURITY),
  user: z.string().trim().max(CREDENTIAL_MAX),
  /** Empty or missing keeps the saved password. */
  password: z.string().max(CREDENTIAL_MAX).optional(),
  from: z.string().trim().max(FROM_MAX).regex(SENDER_PATTERN),
  registration: z.boolean().default(false),
  /** Self-registered people may order servers right away (otherwise an admin must allow it). */
  registrationOrders: z.boolean().default(false),
  crashMails: z.boolean().default(false),
});
export type MailSettingsInput = z.infer<typeof mailSettingsSchema>;

export interface MailSettingsView extends Omit<MailSettingsInput, 'password'> {
  readonly configured: boolean;
  /** The password is never sent back; this only says that one is saved. */
  readonly passwordSet: boolean;
  /** Links in mails need the panel's domain from the admin area. */
  readonly linksPossible: boolean;
}

export const mailTestSchema = z.object({ to: emailSchema.optional() });

/** The test mail runs these steps in order and reports each one. */
export const MAIL_STEPS = ['dns', 'connect', 'tls', 'login', 'send'] as const;
export type MailStep = (typeof MAIL_STEPS)[number];
export type MailStepState = 'ok' | 'failed' | 'skipped';
/** What went wrong, each with its own explanation and tip in the panel. */
export const MAIL_PROBLEMS = [
  'unreachable',
  'port_closed',
  'timeout',
  'wrong_security',
  'tls',
  'login',
  'sender',
  'recipient',
  'other',
] as const;
export type MailProblem = (typeof MAIL_PROBLEMS)[number];

export interface MailStepResult {
  readonly step: MailStep;
  readonly state: MailStepState;
  /** Short facts such as the address used; never a password. */
  readonly detail?: string;
}

export interface MailEndpoint {
  readonly port: number;
  readonly security: MailSecurity;
}

export interface MailAttempt extends MailEndpoint {
  readonly problem: MailProblem | null;
}

export interface MailTestResult {
  readonly ok: boolean;
  readonly sentTo: string;
  /** Steps of the last attempt (the one that worked, or the saved settings when none did). */
  readonly steps: readonly MailStepResult[];
  readonly problem: MailProblem | null;
  /** The mail server's own words, shortened; empty when there are none. */
  readonly message: string;
  /** Every port/encryption tried, the saved one first. */
  readonly attempts: readonly MailAttempt[];
  /** Set when another port/encryption worked; it was saved in place of the old one. */
  readonly switchedTo: MailEndpoint | null;
}

/** Quick start: address, password and (for a mail server at home) its IP; the panel finds the rest. */
export const mailQuickSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(CREDENTIAL_MAX),
  internalHost: z.string().trim().max(HOST_MAX).default(''),
});
export type MailQuickInput = z.infer<typeof mailQuickSchema>;

export interface MailQuickTry extends MailEndpoint {
  readonly host: string;
  readonly problem: MailProblem | null;
}

export interface MailQuickResult {
  /** The mail server that accepted the login; it is saved. Null when none did. */
  readonly found: (MailEndpoint & { readonly host: string }) | null;
  readonly tried: readonly MailQuickTry[];
  /** The test mail sent with what was found. */
  readonly test: MailTestResult | null;
  /** When nothing worked: the attempt that came furthest, step by step. */
  readonly closest:
    (MailQuickTry & { readonly steps: readonly MailStepResult[]; readonly message: string }) | null;
}

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  locale: z.enum(LOCALES).default('de'),
});
export const forgotSchema = z.object({ email: emailSchema });
export const resetSchema = z.object({ token: z.string().min(1).max(TOKEN_MAX), password: passwordSchema });
export const confirmSchema = z.object({ token: z.string().min(1).max(TOKEN_MAX) });
export type ConfirmKind = 'register' | 'email_change';
export interface ConfirmResult {
  readonly kind: ConfirmKind;
}
export const emailChangeSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(CREDENTIAL_MAX),
});
