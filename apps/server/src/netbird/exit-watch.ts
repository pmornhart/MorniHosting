import type { AppContext } from '../context.js';
import { MS_PER_MINUTE } from '../lib/units.js';
import type { AlertService } from '../alerts/service.js';
import type { NetbirdExit } from './exit.js';
import type { NetbirdAutomation } from './service.js';

/**
 * "Hausanschluss verstecken" watched: every few minutes the panel checks whether its traffic really leaves
 * through the NetBird exit. Is it not hidden twice in a row, the admins are alerted (Discord + mail) with the one
 * command to paste on the NetBird server; once it is hidden again, a short all-clear.
 */

const CHECK_EVERY_MINUTES = 5;
const CHECK_EVERY_MS = CHECK_EVERY_MINUTES * MS_PER_MINUTE;
/** Checks in a row that must fail before anyone is told (switching takes a moment). */
const FAILS_BEFORE_ALERT = 2;
const FIRST_CHECK_MS = 60_000;
const ALERT_KEY = 'netbird-exit';
const FIX_COMMAND =
  'bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-exit-node.sh)"';

export interface ExitWatch {
  readonly start: () => void;
  readonly stop: () => void;
  /** One check right now (also used by tests). */
  readonly checkNow: () => Promise<void>;
}

export function createExitWatch(
  ctx: AppContext,
  exit: NetbirdExit,
  alerts: AlertService,
  netbird?: NetbirdAutomation,
): ExitWatch {
  const run: { timer: NodeJS.Timeout | null; fails: number } = { timer: null, fails: 0 };

  /** NetBird repairs itself first: new machine id taken over, leftovers of deleted servers removed. */
  const heal = async (): Promise<void> => {
    const healed = await netbird?.heal();
    if (!healed) return;
    if (healed.peerMoved) await exit.repair();
    alerts.alert({
      key: 'netbird-heal',
      title: 'NetBird von selbst repariert',
      what: [
        healed.peerMoved
          ? `Dein MorniHosting-Rechner hat in NetBird eine neue ID (${healed.peerMoved}). Das Panel hat alle Adressen und den Ausgang auf ihn umgezogen.`
          : '',
        healed.removed.length ? `Reste gelöschter Server entfernt: ${healed.removed.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      status: 'fixed',
    });
  };

  const checkNow = async (): Promise<void> => {
    try {
      await heal();
    } catch (err) {
      ctx.log.debug({ err }, 'NetBird self-repair failed');
    }
    const status = await exit.status();
    if (!status.enabled || status.hidden === null) return;
    const name = status.exitPeerName ?? status.exitIp ?? 'NetBird-Server';
    if (status.hidden) {
      run.fails = 0;
      alerts.resolved(
        ALERT_KEY,
        'Hausanschluss wieder versteckt',
        `Das Panel geht wieder über ${name} ins Internet.`,
      );
      return;
    }
    run.fails += 1;
    // First try to repair it: group and route set up again (e.g. after the machine got a new NetBird id).
    if (run.fails === 1) {
      await exit.repair();
      return;
    }
    if (run.fails < FAILS_BEFORE_ALERT) return;
    alerts.alert({
      key: ALERT_KEY,
      title: 'Hausanschluss nicht mehr versteckt',
      what: `Der NetBird-Ausgang ${name} antwortet nicht. Das Panel geht gerade direkt über deinen Hausanschluss ins Internet – alles läuft weiter, nur nicht versteckt.`,
      status: 'action',
      action:
        'Diesen Befehl als root auf dem NetBird-Server einfügen. Danach schaltet sich der Ausgang spätestens nach 10 Minuten von selbst wieder ein.',
      command: FIX_COMMAND,
    });
  };

  return {
    start: () => {
      // Once shortly after the start (e.g. after the container was connected to NetBird again), then regularly.
      setTimeout(() => {
        void (async () => {
          try {
            await checkNow();
          } catch (err) {
            ctx.log.debug({ err }, 'exit watch check failed');
          }
        })();
      }, FIRST_CHECK_MS).unref();
      run.timer = setInterval(() => {
        void (async () => {
          try {
            await checkNow();
          } catch (err) {
            ctx.log.debug({ err }, 'exit watch check failed');
          }
        })();
      }, CHECK_EVERY_MS);
      run.timer.unref();
    },
    stop: () => {
      if (run.timer) clearInterval(run.timer);
    },
    checkNow,
  };
}
