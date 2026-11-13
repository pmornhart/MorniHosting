import type { ApiErrorBody } from '@mornihosting/shared';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Readonly<Record<string, string | number>> = {},
  ) {
    super(code);
  }
}

const HTTP_NO_CONTENT = 204;
const HTTP_SUCCESS_FROM = 200;
const HTTP_SUCCESS_UNTIL = 300;
const HTTP_UNAUTHORIZED = 401;
const UNSAFE: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

const session = { csrf: '' };
const unauthorizedListeners = new Set<() => void>();

export function setCsrfToken(token: string): void {
  session.csrf = token;
}

export function csrfToken(): string {
  return session.csrf;
}

/** Called when the server says the session is gone, so the app can show the login page. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export interface RequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Extra headers (the team dashboard sends its key this way). */
  readonly headers?: Readonly<Record<string, string>>;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string'
  );
}

export async function toApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null); // eslint-disable-line ts-patterns/prefer-await-to-then -- a body that is not JSON is the same as no body
  if (response.status === HTTP_UNAUTHORIZED) unauthorizedListeners.forEach((l) => l());
  return isErrorBody(body)
    ? new ApiError(response.status, body.error, body.params ?? {})
    : new ApiError(response.status, 'http_' + response.status);
}

export async function api<TResult>(path: string, options: RequestOptions = {}): Promise<TResult> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (UNSAFE.includes(method)) headers['x-csrf-token'] = session.csrf;
  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    signal: options.signal,
  });
  if (!response.ok) throw await toApiError(response);
  if (response.status === HTTP_NO_CONTENT) return undefined as TResult;
  const type = response.headers.get('content-type') ?? '';
  // The API answers JSON for everything except downloads, which callers fetch as Blob themselves.
  return (type.includes('application/json') ? await response.json() : await response.text()) as TResult;
}

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
}

/** Uploads files with progress (fetch cannot report upload progress). */
export async function upload<TResult>(
  path: string,
  form: FormData,
  onProgress?: (progress: UploadProgress) => void,
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('x-csrf-token', session.csrf);
    xhr.upload.addEventListener('progress', (e) => onProgress?.({ loaded: e.loaded, total: e.total }));
    xhr.addEventListener('load', () => {
      const body: unknown = (() => {
        try {
          return JSON.parse(xhr.responseText) as unknown;
        } catch {
          return null;
        }
      })();
      if (xhr.status >= HTTP_SUCCESS_FROM && xhr.status < HTTP_SUCCESS_UNTIL) resolve(body as TResult);
      else
        reject(
          isErrorBody(body)
            ? new ApiError(xhr.status, body.error, body.params ?? {})
            : new ApiError(xhr.status, 'upload_failed'),
        );
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, 'network')));
    xhr.send(form);
  });
}
