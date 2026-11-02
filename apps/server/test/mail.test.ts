/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  MailSettingsView,
  MailStatus,
  MailTestResult,
  ServerSummary,
  UserInfo,
} from '@mornihosting/shared';
import { mailTokens } from '../src/db/schema.js';
import type { OutgoingMail, SmtpConfig } from '../src/mail/service.js';
import {
  authHeaders,
  createTestApp,
  login,
  setupAdmin,
  waitFor,
  type Session,
  type TestApp,
} from './helpers.js';

const SMTP = {
  host: 'smtp.example.test',
  port: 587,
  security: 'starttls',
  user: 'noreply@mornihosting.de',
  password: 'smtp-secret-pw',
  from: 'MorniHosting <noreply@mornihosting.de>',
  registration: true,
  registrationOrders: true,
  registrationApproval: false,
  crashMails: false,
};

describe('mail: settings, sign-up, password forgotten, orders', () => {
  let t: TestApp;
  let admin: Session;
  let sent: OutgoingMail[];
  let configs: SmtpConfig[];
  let failNext = false;
  let verifyError: unknown = null;
  /** Ports that get no answer, like 587 on a Stalwart that only listens on 465. */
  let silentPorts: number[] = [];
  let dialled: string[] = [];

  const post = (url: string, payload: object, session?: Session) =>
    t.app.inject({ method: 'POST', url, payload, ...(session ? { headers: authHeaders(session) } : {}) });
  const asAdmin = (method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: authHeaders(admin), ...(payload ? { payload } : {}) });
  const tokenIn = (mail: OutgoingMail): string => {
    const found = /token=([A-Za-z0-9_-]+)/.exec(mail.text);
    if (!found?.[1]) throw new Error('no link in mail');
    return found[1];
  };
  const lastMail = (): OutgoingMail => {
    const mail = sent.at(-1);
    if (!mail) throw new Error('no mail was sent');
    return mail;
  };
  const status = async (): Promise<MailStatus> =>
    (await t.app.inject({ method: 'GET', url: '/api/system/status' })).json<{ mail: MailStatus }>().mail;

  beforeEach(async () => {
    sent = [];
    configs = [];
    failNext = false;
    verifyError = null;
    silentPorts = [];
    dialled = [];
    t = await createTestApp(
      {},
      {
        mailNetwork: {
          lookup: async (host) =>
            host.endsWith('.test') ? '203.0.113.7' : Promise.reject(new Error('ENOTFOUND')),
          connect: async (address, port) => {
            dialled.push(`${address}:${port}`);
            if (silentPorts.includes(port)) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
          },
        },
        mailTransport: (config) => {
          configs.push(config);
          return {
            verify: async () => {
              if (verifyError) throw verifyError;
              return true;
            },
            sendMail: async (mail) => {
              if (failNext) throw new Error('535 login failed\r\nBcc: evil@example.test');
              sent.push(mail);
              return {};
            },
          };
        },
      },
    );
    admin = await setupAdmin(t);
  });
  afterEach(async () => t.cleanup());

  const configure = async (overrides: object = {}) => {
    await asAdmin('PUT', '/api/settings', { panelDomain: 'mornihosting.de' });
    return asAdmin('PUT', '/api/mail', { ...SMTP, ...overrides });
  };

  test('without SMTP: asking for an account still works and waits for the admin; no password reset', async () => {
    expect(await status()).toEqual({ registration: true, passwordReset: false });
    const res = await post('/api/auth/register', {
      username: 'lena',
      email: 'l@x.de',
      password: 'longenough1',
    });
    expect(res.json()).toEqual({ next: 'wait_approval' });
    expect(sent).toHaveLength(0);
    expect(
      (await post('/api/auth/login', { username: 'lena', password: 'longenough1' })).json(),
    ).toMatchObject({
      error: 'account_pending_approval',
    });
    const pending = (await asAdmin('GET', '/api/approvals')).json<{ users: { username: string }[] }>();
    expect(pending.users.map((u) => u.username)).toEqual(['lena']);
    // The admin can close the door again.
    await asAdmin('PUT', '/api/signup', { enabled: false });
    expect((await status()).registration).toBe(false);
    expect(
      (await post('/api/auth/register', { username: 'tom', email: 't@x.de', password: 'longenough1' }))
        .statusCode,
    ).toBe(403);
    expect((await post('/api/auth/forgot', { email: 'l@x.de' })).statusCode).toBe(403);
    expect((await asAdmin('GET', '/api/mail')).json<{ configured: boolean }>().configured).toBe(false);
  });

  test('settings: the password is saved encrypted and never sent back', async () => {
    const res = await configure();
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('smtp-secret-pw');
    expect(res.json<{ passwordSet: boolean }>().passwordSet).toBe(true);
    const stored = t.ctx.settings.getValue<{ passwordSealed: string }>('mail');
    expect(stored?.passwordSealed).not.toContain('smtp-secret-pw');
    // Saving again without a password keeps the old one.
    await asAdmin('PUT', '/api/mail', { ...SMTP, password: undefined, host: 'smtp2.example.test' });
    await asAdmin('POST', '/api/mail/test', { to: 'me@example.test' });
    expect(configs.at(-1)).toMatchObject({ host: 'smtp2.example.test', password: 'smtp-secret-pw' });
    expect((await t.app.inject({ method: 'GET', url: '/api/mail' })).statusCode).toBe(401);
  });

  test('settings: sender with a line break is refused (header injection)', async () => {
    const res = await configure({ from: 'a@b.de\r\nBcc: evil@example.test' });
    expect(res.statusCode).toBe(400);
  });

  test('test mail: arrives as HTML and text; a failure is reported without the extra header line', async () => {
    await configure();
    const ok = await asAdmin('POST', '/api/mail/test', { to: 'me@example.test' });
    expect(ok.json()).toMatchObject({ ok: true, sentTo: 'me@example.test', problem: null, switchedTo: null });
    expect(ok.json<MailTestResult>().steps.map((s) => `${s.step}:${s.state}`)).toEqual([
      'dns:ok',
      'connect:ok',
      'tls:ok',
      'login:ok',
      'send:ok',
    ]);
    expect(lastMail()).toMatchObject({ to: 'me@example.test', from: SMTP.from });
    expect(lastMail().html).toContain('#10b981');
    expect(lastMail().html).not.toMatch(/<img|https?:\/\/(?!mornihosting)/);
    failNext = true;
    const bad = await asAdmin('POST', '/api/mail/test', { to: 'me@example.test' });
    expect(bad.json()).toMatchObject({ ok: false, problem: 'other' });
    expect(bad.json<MailTestResult>().steps.at(-1)).toEqual({ step: 'send', state: 'failed' });
    expect(JSON.stringify(bad.json())).not.toMatch(/[\r\n]/);
  });

  test('test mail: 587 gets no answer → 465 with TLS is found, saved and used', async () => {
    await configure();
    silentPorts = [587];
    const res = (await asAdmin('POST', '/api/mail/test', { to: 'me@example.test' })).json<MailTestResult>();
    expect(res).toMatchObject({ ok: true, switchedTo: { port: 465, security: 'tls' } });
    expect(res.attempts).toEqual([
      { port: 587, security: 'starttls', problem: 'timeout' },
      { port: 465, security: 'tls', problem: null },
    ]);
    expect(lastMail().to).toBe('me@example.test');
    const view = (await asAdmin('GET', '/api/mail')).json<MailSettingsView>();
    expect(view).toMatchObject({ port: 465, security: 'tls', passwordSet: true, registration: true });
  });

  test('test mail: wrong password is named as such and no other port is tried', async () => {
    await configure();
    verifyError = Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), {
      code: 'EAUTH',
      responseCode: 535,
    });
    const res = (await asAdmin('POST', '/api/mail/test', { to: 'me@example.test' })).json<MailTestResult>();
    expect(res).toMatchObject({ ok: false, problem: 'login', switchedTo: null });
    expect(res.attempts).toHaveLength(1);
    expect(res.steps.map((s) => `${s.step}:${s.state}`)).toEqual([
      'dns:ok',
      'connect:ok',
      'tls:ok',
      'login:failed',
      'send:skipped',
    ]);
    expect(JSON.stringify(res)).not.toContain('smtp-secret-pw');
  });

  test('internal IP: dials the IP, keeps the name for the certificate; old settings without it still load', async () => {
    t.ctx.settings.setValue('mail', { ...SMTP, password: undefined, passwordSealed: '' });
    expect((await asAdmin('GET', '/api/mail')).json<MailSettingsView>().internalHost).toBe('');
    await configure({
      host: 'mail.pmornhart.de',
      internalHost: '192.168.178.116',
      port: 465,
      security: 'tls',
    });
    const res = (await asAdmin('POST', '/api/mail/test', { to: 'me@example.test' })).json<MailTestResult>();
    expect(res.ok).toBe(true);
    expect(res.steps[0]).toEqual({ step: 'dns', state: 'ok', detail: '192.168.178.116' });
    expect(res.steps[2]).toEqual({ step: 'tls', state: 'ok', detail: 'mail.pmornhart.de' });
    expect(dialled.at(-1)).toBe('192.168.178.116:465');
    expect(configs.at(-1)).toMatchObject({ host: 'mail.pmornhart.de', internalHost: '192.168.178.116' });
  });

  test('sign-up: mail link is required before the first login, only standard rights', async () => {
    await configure({ registrationOrders: false });
    expect(await status()).toEqual({ registration: true, passwordReset: true });
    const res = await post('/api/auth/register', {
      username: 'lena',
      email: 'Lena@Example.test',
      password: 'longenough1',
      locale: 'en',
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => sent.length === 1);
    expect(lastMail()).toMatchObject({ to: 'lena@example.test' });
    expect(lastMail().subject).toContain('confirm');
    expect(lastMail().text).toContain('https://mornihosting.de/verify?token=');
    // Right password, but not confirmed yet.
    const early = await post('/api/auth/login', { username: 'lena', password: 'longenough1' });
    expect(early.statusCode).toBe(403);
    expect(early.json<{ error: string }>().error).toBe('email_unconfirmed');
    const token = tokenIn(lastMail());
    expect((await post('/api/auth/confirm', { token })).json()).toEqual({ kind: 'register' });
    // The link works once.
    expect((await post('/api/auth/confirm', { token })).statusCode).toBe(400);
    const lena = await login(t, 'lena', 'longenough1');
    const me = (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(lena) })).json<{
      user: UserInfo;
    }>();
    expect(me.user).toMatchObject({ isAdmin: false, canCreateServers: false, email: 'lena@example.test' });
  });

  test('sign-up: may be allowed to order, a taken name is refused, known addresses are not revealed', async () => {
    await configure();
    expect(
      (
        await post('/api/auth/register', {
          username: 'philip',
          email: 'p@example.test',
          password: 'longenough1',
        })
      ).statusCode,
    ).toBe(409);
    await post('/api/auth/register', {
      username: 'lena',
      email: 'lena@example.test',
      password: 'longenough1',
    });
    await waitFor(() => sent.length === 1);
    await post('/api/auth/confirm', { token: tokenIn(lastMail()) });
    const lena = await login(t, 'lena', 'longenough1');
    const me = (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(lena) })).json<{
      user: UserInfo;
    }>();
    expect(me.user.canCreateServers).toBe(true);
    // The same address again: same answer (204), but only a "you already have an account" mail.
    const again = await post('/api/auth/register', {
      username: 'other',
      email: 'lena@example.test',
      password: 'longenough1',
    });
    expect(again.statusCode).toBe(200);
    await waitFor(() => sent.length === 2);
    expect(lastMail().subject).toBe('Du hast schon einen Zugang');
    expect(lastMail().text).not.toContain('token=');
  });

  test('sign-up: closed switch and expired pending accounts', async () => {
    await configure({ registration: false });
    expect(await status()).toEqual({ registration: false, passwordReset: true });
    expect(
      (
        await post('/api/auth/register', {
          username: 'lena',
          email: 'l@example.test',
          password: 'longenough1',
        })
      ).statusCode,
    ).toBe(403);
    await asAdmin('PUT', '/api/mail', { ...SMTP });
    await post('/api/auth/register', { username: 'lena', email: 'l@example.test', password: 'longenough1' });
    t.ctx.db.run(sql.raw("update users set created_at = '2020-01-01T00:00:00.000Z' where username = 'lena'"));
    t.mail.purgeStale();
    expect(
      (
        await post('/api/auth/register', {
          username: 'lena',
          email: 'l2@example.test',
          password: 'longenough1',
        })
      ).statusCode,
    ).toBe(200);
  });

  test('password forgotten: one-hour link, only once, ends other sessions, no answer about the address', async () => {
    await configure();
    await asAdmin('POST', '/api/users', {
      username: 'lena',
      password: 'oldpassword1',
      email: 'lena@example.test',
      locale: 'de',
    });
    await waitFor(() => sent.length === 1);
    expect(lastMail().subject).toBe('Glückwunsch, du bist auserwählt 👑');
    expect(lastMail().text).not.toContain('oldpassword1');
    const before = await login(t, 'lena', 'oldpassword1');

    const unknown = await post('/api/auth/forgot', { email: 'nobody@example.test' });
    const known = await post('/api/auth/forgot', { email: 'lena@example.test' });
    expect(unknown.statusCode).toBe(204);
    expect(known.statusCode).toBe(204);
    await waitFor(() => sent.length === 2);
    expect(sent.some((m) => m.to === 'nobody@example.test')).toBe(false);
    const token = tokenIn(lastMail());
    expect(lastMail().text).toContain('1 Stunde');
    // A second request right away does not send another mail.
    await post('/api/auth/forgot', { email: 'lena@example.test' });
    expect(sent.length).toBe(2);

    expect((await post('/api/auth/reset', { token: 'wrong', password: 'brandnewpass1' })).statusCode).toBe(
      400,
    );
    expect((await post('/api/auth/reset', { token, password: 'brandnewpass1' })).statusCode).toBe(204);
    expect((await post('/api/auth/reset', { token, password: 'anotherpass12' })).statusCode).toBe(400);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(before) })).statusCode,
    ).toBe(401);
    expect((await post('/api/auth/login', { username: 'lena', password: 'oldpassword1' })).statusCode).toBe(
      401,
    );
    expect((await post('/api/auth/login', { username: 'lena', password: 'brandnewpass1' })).statusCode).toBe(
      200,
    );
  });

  test('password forgotten: an expired link is refused', async () => {
    await configure();
    await asAdmin('POST', '/api/users', {
      username: 'lena',
      password: 'oldpassword1',
      email: 'lena@example.test',
    });
    await post('/api/auth/forgot', { email: 'lena@example.test' });
    await waitFor(() => sent.length === 2);
    t.ctx.db.run(sql.raw("update mail_tokens set expires_at = '2020-01-01T00:00:00.000Z'"));
    expect(
      (await post('/api/auth/reset', { token: tokenIn(lastMail()), password: 'brandnewpass1' })).statusCode,
    ).toBe(400);
  });

  test('only hashes of the links are stored', async () => {
    await configure();
    await asAdmin('POST', '/api/users', {
      username: 'lena',
      password: 'oldpassword1',
      email: 'lena@example.test',
    });
    await post('/api/auth/forgot', { email: 'lena@example.test' });
    await waitFor(() => sent.length === 2);
    const token = tokenIn(lastMail());
    const rows = t.ctx.db.select({ tokenHash: mailTokens.tokenHash }).from(mailTokens).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.tokenHash).not.toContain(token);
  });

  test('own address: change needs the password and a confirmation link', async () => {
    await configure();
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/account/email',
      headers: authHeaders(admin),
      payload: { email: 'philip@example.test', password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/account/email',
      headers: authHeaders(admin),
      payload: { email: 'Philip@Example.test', password: 'supersecret123' },
    });
    expect(ok.statusCode).toBe(204);
    await waitFor(() => sent.length === 1);
    expect(lastMail().to).toBe('philip@example.test');
    const before = (
      await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(admin) })
    ).json<{ user: UserInfo }>();
    expect(before.user.email).toBeNull();
    expect((await post('/api/auth/confirm', { token: tokenIn(lastMail()) })).json()).toEqual({
      kind: 'email_change',
    });
    const after = (
      await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(admin) })
    ).json<{ user: UserInfo }>();
    expect(after.user.email).toBe('philip@example.test');
  });

  test('admins: addresses are unique', async () => {
    await configure();
    await asAdmin('POST', '/api/users', {
      username: 'lena',
      password: 'oldpassword1',
      email: 'lena@example.test',
    });
    const dup = await asAdmin('POST', '/api/users', {
      username: 'finn',
      password: 'oldpassword1',
      email: 'LENA@example.test',
    });
    expect(dup.statusCode).toBe(409);
  });

  test('ordering a server sends a confirmation with plan, software and address', async () => {
    await configure();
    await asAdmin('PATCH', '/api/users/1', { email: 'philip@example.test' });
    const res = await asAdmin('POST', '/api/servers', {
      name: 'Survival',
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb: 4096,
      port: 25565,
      eula: true,
      startNow: false,
    });
    const server = res.json<ServerSummary>();
    await waitFor(() => sent.length === 1);
    const mail = lastMail();
    expect(mail.to).toBe('philip@example.test');
    expect(mail.subject).toContain('Survival');
    expect(mail.text).toContain('4 GB RAM');
    expect(mail.text).toContain('Paper 1.21.4');
    expect(mail.text).toContain(`https://mornihosting.de/servers/${server.id}`);
  });

  test('server names cannot inject HTML or headers into the mail', async () => {
    await configure();
    await asAdmin('PATCH', '/api/users/1', { email: 'philip@example.test' });
    await asAdmin('POST', '/api/servers', {
      name: '<script>x</script>\nBcc: e@x.de',
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb: 2048,
      port: 25565,
      eula: true,
      startNow: false,
    });
    await waitFor(() => sent.length === 1);
    expect(lastMail().html).not.toContain('<script>');
    expect(lastMail().subject).not.toMatch(/[\r\n]/);
  });

  test('crash mails go to admins when switched on, not more than every 15 minutes', async () => {
    await configure({ crashMails: true });
    await asAdmin('PATCH', '/api/users/1', { email: 'philip@example.test' });
    const server = (
      await asAdmin('POST', '/api/servers', {
        name: 'Survival',
        edition: 'java',
        software: 'paper',
        version: '1.21.4',
        memoryMb: 2048,
        port: 25565,
        eula: true,
        startNow: false,
      })
    ).json<ServerSummary>();
    await waitFor(() => sent.length === 1);
    const crash = {
      at: new Date().toISOString(),
      ruleId: 'out_of_memory',
      exitCode: 137,
      lines: [],
    } as never;
    t.ctx.events.emit('server.crashed', { serverId: server.id, crash });
    t.ctx.events.emit('server.crashed', { serverId: server.id, crash });
    await waitFor(() => sent.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.length).toBe(2);
    expect(lastMail().subject).toContain('Survival');
  });
});
