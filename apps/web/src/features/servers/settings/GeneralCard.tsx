import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw, Save, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CPU_STEP,
  JAVA_TAGS,
  SOFTWARE,
  compareMcVersions,
  isGameId,
  javaTagFor,
  recommendedMemoryMb,
  type JavaTag,
  type ServerDetail,
  type UpdateServerInput,
  type VersionOption,
} from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Slider } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { formatMemoryMb, versionLabel } from '@/lib/format';
import { useServerMemoryCap } from '@/lib/my-quota';
import { cn } from '@/lib/utils';
import { hostQuery } from '@/features/dashboard/HostStrip';
import { useServerAction } from '@/features/dashboard/ServerCard';
import { NetbirdServerField } from '@/features/netbird/NetbirdServerField';
import { useAddressAutomation } from '@/features/netbird/netbird';
import { useSession } from '@/features/auth/session';

const MEMORY_STEP_MB = 512;
const MEMORY_MIN_MB = 512;
/** Same ceiling as the server accepts (128 GB); the slider still stops at the machine's own RAM. */
const MEMORY_CAP_MB = 131072;
const FALLBACK_HOST_MB = 16384;
const MEMORY_SLIDER_MIN_MAX_MB = 1024;
const MAX_VERSIONS = 80;
const AUTO = 'auto';
const MB_PER_GB = 1024;
// Everything that is not a digit: in "25 565" it matches the space.
// https://regex101.com/?regex=%5CD&flags=g&testString=25%20565
const NON_DIGITS = /\D/g;

interface Draft {
  readonly name: string;
  readonly memoryMb: number;
  readonly port: string;
  readonly autoStart: boolean;
  readonly domain: string;
  readonly publicPort: string;
  readonly javaTag: JavaTag | typeof AUTO;
  readonly version: string;
  /** Admins only; empty = no limit. Disk in GB. */
  readonly cpuLimit: string;
  readonly diskLimitGb: string;
}

function draftOf(server: ServerDetail): Draft {
  return {
    name: server.name,
    memoryMb: server.memoryMb,
    port: String(server.port),
    autoStart: server.autoStart,
    domain: server.domain ?? '',
    publicPort: server.publicPort ? String(server.publicPort) : '',
    javaTag: server.javaTag ?? AUTO,
    version: server.version,
    cpuLimit: server.cpuLimit === null ? '' : String(server.cpuLimit),
    diskLimitGb: server.diskLimitMb === null ? '' : String(server.diskLimitMb / MB_PER_GB),
  };
}

const cpuLimitOf = (draft: Draft): number | null =>
  draft.cpuLimit.trim() ? Math.round(Number(draft.cpuLimit.replace(',', '.')) / CPU_STEP) * CPU_STEP : null;
const diskLimitOf = (draft: Draft): number | null =>
  draft.diskLimitGb.trim() ? Math.round(Number(draft.diskLimitGb.replace(',', '.')) * MB_PER_GB) : null;

const publicPortOf = (draft: Draft): number | null =>
  draft.publicPort.trim() ? Number(draft.publicPort) : null;

/** Only the fields that changed, in the shape PATCH /api/servers/:id expects. */
function patchOf(server: ServerDetail, draft: Draft): UpdateServerInput {
  const javaTag = draft.javaTag === AUTO ? null : draft.javaTag;
  // With NetBird the panel keeps domain and outside port in sync itself.
  const own = server.netbird === null;
  return {
    ...(draft.name.trim() !== server.name ? { name: draft.name.trim() } : {}),
    ...(draft.memoryMb !== server.memoryMb ? { memoryMb: draft.memoryMb } : {}),
    ...(Number(draft.port) !== server.port ? { port: Number(draft.port) } : {}),
    ...(draft.autoStart !== server.autoStart ? { autoStart: draft.autoStart } : {}),
    ...(own && draft.domain.trim() !== (server.domain ?? '') ? { domain: draft.domain.trim() } : {}),
    ...(own && publicPortOf(draft) !== server.publicPort ? { publicPort: publicPortOf(draft) } : {}),
    ...(javaTag !== server.javaTag ? { javaTag } : {}),
    ...(draft.version !== server.version ? { version: draft.version } : {}),
    ...(cpuLimitOf(draft) !== server.cpuLimit ? { cpuLimit: cpuLimitOf(draft) } : {}),
    ...(diskLimitOf(draft) !== server.diskLimitMb ? { diskLimitMb: diskLimitOf(draft) } : {}),
  };
}

