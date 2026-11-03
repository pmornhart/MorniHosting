import fs from 'node:fs';
import path from 'node:path';
import { PORT_VOICE_CHAT, type SoftwareId, type VoiceChatResult } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { MarketService } from '../market/service.js';
import { parseProperties, serialiseProperties } from '../servers/properties-file.js';
import { VOICE_PURPOSE, type ServerService } from '../servers/service.js';
import { serial } from '../lib/serial.js';

/**
 * Simple Voice Chat with one switch: installs the plugin (Paper and friends) or the mod (Fabric, Forge,
 * NeoForge) from Modrinth, opens a UDP port and writes voicechat-server.properties, so the players'
 * mods find the voice server. Inside the container it always listens on 24454; the host port may differ.
 */

const SOURCE = 'modrinth';
const PROJECT_ID = '9eGKb6K1';
const PLUGIN_DIR = 'plugins/voicechat';
const MOD_DIR = 'config/voicechat';
/** Where the plugin or the mod keeps its settings; servers not listed cannot use voice chat. */
const CONFIG_DIRS: Partial<Readonly<Record<SoftwareId, string>>> = {
  paper: PLUGIN_DIR,
  purpur: PLUGIN_DIR,
  custom: PLUGIN_DIR,
  fabric: MOD_DIR,
  forge: MOD_DIR,
  neoforge: MOD_DIR,
};
const CONFIG_FILE = 'voicechat-server.properties';
// The voice chat jar, also when switched off: "voicechat-bukkit-2.6.26.jar" and
// "voicechat-fabric-1.21.4-2.6.26.jar.disabled" match, "Geyser-Spigot.jar" does not.
// https://regex101.com/?flavor=javascript&regex=%5Evoicechat-&flags=i&testString=voicechat-bukkit-2.6.26.jar%0Avoicechat-fabric-1.21.4-2.6.26.jar.disabled%0AGeyser-Spigot.jar
const VOICE_FILE = /^voicechat-/i;

export interface VoiceChatService {
  readonly set: (
    serverId: string,
    input: { readonly enabled: boolean; readonly publicPort?: number | null },
    actor: Actor,
  ) => Promise<VoiceChatResult>;
  /** Writes port and voice_host again, e.g. before a start after the address changed. */
  readonly writeConfig: (serverId: string) => void;
}

export function createVoiceChatService(
  ctx: AppContext,
  servers: ServerService,
  market: MarketService,
): VoiceChatService {
  const configDirOf = (serverId: string): string => {
    const row = servers.row(serverId);
    if (row.edition !== 'java') throw badRequest('voicechat_java_only');
    const dir = CONFIG_DIRS[row.software];
    if (!dir) throw badRequest('voicechat_unsupported');
    return path.join(servers.dir(serverId), dir);
  };

  const writeConfig = (serverId: string): void => {
    const dir = configDirOf(serverId);
    const file = path.join(dir, CONFIG_FILE);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const updates = { port: String(PORT_VOICE_CHAT), voice_host: servers.voiceHost(serverId) };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, serialiseProperties(parseProperties(text), updates));
  };

  const switchJars = (serverId: string, enabled: boolean, actor: Actor): void => {
    market
      .list(serverId)
      .filter((e) => VOICE_FILE.test(e.fileName) && e.enabled !== enabled)
      .forEach((e) => market.setEnabled(serverId, e.fileName, enabled, actor));
  };

  const enable = async (
    serverId: string,
    publicPort: number | null,
    actor: Actor,
  ): Promise<VoiceChatResult> => {
    configDirOf(serverId);
    switchJars(serverId, true, actor);
    try {
      await market.installFrom(serverId, SOURCE, PROJECT_ID, actor);
    } catch (err) {
      // Already there (also from another marketplace) is fine: it only has to be switched on.
      if (!(err instanceof AppError && err.code === 'content_already_installed')) throw err;
    }
    const row = servers.row(serverId);
    const existing = row.extraPorts.find((p) => p.purpose === VOICE_PURPOSE);
    const port = existing?.port ?? servers.freePort(PORT_VOICE_CHAT, 'udp', serverId);
    if (!existing) {
      servers.setExtraPorts(serverId, [
        ...row.extraPorts,
        { port, containerPort: PORT_VOICE_CHAT, protocol: 'udp', purpose: VOICE_PURPOSE },
      ]);
    }
    servers.setVoiceChat(serverId, true, publicPort);
    writeConfig(serverId);
    ctx.audit.record(actor, 'voicechat.enable', serverId, { port, publicPort });
    return {
      enabled: true,
      port,
      voiceHost: servers.voiceHost(serverId),
      restartRequired: servers.isRunning(serverId),
    };
  };

  const disable = (serverId: string, actor: Actor): VoiceChatResult => {
    switchJars(serverId, false, actor);
    const row = servers.row(serverId);
    servers.setExtraPorts(
      serverId,
      row.extraPorts.filter((p) => p.purpose !== VOICE_PURPOSE),
    );
    servers.setVoiceChat(serverId, false, null);
    ctx.audit.record(actor, 'voicechat.disable', serverId);
    return { enabled: false, port: null, voiceHost: null, restartRequired: servers.isRunning(serverId) };
  };

  // Before each start the address may have changed (panel domain, public port), so write it again.
  servers.onBeforeStart((serverId) => {
    try {
      if (servers.row(serverId).voiceChat) writeConfig(serverId);
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'voice chat config not written');
    }
  });

  return {
    set: (serverId, input, actor) =>
      serial(serverId, async () =>
        input.enabled ? enable(serverId, input.publicPort ?? null, actor) : disable(serverId, actor),
      ),
    writeConfig,
  };
}
