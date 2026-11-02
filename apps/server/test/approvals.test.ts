/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  ApprovalsView,
  ConfirmResult,
  DiscordLinkCode,
  ServerRequestView,
  ServerSummary,
  UserListEntry,
} from '@mornihosting/shared';
import type { OutgoingMail } from '../src/mail/service.js';
import {
  DiscordError,
  INTERACTION_COMMAND,
  INTERACTION_COMPONENT,
  type DiscordApi,
  type DiscordInteraction,
  type DiscordMessage,
} from '../src/notify/discord.js';
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
  port: 465,
  security: 'tls',
  user: 'noreply@mornihosting.de',
  password: 'smtp-secret-pw',
  from: 'MorniHosting <noreply@mornihosting.de>',
  registration: true,
  registrationOrders: false,
  crashMails: false,
};
const PAPER = {
  name: 'Lenas Welt',
  edition: 'java',
  software: 'paper',
  version: '1.21.4',
  memoryMb: 2048,
  port: 25565,
  eula: true,
};
const PHILIP_DISCORD = '111111111111111111';
const BLOCKED_DISCORD = '333';

/** Discord as seen by the panel: DMs are collected, clicks and commands are injected. */
function fakeDiscord() {
  const dms: { userId: string; message: DiscordMessage }[] = [];
  const replies: { type: number; message: DiscordMessage | null }[] = [];
  const hooks: { onInteraction: ((i: DiscordInteraction) => void) | null } = { onInteraction: null };
  const api: DiscordApi = {
    whoAmI: async (token) => {
      if (token !== 'bot-token') throw new DiscordError(401, 0, '401: Unauthorized');
      return { id: '999', name: 'MorniBot' };
    },
    registerCommands: async () => undefined,
    sendDm: async (_token, userId, message) => {
      if (userId === BLOCKED_DISCORD) throw new DiscordError(403, 50007, 'Cannot send messages to this user');
      dms.push({ userId, message });
    },
    reply: async (_interaction, type, message) => {
      replies.push({ type, message });
    },
    connect: (_token, onInteraction, onStatus) => {
      hooks.onInteraction = onInteraction;
      onStatus(true, null);
      return () => undefined;
    },
  };
  const interact = (type: number, value: string, userId = PHILIP_DISCORD): void =>
    hooks.onInteraction?.({ id: 'i1', token: 't1', type, userId, userName: 'philip_dc', value });
  return { api, dms, replies, interact };
}

