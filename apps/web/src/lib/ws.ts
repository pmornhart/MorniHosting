import type { WsClientMessage, WsServerMessage } from '@mornihosting/shared';
import { csrfToken, apiUrl } from './api';

type Listener = (message: WsServerMessage) => void;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PING_INTERVAL_MS = 25000;
const BACKOFF_FACTOR = 2;
const OPEN = 1;

/**
 * One shared WebSocket for the whole app. Subscriptions are remembered and sent again
 * after a reconnect, so a dropped connection heals without the page noticing.
 */
const state: {
  socket: WebSocket | null;
  delay: number;
  servers: number;
  consoles: Map<string, number>;
  ping: number | null;
  connected: boolean;
} = { socket: null, delay: RECONNECT_MIN_MS, servers: 0, consoles: new Map(), ping: null, connected: false };
const listeners = new Set<Listener>();
const statusListeners = new Set<(connected: boolean) => void>();

function send(message: WsClientMessage): void {
  if (state.socket?.readyState === OPEN) state.socket.send(JSON.stringify(message));
}

function resubscribe(): void {
  if (state.servers) send({ type: 'subscribe', channel: 'servers' });
  state.consoles.forEach((_count, serverId) => send({ type: 'subscribe', channel: 'console', serverId }));
}

function setConnected(value: boolean): void {
  state.connected = value;
  statusListeners.forEach((l) => l(value));
}

function connect(): void {
  if (state.socket) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}${apiUrl('/api/ws')}`);
  state.socket = socket;
  socket.addEventListener('open', () => {
    state.delay = RECONNECT_MIN_MS;
    setConnected(true);
    send({ type: 'hello', csrf: csrfToken() });
    resubscribe();
    state.ping = window.setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);
  });
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    try {
      const message = JSON.parse(event.data) as WsServerMessage; // the server only sends this union
      listeners.forEach((l) => l(message));
    } catch {
      // A broken frame carries nothing we could show.
    }
  });
  socket.addEventListener('close', () => {
    if (state.ping) window.clearInterval(state.ping);
    state.socket = null;
    setConnected(false);
    if (!state.servers && !state.consoles.size) return;
    window.setTimeout(connect, state.delay);
    state.delay = Math.min(RECONNECT_MAX_MS, state.delay * BACKOFF_FACTOR);
  });
}

export function onMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onConnectionChange(listener: (connected: boolean) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function isConnected(): boolean {
  return state.connected;
}

export function subscribeServers(): () => void {
  state.servers += 1;
  connect();
  send({ type: 'subscribe', channel: 'servers' });
  return () => {
    state.servers -= 1;
  };
}

export function subscribeConsole(serverId: string): () => void {
  state.consoles.set(serverId, (state.consoles.get(serverId) ?? 0) + 1);
  connect();
  send({ type: 'subscribe', channel: 'console', serverId });
  return () => {
    const left = (state.consoles.get(serverId) ?? 1) - 1;
    if (left) state.consoles.set(serverId, left);
    else {
      state.consoles.delete(serverId);
      send({ type: 'unsubscribe', channel: 'console', serverId });
    }
  };
}

export function disconnect(): void {
  state.servers = 0;
  state.consoles.clear();
  state.socket?.close();
}
