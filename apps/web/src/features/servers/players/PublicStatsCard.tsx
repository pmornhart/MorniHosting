import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { PublicStatsSetting } from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';

/** Switch for the public statistics page (who plays, who died how) and its link. */
export function PublicStatsCard({ serverId, canEdit }: { serverId: string; canEdit: boolean }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ['public-stats-setting', serverId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<PublicStatsSetting>(`/api/servers/${serverId}/public-stats`),
  });
  const set = useMutation({
    mutationFn: (enabled: boolean) =>
      api<PublicStatsSetting>(`/api/servers/${serverId}/public-stats`, { method: 'PUT', body: { enabled } }),
    onSuccess: (result) => queryClient.setQueryData(key, result),
    onError: (err) => toast.error(errorText(err)),
  });
  const url = data ? `${window.location.origin}/stats/${data.slug}` : '';
  return (
    <Card className="grid gap-3 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-primary/12 text-primary">
          <Globe className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle>{t('publicStats.cardTitle')}</CardTitle>
          <CardDescription>{t('publicStats.cardText')}</CardDescription>
        </div>
        <Switch
          checked={data?.enabled ?? false}
          disabled={!data || !canEdit || set.isPending}
          onCheckedChange={(on) => set.mutate(on)}
          aria-label={t('publicStats.cardTitle')}
        />
      </div>
      {data?.enabled ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-[10px] border border-border bg-secondary/40 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-sm">{url}</code>
          <CopyButton text={url} />
          <Button asChild size="sm" variant="secondary">
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              {t('publicStats.open')}
            </a>
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
