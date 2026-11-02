/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { MailQuickResult, MailSettingsView } from '@mornihosting/shared';
import type { MailNetwork } from '../src/mail/check.js';
import { candidateHosts } from '../src/mail/quick.js';
import type { OutgoingMail, SmtpConfig } from '../src/mail/service.js';
import { authHeaders, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

/** Like Philip's Stalwart: at 192.168.178.116, only port 465, certificate for *.mornihosting.de. */
const HOME_IP = '192.168.178.116';
const network: MailNetwork = {
  lookup: async (host) => {
    if (host === 'mail.pmornhart.de') throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return '203.0.113.9';
  },
  connect: async (address, port) => {
    if (address !== HOME_IP || port !== 465)
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  },
  mx: async (domain) => (domain === 'mornihosting.de' ? ['mail.pmornhart.de'] : []),
  certificateNames: async () => ['*.mornihosting.de', 'mornihosting.de', 'evil.example'],
};

describe('mail quick start', () => {
  let t: TestApp;
  let admin: Session;
  let sent: OutgoingMail[];
  let verified: SmtpConfig[];

  beforeEach(async () => {
    sent = [];
    verified = [];
    t = await createTestApp(
      {},
      {
        mailNetwork: network,
        mailTransport: (config) => ({
          verify: async () => {
            verified.push(config);
            if (!['mail.mornihosting.de', 'mornihosting.de'].includes(config.host))
              throw Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
                code: 'ESOCKET',
                originalCode: 'ERR_TLS_CERT_ALTNAME_INVALID',
              });
            if (config.password !== 'richtig')
              throw Object.assign(new Error('535 5.7.8 Authentication failed'), {
                code: 'EAUTH',
                responseCode: 535,
              });
            return true;
          },
          sendMail: async (mail) => {
            sent.push(mail);
            return {};
          },
        }),
      },
    );
    admin = await setupAdmin(t);
  });
  afterEach(async () => t.cleanup());

  const quick = async (body: object) =>
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/mail/quick',
        headers: authHeaders(admin),
        payload: body,
      })
    ).json<MailQuickResult>();

  test('guesses from certificate and MX; a stranger name in the certificate is never tried', async () => {
    const hosts = await candidateHosts('noreply@mornihosting.de', HOME_IP, network);
    expect(hosts[0]).toBe('mail.mornihosting.de');
    expect(hosts).toContain('mail.pmornhart.de');
    expect(hosts).not.toContain('evil.example');
    expect((await candidateHosts('ich@gmail.com', '', network))[0]).toBe('smtp.gmail.com');
  });

  test('address + password + home IP is enough: finds mail.mornihosting.de:465 TLS, saves it, sends a test mail', async () => {
    const res = await quick({ email: 'noreply@mornihosting.de', password: 'richtig', internalHost: HOME_IP });
    expect(res.found).toEqual({ host: 'mail.mornihosting.de', port: 465, security: 'tls' });
    expect(res.test?.ok).toBe(true);
    expect(sent.at(-1)?.from).toBe('MorniHosting <noreply@mornihosting.de>');
    const view = (
      await t.app.inject({ method: 'GET', url: '/api/mail', headers: authHeaders(admin) })
    ).json<MailSettingsView>();
    expect(view).toMatchObject({
      configured: true,
      host: 'mail.mornihosting.de',
      internalHost: HOME_IP,
      port: 465,
      security: 'tls',
      user: 'noreply@mornihosting.de',
      passwordSet: true,
    });
    expect(verified.some((c) => c.host === 'evil.example')).toBe(false);
  });

  test('wrong password: nothing is saved and the answer says the login was refused', async () => {
    const res = await quick({ email: 'noreply@mornihosting.de', password: 'falsch', internalHost: HOME_IP });
    expect(res.found).toBeNull();
    expect(res.closest).toMatchObject({ host: 'mail.mornihosting.de', port: 465, problem: 'login' });
    expect(JSON.stringify(res)).not.toContain('falsch');
    const view = (
      await t.app.inject({ method: 'GET', url: '/api/mail', headers: authHeaders(admin) })
    ).json<MailSettingsView>();
    expect(view.configured).toBe(false);
  });
});
