import type { CreateServerInput, ServerState, ServerSummary, SetupStep } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import type { GeyserService } from '../geyser/service.js';
import type { ScheduleService } from '../schedules/service.js';
import type { ServerService } from '../servers/service.js';
import type { VoiceChatService } from '../voicechat/service.js';
import { MS_PER_HOUR } from '../lib/units.js';

/**
 * Ordering a server: it is created at once (the page opens right away and shows a setup screen), then the panel
 * loads all plugins at the same time, sets up Geyser (+ ViaVersion), voice chat and the daily backup one after
 * another and starts it – the setup screen stays until the server really runs, so nobody changes things halfway.
 */

const BACKUP_TIME = '04:00';
/** Big games (CS2) download for hours on the first start; after that the screen gives way anyway. */
const FIRST_START_LIMIT_HOURS = 6;
const FIRST_START_LIMIT_MS = FIRST_START_LIMIT_HOURS * MS_PER_HOUR;
const START_ENDS: readonly ServerState[] = ['running', 'crashed', 'stopped'];

export interface OrderService {
  readonly create: (input: CreateServerInput, actor: Actor, creator: UserRow) => Promise<ServerSummary>;
}

interface Step {
  readonly key: SetupStep;
  readonly on: boolean;
  readonly label: string;
  readonly run: () => Promise<unknown>;
  /** Takes the tick back when setting it up did not work. */
  readonly undo?: () => void;
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

  /** Resolves once the first start is over: running, crashed or stopped (or after the time limit). */
  const firstStartOver = (serverId: string): Promise<void> =>
    new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(finish, FIRST_START_LIMIT_MS);
      const off = ctx.events.on('server.state', (event) => {
        if (event.serverId === serverId && START_ENDS.includes(event.state)) finish();
      });
    });

  const setUp = async (serverId: string, input: CreateServerInput, actor: Actor): Promise<void> => {
    const addOns = input.addOns;
    const steps: readonly Step[] = [
      {
        key: 'download',
        on: addOns?.geyser === true || addOns?.voice === true,
        label: 'Plugins herunterladen',
        // All at once: the installs below then only copy from the cache.
        run: () =>
          Promise.all([
            addOns?.geyser ? geyser.prefetch(serverId) : null,
            addOns?.voice ? voice.prefetch(serverId) : null,
          ]),
      },
      {
        key: 'geyser',
        on: addOns?.geyser === true,
        label: 'Geyser (Bedrock-Spieler) + ViaVersion',
        run: () => geyser.set(serverId, true, actor),
        undo: () => servers.setGeyser(serverId, false),
      },
      {
        key: 'voice',
        on: addOns?.voice === true,
        label: 'Simple Voice Chat',
        run: () => voice.set(serverId, { enabled: true }, actor),
        undo: () => servers.setVoiceChat(serverId, false, null),
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
      {
        key: 'start',
        on: input.startNow === true,
        label: 'Erster Start',
        run: async () => {
          const over = firstStartOver(serverId);
          await servers.start(serverId, actor);
          await over;
        },
      },
    ];
    const chosen = steps.filter((step) => step.on);
    const show = (doneCount: number): void =>
      servers.setSetup(serverId, {
        pending: chosen.slice(doneCount).map((step) => step.key),
        done: chosen.slice(0, doneCount).map((step) => step.key),
      });
    show(0);
    await chosen.reduce(async (previous, step, index) => {
      await previous;
      if (step.key !== 'download' && step.key !== 'start')
        servers.note(serverId, `Richte ${step.label} ein …`);
      try {
        await step.run();
        if (step.key !== 'start') servers.note(serverId, `✓ ${step.label} ist fertig.`);
      } catch (err) {
        ctx.log.warn({ err, serverId, step: step.key }, 'step of the order failed');
        step.undo?.();
        servers.note(serverId, `✗ ${step.label} hat nicht geklappt: ${errorMessage(err)}`);
      }
      show(index + 1);
    }, Promise.resolve());
    servers.setSetup(serverId, null);
  };

  const create: OrderService['create'] = async (input, actor, creator) => {
    const wanted = input.addOns && (input.addOns.geyser || input.addOns.voice || input.addOns.backups);
    if (!wanted && !input.startNow) return servers.create(input, actor, creator);
    const summary = await servers.create({ ...input, startNow: false }, actor, creator);
    // Ticked at the order = switched on right away; the setup below fills in plugins and ports.
    if (input.addOns?.geyser) servers.setGeyser(summary.id, true);
    if (input.addOns?.voice) servers.setVoiceChat(summary.id, true, null);
    void (async () => {
      try {
        await setUp(summary.id, input, actor);
      } catch (err) {
        servers.setSetup(summary.id, null);
        ctx.log.error({ err, serverId: summary.id }, 'setting up the order failed');
      }
    })();
    return summary;
  };

  return { create };
}
