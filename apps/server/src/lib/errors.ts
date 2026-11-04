import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
} from './http-status.js';

/**
 * An error the API reports to the client. `code` is a stable key the web app
 * translates (errors.<code>); `params` fill placeholders in that text.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Readonly<Record<string, string | number>> = {},
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export const badRequest = (code: string, params?: Record<string, string | number>): AppError =>
  new AppError(HTTP_BAD_REQUEST, code, params);
export const unauthorized = (code = 'unauthorized'): AppError => new AppError(HTTP_UNAUTHORIZED, code);
export const forbidden = (code = 'forbidden'): AppError => new AppError(HTTP_FORBIDDEN, code);
export const notFound = (code = 'not_found'): AppError => new AppError(HTTP_NOT_FOUND, code);
export const conflict = (code: string, params?: Record<string, string | number>): AppError =>
  new AppError(HTTP_CONFLICT, code, params);

/** Why a connection failed, in words: Node's fetch only says "fetch failed" and hides the reason in `cause`. */
const NETWORK_CAUSES: Readonly<Record<string, (host: string) => string>> = {
  ENOTFOUND: (host) => `Die Adresse ${host} wurde nicht gefunden (DNS des Rechners prüfen)`,
  EAI_AGAIN: (host) => `Die Adresse ${host} konnte gerade nicht aufgelöst werden (DNS des Rechners prüfen)`,
  ECONNREFUSED: (host) => `${host} hat die Verbindung abgelehnt`,
  ECONNRESET: (host) => `Die Verbindung zu ${host} wurde unterbrochen`,
  ETIMEDOUT: (host) => `${host} hat nicht rechtzeitig geantwortet (Internet oder Firewall prüfen)`,
  UND_ERR_CONNECT_TIMEOUT: (host) =>
    `${host} hat nicht rechtzeitig geantwortet (Internet oder Firewall prüfen)`,
  ENETUNREACH: () => 'Der Rechner hat gerade kein Internet',
  EHOSTUNREACH: (host) => `${host} ist von diesem Rechner aus nicht erreichbar`,
};

interface NetworkCause {
  readonly code?: string;
  readonly hostname?: string;
  readonly message?: string;
}

function networkReason(err: Error): string | null {
  const cause = err.cause as NetworkCause | undefined;
  if (!cause || typeof cause !== 'object') return null;
  const explain = cause.code ? NETWORK_CAUSES[cause.code] : undefined;
  if (explain) return explain(cause.hostname ?? 'Der Dienst');
  return cause.message ?? cause.code ?? null;
}

/**
 * Low-level network errors that mean "this computer has no working internet right now", with what to check.
 * WireGuard (NetBird) answers "required key not available" when traffic goes to a peer that is not connected –
 * typically an exit node that is selected but offline.
 */
const OFFLINE_HINTS: readonly (readonly [RegExp, string])[] = [
  // "write udp 10.99.1.2:6018->9.9.9.9:53: write: required key not available" → NetBird exit node down.
  // https://regex101.com/?flavor=javascript&regex=required%20key%20not%20available&testString=write%3A%20required%20key%20not%20available
  [
    /required key not available/,
    'Der Rechner kommt gerade nicht ins Internet: der Verkehr geht über NetBird, aber der Ausgang (Exit-Node) ist nicht verbunden. Ausgang abwählen (netbird networks deselect) oder den Ausgangs-Rechner wieder verbinden.',
  ],
  // "dial tcp: lookup registry-1.docker.io on 9.9.9.9:53: i/o timeout" → DNS unreachable.
  // https://regex101.com/?flavor=javascript&regex=lookup%20%5CS%2B%20on%20%5CS%2B%3A53&testString=dial%20tcp%3A%20lookup%20registry-1.docker.io%20on%209.9.9.9%3A53%3A%20i%2Fo%20timeout
  [/lookup \S+ on \S+:53/, 'Der Rechner kann gerade keine Adressen auflösen (DNS prüfen).'],
];

function withOfflineHint(message: string): string {
  const hint = OFFLINE_HINTS.find(([pattern]) => pattern.test(message))?.[1];
  return hint ? `${hint} (${message})` : message;
}

export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return withOfflineHint(String(err));
  if (err.message !== 'fetch failed') return withOfflineHint(err.message);
  const reason = networkReason(err);
  return reason ? `Keine Verbindung: ${reason}` : err.message;
}
