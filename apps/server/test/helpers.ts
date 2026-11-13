import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type BuildOptions, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createFakeDriver, FAKE_STEP_MS_FAST } from '../src/docker/fake-driver.js';

export interface TestApp extends BuiltApp {
  readonly dataDir: string;
  readonly cleanup: () => Promise<void>;
}

const TEST_SECRET = 'test-secret-test-secret-test-secret-123';

/** A panel with a fresh data folder and the fake Docker driver, for HTTP-level tests. */
export async function createTestApp(
  env: Record<string, string> = {},
  options: Pick<
    BuildOptions,
    'resolver' | 'mailTransport' | 'mailNetwork' | 'discord' | 'stalwart' | 'stalwartResolver' | 'docker'
  > = {},
): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
  const config = loadConfig(
    {
      MH_SECRET: TEST_SECRET,
      MH_DATA_DIR: dataDir,
      MH_DOCKER_DRIVER: 'fake',
      // The address router changes NetBird ports; tests that want it switch it on.
      MH_ROUTER_JAVA_PORT: '0',
      MH_ROUTER_BEDROCK_PORT: '0',
      ...env,
    },
    '0.0.0-test',
  );
  const built = await buildApp({
    config,
    logger: process.env['MH_TEST_LOG'] === '1',
    docker: createFakeDriver({ stepMs: FAKE_STEP_MS_FAST, simulatePlayers: false }),
    ...options,
  });
  await built.start();
  await built.app.ready();
  return {
    ...built,
    dataDir,
    cleanup: async () => {
      await built.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (first ?? '').split(';')[0] ?? '';
}

export async function setupAdmin(
  app: TestApp,
  username = 'philip',
  password = 'supersecret123',
): Promise<Session> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username, password, locale: 'de' },
  });
  const body = res.json<{ csrfToken: string }>();
  return { cookie: cookieFrom(res.headers['set-cookie']), csrf: body.csrfToken };
}

export async function login(app: TestApp, username: string, password: string): Promise<Session> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const body = res.json<{ me: { csrfToken: string } }>();
  return { cookie: cookieFrom(res.headers['set-cookie']), csrf: body.me.csrfToken };
}

export function authHeaders(session: Session): Record<string, string> {
  return { cookie: session.cookie, 'x-csrf-token': session.csrf };
}

const POLL_MS = 20;
const DEFAULT_WAIT_MS = 5000;

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    await poll();
  };
  await poll();
}

export interface UploadPart {
  readonly name: string;
  readonly data: Buffer | string;
  readonly type?: string;
}

/** A multipart/form-data body with one or more files (field name "file"). */
export function multipartBody(parts: readonly UploadPart[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----mhtest${Date.now()}`;
  const chunks = parts.flatMap((part) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${part.name}"\r\nContent-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
    ),
    Buffer.from(part.data),
    Buffer.from('\r\n'),
  ]);
  return {
    payload: Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
