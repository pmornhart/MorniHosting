import type { AddOnKey, CreateServerInput, ServerSummary } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import type { GeyserService } from '../geyser/service.js';
import type { ScheduleService } from '../schedules/service.js';
import type { ServerService } from '../servers/service.js';
import type { VoiceChatService } from '../voicechat/service.js';

/**
 * Ordering a server with add-ons: the server is created at once (the page opens right away), then the panel
 * sets up Geyser (+ ViaVersion), voice chat and the daily backup one after another, and only then starts it –
 * so everything is in place on the very first start, with the right ports.
 */

const BACKUP_TIME = '04:00';

export interface OrderService {
  readonly create: (input: CreateServerInput, actor: Actor, creator: UserRow) => Promise<ServerSummary>;
}

export function createOrderService(
  ctx: AppContext,
  deps: {
    readonly servers: ServerService;
    readonly geyser: GeyserService;
    readonly voice: VoiceChatService;
    readonly schedules: ScheduleService;
  },
): OrderService {
  const { servers, geyser, voice, schedules } = deps;

  const setUp = async (serverId: string, input: CreateServerInput, actor: Actor): Promise<void> => {
    const addOns = input.addOns;
    const steps: readonly {
      readonly key: AddOnKey;
      readonly on: boolean;
      readonly label: string;
      readonly run: () => Promise<unknown>;
    }[] = [
      {
        key: 'geyser',
        on: addOns?.geyser === true,
        label: 'Geyser (Bedrock-Spieler) + ViaVersion',
        run: () => geyser.set(serverId, true, actor),
      },
      {
        key: 'voice',
        on: addOns?.voice === true,
        label: 'Simple Voice Chat',
        run: () => voice.set(serverId, { enabled: true }, actor),
      },
      {
        key: 'backups',
        on: addOns?.backups === true,
        label: `Tägliches Backup um ${BACKUP_TIME}`,
        run: async () =>
          schedules.create(
            serverId,
            {
              name: 'Tägliches Backup',
              action: 'backup',
              spec: { kind: 'daily', time: BACKUP_TIME },
              enabled: true,
              warnMinutes: 0,
            },
            actor,
          ),
      },
    ];
    const chosen = steps.filter((step) => step.on);
    // The switches on the server page show these as on and busy until each one is done.
    servers.setSetup(
      serverId,
      chosen.map((step) => step.key),
    );
    await chosen.reduce(async (previous, step, index) => {
      await previous;
      servers.note(serverId, `Richte ${step.label} ein …`);
      try {
        await step.run();
        servers.note(serverId, `✓ ${step.label} ist fertig.`);
      } catch (err) {
        ctx.log.warn({ err, serverId }, 'add-on from the order failed');
        servers.note(serverId, `✗ ${step.label} hat nicht geklappt: ${errorMessage(err)}`);
      }
      servers.setSetup(
        serverId,
        chosen.slice(index + 1).map((later) => later.key),
      );
    }, Promise.resolve());
    if (input.startNow) await servers.start(serverId, actor);
  };

  const create: OrderService['create'] = async (input, actor, creator) => {
    const wanted = input.addOns && (input.addOns.geyser || input.addOns.voice || input.addOns.backups);
    if (!wanted) return servers.create(input, actor, creator);
    const summary = await servers.create({ ...input, startNow: false }, actor, creator);
    void setUp(summary.id, input, actor).catch((err: unknown) =>
      ctx.log.error({ err, serverId: summary.id }, 'setting up the order failed'),
    );
    return summary;
  };

  return { create };
}
