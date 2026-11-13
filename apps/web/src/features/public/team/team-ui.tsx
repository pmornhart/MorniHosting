import { Gavel, Lock, MicOff, Snowflake, UserX } from 'lucide-react';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamAction, TeamBoardView } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const SECOND_MS = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const MINUTE_MS = SECONDS_PER_MINUTE * SECOND_MS;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
const PAD = 2;

/** "9:41", "2 Std. 5 Min.", "3 Tage" – how long something still lasts. */
export function useLeft(): (until: number) => string {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => clearInterval(timer);
  }, []);
  return (until) => {
    const ms = Math.max(0, until - now);
    if (ms < HOUR_MS) {
      const s = Math.floor(ms / SECOND_MS);
      return `${Math.floor(s / SECONDS_PER_MINUTE)}:${String(s % SECONDS_PER_MINUTE).padStart(PAD, '0')}`;
    }
    if (ms < DAY_MS)
      return t('teamBoard.hoursMinutes', {
        h: Math.floor(ms / HOUR_MS),
        m: Math.floor((ms % HOUR_MS) / MINUTE_MS),
      });
    return t('teamBoard.days', { count: Math.floor(ms / DAY_MS) });
  };
}

/** Durations offered for jail, mute and ban (minutes; 0 = for good, bans only). */
const SHORT = 5;
const TEN = 10;
const HALF_HOUR = 30;
const SIX_HOURS = 6;
const DAY_MINUTES = HOURS_PER_DAY * MINUTES_PER_HOUR;
const DURATIONS = [
  SHORT,
  TEN,
  HALF_HOUR,
  MINUTES_PER_HOUR,
  SIX_HOURS * MINUTES_PER_HOUR,
  DAY_MINUTES,
  DAYS_PER_WEEK * DAY_MINUTES,
] as const;
const FOREVER = 0;

export function durationLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  minutes: number,
): string {
  if (minutes === FOREVER) return t('teamBoard.forever');
  if (minutes < SECONDS_PER_MINUTE) return t('teamBoard.minutes', { count: minutes });
  const hours = minutes / SECONDS_PER_MINUTE;
  const hoursPerDay = DAY_MS / HOUR_MS;
  if (hours < hoursPerDay) return t('teamBoard.hours', { count: hours });
  return t('teamBoard.days', { count: hours / hoursPerDay });
}

const ICONS: Partial<Record<TeamAction, ReactNode>> = {
  jail: <Lock className="size-4" aria-hidden />,
  mute: <MicOff className="size-4" aria-hidden />,
  freeze: <Snowflake className="size-4" aria-hidden />,
  kick: <UserX className="size-4" aria-hidden />,
  ban: <Gavel className="size-4" aria-hidden />,
};

/**
 * Jail, mute or ban with a duration and a reason (also for players who are offline – typed name). Kick only asks
 * for the reason.
 */
export function PunishDialog({
  action,
  name,
  onClose,
  onSend,
  busy,
}: {
  action: 'jail' | 'mute' | 'ban' | 'kick' | null;
  name: string;
  onClose: () => void;
  onSend: (request: { minutes?: number; reason: string; target: string }) => void;
  busy: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState<number>(DURATIONS[1]);
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState(name);
  useEffect(() => {
    setTarget(name);
    setReason('');
    setMinutes(action === 'ban' ? FOREVER : DURATIONS[1]);
  }, [action, name]);
  const options = action === 'ban' ? [...DURATIONS, FOREVER] : DURATIONS;
  return (
    <Dialog open={action !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogTitle className="flex items-center gap-2">
          {action ? ICONS[action] : null}
          {action ? t(`teamBoard.do.${action}`) : ''}
        </DialogTitle>
        <DialogDescription>{t(`teamBoard.doText.${action ?? 'jail'}`)}</DialogDescription>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="team-target">{t('teamBoard.player')}</Label>
            <Input id="team-target" value={target} onChange={(e) => setTarget(e.target.value.trim())} />
          </div>
          {action === 'kick' ? null : (
            <div className="grid gap-1.5">
              <Label>{t('teamBoard.duration')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {options.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMinutes(m)}
                    style={{ color: 'inherit' }}
                    className={cn(
                      'rounded-full border px-3 py-1 text-sm transition',
                      m === minutes
                        ? 'border-primary bg-primary/15 font-semibold'
                        : 'border-border hover:bg-secondary',
                    )}
                  >
                    {durationLabel(t, m)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="team-reason">{t('teamBoard.reason')}</Label>
            <Input
              id="team-reason"
              value={reason}
              maxLength={120}
              placeholder={t('teamBoard.reasonHint')}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('teamBoard.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={busy || target.length < 1}
            onClick={() => onSend({ target, reason, ...(action === 'kick' ? {} : { minutes }) })}
          >
            {action ? t(`teamBoard.do.${action}`) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A rank name in its colour, as a small pill. */
export function RankPill({ name, color }: { name: string; color: string }): ReactElement | null {
  if (!name) return null;
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold"
      style={{ color, borderColor: `${color}66`, background: `${color}1a` }}
    >
      {name}
    </span>
  );
}

/** One of the counters at the top. */
export function Tile({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone: 'ok' | 'bad' | 'warn' | 'info' | 'live';
}): ReactElement {
  const tones = {
    ok: 'text-emerald-400 bg-emerald-400/10',
    bad: 'text-red-400 bg-red-400/10',
    warn: 'text-amber-400 bg-amber-400/10',
    info: 'text-sky-400 bg-sky-400/10',
    live: 'text-rose-400 bg-rose-400/10',
  } as const;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4" data-slot="card">
      <span className={cn('grid size-11 place-items-center rounded-xl', tones[tone])}>{icon}</span>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-none tabular-nums">{value}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

export type Board = TeamBoardView;
