import { z } from 'zod';

/**
 * Connecting the panel to a Stalwart mail server (free edition, version 1.0 and later). The panel logs in with
 * the Stalwart admin account once, creates the domain and a sender account, sets up its own mail settings with
 * it and — if the domain's DNS is managed by the panel — lets Stalwart publish its records (MX, SPF, DKIM, DMARC …)
 * with the same DNS access.
 */

const URL_MAX = 300;
// Matches "http" and "https" only. https://regex101.com/?flavor=javascript&regex=%5Ehttps%3F%24&testString=http%0Ahttps%0Aftp
const HTTP_OR_HTTPS = /^https?$/;
const CREDENTIAL_MAX = 200;
const NAME_MAX = 64;
const HOST_MAX = 253;
// Local part of the sender address. Matches "noreply", "panel.mails", "no-reply"; rejects "a@b", "two words", "".
// https://regex101.com/?flavor=javascript&regex=%5E%5Ba-z0-9%5D%5Ba-z0-9._-%5D*%24&flags=gm&testString=noreply%0Apanel.mails%0Ano-reply%0Aa%40b%0Atwo%20words
const LOCAL_PART = /^[a-z0-9][a-z0-9._-]*$/;
// Domain name. Matches "mornihosting.de", "mail.example.co.uk"; rejects "localhost", "-bad.de", "a..de".
// https://regex101.com/?flavor=javascript&regex=%5E(%3F%3D.%7B1%2C253%7D%24)(%5Ba-z0-9%5D(%5Ba-z0-9-%5D*%5Ba-z0-9%5D)%3F%5C.)%2B%5Ba-z%5D%7B2%2C%7D%24&flags=gm&testString=mornihosting.de%0Amail.example.co.uk%0Alocalhost%0A-bad.de%0Aa..de
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export const stalwartConnectSchema = z.object({
  /** Where the Stalwart admin page is, e.g. https://mail.mornihosting.de or http://192.168.178.116:8080. */
  url: z.url({ protocol: HTTP_OR_HTTPS }).max(URL_MAX),
  username: z.string().trim().min(1).max(CREDENTIAL_MAX).default('admin'),
  /** Empty keeps the saved password (same address only). */
  password: z.string().max(CREDENTIAL_MAX).default(''),
  /** Mail domain; empty takes the panel's domain. */
  domain: z.string().trim().toLowerCase().max(HOST_MAX).regex(DOMAIN_PATTERN).or(z.literal('')).default(''),
  /** Name of the sender account (before the @). */
  sender: z.string().trim().toLowerCase().max(NAME_MAX).regex(LOCAL_PART).default('noreply'),
  /** Public IPv4 of the mail server, for the A record of its name; empty: taken from the URL if possible. */
  publicIp: z.union([z.ipv4(), z.literal('')]).default(''),
  /** Let Stalwart publish its DNS records with the panel's DNS access (INWX or Cloudflare). */
  publishDns: z.boolean().default(true),
});
export type StalwartConnectInput = z.input<typeof stalwartConnectSchema>;

export const STALWART_CHECKS = ['a', 'ptr', 'mx', 'spf', 'dkim', 'dmarc'] as const;
export type StalwartCheckKey = (typeof STALWART_CHECKS)[number];

export interface StalwartCheck {
  readonly key: StalwartCheckKey;
  /** null: could not be checked (e.g. no IP known for the reverse lookup). */
  readonly ok: boolean | null;
  /** What DNS answers today. */
  readonly found: string;
  /** What it should be. */
  readonly expected: string;
}

/** One DNS record Stalwart wants for the domain (from its zone file). */
export interface StalwartRecord {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export interface StalwartView {
  readonly connected: boolean;
  readonly url: string;
  readonly username: string;
  readonly domain: string;
  /** The mail server's own name (MX target), e.g. mail.mornihosting.de. */
  readonly hostname: string;
  readonly sender: string;
  readonly publicIp: string;
  /** Stalwart publishes its records itself through the panel's DNS provider. */
  readonly dnsAutomatic: boolean;
  /** Which DNS provider the panel could hand over (null: none, records must be set by hand). */
  readonly dnsProvider: string | null;
  readonly records: readonly StalwartRecord[];
  readonly checks: readonly StalwartCheck[];
  readonly checkedAt: string | null;
  /** The panel's own domain, suggested for the mail domain. */
  readonly suggestedDomain: string;
}

/** What the connect button did, step by step. */
export const STALWART_STEPS = ['login', 'domain', 'dns', 'account', 'smtp', 'test'] as const;
export type StalwartStepKey = (typeof STALWART_STEPS)[number];
export interface StalwartStep {
  readonly key: StalwartStepKey;
  readonly state: 'ok' | 'failed' | 'skipped';
  readonly detail: string;
}
export interface StalwartConnectResult {
  readonly ok: boolean;
  readonly steps: readonly StalwartStep[];
  readonly view: StalwartView;
}
