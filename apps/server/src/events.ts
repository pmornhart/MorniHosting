import { EventEmitter } from 'node:events';
import type { CrashInfo, ServerLive, ServerState } from '@mornihosting/shared';

export interface PanelEvents {
  'server.state': { serverId: string; state: ServerState; previous: ServerState };
  'server.live': { serverId: string; live: ServerLive };
  'server.log': { serverId: string; line: string };
  'server.crashed': { serverId: string; crash: CrashInfo };
  /** `coupon` is the voucher code from the order page, if any. */
  'server.created': { serverId: string; userId: number; coupon?: string | null };
  'server.deleted': { serverId: string };
  /** Who may do what changed: roles, admin rights, a user locked, deleted or a Minecraft account linked. */
  'access.changed': { userId: number | null };
  'player.joined': { serverId: string; player: string };
  'player.left': { serverId: string; player: string };
  'backup.done': { serverId: string; backupId: number; sizeBytes: number };
  'backup.failed': { serverId: string; backupId: number; error: string };
  /** Someone confirmed their sign-up and waits for an admin to let them in. */
  'user.awaiting_approval': { userId: number };
  /** Someone without the right to order asked for a server. */
  'server.requested': { requestId: string };
  /** A sign-up or server request was decided; `userId` is the person it was about (null when deleted). */
  'approvals.changed': { userId: number | null };
  /** A mail could not be handed to the mail server (unreachable, login refused …). */
  'mail.failed': { error: string };
  /** Always-on could not start a server that should run (tries counts up; 0 = it runs again). */
  'server.revive': {
    serverId: string;
    tries: number;
    reason: string | null;
    code?: string;
    params?: Readonly<Record<string, unknown>>;
  };
}

export type PanelEventName = keyof PanelEvents;
export type PanelListener<TName extends PanelEventName> = (payload: PanelEvents[TName]) => void;

export interface EventBus {
  readonly on: <TName extends PanelEventName>(name: TName, listener: PanelListener<TName>) => () => void;
  readonly emit: <TName extends PanelEventName>(name: TName, payload: PanelEvents[TName]) => void;
}

/** In-process event bus: services publish what happened, the WebSocket hub, webhooks and stats listen. */
export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    on: (name, listener) => {
      emitter.on(name, listener);
      return () => emitter.off(name, listener);
    },
    emit: (name, payload) => {
      emitter.emit(name, payload);
    },
  };
}
