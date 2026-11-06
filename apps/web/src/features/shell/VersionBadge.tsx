import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, ExternalLink, GitCommitHorizontal, Sparkles } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ChangeList } from '@/components/change-list';
import { Link } from 'react-router';
import type { Changelog } from '@mornihosting/shared';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useSession } from '@/features/auth/session';
import { updateQuery } from './UpdateCard';

const changelogQuery = {
  queryKey: ['changelog'],
  queryFn: () => api<Changelog>('/api/system/changelog'),
  staleTime: Infinity,
} as const;
const SKELETON_ROWS = ['a', 'b', 'c', 'd'];

/** "v1.0.0 · a1b2c3d" at the bottom of the menu; a click shows what is new in this version. */
export function VersionBadge({ onNavigate }: { onNavigate?: () => void }): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const { data } = useQuery(changelogQuery);
  const { data: update } = useQuery({ ...updateQuery, enabled: me.user.isAdmin, retry: false });
  const release = data?.release ? `v${data.release}` : null;
  // The version number alone ("v0.8.4"); the commit only when there is no number.
  const label = release ?? data?.commit ?? t('version.dev');
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center gap-1.5 rounded-[8px] px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={t('changelog.open')}
      >
        <GitCommitHorizontal className="size-3.5" aria-hidden />
        {label}
        {update?.available ? (
          <span className="size-1.5 rounded-full bg-primary" aria-label={t('changelog.updateDot')} />
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" aria-hidden />
            {t('changelog.title')}
          </DialogTitle>
          <DialogDescription>{t('changelog.running', { version: label })}</DialogDescription>
          {update?.available ? (
            <Link
              to="/settings#update"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2 rounded-[12px] bg-accent px-3 py-2.5 text-sm font-semibold"
            >
              <ArrowUpCircle className="size-4 text-primary" aria-hidden />
              {t('changelog.updateReady', { count: update.behind })}
            </Link>
          ) : null}
          <div className="grid max-h-[50vh] gap-1 overflow-y-auto">
            {data ? null : SKELETON_ROWS.map((k) => <Skeleton key={k} className="h-11" />)}
            {data?.failed ? <p className="text-sm text-muted-foreground">{t('changelog.failed')}</p> : null}
            {data ? <ChangeList changes={data.changes} /> : null}
          </div>
          {data?.url ? (
            <a
              href={data.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              <ExternalLink className="size-4" aria-hidden />
              {t('changelog.all')}
            </a>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
