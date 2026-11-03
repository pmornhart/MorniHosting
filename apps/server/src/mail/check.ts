import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import type { MailProblem, MailSecurity, MailStep, MailStepResult } from '@mornihosting/shared';
import { errorMessage } from '../lib/errors.js';
import { MS_PER_SECOND } from '../lib/units.js';

/**
 * Step-by-step SMTP check for the "send test mail" button: DNS → connection → TLS → login → sending.
 * Each failure is sorted into a problem the panel can explain in plain words.
 */

/** Short enough that a wrong port does not keep the admin waiting, long enough for a slow home server. */
const CONNECT_TIMEOUT_SECONDS = 10;
export const SMTP_CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_SECONDS * MS_PER_SECOND;
const SERVER_TEXT_MAX = 200;

export interface CheckConfig {
  readonly host: string;
  readonly internalHost: string;
  readonly port: number;
  readonly security: MailSecurity;
  readonly user: string;
}

/** The network calls around SMTP itself; tests replace them. */
export interface MailNetwork {
  readonly lookup: (host: string) => Promise<string>;
  readonly connect: (address: string, port: number, timeoutMs: number) => Promise<void>;
  /** Mail servers of a domain (MX), best first; empty when there are none. */
  readonly mx?: (domain: string) => Promise<readonly string[]>;
  /** Names in the certificate a TLS port presents. Only used to guess the name; it is verified again later. */
  readonly certificateNames?: (address: string, port: number) => Promise<readonly string[]>;
}

/** What the check needs from nodemailer: log in without sending, and send. */
export interface CheckTransport {
  readonly verify: () => Promise<unknown>;
  readonly send: () => Promise<unknown>;
}

export interface CheckOutcome {
  readonly steps: readonly MailStepResult[];
  readonly problem: MailProblem | null;
  /** The server's own words (or the system error), one line, without credentials. */
  readonly message: string;
}

const failure = (code: string): Error => Object.assign(new Error(code), { code });

const withTimeout = async <T>(work: Promise<T>, ms: number, code: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure(code)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const DNS_NAME_PREFIX = 'DNS:';

export const realNetwork: MailNetwork = {
  lookup: async (host) =>
    (await withTimeout(dnsPromises.lookup(host), SMTP_CONNECT_TIMEOUT_MS, 'EAI_AGAIN')).address,
  mx: async (domain) =>
    (await withTimeout(dnsPromises.resolveMx(domain), SMTP_CONNECT_TIMEOUT_MS, 'EAI_AGAIN'))
      .toSorted((a, b) => a.priority - b.priority)
      .map((record) => record.exchange.toLowerCase()),
  certificateNames: (address, port) =>
    new Promise((resolve, reject) => {
      // Reading only: nothing is sent over this connection, and the name is checked properly before logging in.
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      const socket = tls.connect({
        host: address,
        port,
        rejectUnauthorized: false,
        timeout: SMTP_CONNECT_TIMEOUT_MS,
      });
      socket.once('secureConnect', () => {
        const names = (socket.getPeerCertificate().subjectaltname ?? '')
          .split(', ')
          .filter((entry) => entry.startsWith(DNS_NAME_PREFIX))
          .map((entry) => entry.slice(DNS_NAME_PREFIX.length).toLowerCase());
        socket.destroy();
        resolve(names);
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(failure('ETIMEDOUT'));
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    }),
  connect: (address, port, timeoutMs) =>
    new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: address, port });
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(failure('ETIMEDOUT'));
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    }),
};

/** System and TLS error codes (Node, OpenSSL) → problem. */
const CODE_PROBLEMS: Readonly<Record<string, MailProblem>> = {
  ENOTFOUND: 'unreachable',
  EAI_AGAIN: 'unreachable',
  EAI_NONAME: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  EHOSTDOWN: 'unreachable',
  EDNS: 'unreachable',
  ECONNREFUSED: 'port_closed',
  ECONNRESET: 'port_closed',
  ETIMEDOUT: 'timeout',
  SOCKET_TIMEOUT: 'timeout',
  ERR_SSL_WRONG_VERSION_NUMBER: 'wrong_security',
  ERR_SSL_PACKET_LENGTH_TOO_LONG: 'wrong_security',
  ERR_SSL_HTTP_REQUEST: 'wrong_security',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls',
  CERT_HAS_EXPIRED: 'tls',
  CERT_NOT_YET_VALID: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
  ETLS: 'tls',
  EAUTH: 'login',
};
/** Envelope refusals by the SMTP command they answered. */
const COMMAND_PROBLEMS: Readonly<Record<string, MailProblem>> = {
  'MAIL FROM': 'sender',
  'RCPT TO': 'recipient',
};
/** OpenSSL words for "this port speaks the other kind of encryption". */
const WRONG_SECURITY_HINTS = ['wrong version number', 'packet length too long', 'unknown protocol'];
/** SMTP replies meaning "log in first" (530), "this login method is refused" (534), "wrong user or password" (535). */
const SMTP_AUTH_REQUIRED = 530;
const SMTP_AUTH_MECHANISM_REFUSED = 534;
const SMTP_AUTH_WRONG = 535;
const SMTP_AUTH_FAILED = new Set([SMTP_AUTH_REQUIRED, SMTP_AUTH_MECHANISM_REFUSED, SMTP_AUTH_WRONG]);

