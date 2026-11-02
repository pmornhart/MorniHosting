import { errorMessage } from '../lib/errors.js';
import { fetchResponse } from '../lib/http-client.js';
import { MS_PER_SECOND } from '../lib/units.js';

/**
 * A small Discord bot client: the REST calls the panel needs (who am I, register /verbinden, write a private
 * message, answer a button click) and a Gateway connection that delivers clicks and commands. The Gateway needs
 * no open port at home, so it works behind any router. Messages only ever go to people privately (DM).
 */

const API = 'https://discord.com/api/v10';
const GATEWAY_QUERY = '?v=10&encoding=json';
const RECONNECT_MIN_SECONDS = 5;
const RECONNECT_MAX_SECONDS = 300;
const RECONNECT_FACTOR = 2;

/** Gateway opcodes, https://docs.discord.com/developers/topics/opcodes-and-status-codes#gateway */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
/** Only "guilds": interactions need no intent; this one tells us when the bot joins a server. */
const INTENT_GUILDS = 1;

/** Interaction types and answers, https://docs.discord.com/developers/interactions/receiving-and-responding */
export const INTERACTION_COMMAND = 2;
export const INTERACTION_COMPONENT = 3;
export const REPLY_MESSAGE = 4;
export const REPLY_UPDATE_MESSAGE = 7;
const FLAG_EPHEMERAL = 64;
const COMPONENT_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_SUCCESS = 3;
const BUTTON_DANGER = 4;
const BUTTON_LINK = 5;
/** The /verbinden command: usable by people who added the app to their account, in the bot's DM. */
const INTEGRATION_GUILD_INSTALL = 0;
const INTEGRATION_USER_INSTALL = 1;
/** Where /verbinden works: servers, the bot's DM and any other DM or group, so nobody has to find the bot's chat first. */
const CONTEXT_GUILD = 0;
const CONTEXT_BOT_DM = 1;
const CONTEXT_PRIVATE_CHANNEL = 2;
const OPTION_STRING = 3;
export const LINK_COMMAND = 'verbinden';

export interface DiscordButton {
  readonly label: string;
  /** Our own id ("mh:…"); or a link to open. */
  readonly id?: string;
  readonly url?: string;
  readonly style?: 'approve' | 'reject';
}

export interface DiscordMessage {
  readonly title: string;
  readonly text: string;
  readonly colour?: number;
  readonly fields?: readonly { readonly name: string; readonly value: string }[];
  readonly buttons?: readonly DiscordButton[];
}

export interface DiscordInteraction {
  readonly id: string;
  readonly token: string;
  readonly type: number;
  readonly userId: string;
  readonly userName: string;
  /** Command option "code", or the clicked button's id. */
  readonly value: string;
}

export interface DiscordBot {
  readonly id: string;
  readonly name: string;
}

/** Everything that talks to Discord; tests replace it. */
export interface DiscordApi {
  readonly whoAmI: (token: string) => Promise<DiscordBot>;
  readonly registerCommands: (token: string, appId: string) => Promise<void>;
  /** Bot profile picture, app icon and the description shown on the bot's profile. */
  readonly brand: (
    token: string,
    look: { readonly avatar: string; readonly description: string },
  ) => Promise<void>;
  readonly sendDm: (token: string, userId: string, message: DiscordMessage) => Promise<void>;
  readonly reply: (
    interaction: DiscordInteraction,
    type: number,
    message: DiscordMessage | null,
  ) => Promise<void>;
  /** Stays connected (reconnecting by itself) until the returned function is called. */
  readonly connect: (
    token: string,
    onInteraction: (interaction: DiscordInteraction) => void,
    onStatus: (online: boolean, error: string | null) => void,
    /** The bot is on a server (joined just now, or seen again after connecting). */
    onServer?: () => void,
  ) => () => void;
}

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

