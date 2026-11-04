import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { NETBIRD_DEFAULT_API, netbirdApiUrlSchema } from '@mornihosting/shared';

const DEFAULT_PORT = 8080;
const MIN_SECRET_LENGTH = 32;
const DEFAULT_MAX_UPLOAD_MB = 4096;
const DEFAULT_PLUGIN_UPLOAD_MB = 100;
const PORT_MAX = 65535;
/** Inside the panel container; docker-compose.yml publishes them, NetBird sends 25565/19132 there. */
const DEFAULT_ROUTER_JAVA_PORT = 24565;
const DEFAULT_ROUTER_BEDROCK_PORT = 19100;

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const envSchema = z.object({
  MH_HOST: z.string().default('0.0.0.0'),
  MH_PORT: z.coerce.number().int().min(1).max(PORT_MAX).default(DEFAULT_PORT),
  MH_DATA_DIR: z.string().default('/data'),
  MH_SECRET: z
    .string({ error: 'MH_SECRET fehlt. Lege in der .env-Datei einen langen Zufallswert an.' })
    .min(MIN_SECRET_LENGTH, `MH_SECRET muss mindestens ${MIN_SECRET_LENGTH} Zeichen lang sein.`),
  MH_DOCKER_DRIVER: z.enum(['docker', 'fake']).default('docker'),
  MH_DOCKER_HOST: z.string().default('tcp://socket-proxy:2375'),
  MH_HOST_DATA_DIR: z.string().optional(),
  MH_MC_NETWORK: z.string().default('mornihosting-mc'),
  MH_IMAGE_JAVA: z.string().default('itzg/minecraft-server'),
  MH_IMAGE_BEDROCK: z.string().default('itzg/minecraft-bedrock-server'),
  MH_IMAGE_PROXY: z.string().default('itzg/mc-proxy'),
  MH_TRUST_PROXY: booleanFromEnv.default(false),
  MH_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  MH_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MH_TIMEZONE: z.string().optional(),
  TZ: z.string().optional(),
  MH_LAN_IP: z.string().optional(),
  MH_PUBLIC_ADDRESS: z.string().optional(),
  MH_UPDATE_REPO: z.string().default('pmornhart/MorniHosting'),
  MH_UPDATE_BRANCH: z.string().default('main'),
  /** NetBird server this machine is connected to; install.sh and update.sh read it from `netbird status`. */
  MH_NETBIRD_API: netbirdApiUrlSchema.optional().catch(undefined),
  /** Address router (every server by name, no port): ports inside the panel container; 0 = off. */
  MH_ROUTER_JAVA_PORT: z.coerce.number().int().min(0).max(PORT_MAX).default(DEFAULT_ROUTER_JAVA_PORT),
  MH_ROUTER_BEDROCK_PORT: z.coerce.number().int().min(0).max(PORT_MAX).default(DEFAULT_ROUTER_BEDROCK_PORT),
  MH_DEMO: booleanFromEnv.default(false),
  MH_WEB_DIR: z.string().optional(),
  MH_MAX_UPLOAD_MB: z.coerce.number().int().positive().default(DEFAULT_MAX_UPLOAD_MB),
  MH_PLUGIN_UPLOAD_MB: z.coerce.number().int().positive().default(DEFAULT_PLUGIN_UPLOAD_MB),
  MH_VERSION: z.string().optional(),
  MH_FAKE_STEP_MS: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly secret: string;
  readonly dockerDriver: 'docker' | 'fake';
  readonly dockerHost: string;
  readonly hostDataDir: string | null;
  readonly mcNetwork: string;
  readonly images: { readonly java: string; readonly bedrock: string; readonly proxy: string };
  readonly trustProxy: boolean;
  readonly cookieSecure: 'auto' | 'true' | 'false';
  readonly logLevel: Env['MH_LOG_LEVEL'];
  readonly timezone: string;
  readonly lanIp: string | null;
  readonly publicAddress: string | null;
  readonly updateRepo: string;
  readonly updateBranch: string;
  /** Default NetBird API address: the server this machine is connected to, else NetBird Cloud. */
  readonly netbirdApi: string;
  /** Ports of the address router in the panel container (0 = off). */
  readonly routerPorts: { readonly java: number; readonly bedrock: number };
  readonly demo: boolean;
  readonly webDir: string;
  readonly maxUploadBytes: number;
  readonly pluginUploadBytes: number;
  readonly version: string;
  /** Speed of the simulated console (fake driver only). */
  readonly fakeStepMs: number | null;
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const here = path.dirname(fileURLToPath(import.meta.url));

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv, version: string): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Ungültige Einstellungen:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    host: e.MH_HOST,
    port: e.MH_PORT,
    dataDir: path.resolve(e.MH_DATA_DIR),
    secret: e.MH_SECRET,
    dockerDriver: e.MH_DEMO ? 'fake' : e.MH_DOCKER_DRIVER,
    dockerHost: e.MH_DOCKER_HOST,
    hostDataDir: e.MH_HOST_DATA_DIR ?? null,
    mcNetwork: e.MH_MC_NETWORK,
    images: { java: e.MH_IMAGE_JAVA, bedrock: e.MH_IMAGE_BEDROCK, proxy: e.MH_IMAGE_PROXY },
    trustProxy: e.MH_TRUST_PROXY,
    cookieSecure: e.MH_COOKIE_SECURE,
    logLevel: e.MH_LOG_LEVEL,
    timezone: e.MH_TIMEZONE ?? e.TZ ?? 'Europe/Berlin',
    lanIp: e.MH_LAN_IP || null,
    publicAddress: e.MH_PUBLIC_ADDRESS || null,
    updateRepo: e.MH_UPDATE_REPO,
    updateBranch: e.MH_UPDATE_BRANCH,
    netbirdApi: e.MH_NETBIRD_API ?? NETBIRD_DEFAULT_API,
    routerPorts: { java: e.MH_ROUTER_JAVA_PORT, bedrock: e.MH_ROUTER_BEDROCK_PORT },
    demo: e.MH_DEMO,
    webDir: e.MH_WEB_DIR ? path.resolve(e.MH_WEB_DIR) : path.resolve(here, '../../web/dist'),
    maxUploadBytes: e.MH_MAX_UPLOAD_MB * BYTES_PER_MB,
    pluginUploadBytes: e.MH_PLUGIN_UPLOAD_MB * BYTES_PER_MB,
    version: e.MH_VERSION ?? version,
    fakeStepMs: e.MH_FAKE_STEP_MS ?? null,
  };
}
