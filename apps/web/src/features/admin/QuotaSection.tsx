import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, HardDrive, MemoryStick, RotateCcw, Save, Server, Users } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CPU_STEP, type Quota, type QuotaUserView, type QuotaView } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/misc';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { cn } from '@/lib/utils';

const quotaQuery = { queryKey: ['quotas'], queryFn: () => api<QuotaView>('/api/quotas') } as const;
const MB_PER_GB = 1024;
const PERCENT = 100;
const FULL_FROM = 90;

type Key = keyof Quota;
const KEYS: readonly Key[] = ['servers', 'memoryMb', 'diskMb', 'cpus'];
const ICONS: Readonly<Record<Key, typeof Server>> = {
  servers: Server,
  memoryMb: MemoryStick,
  diskMb: HardDrive,
  cpus: Cpu,
};
/** RAM and disk are typed in GB, stored in MB. */
const IN_GB: ReadonlySet<Key> = new Set(['memoryMb', 'diskMb']);

type Draft = Readonly<Record<Key, string>>;

const toDraft = (q: Quota): Draft => ({
  servers: q.servers === null ? '' : String(q.servers),
  memoryMb: q.memoryMb === null ? '' : String(q.memoryMb / MB_PER_GB),
  diskMb: q.diskMb === null ? '' : String(q.diskMb / MB_PER_GB),
  cpus: q.cpus === null ? '' : String(q.cpus),
});
const toQuota = (d: Draft): Quota => {
  const num = (key: Key): number | null => {
    const text = d[key].trim().replace(',', '.');
    if (!text) return null;
    const value = Number(text);
    if (key === 'cpus') return Math.round(value / CPU_STEP) * CPU_STEP;
    return IN_GB.has(key) ? Math.round(value * MB_PER_GB) : Math.round(value);
  };
  return { servers: num('servers'), memoryMb: num('memoryMb'), diskMb: num('diskMb'), cpus: num('cpus') };
};
const shown = (key: Key, value: number): string =>
  IN_GB.has(key) ? `${Math.round((value / MB_PER_GB) * 10) / 10} GB` : String(value); // eslint-disable-line ts-patterns/no-magic-numbers -- one decimal

/** Four number fields; empty means "no limit". */
function QuotaFields({
  id,
  draft,
  onChange,
}: {
  id: string;
  draft: Draft;
  onChange: (d: Draft) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {KEYS.map((key) => (
        <Field key={key} id={`${id}-${key}`} label={t(`quota.fields.${key}`)}>
          <Input
            id={`${id}-${key}`}
            inputMode="decimal"
            placeholder={t('quota.unlimited')}
            value={draft[key]}
            onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}

/** "3 von 4" with a bar; without a limit only what is used. */
function UsageBar({
  label,
  used,
  limit,
  keyName,
}: {
  label: string;
  used: number;
  limit: number | null;
  keyName: Key;
}): ReactElement {
  const { t } = useTranslation();
  const Icon = ICONS[keyName];
  const percent = limit ? Math.min(PERCENT, (used / limit) * PERCENT) : 0;
  return (
    <div className="grid min-w-0 gap-1">
      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </span>
      <span className="tabular text-sm font-semibold">
        {limit === null
          ? t('quota.usedNoLimit', { used: shown(keyName, used) })
          : t('quota.usedOf', { used: shown(keyName, used), limit: shown(keyName, limit) })}
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full', percent >= FULL_FROM ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${limit === null ? 0 : percent}%` }}
        />
      </div>
    </div>
  );
}

function PersonRow({ person }: { person: QuotaUserView }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(toDraft(person.own ?? person.effective));
  const save = useMutation({
    mutationFn: (quota: Quota | null) =>
      api<QuotaView>(`/api/quotas/users/${person.id}`, { method: 'PUT', body: { quota } }),
    onSuccess: (view) => {
      queryClient.setQueryData(quotaQuery.queryKey, view);
      setEditing(false);
      toast.success(t('quota.saved'));
    },
  });
  const usage = person.usage;
  const used: Readonly<Record<Key, number>> = {
    servers: usage.servers,
    memoryMb: usage.memoryMb,
    diskMb: usage.diskMb,
    cpus: usage.cpus,
  };
  return (
    <div className="grid gap-3 rounded-[12px] border border-border p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="truncate">{person.displayName}</b>
        <div className="flex items-center gap-2">
          {person.own ? <Pill tone="accent">{t('quota.own')}</Pill> : <Pill>{t('quota.default')}</Pill>}
          <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
            {t('quota.edit')}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {KEYS.map((key) => (
          <UsageBar
            key={key}
            keyName={key}
            label={t(`quota.fields.${key}`)}
            used={used[key]}
            limit={person.effective[key]}
          />
        ))}
      </div>
      {usage.diskUsedMb > 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {t('quota.diskUsed', { used: shown('diskMb', usage.diskUsedMb) })}
        </p>
      ) : null}
      {editing ? (
        <div className="grid gap-3 border-t border-border pt-3">
          <QuotaFields id={`q-${person.id}`} draft={draft} onChange={setDraft} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(toQuota(draft))}>
              <Save />
              {t('quota.saveOwn')}
            </Button>
            {person.own ? (
              <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>
                <RotateCcw />
                {t('quota.useDefault')}
              </Button>
            ) : null}
          </div>
          {save.error ? <p className="text-sm text-destructive">{errorText(save.error)}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Defaults({ view }: { view: QuotaView }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(toDraft(view.defaults));
  const save = useMutation({
    mutationFn: () => api<QuotaView>('/api/quotas/defaults', { method: 'PUT', body: toQuota(draft) }),
    onSuccess: (next) => {
      queryClient.setQueryData(quotaQuery.queryKey, next);
      toast.success(t('quota.saved'));
    },
  });
  return (
    <Card className="grid gap-4 p-5">
      <div className="grid gap-1.5">
        <CardTitle className="flex items-center gap-2">
          <Server className="size-5 shrink-0 text-primary" aria-hidden />
          {t('quota.defaultsTitle')}
        </CardTitle>
        <CardDescription>{t('quota.defaultsText')}</CardDescription>
      </div>
      <p className="rounded-[10px] bg-secondary px-3 py-2 text-sm">
        {t('quota.host', {
          memory: shown('memoryMb', view.host.memoryMb),
          cpus: view.host.cpus,
          disk: view.host.diskMb === null ? '?' : shown('diskMb', view.host.diskMb),
        })}
      </p>
      <QuotaFields id="q-default" draft={draft} onChange={setDraft} />
      <Button className="justify-self-start" disabled={save.isPending} onClick={() => save.mutate()}>
        <Save />
        {t('quota.save')}
      </Button>
      {save.error ? <p className="text-sm text-destructive">{errorText(save.error)}</p> : null}
    </Card>
  );
}

/** Admin area → quotas: how much RAM, disk, CPU and how many servers each person may have. */
export function QuotaSection(): ReactElement {
  const { t } = useTranslation();
  const { data } = useQuery(quotaQuery);
  if (!data) return <Skeleton className="h-64" />;
  const people = data.users.filter((u) => !u.isAdmin);
  return (
    <>
      <Defaults view={data} />
      <Card className="grid gap-4 p-5">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Users className="size-5 shrink-0 text-primary" aria-hidden />
            {t('quota.peopleTitle')}
          </CardTitle>
          <CardDescription>{t('quota.peopleText')}</CardDescription>
        </div>
        {people.length === 0 ? <p className="text-sm text-muted-foreground">{t('quota.nobody')}</p> : null}
        {people.map((person) => (
          <PersonRow key={person.id} person={person} />
        ))}
      </Card>
    </>
  );
}