const call = async (token: string, method: string, path: string, body?: unknown): Promise<unknown> => {
  const response = await fetchResponse(`${API}${path}`, {
    method,
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const info = (json ?? {}) as { code?: number; message?: string };
    throw new DiscordError(response.status, info.code ?? null, info.message ?? response.statusText);
  }
  return json;
};

const BUTTON_STYLES = { approve: BUTTON_SUCCESS, reject: BUTTON_DANGER } as const;

/** Discord's message shape: one embed, buttons in one row. */
export function toDiscordPayload(message: DiscordMessage | null): object {
  if (!message) return { components: [] };
  const buttons = message.buttons ?? [];
  return {
    embeds: [
      {
        title: message.title,
        description: message.text,
        color: message.colour,
        fields: message.fields?.map((f) => ({ name: f.name, value: f.value, inline: true })),
      },
    ],
    components: buttons.length
      ? [
          {
            type: COMPONENT_ROW,
            components: buttons.map((b) =>
              b.url
                ? { type: COMPONENT_BUTTON, style: BUTTON_LINK, label: b.label, url: b.url }
                : {
                    type: COMPONENT_BUTTON,
                    style: BUTTON_STYLES[b.style ?? 'approve'],
                    label: b.label,
                    custom_id: b.id,
                  },
            ),
          },
        ]
      : [],
  };
}

interface RawInteraction {
  id: string;
  token: string;
  type: number;
  user?: { id: string; username: string };
  member?: { user: { id: string; username: string } };
  data?: { custom_id?: string; options?: { name: string; value: string }[] };
}

const parseInteraction = (raw: RawInteraction): DiscordInteraction | null => {
  const user = raw.user ?? raw.member?.user;
  if (!user) return null;
  return {
    id: raw.id,
    token: raw.token,
    type: raw.type,
    userId: user.id,
    userName: user.username,
    value: raw.data?.custom_id ?? raw.data?.options?.find((o) => o.name === 'code')?.value ?? '',
  };
};

export const realDiscord: DiscordApi = {
  whoAmI: async (token) => {
    const me = (await call(token, 'GET', '/users/@me')) as { id: string; username: string };
    return { id: me.id, name: me.username };
  },
  registerCommands: async (token, appId) => {
    await call(token, 'PUT', `/applications/${appId}/commands`, [
      {
        name: LINK_COMMAND,
        description: 'Verbindet dich mit deinem MorniHosting-Konto',
        integration_types: [INTEGRATION_GUILD_INSTALL, INTEGRATION_USER_INSTALL],
        contexts: [CONTEXT_GUILD, CONTEXT_BOT_DM, CONTEXT_PRIVATE_CHANNEL],
        // Without a code the bot answers with a button that opens the panel; the code stays for panels without
        // a domain.
        options: [
          {
            type: OPTION_STRING,
            name: 'code',
            description: 'Nur nötig, wenn das Panel es sagt',
            required: false,
          },
        ],
      },
    ]);
  },
  brand: async (token, look) => {
    await call(token, 'PATCH', '/users/@me', { avatar: look.avatar });
    await call(token, 'PATCH', '/applications/@me', {
      icon: look.avatar,
      description: look.description,
      // Install links ask for the right things, so nobody has to tick anything in the Developer Portal.
      integration_types_config: {
        [INTEGRATION_GUILD_INSTALL]: {
          oauth2_install_params: { scopes: ['bot', 'applications.commands'], permissions: '0' },
        },
        [INTEGRATION_USER_INSTALL]: {
          oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' },
        },
      },
    });
  },
  sendDm: async (token, userId, message) => {
    const channel = (await call(token, 'POST', '/users/@me/channels', { recipient_id: userId })) as {
      id: string;
    };
    await call(token, 'POST', `/channels/${channel.id}/messages`, toDiscordPayload(message));
  },
  reply: async (interaction, type, message) => {
    const data =
      type === REPLY_MESSAGE
        ? {
            content: message ? `**${message.title}**\n${message.text}` : '',
            components: (toDiscordPayload(message) as { components: unknown[] }).components,
            flags: FLAG_EPHEMERAL,
          }
        : toDiscordPayload(message);
    const response = await fetchResponse(
      `${API}/interactions/${interaction.id}/${interaction.token}/callback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, data }),
      },
    );
    if (!response.ok) throw new DiscordError(response.status, null, await response.text());
  },
  connect: (token, onInteraction, onStatus, onServer) => {
    const state: {
      socket: WebSocket | null;
      heartbeat: NodeJS.Timeout | null;
      retry: NodeJS.Timeout | null;
      seq: number | null;
      delaySeconds: number;
      closed: boolean;
    } = {
      socket: null,
      heartbeat: null,
      retry: null,
      seq: null,
      delaySeconds: RECONNECT_MIN_SECONDS,
      closed: false,
    };

    const cleanup = (): void => {
      if (state.heartbeat) clearInterval(state.heartbeat);
      state.heartbeat = null;
      const socket = state.socket;
      state.socket = null;
      socket?.close();
    };
    const scheduleReconnect = (): void => {
      cleanup();
      if (state.closed || state.retry) return;
      state.retry = setTimeout(() => {
        state.retry = null;
        void open();
      }, state.delaySeconds * MS_PER_SECOND);
      state.delaySeconds = Math.min(state.delaySeconds * RECONNECT_FACTOR, RECONNECT_MAX_SECONDS);
    };
    const send = (op: number, d: unknown): void => state.socket?.send(JSON.stringify({ op, d }));

    const open = async (): Promise<void> => {
      try {
        const { url } = (await call(token, 'GET', '/gateway/bot')) as { url: string };
        const socket = new WebSocket(`${url}${GATEWAY_QUERY}`);
        state.socket = socket;
        socket.addEventListener('message', (event) => {
          const packet = JSON.parse(String(event.data)) as {
            op: number;
            d: unknown;
            s: number | null;
            t?: string;
          };
          if (packet.s !== null) state.seq = packet.s;
          if (packet.op === OP_HELLO) {
            const { heartbeat_interval: every } = packet.d as { heartbeat_interval: number };
            state.heartbeat = setInterval(() => send(OP_HEARTBEAT, state.seq), every);
            send(OP_IDENTIFY, {
              token,
              intents: INTENT_GUILDS,
              properties: { os: 'linux', browser: 'mornihosting', device: 'mornihosting' },
            });
          } else if (packet.op === OP_RECONNECT || packet.op === OP_INVALID_SESSION) {
            scheduleReconnect();
          } else if (packet.op === OP_DISPATCH && packet.t === 'READY') {
            state.delaySeconds = RECONNECT_MIN_SECONDS;
            onStatus(true, null);
          } else if (packet.op === OP_DISPATCH && packet.t === 'GUILD_CREATE') {
            onServer?.();
          } else if (packet.op === OP_DISPATCH && packet.t === 'INTERACTION_CREATE') {
            const interaction = parseInteraction(packet.d as RawInteraction);
            if (interaction) onInteraction(interaction);
          }
        });
        socket.addEventListener('close', (event) => {
          onStatus(false, event.reason || null);
          scheduleReconnect();
        });
      } catch (err) {
        onStatus(false, errorMessage(err));
        scheduleReconnect();
      }
    };

    void open();
    return () => {
      state.closed = true;
      if (state.retry) clearTimeout(state.retry);
      cleanup();
    };
  },
};