/** Name, memory, port, autostart, domain, Java and Minecraft version. Changes apply on the next start. */
export function GeneralCard({ server }: { server: ServerDetail }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const restart = useServerAction(server.id);
  const [draft, setDraft] = useState<Draft>(() => draftOf(server));
  const [pendingRestart, setPendingRestart] = useState(false);
  const netbird = useAddressAutomation();
  const isAdmin = useSession().me.user.isAdmin;
  const memoryCap = useServerMemoryCap();
  const managed = server.netbird !== null;
  const managedHint = netbird?.via === 'dns' ? t('netbirdAuto.managedDns') : t('netbirdAuto.managed');
  const { data: host } = useQuery(hostQuery);
  const versions = useQuery({
    queryKey: ['versions', server.software],
    queryFn: () => api<VersionOption[]>(`/api/versions/${server.software}`),
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: (patch: UpdateServerInput) =>
      api(`/api/servers/${server.id}`, { method: 'PATCH', body: patch }),
    onSuccess: async () => {
      toast.success(t('common.saved'));
      if (server.live.state === 'running') setPendingRestart(true);
      await queryClient.invalidateQueries({ queryKey: ['server', server.id] });
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));
  const patch = patchOf(server, draft);
  const changed = Object.keys(patch).length > 0;
  const hostTotal = host?.memoryTotalMb ?? FALLBACK_HOST_MB;
  // Up to the person's RAM per server (normally 16 GB; admins: no limit). A server an admin made bigger
  // keeps its RAM: it can be lowered, not raised further.
  const capped = memoryCap !== null && memoryCap < Math.min(MEMORY_CAP_MB, hostTotal);
  const maxMemory = Math.max(
    MEMORY_SLIDER_MIN_MAX_MB,
    Math.min(MEMORY_CAP_MB, hostTotal, memoryCap ?? MEMORY_CAP_MB),
    server.memoryMb,
  );
  const java = SOFTWARE[server.software].edition === 'java' && !SOFTWARE[server.software].proxy;
  const downgrade = compareMcVersions(draft.version, server.version) < 0;
  const versionList = useMemo(() => {
    const stable = (versions.data ?? []).filter((v) => v.stable).slice(0, MAX_VERSIONS);
    return stable.some((v) => v.id === server.version)
      ? stable
      : [{ id: server.version, stable: true }, ...stable];
  }, [versions.data, server.version]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (changed) save.mutate(patch);
  };

  return (
    <Card className="p-5 sm:p-6">
      <CardHeader className="mb-1">
        <CardTitle>{t('settings.general.title')}</CardTitle>
      </CardHeader>
      <CardDescription className="mb-5">{t('settings.general.text')}</CardDescription>
      <form onSubmit={submit} className="grid gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <Field id="s-name" label={t('create.name')}>
            <Input
              id="s-name"
              value={draft.name}
              maxLength={60}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field id="s-port" label={t('create.port')} hint={t('settings.general.portHint')}>
            <Input
              id="s-port"
              inputMode="numeric"
              value={draft.port}
              onChange={(e) => set('port', e.target.value.replace(NON_DIGITS, ''))}
            />
          </Field>
        </div>

        <div id="memory" className="grid scroll-mt-24 gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold">{t('settings.general.memory')}</span>
            <span className="tabular text-lg font-bold">{formatMemoryMb(draft.memoryMb)}</span>
          </div>
          <Slider
            value={[draft.memoryMb]}
            min={MEMORY_MIN_MB}
            max={maxMemory}
            step={MEMORY_STEP_MB}
            onValueChange={([value]) => set('memoryMb', value ?? draft.memoryMb)}
            aria-label={t('settings.general.memory')}
          />
          <p className="text-[13px] text-muted-foreground">
            {t('settings.general.memoryHint', {
              recommended: formatMemoryMb(recommendedMemoryMb(server.software)),
            })}
            {capped ? ` ${t('order.memoryCap', { ram: formatMemoryMb(memoryCap) })}` : null}
          </p>
        </div>

        {isAdmin ? (
          <div className="grid gap-3 rounded-[12px] border border-border p-3 sm:p-4">
            <b className="text-sm">{t('serverLimits.title')}</b>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="s-cpu" label={t('serverLimits.cpu')}>
                <Input
                  id="s-cpu"
                  inputMode="decimal"
                  placeholder={t('quota.unlimited')}
                  value={draft.cpuLimit}
                  onChange={(e) => set('cpuLimit', e.target.value)}
                />
              </Field>
              <Field id="s-disk" label={t('serverLimits.disk')}>
                <Input
                  id="s-disk"
                  inputMode="decimal"
                  placeholder={t('quota.unlimited')}
                  value={draft.diskLimitGb}
                  onChange={(e) => set('diskLimitGb', e.target.value)}
                />
              </Field>
            </div>
            <p className="text-[13px] text-muted-foreground">{t('serverLimits.hint')}</p>
          </div>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          <Field
            id="s-version"
            label={isGameId(server.software) ? t('games.versionTitle') : t('settings.general.version')}
          >
            <Select value={draft.version} onValueChange={(v) => set('version', v)}>
              <SelectTrigger id="s-version">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versionList.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {versionLabel(server.software, v.id)}
                    {v.id === server.version ? ` · ${t('settings.general.current')}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {java ? (
            <Field
              id="s-java"
              label={t('settings.general.java')}
              hint={t('settings.general.javaHint', {
                auto: javaTagFor(server.software, draft.version).replace('java', 'Java '),
              })}
            >
              <Select value={draft.javaTag} onValueChange={(v) => set('javaTag', v as Draft['javaTag'])}>
                <SelectTrigger id="s-java">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>{t('settings.general.javaAuto')}</SelectItem>
                  {JAVA_TAGS.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag.replace('java', 'Java ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>
        {downgrade ? (
          <p className="flex items-start gap-2 rounded-[12px] bg-warning-soft px-3 py-2.5 text-sm text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('settings.general.downgrade')}
          </p>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          {netbird?.domain ? <NetbirdServerField server={server} domain={netbird.domain} /> : null}
          <Field
            id="s-domain"
            label={t('settings.general.domain')}
            hint={managed ? managedHint : t('settings.general.domainHint')}
          >
            <Input
              id="s-domain"
              value={managed ? (server.domain ?? '') : draft.domain}
              disabled={managed}
              placeholder="mc.example.de"
              onChange={(e) => set('domain', e.target.value)}
            />
          </Field>
          <Field
            id="s-public-port"
            label={t('settings.general.publicPort')}
            hint={managed ? managedHint : t('settings.general.publicPortHint')}
          >
            <Input
              id="s-public-port"
              inputMode="numeric"
              value={managed ? String(server.publicPort ?? '') : draft.publicPort}
              disabled={managed}
              placeholder={draft.port}
              onChange={(e) => set('publicPort', e.target.value.trim())}
            />
          </Field>
          <label className="flex items-start gap-3 rounded-[12px] border border-border p-3 md:self-end">
            <Switch
              checked={draft.autoStart}
              onCheckedChange={(on) => set('autoStart', on)}
              className="mt-0.5"
            />
            <span>
              <b className="block text-sm font-semibold">{t('settings.general.autoStart')}</b>
              <span className="text-[13px] text-muted-foreground">{t('settings.general.autoStartHint')}</span>
            </span>
          </label>
        </div>

        <div
          className={cn(
            'flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4',
            pendingRestart && 'justify-between',
          )}
        >
          {pendingRestart ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {t('settings.restartToApply')}
              <Button
                size="sm"
                variant="secondary"
                disabled={restart.isPending}
                onClick={() => {
                  restart.mutate('restart');
                  setPendingRestart(false);
                }}
              >
                <RotateCw />
                {t('actions.restart')}
              </Button>
            </p>
          ) : null}
          <div className="flex gap-2">
            {changed ? (
              <Button variant="ghost" onClick={() => setDraft(draftOf(server))}>
                {t('common.cancel')}
              </Button>
            ) : null}
            <Button type="submit" disabled={!changed || save.isPending}>
              <Save />
              {t('common.save')}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
