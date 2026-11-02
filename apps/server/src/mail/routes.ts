import { eq } from 'drizzle-orm';
import {
  confirmSchema,
  emailChangeSchema,
  forgotSchema,
  mailSettingsSchema,
  mailQuickSchema,
  mailTestSchema,
  registerSchema,
  resetSchema,
  signupSettingsSchema,
  type ConfirmResult,
  type MailQuickResult,
  type MailSettingsView,
  type MailTestResult,
  type RegisterResult,
  type SignupSettings,
} from '@mornihosting/shared';
import { actorOf, requireAdmin, requireAuth } from '../auth/context.js';
import { verifyPassword } from '../auth/passwords.js';
import type { Api, AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { HTTP_NO_CONTENT } from '../lib/http-status.js';
import type { MailService } from './service.js';

/** Mail settings for admins, plus the pages behind the links in mails (sign-up, reset, new address). */

const ANONYMOUS_LIMIT = 5;
const ANONYMOUS_WINDOW = '1 minute';
const anonymousRateLimit = { rateLimit: { max: ANONYMOUS_LIMIT, timeWindow: ANONYMOUS_WINDOW } };

export function registerMailRoutes(app: Api, ctx: AppContext, mail: MailService): void {
  app.get('/api/mail', async (request): Promise<MailSettingsView> => {
    requireAdmin(request);
    return mail.view();
  });

  app.put(
    '/api/mail',
    { schema: { body: mailSettingsSchema } },
    async (request): Promise<MailSettingsView> => {
      requireAdmin(request);
      const view = mail.save(request.body);
      ctx.audit.record(actorOf(request), 'mail.settings', null, {
        host: view.host,
        registration: view.registration,
      });
      return view;
    },
  );

  app.delete('/api/mail', async (request, reply) => {
    requireAdmin(request);
    mail.clear();
    ctx.audit.record(actorOf(request), 'mail.removed');
    return reply.code(HTTP_NO_CONTENT).send();
  });

  app.post(
    '/api/mail/test',
    { schema: { body: mailTestSchema }, config: anonymousRateLimit },
    async (request): Promise<MailTestResult> => {
      const auth = requireAdmin(request);
      const to = request.body.to ?? auth.user.email;
      if (!to) throw badRequest('mail_no_recipient');
      const result = await mail.test(to, auth.user.locale, {
        name: auth.user.displayName || auth.user.username,
      });
      if (result.switchedTo)
        ctx.audit.record(actorOf(request), 'mail.settings', null, {
          host: mail.view().host,
          port: result.switchedTo.port,
        });
      return result;
    },
  );

  app.post(
    '/api/mail/quick',
    { schema: { body: mailQuickSchema }, config: anonymousRateLimit },
    async (request): Promise<MailQuickResult> => {
      const auth = requireAdmin(request);
      const result = await mail.quick(request.body, auth.user.email ?? request.body.email, auth.user.locale, {
        name: auth.user.displayName || auth.user.username,
      });
      if (result.found)
        ctx.audit.record(actorOf(request), 'mail.settings', null, {
          host: result.found.host,
          registration: mail.view().registration,
        });
      return result;
    },
  );

  /* ---------- Visitors ---------- */

  app.post(
    '/api/auth/register',
    { schema: { body: registerSchema }, config: anonymousRateLimit },
    async (request): Promise<RegisterResult> => mail.register({ ...request.body, ip: request.ip }),
  );

  app.get('/api/signup', async (request): Promise<SignupSettings> => {
    requireAdmin(request);
    return mail.signup();
  });
  app.put(
    '/api/signup',
    { schema: { body: signupSettingsSchema } },
    async (request): Promise<SignupSettings> => {
      requireAdmin(request);
      ctx.audit.record(actorOf(request), 'signup.settings', null, { enabled: request.body.enabled });
      return mail.setSignup(request.body);
    },
  );

  app.post(
    '/api/auth/confirm',
    { schema: { body: confirmSchema }, config: anonymousRateLimit },
    async (request): Promise<ConfirmResult> => mail.confirm(request.body.token),
  );

  app.post(
    '/api/auth/forgot',
    { schema: { body: forgotSchema }, config: anonymousRateLimit },
    async (request, reply) => {
      mail.forgot(request.body.email);
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  app.post(
    '/api/auth/reset',
    { schema: { body: resetSchema }, config: anonymousRateLimit },
    async (request, reply) => {
      await mail.reset(request.body.token, request.body.password, actorOf(request));
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  /* ---------- Own account ---------- */

  app.put(
    '/api/account/email',
    { schema: { body: emailChangeSchema }, config: anonymousRateLimit },
    async (request, reply) => {
      const auth = requireAuth(request);
      if (!(await verifyPassword(auth.user.passwordHash, request.body.password)))
        throw badRequest('wrong_password');
      mail.startEmailChange(auth.user, request.body.email);
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  app.delete('/api/account/email', async (request, reply) => {
    const auth = requireAuth(request);
    ctx.db.update(users).set({ email: null }).where(eq(users.id, auth.user.id)).run();
    ctx.audit.record(actorOf(request), 'account.email_removed');
    return reply.code(HTTP_NO_CONTENT).send();
  });
}
