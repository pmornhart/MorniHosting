import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ServerDetail, ViaStatus } from '@mornihosting/shared';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';

/** "All versions": ViaVersion + ViaBackwards (ViaFabric on Fabric) with one switch; kept up to date by the panel. */
export function ViaCard({ server }: { server: ServerDetail }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ['via', server.id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<ViaStatus>(`/api/servers/${server.id}/via`),
  });
  const set = useMutation({
    mutationFn: (enabled: boolean) =>
      api<ViaStatus>(`/api/servers/${server.id}/via`, { method: 'PUT', body: { enabled } }),
    onSuccess: (status) => {
      queryClient.setQueryData(key, status);
      void queryClient.invalidateQueries({ queryKey: ['content', server.id] });
      if (status.restartRequired) toast.info(t('via.restart'));
    },
  });
  const on = data?.enabled ?? false;
  return (
    <Card className="grid gap-3 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <CardHeader className="mb-0">
          <CardTitle className="flex items-center gap-2">
            <History className="size-4 text-primary" aria-hidden />
            {t('via.title')}
          </CardTitle>
          <CardDescription>{t('via.text')}</CardDescription>
        </CardHeader>
        <Switch
          checked={on}
          disabled={!data || set.isPending}
          onCheckedChange={(v) => set.mutate(v)}
          aria-label={t('via.title')}
        />
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Pill tone={on ? 'ok' : 'neutral'}>{on ? t('via.pillOn') : t('via.pillOff')}</Pill>
        <span className="text-muted-foreground">{on ? t('via.on') : t('via.off')}</span>
      </div>
    </Card>
  );
}
