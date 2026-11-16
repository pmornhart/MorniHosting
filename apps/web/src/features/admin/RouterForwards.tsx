import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ROUTER_PUBLIC_PORTS,
  type NetbirdStatus,
  type RouterForward,
  type RouterForwardCheck,
  type RouterForwardsStatus,
  type RouterForwardView,
} from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { brandOf } from '@/features/netbird/netbird';

const FORWARDS_PATH = '/api/netbird/forwards';
const forwardsQuery = {
  queryKey: ['netbird-forwards'],
  queryFn: () => api<RouterForwardsStatus>(FORWARDS_PATH),
} as const;
type Kind = 'java' | 'bedrock';
const KINDS: readonly Kind[] = ['java', 'bedrock'];
const PORT_OF: Readonly<Record<Kind, 'javaPort' | 'bedrockPort'>> = {
  java: 'javaPort',
  bedrock: 'bedrockPort',
};
/** The list as the server stores it (without what NetBird said about it). */
const plain = (f: RouterForward): RouterForward => ({
  domain: f.domain,
  javaPort: f.javaPort,
  bedrockPort: f.bedrockPort,
});
/** A typed port: empty = none. */
const portOf = (text: string): number | null => (text.trim() ? Number(text.trim()) : null);
/** A typed domain as the server keeps it: lower case, without a trailing dot ("MoinMorni.net." → "moinmorni.net"). */
function domainOf(text: string): string {
  const bare = text.trim().toLowerCase();
  return bare.endsWith('.') ? bare.slice(0, -1) : bare;
}

/** One port of an entry: where NetBird sends it ("gefunden: …") or why players do not get through. */
function CheckLine({
  kind,
  port,
  check,
  routerOn,
  status,
}: {
  kind: Kind;
  port: number;
  check: RouterForwardCheck;
  routerOn: boolean;
  status: NetbirdStatus;
}): ReactElement {
  const { t } = useTranslation();
  const label = t('routerForwards.portLabel', { kind: t(`routerForwards.kind.${kind}`), port });
  const error = check.error
    ? t(`errors.${check.error.code}`, { ...check.error.params, defaultValue: t('errors.generic') })
    : '';
  const problem = check.problem
    ? t(`routerForwards.problems.${check.problem}`, {
        port,
        service: check.service ?? '',
        target: check.target ?? '',
        error,
        ...brandOf(status),
      })
    : null;
  return (
    <div className="grid gap-1 text-[13px]">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{label}</span>
        {problem ? (
          <Pill tone="warn">{t('routerForwards.notFound')}</Pill>
        ) : (
          <Pill tone="ok">{t('routerForwards.found', { target: check.target })}</Pill>
        )}
        {check.service ? <span className="font-mono text-muted-foreground">{check.service}</span> : null}
      </span>
      {problem ? (
        <span className="flex items-start gap-2 text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {problem}
        </span>
      ) : null}
      {routerOn ? null : (
        <span className="text-muted-foreground">
          {t('routerForwards.routerOff', { port: ROUTER_PUBLIC_PORTS[kind] })}
        </span>
      )}
    </div>
  );
}

function Entry({
  entry,
  router,
  status,
  busy,
  onRemove,
}: {
  entry: RouterForwardView;
  router: RouterForwardsStatus['router'];
  status: NetbirdStatus;
  busy: boolean;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="grid min-w-0 gap-2 rounded-[10px] bg-secondary px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="min-w-0 break-all font-mono text-sm font-semibold">{entry.domain}</b>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          <Trash2 />
          {t('routerForwards.remove')}
        </Button>
      </div>
      {KINDS.map((kind) => {
        const port = entry[PORT_OF[kind]];
        const check = entry[kind];
        return port !== null && check ? (
          <CheckLine
            key={kind}
            kind={kind}
            port={port}
            check={check}
            routerOn={router[kind]}
            status={status}
          />
        ) : null;
      })}
      {entry.shadowedBy ? (
        <span className="flex items-start gap-2 text-[13px] text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('routerForwards.shadowed', { server: entry.shadowedBy, domain: entry.domain })}
        </span>
      ) : null}
    </li>
  );
}

/**
 * "Weitere Domains über diesen Verteiler": another product on the same NetBird server (e.g. MoinMorni) has no
 * 25565/19132 of its own – this panel's address router holds them. Entered here with the ports it has in NetBird, its
 * players type only its domain too: the router sends them where NetBird sends those ports.
 */
