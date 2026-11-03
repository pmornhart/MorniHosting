/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { CouponCheck, PaymentsView, ServerSummary } from '@mornihosting/shared';
import { authHeaders, createTestApp, login, setupAdmin, type Session, type TestApp } from './helpers.js';

const order = {
  name: 'Teuer',
  edition: 'java',
  software: 'paper',
  version: '1.21.4',
  memoryMb: 2048,
  port: 25565,
  eula: true,
  startNow: false,
};

describe('voucher MORNI and payments', () => {
  let t: TestApp;
  let admin: Session;
  const as = (s: Session, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(s) });

  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    await as(admin, 'POST', '/api/users', {
      username: 'lena',
      password: 'lena-passwort-1',
      canCreateServers: true,
    });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('morni (any case) is accepted, others are not', async () => {
    const lena = await login(t, 'lena', 'lena-passwort-1');
    const ok = (await as(lena, 'POST', '/api/coupons/check', { code: ' morni ' })).json<CouponCheck>();
    expect(ok).toMatchObject({ code: 'MORNI', monthlyCents: 999_999 });
    expect((await as(lena, 'POST', '/api/coupons/check', { code: 'gratis' })).statusCode).toBe(404);
    expect((await as(lena, 'POST', '/api/servers', { ...order, coupon: 'gratis' })).statusCode).toBe(400);
  });

  test('a server ordered with MORNI is owed every month until marked paid; deleting it ends the charge', async () => {
    const lena = await login(t, 'lena', 'lena-passwort-1');
    const server = (
      await as(lena, 'POST', '/api/servers', { ...order, coupon: 'Morni' })
    ).json<ServerSummary>();
    await as(lena, 'POST', '/api/servers', { ...order, name: 'Gratis', port: 25570 });

    const before = (await as(admin, 'GET', '/api/payments')).json<PaymentsView>();
    expect(before.charges).toHaveLength(1);
    expect(before.charges[0]).toMatchObject({ serverName: 'Teuer', userName: 'lena', monthlyCents: 999_999 });
    expect(before.openCents).toBe(999_999);
    const month = before.charges[0]?.months[0]?.month ?? '';

    expect((await as(lena, 'GET', '/api/payments')).statusCode).toBe(403);
    expect((await as(lena, 'GET', '/api/payments/mine')).json<PaymentsView>().openCents).toBe(999_999);

    const id = before.charges[0]?.id;
    const after = (await as(admin, 'PUT', `/api/payments/${id}`, { month, paid: true })).json<PaymentsView>();
    expect(after).toMatchObject({ openCents: 0, paidCents: 999_999 });

    await as(admin, 'DELETE', `/api/servers/${server.id}`, { confirm: 'Teuer' });
    const ended = (await as(admin, 'GET', '/api/payments')).json<PaymentsView>();
    expect(ended.charges[0]?.endedAt).not.toBeNull();
  });
});