interface SmtpError {
  readonly code?: string;
  readonly originalCode?: string;
  readonly command?: string;
  readonly responseCode?: number;
}

/** Sorts an error from Node, OpenSSL or nodemailer into one of the problems the panel explains. */
export function classifyMailError(err: unknown): MailProblem {
  const e: SmtpError = typeof err === 'object' && err !== null ? err : {};
  const text = errorMessage(err).toLowerCase();
  if (WRONG_SECURITY_HINTS.some((hint) => text.includes(hint))) return 'wrong_security';
  const fromCommand = e.code === 'EENVELOPE' && e.command ? COMMAND_PROBLEMS[e.command] : undefined;
  if (fromCommand) return fromCommand;
  if (e.responseCode && SMTP_AUTH_FAILED.has(e.responseCode)) return 'login';
  const fromOriginal = e.originalCode ? CODE_PROBLEMS[e.originalCode] : undefined;
  return fromOriginal ?? (e.code ? CODE_PROBLEMS[e.code] : undefined) ?? 'other';
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, SERVER_TEXT_MAX); // eslint-disable-line ts-patterns/require-regex-example -- whitespace runs: "535 5.7.8\r\n  bad" → "535 5.7.8 bad"

/** Runs the steps in order; with `send` the last step sends the mail, without it the check ends after logging in. */
export async function runMailCheck(
  config: CheckConfig,
  network: MailNetwork,
  transport: CheckTransport,
  withSend: boolean,
): Promise<CheckOutcome> {
  const steps: MailStepResult[] = [];
  const mark = (step: MailStep, state: MailStepResult['state'], detail?: string): void => {
    steps.push(detail ? { step, state, detail } : { step, state });
  };
  const skipRest = (from: MailStep): void => {
    const order: readonly MailStep[] = ['dns', 'connect', 'tls', 'login', 'send'];
    order.slice(order.indexOf(from)).forEach((step) => mark(step, 'skipped'));
  };
  const fail = (step: MailStep, err: unknown, problem = classifyMailError(err)): CheckOutcome => {
    mark(step, 'failed');
    const next: Readonly<Record<MailStep, MailStep | null>> = {
      dns: 'connect',
      connect: 'tls',
      tls: 'login',
      login: 'send',
      send: null,
    };
    const rest = next[step];
    if (rest) skipRest(rest);
    return { steps, problem, message: oneLine(errorMessage(err)) };
  };

  const target = config.internalHost || config.host;
  let address = target;
  if (net.isIP(target)) {
    mark('dns', 'ok', target);
  } else {
    try {
      address = await network.lookup(target);
      mark('dns', 'ok', `${target} → ${address}`);
    } catch (err) {
      return fail('dns', err, 'unreachable');
    }
  }

  try {
    await network.connect(address, config.port, SMTP_CONNECT_TIMEOUT_MS);
    mark('connect', 'ok', `${address}:${config.port}`);
  } catch (err) {
    return fail('connect', err);
  }

  try {
    await transport.verify();
    if (config.security === 'none') mark('tls', 'skipped');
    else mark('tls', 'ok', config.host);
    if (config.user) mark('login', 'ok', config.user);
    else mark('login', 'skipped');
  } catch (err) {
    const problem = classifyMailError(err);
    if (problem === 'login') {
      if (config.security === 'none') mark('tls', 'skipped');
      else mark('tls', 'ok', config.host);
      return fail('login', err, problem);
    }
    // The port answered, but nothing came back in time: it speaks the other kind of encryption.
    const sorted = problem === 'timeout' && config.security !== 'none' ? 'wrong_security' : problem;
    return fail('tls', err, sorted);
  }

  if (!withSend) {
    mark('send', 'skipped');
    return { steps, problem: null, message: '' };
  }
  try {
    await transport.send();
    mark('send', 'ok');
    return { steps, problem: null, message: '' };
  } catch (err) {
    return fail('send', err);
  }
}