export function RouterForwards({ status }: { status: NetbirdStatus }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, error: loadError } = useQuery(forwardsQuery);
  const [domain, setDomain] = useState('');
  const [javaPort, setJavaPort] = useState('');
  const [bedrockPort, setBedrockPort] = useState('');
  const save = useMutation({
    mutationFn: (forwards: readonly RouterForward[]) =>
      api<RouterForwardsStatus>(FORWARDS_PATH, { method: 'PUT', body: { forwards } }),
    onSuccess: (next) => queryClient.setQueryData(forwardsQuery.queryKey, next),
  });
  const recheck = useMutation({
    mutationFn: () => api<RouterForwardsStatus>(`${FORWARDS_PATH}?fresh=1`),
    onSuccess: (next) => queryClient.setQueryData(forwardsQuery.queryKey, next),
  });
  const forwards = data?.forwards ?? [];
  const problems = forwards.filter((f) => f.shadowedBy || KINDS.some((kind) => f[kind]?.problem)).length;
  const typed: RouterForward = {
    domain: domainOf(domain),
    javaPort: portOf(javaPort),
    bedrockPort: portOf(bedrockPort),
  };
  const ready = typed.domain !== '' && (typed.javaPort !== null || typed.bedrockPort !== null);
  const add = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    save.mutate([...forwards.map(plain), typed], {
      onSuccess: () => {
        toast.success(t('routerForwards.added', { domain: typed.domain }));
        setDomain('');
        setJavaPort('');
        setBedrockPort('');
      },
    });
  };
  const remove = (gone: string): void =>
    save.mutate(forwards.filter((f) => f.domain !== gone).map(plain), {
      onSuccess: () => toast.success(t('routerForwards.removed', { domain: gone })),
    });
  const failure = save.error ?? recheck.error ?? loadError;

  return (
    <details className="group min-w-0 rounded-[12px] border border-border px-3.5 py-3 text-sm">
      <summary className="cursor-pointer font-semibold">
        {t('routerForwards.title')}
        {forwards.length ? (
          <Pill tone={problems ? 'warn' : 'ok'} className="ml-2 align-middle">
            {problems
              ? t('routerForwards.summaryProblems', { count: problems })
              : t('routerForwards.summary', { count: forwards.length })}
          </Pill>
        ) : (
          <span className="ml-1 font-normal text-muted-foreground">{t('routerForwards.summaryNone')}</span>
        )}
      </summary>
      <div className="mt-2.5 grid min-w-0 gap-3">
        <p>{t('routerForwards.text')}</p>
        <p className="text-[13px] text-muted-foreground">{t('routerForwards.how', brandOf(status))}</p>
        {forwards.length ? (
          <ul className="grid gap-2">
            {forwards.map((entry) => (
              <Entry
                key={entry.domain}
                entry={entry}
                router={data?.router ?? status.router}
                status={status}
                busy={save.isPending}
                onRemove={() => remove(entry.domain)}
              />
            ))}
          </ul>
        ) : null}
        <form
          onSubmit={add}
          className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_110px_110px_auto] sm:items-end"
        >
          <Field id="rf-domain" label={t('routerForwards.domain')} className="col-span-2 sm:col-span-1">
            <Input
              id="rf-domain"
              value={domain}
              placeholder="moinmorni.net"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDomain(e.target.value)}
            />
          </Field>
          <Field id="rf-java" label={t('routerForwards.javaPort')}>
            <Input
              id="rf-java"
              inputMode="numeric"
              value={javaPort}
              placeholder="25567"
              onChange={(e) => setJavaPort(e.target.value.trim())}
            />
          </Field>
          <Field id="rf-bedrock" label={t('routerForwards.bedrockPort')}>
            <Input
              id="rf-bedrock"
              inputMode="numeric"
              value={bedrockPort}
              placeholder="19134"
              onChange={(e) => setBedrockPort(e.target.value.trim())}
            />
          </Field>
          <Button
            type="submit"
            variant="secondary"
            className="col-span-2 sm:col-span-1"
            disabled={save.isPending || !ready}
          >
            <Plus />
            {t('routerForwards.add')}
          </Button>
        </form>
        <p className="text-[13px] text-muted-foreground">{t('routerForwards.portsHint')}</p>
        {forwards.length ? (
          <span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              {recheck.isPending ? <RefreshCw className="animate-spin" /> : <CircleCheck />}
              {t('routerForwards.recheck')}
            </Button>
          </span>
        ) : null}
        {failure ? (
          <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">{errorText(failure)}</p>
        ) : null}
      </div>
    </details>
  );
}
