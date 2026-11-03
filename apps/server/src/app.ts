import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createAuditService } from './audit/service.js';
import { createAuthHook } from './auth/hook.js';
import { registerAuditRoutes } from './audit/routes.js';
import { registerPasskeyRoutes } from './auth/passkey-routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerTokenRoutes } from './auth/token-routes.js';
import { createSessionStore } from './auth/sessions.js';
import type { Config } from './config.js';
import type { Api, AppContext } from './context.js';
import { openDatabase } from './db/index.js';
import { createDockerDriver } from './docker/docker-driver.js';
import type { DockerDriver } from './docker/driver.js';
import { createFakeDriver, FAKE_STEP_MS_DEFAULT } from './docker/fake-driver.js';
import { createEventBus } from './events.js';
import { createSecretBox } from './lib/crypto.js';
import { AppError } from './lib/errors.js';
import { setUserAgent } from './lib/http-client.js';
import { HTTP_BAD_REQUEST, HTTP_INTERNAL, HTTP_NOT_FOUND, HTTP_TOO_MANY } from './lib/http-status.js';
import { BYTES_PER_MB, MS_PER_HOUR, MS_PER_SECOND } from './lib/units.js';
import { registerFileRoutes } from './files/routes.js';
import { createFileService } from './files/service.js';
import { registerBackupRoutes } from './backups/routes.js';
import { createBackupService } from './backups/service.js';
import { registerGeyserRoutes } from './geyser/routes.js';
import { createGeyserService } from './geyser/service.js';
import { registerVoiceChatRoutes } from './voicechat/routes.js';
import { createVoiceChatService } from './voicechat/service.js';
import { registerMarketRoutes } from './market/routes.js';
import { createMarketService } from './market/service.js';
import { registerImportRoutes } from './servers/import-routes.js';
import { registerServerRoutes } from './servers/routes.js';
import { createServerService, type ServerService } from './servers/service.js';
import { registerScheduleRoutes } from './schedules/routes.js';
import { createScheduleService } from './schedules/service.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { registerTransferRoutes } from './transfer/routes.js';
import { createTransferService } from './transfer/service.js';
import { createSettingsService } from './settings/service.js';
import { sampleHostCpu } from './system/host.js';
import { registerSystemRoutes } from './system/routes.js';
import { registerQuotaRoutes } from './quota/routes.js';
import { createQuotaService } from './quota/service.js';
import { createUpdateService } from './system/update.js';
import { createAccessService } from './users/access.js';
import { registerUserRoutes } from './users/routes.js';
import { registerWebhookRoutes } from './webhooks/routes.js';
import { createWebhookService } from './webhooks/service.js';
import { registerWebSocket } from './ws.js';
import { createNetbirdAutomation } from './netbird/service.js';
import { createNetbirdExit } from './netbird/exit.js';
import { createDnsAutomation, type DnsAutomation } from './dns/service.js';
import { registerDnsRoutes } from './dns/routes.js';
import { createHttpsGateway } from './https/gateway.js';
import { registerHttpsRoutes } from './https/routes.js';
import { registerGameArtRoutes } from './branding/game-art.js';
import { registerNetbirdRoutes } from './netbird/routes.js';
import { createMinecraftLinkService } from './minecraft/service.js';
import { registerMinecraftRoutes } from './minecraft/routes.js';
import type { Resolver } from './lib/net-guard.js';
import { createDdosService } from './ddos/service.js';
import { registerDdosRoutes } from './ddos/routes.js';
import { rememberRawBody } from './lib/raw-body.js';
import type { MailNetwork } from './mail/check.js';
import { createMailService, type MailService, type TransportFactory } from './mail/service.js';
import { registerMailRoutes } from './mail/routes.js';
import { createStalwartService, type StalwartResolver } from './stalwart/service.js';
import type { StalwartClientFactory } from './stalwart/client.js';
import { registerStalwartRoutes } from './stalwart/routes.js';
import { createApprovalService } from './notify/approvals.js';
import type { DiscordApi } from './notify/discord.js';
import { registerNotifyRoutes } from './notify/routes.js';
import { createNotifyService } from './notify/service.js';

