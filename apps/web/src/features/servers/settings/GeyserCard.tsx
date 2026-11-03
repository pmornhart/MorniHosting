import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, HelpCircle, Radar, RotateCw, Smartphone, XCircle } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { GeyserCheck, ServerDetail, SoftwareId } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { ProjectLogo } from '@/components/project-logo';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useServerAction } from '@/features/dashboard/ServerCard';

/** Server software that Geyser and Floodgate exist for. */
export const GEYSER_SOFTWARE: readonly SoftwareId[] = [
  'paper',
  'purpur',
  'custom',
  'velocity',
  'fabric',
  'neoforge',
];

interface GeyserResult {
  readonly enabled: boolean;
  readonly port: number | null;
  readonly restartRequired: boolean;
}

/** One switch so friends on phones, consoles and Windows (Bedrock) can join a Java server. */
/** "Bedrock-Verbindung prüfen": inside the server and from the internet, each with a tip if it fails. */
function BedrockCheck({ serverId, running }: { serverId: string; running: boolean }): ReactElement {
  const { t } = useTranslation();
  const check = useMutation({
    mutationFn: () => api<GeyserCheck>(`/api/servers/${serverId}/geyser/check`, { method: 'POST' }),
  });
  const result = check.data;
  const outsideTip = (r: GeyserCheck): string => {
    if (r.outside?.ok === null) return t('geyser.outsideUnknown');
    return r.inside.ok ? t('geyser.outsideTip', { port: r.outside?.port }) : t('geyser.outsideAfterInside');
  };
  const row = (ok: boolean | null, title: string, tip: string): ReactElement => (
    <li className="grid gap-0.5 rounded-[10px] bg-secondary px-3 py-2">
      <span className="flex items-center gap-2 font-semibold">
        {ok === true ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : null}
        {ok === false ? <XCircle className="size-4 text-destructive" aria-hidden /> : null}
        {ok === null ? <HelpCircle className="size-4 text-muted-foreground" aria-hidden /> : null}
        {title}
      </span>
      {ok === true ? null : <span className="pl-6 text-[13px] text-muted-foreground">{tip}</span>}
    </li>
  );
  return (
    <div className="mt-4 grid gap-2 text-sm">
      <Button
        variant="outline"
        className="w-fit"
        disabled={check.isPending || !running}
        onClick={() => check.mutate()}
      >
        <Radar aria-hidden />
        {check.isPending ? t('geyser.checking') : t('geyser.check')}
      </Button>
      {!running ? (
        <span className="text-[13px] text-muted-foreground">{t('geyser.checkNeedsRunning')}</span>
      ) : null}
      {result ? (
        <ul className="grid gap-1.5">
          {row(
            result.inside.ok,
            result.inside.ok
              ? t('geyser.insideOk', { version: result.inside.version ?? '' })
              : t('geyser.insideFail'),
            t('geyser.insideTip'),
          )}
          {result.outside
            ? row(
                result.outside.ok,
                t('geyser.outside', { host: result.outside.host, port: result.outside.port }),
                outsideTip(result),
              )
            : null}
        </ul>
      ) : null}
      {result?.outside ? (
        <p className="text-[13px] text-muted-foreground">
          {t('geyser.howToJoin', { host: result.outside.host, port: result.outside.port })}
        </p>
      ) : null}
    </div>
  );
}

export function GeyserCard({ server }: { server: ServerDetail }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const restart = useServerAction(server.id);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<GeyserResult>(`/api/servers/${server.id}/geyser`, { method: 'PUT', body: { enabled } }),
    onSuccess: async (result) => {
      toast.success(result.enabled ? t('geyser.enabled', { port: result.port }) : t('geyser.disabled'));
      setRestartNeeded(result.restartRequired);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['server', server.id] }),
        queryClient.invalidateQueries({ queryKey: ['content', server.id] }),
      ]);
    },
  });
  return (
    <Card className="p-5 sm:p-6">
      <CardHeader className="mb-1">
        <CardTitle className="flex items-center gap-2">
          <ProjectLogo
            project="geyser"
            className="size-6 rounded-[6px]"
            fallback={<Smartphone className="size-4 text-primary" aria-hidden />}
          />
          {t('geyser.title')}
        </CardTitle>
        <Switch
          checked={server.geyser}
          disabled={toggle.isPending}
          aria-label={t('geyser.title')}
          onCheckedChange={(on) => toggle.mutate(on)}
        />
      </CardHeader>
      <CardDescription>{t('geyser.text')}</CardDescription>
      {toggle.isPending ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('geyser.installing')}</p>
      ) : null}
      {server.geyser && server.geyserPort ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <Pill tone="ok">{t('geyser.on')}</Pill>
          <span className="text-muted-foreground">{t('geyser.portInfo', { port: server.geyserPort })}</span>
        </div>
      ) : null}
      {restartNeeded && server.live.state === 'running' ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[12px] bg-warning-soft px-3 py-2 text-sm text-warning">
          <span className="flex-1">{t('settings.restartToApply')}</span>
          <Button
            size="sm"
            disabled={restart.isPending}
            onClick={() => {
              restart.mutate('restart');
              setRestartNeeded(false);
            }}
          >
            <RotateCw />
            {t('actions.restart')}
          </Button>
        </div>
      ) : null}
      {server.geyser ? <BedrockCheck serverId={server.id} running={server.live.state === 'running'} /> : null}
      <p className="mt-4 text-[13px] text-muted-foreground">{t('geyser.routerHint')}</p>
    </Card>
  );
}
