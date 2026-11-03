import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Mic, RotateCw, Save } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  PORT_VOICE_CHAT,
  type ServerDetail,
  type SoftwareId,
  type VoiceChatResult,
} from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { ProjectLogo } from '@/components/project-logo';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { useAddOnSetup } from './add-on-setup';
import { api } from '@/lib/api';
import { useServerAction } from '@/features/dashboard/ServerCard';

/** Server software that Simple Voice Chat runs on (plugin or mod). */
export const VOICE_CHAT_SOFTWARE: readonly SoftwareId[] = [
  'paper',
  'purpur',
  'custom',
  'fabric',
  'forge',
  'neoforge',
];
const MOD_PAGE = 'https://modrinth.com/plugin/simple-voice-chat';
const PORT_MIN = 1;
const PORT_MAX = 65535;

/** One switch for proximity voice chat: plugin or mod, UDP port and settings set themselves up. */
export function VoiceChatCard({ server }: { server: ServerDetail }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const restart = useServerAction(server.id);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [publicPort, setPublicPort] = useState(server.voicePublicPort ? String(server.voicePublicPort) : '');
  const portValue = publicPort.trim() ? Number(publicPort) : null;
  const portValid =
    portValue === null || (Number.isInteger(portValue) && portValue >= PORT_MIN && portValue <= PORT_MAX);
  const settingUp = useAddOnSetup(server, 'voice');
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api<VoiceChatResult>(`/api/servers/${server.id}/voicechat`, {
        method: 'PUT',
        body: { enabled, publicPort: portValue },
      }),
    onSuccess: async (result) => {
      toast.success(result.enabled ? t('voiceChat.enabled', { port: result.port }) : t('voiceChat.disabled'));
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
            project="voicechat"
            className="size-6 rounded-[6px]"
            fallback={<Mic className="size-4 text-primary" aria-hidden />}
          />
          {t('voiceChat.title')}
        </CardTitle>
        <Switch
          checked={server.voiceChat || settingUp || (save.isPending && save.variables)}
          disabled={settingUp || save.isPending || !portValid}
          aria-label={t('voiceChat.title')}
          onCheckedChange={(on) => save.mutate(on)}
        />
      </CardHeader>
      <CardDescription>{t('voiceChat.text')}</CardDescription>
      {settingUp ? (
        <p className="mt-3 flex items-center gap-2 text-sm font-medium text-primary">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('addOnSetup.running')}
        </p>
      ) : save.isPending ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('voiceChat.installing')}</p>
      ) : null}
      {server.voiceChat && server.voicePort ? (
        <div className="mt-4 grid gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Pill tone="ok">{t('geyser.on')}</Pill>
            <span className="text-muted-foreground">
              {t('voiceChat.portInfo', { port: server.voicePort })}
            </span>
          </div>
          {server.voiceHost ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-secondary px-3 py-2 text-[13px]">
              <span className="text-muted-foreground">{t('voiceChat.hostLabel')}</span>
              <code className="font-mono font-semibold">{server.voiceHost}</code>
              <CopyButton text={server.voiceHost} className="size-7" />
            </div>
          ) : null}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(true);
            }}
          >
            <Field
              id={`voice-port-${server.id}`}
              label={t('voiceChat.publicPort')}
              hint={t('voiceChat.publicPortHint')}
              className="min-w-[220px] flex-1"
            >
              <Input
                id={`voice-port-${server.id}`}
                inputMode="numeric"
                placeholder={String(server.voicePort)}
                value={publicPort}
                aria-invalid={!portValid}
                onChange={(e) => setPublicPort(e.target.value.trim())}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={save.isPending || !portValid}>
              <Save />
              {t('common.save')}
            </Button>
          </form>
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
      <div className="mt-4 grid gap-1.5 text-[13px] text-muted-foreground">
        <p>{t('voiceChat.playersHint')}</p>
        <a
          href={MOD_PAGE}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
        >
          <ExternalLink className="size-4" aria-hidden />
          {t('voiceChat.modLink')}
        </a>
        <p>{t('voiceChat.routerHint', { port: server.voicePort ?? PORT_VOICE_CHAT })}</p>
      </div>
    </Card>
  );
}