export interface BuildOptions {
  readonly config: Config;
  /** Inject a driver (tests); otherwise chosen by MH_DOCKER_DRIVER. */
  readonly docker?: DockerDriver;
  readonly logger?: boolean;
  /** DNS lookup for webhook targets (tests answer without a network). */
  readonly resolver?: Resolver;
  /** Tests catch outgoing mails here instead of reaching a mail server. */
  readonly mailTransport?: TransportFactory;
  /** Tests answer DNS and TCP for the mail check here. */
  readonly mailNetwork?: MailNetwork;
  /** Tests answer Discord here. */
  readonly discord?: DiscordApi;
  /** Tests answer Stalwart's management API and the DNS checks here. */
  readonly stalwart?: StalwartClientFactory;
  readonly stalwartResolver?: StalwartResolver;
}

export interface BuiltApp {
  readonly app: Api;
  readonly mail: MailService;
  readonly ctx: AppContext;
  readonly servers: ServerService;
  /** Own-domain DNS automation; tests trigger its IP check directly. */
  readonly dns: DnsAutomation;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

const BODY_LIMIT_MB = 2;
const GLOBAL_RATE_LIMIT = 600;
const HOST_SAMPLE_SECONDS = 5;
const SERVER_ERROR_FROM = 500;

function createDriver(config: Config): DockerDriver {
  if (config.dockerDriver === 'fake') {
    return createFakeDriver({
      stepMs: config.fakeStepMs ?? FAKE_STEP_MS_DEFAULT,
      simulatePlayers: config.demo,
    });
  }
  return createDockerDriver(config);
}

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options;
  setUserAgent(config.version);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const database = openDatabase(path.join(config.dataDir, 'panel.db'));