describe('approvals: accounts and server requests, by panel, mail and Discord DM', () => {
  let t: TestApp;
  let admin: Session;
  let sent: OutgoingMail[];
  let discord: ReturnType<typeof fakeDiscord>;

  const as = (
    session: Session | null,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url,
      ...(session ? { headers: authHeaders(session) } : {}),
      ...(payload ? { payload } : {}),
    });

  beforeEach(async () => {
    sent = [];
    discord = fakeDiscord();
    t = await createTestApp(
      {},
      {
        discord: discord.api,
        mailNetwork: { lookup: async () => '203.0.113.9', connect: async () => undefined },
        mailTransport: () => ({
          sendMail: async (mail) => {
            sent.push(mail);
            return {};
          },
        }),
      },
    );
    admin = await setupAdmin(t);
    await as(admin, 'PUT', '/api/settings', { panelDomain: 'mornihosting.de' });
    await as(admin, 'PUT', '/api/mail', SMTP);
    await as(admin, 'PUT', '/api/account/email', {
      email: 'philip@mornihosting.de',
      password: 'supersecret123',
    });
    const verify = sent.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? '';
    await as(null, 'POST', '/api/auth/confirm', { token: verify });
    // Discord: the admin sets up the bot and links his own account with /verbinden.
    expect((await as(admin, 'PUT', '/api/discord', { token: 'bot-token' })).json()).toMatchObject({
      configured: true,
      botName: 'MorniBot',
      online: true,
    });
    const { code } = (await as(admin, 'POST', '/api/account/discord/code')).json<DiscordLinkCode>();
    discord.interact(INTERACTION_COMMAND, code);
  });
  afterEach(async () => t.cleanup());

  test('linking with /verbinden: the bot writes first, which opens the private chat', async () => {
    await waitFor(() => discord.dms.some((d) => d.userId === PHILIP_DISCORD));
    expect(discord.dms[0]?.message.title).toBe('👋 Hallo von MorniHosting');
  });

  test('a wrong bot token is refused with its own message', async () => {
    expect((await as(admin, 'PUT', '/api/discord', { token: 'nope' })).json()).toMatchObject({
      error: 'discord_token_invalid',
    });
  });

  test('sign-up waits for the admin; approved with the button in the Discord DM', async () => {
    await as(null, 'POST', '/api/auth/register', {
      username: 'lena',
      email: 'lena@example.test',
      password: 'longenough1',
    });
    const token = sent.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? '';
    expect((await as(null, 'POST', '/api/auth/confirm', { token })).json<ConfirmResult>().kind).toBe(
      'register_pending',
    );
    expect(
      (await as(null, 'POST', '/api/auth/login', { username: 'lena', password: 'longenough1' })).json(),
    ).toMatchObject({
      error: 'account_pending_approval',
    });

    await waitFor(() => discord.dms.length > 0);
    expect(sent.some((m) => m.to === 'philip@mornihosting.de' && m.subject.includes('lena'))).toBe(true);
    const dm = discord.dms.at(-1);
    expect(dm?.userId).toBe(PHILIP_DISCORD);
    const approve = dm?.message.buttons?.find((b) => b.label === 'Freigeben')?.id ?? '';
    expect(
      (await as(admin, 'GET', '/api/approvals')).json<ApprovalsView>().users.map((u) => u.username),
    ).toEqual(['lena']);

    discord.interact(INTERACTION_COMPONENT, approve);
    await waitFor(() => discord.replies.some((r) => r.message?.title.includes('Freigegeben')));
    expect(
      (await as(null, 'POST', '/api/auth/login', { username: 'lena', password: 'longenough1' })).statusCode,
    ).toBe(200);
    expect(sent.at(-1)).toMatchObject({ to: 'lena@example.test' });
    // Clicking again (or deciding in the panel too) only reports that it is done.
    discord.interact(INTERACTION_COMPONENT, approve);
    await waitFor(() => discord.replies.some((r) => r.message?.title === 'Schon erledigt'));
  });

  test('server request: admin approves in the panel, the server belongs to the asker; Discord click afterwards says done', async () => {
    await as(admin, 'POST', '/api/users', {
      username: 'lena',
      password: 'lena-passwort-1',
      canCreateServers: false,
    });
    const lena = await login(t, 'lena', 'lena-passwort-1');
    expect((await as(lena, 'POST', '/api/servers', PAPER)).statusCode).toBe(403);
    const req = (await as(lena, 'POST', '/api/server-requests', PAPER)).json<ServerRequestView>();
    expect(req.status).toBe('pending');
    await waitFor(() => discord.dms.some((d) => d.message.title.includes('Server-Anfrage')));
    expect(sent.some((m) => m.subject.includes('fragt einen Server an'))).toBe(true);

    const result = await as(admin, 'POST', `/api/server-requests/${req.id}/approve`);
    expect(result.json<DiscordMessage>().title).toContain('Angenommen');
    const mine = (await as(lena, 'GET', '/api/server-requests/mine')).json<ServerRequestView[]>();
    expect(mine[0]).toMatchObject({ status: 'approved', decidedBy: 'philip' });
    const servers = (await as(lena, 'GET', '/api/servers')).json<ServerSummary[]>();
    expect(servers.map((s) => s.name)).toEqual(['Lenas Welt']);

    const approve =
      discord.dms.find((d) => d.message.title.includes('Server-Anfrage'))?.message.buttons?.[0]?.id ?? '';
    discord.interact(INTERACTION_COMPONENT, approve);
    await waitFor(() => discord.replies.some((r) => r.message?.title === 'Schon erledigt'));
  });

  test('declined request: the asker gets a mail with the reason; buttons only work for admins', async () => {
    await as(admin, 'POST', '/api/users', { username: 'lena', password: 'lena-passwort-1' });
    const users = (await as(admin, 'GET', '/api/users')).json<UserListEntry[]>();
    const lenaId = users.find((u) => u.username === 'lena')?.id;
    const lena = await login(t, 'lena', 'lena-passwort-1');
    await as(lena, 'PUT', '/api/account/email', { email: 'lena@example.test', password: 'lena-passwort-1' });
    const verify = sent.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? '';
    await as(null, 'POST', '/api/auth/confirm', { token: verify });
    const req = (await as(lena, 'POST', '/api/server-requests', PAPER)).json<ServerRequestView>();

    // Lena links her Discord too and tries to approve her own request: not allowed.
    const { code } = (await as(lena, 'POST', '/api/account/discord/code')).json<DiscordLinkCode>();
    discord.interact(INTERACTION_COMMAND, code, '222');
    discord.interact(INTERACTION_COMPONENT, `mh:approve-req:${req.id}`, '222');
    await waitFor(() => discord.replies.some((r) => r.message?.title === 'Hat nicht geklappt'));
    expect(lenaId).toBeDefined();

    await as(admin, 'POST', `/api/server-requests/${req.id}/reject`, { note: 'Gerade kein Platz' });
    expect(sent.at(-1)).toMatchObject({ to: 'lena@example.test' });
    expect(sent.at(-1)?.text).toContain('Gerade kein Platz');
    await waitFor(() =>
      discord.dms.some((d) => d.userId === '222' && d.message.title === 'Anfrage abgelehnt'),
    );
  });

  test('notification choices: no Discord, no mails about approvals', async () => {
    await as(admin, 'PUT', '/api/account/notifications', {
      approvals: false,
      crashes: true,
      decisions: true,
      email: true,
      discord: true,
    });
    const before = { dms: discord.dms.length, mails: sent.length };
    await as(admin, 'POST', '/api/users', {
      username: 'lena',
      password: 'lena-passwort-1',
      canCreateServers: false,
    });
    const lena = await login(t, 'lena', 'lena-passwort-1');
    await as(lena, 'POST', '/api/server-requests', PAPER);
    expect(discord.dms.length).toBe(before.dms);
    expect(sent.length).toBe(before.mails);
  });

  test('test message: arrives as DM; blocked DMs are explained; without link a clear error', async () => {
    expect((await as(admin, 'POST', '/api/account/discord/test')).statusCode).toBe(204);
    expect(discord.dms.at(-1)).toMatchObject({
      userId: PHILIP_DISCORD,
      message: { title: '🎉 Test-Nachricht' },
    });

    await as(admin, 'POST', '/api/users', { username: 'lena', password: 'lena-passwort-1' });
    const lena = await login(t, 'lena', 'lena-passwort-1');
    expect((await as(lena, 'POST', '/api/account/discord/test')).json()).toMatchObject({
      error: 'discord_not_linked',
    });
    const { code } = (await as(lena, 'POST', '/api/account/discord/code')).json<DiscordLinkCode>();
    discord.interact(INTERACTION_COMMAND, code, BLOCKED_DISCORD);
    await waitFor(
      async () =>
        (await as(lena, 'GET', '/api/account/notifications')).json<{ discord: { linked: boolean } }>().discord
          .linked,
    );
    expect((await as(lena, 'POST', '/api/account/discord/test')).json()).toMatchObject({
      error: 'discord_dm_blocked',
    });
  });
});
