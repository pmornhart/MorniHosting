import type { MailProblem } from '@mornihosting/shared';
import type { MailNetwork } from './check.js';

/**
 * Quick start: from an e-mail address (and, for a mail server at home, its IP) guess which server names to try.
 * Every guess is checked with full certificate verification before the password is sent, so a wrong guess
 * only costs a try.
 */

/** Big mail providers whose outgoing server is not named after the domain. */
const PROVIDERS: Readonly<Record<string, string>> = {
  'gmail.com': 'smtp.gmail.com',
  'googlemail.com': 'smtp.gmail.com',
  'outlook.com': 'smtp-mail.outlook.com',
  'outlook.de': 'smtp-mail.outlook.com',
  'hotmail.com': 'smtp-mail.outlook.com',
  'hotmail.de': 'smtp-mail.outlook.com',
  'live.com': 'smtp-mail.outlook.com',
  'live.de': 'smtp-mail.outlook.com',
  'gmx.de': 'mail.gmx.net',
  'gmx.net': 'mail.gmx.net',
  'web.de': 'smtp.web.de',
  't-online.de': 'securesmtp.t-online.de',
  'icloud.com': 'smtp.mail.me.com',
  'posteo.de': 'posteo.de',
  'mailbox.org': 'smtp.mailbox.org',
};
const IMPLICIT_TLS_PORT = 465;
const WILDCARD = '*.';
/** Enough for provider, certificate, MX and the two usual names; each one costs two tries. */
const MAX_HOSTS = 5;

/** Which failure says most about what to fix: a refused login means the server itself was found. */
const CLOSENESS: readonly MailProblem[] = [
  'login',
  'sender',
  'recipient',
  'tls',
  'wrong_security',
  'timeout',
  'port_closed',
  'unreachable',
  'other',
];
export const closeness = (problem: MailProblem | null): number =>
  problem === null ? -1 : CLOSENESS.indexOf(problem);

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

const belongsTo = (name: string, domain: string): boolean => name === domain || name.endsWith(`.${domain}`);

/**
 * Server names to try, most likely first. Names from the certificate at the home IP only count when they belong
 * to the address's domain or are one of its MX servers: a stranger's certificate never gets the password.
 */
export async function candidateHosts(
  email: string,
  internalHost: string,
  network: MailNetwork,
): Promise<readonly string[]> {
  const domain = domainOf(email);
  const mx = (await network.mx?.(domain).catch(() => [])) ?? [];
  const certNames = internalHost
    ? ((await network.certificateNames?.(internalHost, IMPLICIT_TLS_PORT).catch(() => [])) ?? [])
    : [];
  const fromCert = certNames
    .map((name) => (name.startsWith(WILDCARD) ? `mail.${name.slice(WILDCARD.length)}` : name))
    .filter((name) => belongsTo(name, domain) || mx.includes(name))
    .toSorted((a, b) => Number(b === `mail.${domain}`) - Number(a === `mail.${domain}`));
  const guesses = [PROVIDERS[domain], ...fromCert, ...mx, `mail.${domain}`, `smtp.${domain}`];
  return [...new Set(guesses.filter((host): host is string => Boolean(host)))].slice(0, MAX_HOSTS);
}