  // The visitor's real IP comes from X-Forwarded-For only behind a proxy the admin trusts, or the own HTTPS gateway.
  const proxies = { isGateway: (_address: string): boolean => false };
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    trustProxy: (address: string) => config.trustProxy || proxies.isGateway(address),
    bodyLimit: BODY_LIMIT_MB * BYTES_PER_MB,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // API clients often send "content-type: application/json" with an empty body on action endpoints.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    async (request: object, body: string) => {
      rememberRawBody(request, body);
      if (!body.trim()) return undefined;
      try {
        return JSON.parse(body) as unknown;
      } catch (err) {
        throw new AppError(HTTP_BAD_REQUEST, 'invalid_json', {}, { cause: err });
      }
    },
  );

  const secrets = createSecretBox(config.secret);
  const events = createEventBus();
  const settings = createSettingsService(database.db, config, secrets);
  const ctx: AppContext = {
    config,
    db: database.db,
    log: app.log,
    secrets,
    events,
    settings,
    audit: createAuditService(database.db),
    sessions: createSessionStore(database.db),
    access: createAccessService(database.db),
    docker: options.docker ?? createDriver(config),
  };
  const servers = createServerService(ctx);
  const files = createFileService(config);
  const backups = createBackupService(ctx, servers);
  const schedules = createScheduleService(ctx, servers, backups);
  const webhooks = createWebhookService(ctx, options.resolver);
  const netbird = createNetbirdAutomation(ctx, servers);
  const dns = createDnsAutomation(ctx, servers);
  const https = createHttpsGateway(ctx, () => dns.status().domain);
  proxies.isGateway = https.isGateway;
  const minecraftLink = createMinecraftLinkService(ctx, servers);
  const ddos = createDdosService(ctx, servers);
  const mail = createMailService(ctx, options.mailTransport, options.mailNetwork);
  mail.init(servers);
  const stalwart = createStalwartService(ctx, mail, dns, options.stalwart, options.stalwartResolver);
  const notify = createNotifyService(ctx, mail, options.discord);
  const approvals = createApprovalService(ctx, mail, notify, servers);
  notify.start();

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      statusCode: HTTP_TOO_MANY,
      code: 'rate_limited',
      message: `retry in ${Math.ceil(context.ttl / MS_PER_SECOND)}s`,
    }),
  });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50 } }); // eslint-disable-line ts-patterns/no-magic-numbers -- at most 50 files per upload request
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'MorniHosting API',
        description:
          'REST-API des MorniHosting-Panels. Anmeldung mit einem API-Token: Header `Authorization: Bearer mh_…` (unter „API-Zugänge“ erstellen).',
        version: config.version,
      },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.addHook('onRequest', createAuthHook(ctx));

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, params: err.params });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(HTTP_BAD_REQUEST).send({
        error: 'validation',
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err.statusCode === HTTP_TOO_MANY) return reply.code(HTTP_TOO_MANY).send({ error: 'rate_limited' });
    if (err.statusCode && err.statusCode < SERVER_ERROR_FROM) {
      return reply
        .code(err.statusCode)
        .send({ error: err.code?.toLowerCase() ?? 'bad_request', message: err.message });
    }
    request.log.error({ err }, 'request failed');
    return reply.code(HTTP_INTERNAL).send({ error: 'internal' });
  });

  registerAuthRoutes(app, ctx, mail);
  registerPasskeyRoutes(app, ctx);
  registerServerRoutes(app, ctx, servers);
  registerImportRoutes(app, ctx, servers);
  registerFileRoutes(app, ctx, servers, files);
  const market = createMarketService(ctx, servers, files);
  registerMarketRoutes(app, ctx, servers, market);
  registerGeyserRoutes(app, ctx, createGeyserService(ctx, servers, market));
  registerVoiceChatRoutes(app, ctx, createVoiceChatService(ctx, servers, market));
  registerNetbirdRoutes(app, netbird, dns, createNetbirdExit(ctx, undefined, options.resolver));
  registerDnsRoutes(app, dns);
  registerHttpsRoutes(app, https);
  registerGameArtRoutes(app, ctx);
  registerMinecraftRoutes(app, minecraftLink);
  registerBackupRoutes(app, ctx, servers, backups);
  registerScheduleRoutes(app, ctx, servers, schedules);
  registerWebhookRoutes(app, webhooks);
  registerMailRoutes(app, ctx, mail);
  registerStalwartRoutes(app, stalwart);
  registerNotifyRoutes(app, ctx, notify, approvals);
  registerUserRoutes(app, ctx, mail);
  registerTokenRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerTransferRoutes(app, ctx, createTransferService(ctx));
  registerSystemRoutes(app, createUpdateService(ctx));
  registerDdosRoutes(app, ddos);
  registerQuotaRoutes(app, createQuotaService(ctx, servers));
  registerWebSocket(app, ctx, servers);

  const hasWeb = fs.existsSync(path.join(config.webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, index: false });
  }
  app.setNotFoundHandler((request, reply) => {
    // Missing build files (e.g. an old chunk after an update) must stay 404, not turn into the page.
    const wantsPage =
      request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/assets/');
    if (wantsPage && hasWeb) return reply.type('text/html').sendFile('index.html');
    return reply.code(HTTP_NOT_FOUND).send({ error: 'not_found' });
  });

  const intervals: NodeJS.Timeout[] = [];
  return {
    app,
    mail,
    ctx,
    servers,
    dns,
    start: async () => {
      sampleHostCpu();
      intervals.push(setInterval(sampleHostCpu, HOST_SAMPLE_SECONDS * MS_PER_SECOND));
      intervals.push(setInterval(() => ctx.sessions.purgeExpired(), MS_PER_HOUR));
      mail.purgeStale();
      intervals.push(setInterval(() => mail.purgeStale(), MS_PER_HOUR));
      files.purgeOld();
      intervals.push(setInterval(() => files.purgeOld(), MS_PER_HOUR));
      backups.init();
      ddos.init();
      void https.init();
      webhooks.init();
      await servers.init();
      schedules.init();
    },
    stop: async () => {
      intervals.forEach(clearInterval);
      schedules.shutdown();
      notify.stop();
      dns.shutdown();
      servers.shutdown();
      ctx.docker.close();
      await app.close();
      database.close();
    },
  };
}
