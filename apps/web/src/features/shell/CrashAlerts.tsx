import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, LifeBuoy } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import type { CrashHelp, ServerSummary } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSession } from '@/features/auth/session';
import { useCrashFix } from '@/features/servers/overview/CrashCard';
import { serversQuery } from '@/features/servers/live';

const SHOWN_MAX = 3;

function CrashAlert({ server }: { server: ServerSummary }): ReactElement {
  const { t } = useTranslation();
  const { can } = useSession();
  const crash = server.crash;
  const { data } = useQuery({
    queryKey: ['crash-help', server.id, crash?.at],
    queryFn: () => api<{ help: CrashHelp | null }>(`/api/servers/${server.id}/crash`),
  });
  const fix = useCrashFix(server.id);
  const first = data?.help?.fixes.find((f) => !f.danger);
  const rule = crash && t(`crash.${crash.ruleId}.title`, { defaultValue: '' }) ? crash.ruleId : 'unknown';
  return (
    <div className="mh-alert-in grid gap-2 rounded-[14px] border border-destructive/50 bg-popover p-3.5 shadow-float">
      <div className="flex items-start gap-2.5">
        <LifeBuoy className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="grid min-w-0">
          <b className="truncate text-sm">{t('crash.popupTitle', { name: server.name })}</b>
          <span className="text-[13px] text-muted-foreground">
            {t(`crash.${rule}.title`, crash?.params ?? {})}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {first && can(server.id, 'control') ? (
          <Button
            size="sm"
            disabled={fix.isPending}
            onClick={() => fix.mutate({ fix: first.id, start: true })}
          >
            {t(`crash.fixes.${first.id}`, first.params)}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" asChild>
          <Link to={`/servers/${server.id}`}>{t('crash.popupOpen')}</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Stays in the corner on every page while a server has an unsolved crash – until it is repaired or the crash
 * helper on the server page is dismissed. It can be folded to a small badge, not closed.
 */
export function CrashAlerts(): ReactElement | null {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [folded, setFolded] = useState(false);
  const { data } = useQuery(serversQuery);
  const crashed = (data ?? []).filter(
    (s) =>
      s.crash &&
      (s.live.state === 'crashed' || s.live.state === 'stopped') &&
      !pathname.startsWith(`/servers/${s.id}`),
  );
  if (crashed.length === 0) return null;
  return (
    <div
      className="fixed z-40 grid w-[min(22rem,calc(100vw-2rem))] gap-2 max-sm:[&>*:nth-child(n+3)]:hidden"
      style={{
        right: 'max(1rem, env(safe-area-inset-right, 0px))',
        bottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
      }}
      role="status"
    >
      <button
        type="button"
        onClick={() => setFolded((f) => !f)}
        className={cn(
          'flex items-center justify-between gap-2 justify-self-end rounded-full bg-destructive px-3 py-1.5 text-[13px] font-semibold text-white shadow-float',
          !folded && 'mh-ping',
        )}
      >
        <LifeBuoy className="size-4" aria-hidden />
        {t('crash.popupCount', { count: crashed.length })}
        {folded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      {folded ? null : crashed.slice(0, SHOWN_MAX).map((s) => <CrashAlert key={s.id} server={s} />)}
    </div>
  );
}
