import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, Network, Plus, Trash2, Waypoints } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { NETWORK_MEMBER_SOFTWARE, type NetworkView, type ServerSummary } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, PageHeader } from '@/components/page';
import { ServerIcon, StatePill } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { serversQuery } from '@/features/servers/live';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';

const REFRESH_MS = 10_000;

export const networksQuery = {
  queryKey: ['networks'],
  queryFn: () => api<NetworkView[]>('/api/networks'),
  refetchInterval: REFRESH_MS,
} as const;

const NAME_MAX = 32;
// Turns a server name into a name for the proxy: "Duels 2!" → "duels-2". Matches every run of characters that
// are not a-z or 0-9 (after lower-casing): "Duels 2!" has " " and "!"; "lobby" has none.
// https://regex101.com/?flavor=javascript&flags=g&regex=%5B%5Ea-z0-9%5D%2B&testString=duels%202!
const NOT_ALLOWED = /[^a-z0-9]+/g;
// Leading or trailing dashes left over from the step above: "-duels-2-" → "duels-2".
// https://regex101.com/?flavor=javascript&flags=g&regex=%5E-%2B%7C-%2B%24&testString=-duels-2-
const EDGE_DASHES = /^-+|-+$/g;

/** Suggested name in the proxy for a server (lower case, digits, dashes). */
export function memberNameFor(serverName: string): string {
  return serverName
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .replace(NOT_ALLOWED, '-')
    .replace(EDGE_DASHES, '')
    .slice(0, NAME_MAX);
}

function useNetworkMutation<T>(fn: (input: T) => Promise<unknown>, done?: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (done) toast.success(t(done));
      void queryClient.invalidateQueries({ queryKey: networksQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
    },
    onError: (err) => toast.error(errorText(err)),
  });
}

function CreateNetwork({ proxies }: { readonly proxies: readonly ServerSummary[] }): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [proxyId, setProxyId] = useState('');
  const create = useNetworkMutation(
    () =>
      api<NetworkView>('/api/networks', {
        method: 'POST',
        body: { name: name.trim(), proxyServerId: proxyId },
      }),
    'networks.created',
  );
  return (
    <Card className="grid min-w-0 gap-4 p-4 sm:p-5">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          <Plus className="size-5 text-primary" aria-hidden />
          {t('networks.create')}
        </CardTitle>
        <CardDescription>{t('networks.createText')}</CardDescription>
      </CardHeader>
      {proxies.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('networks.noProxy')}{' '}
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" to="/servers/new">
            {t('networks.createProxy')}
          </Link>
        </p>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="network-name">{t('networks.name')}</Label>
            <Input
              id="network-name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="MoinMorni"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="network-proxy">{t('networks.proxy')}</Label>
            <Select value={proxyId} onValueChange={setProxyId}>
              <SelectTrigger id="network-proxy">
                <SelectValue placeholder={t('networks.chooseProxy')} />
              </SelectTrigger>
              <SelectContent>
                {proxies.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={!name.trim() || !proxyId || create.isPending}>
            <Network />
            {t('networks.createButton')}
          </Button>
        </form>
      )}
    </Card>
  );
}

function AddMember({
  network,
  candidates,
}: {
  readonly network: NetworkView;
  readonly candidates: readonly ServerSummary[];
}): ReactElement {
  const { t } = useTranslation();
  const [serverId, setServerId] = useState('');
  const [name, setName] = useState('');
  const add = useNetworkMutation(
    () =>
      api<NetworkView>(`/api/networks/${network.id}/members`, {
        method: 'POST',
        body: { serverId, name: name.trim() },
      }),
    'networks.memberAdded',
  );
  if (candidates.length === 0)
    return <p className="text-sm text-muted-foreground">{t('networks.noCandidates')}</p>;
  return (
    <form
      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined);
        setServerId('');
        setName('');
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`member-server-${network.id}`}>{t('networks.addServer')}</Label>
        <Select
          value={serverId}
          onValueChange={(id) => {
            setServerId(id);
            setName(memberNameFor(candidates.find((c) => c.id === id)?.name ?? ''));
          }}
        >
          <SelectTrigger id={`member-server-${network.id}`}>
            <SelectValue placeholder={t('networks.chooseServer')} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`member-name-${network.id}`}>{t('networks.memberName')}</Label>
        <Input
          id={`member-name-${network.id}`}
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder="lobby"
        />
      </div>
      <Button type="submit" disabled={!serverId || !name.trim() || add.isPending}>
        <Plus />
        {t('networks.add')}
      </Button>
    </form>
  );
}

function NetworkCard({
  network,
  candidates,
}: {
  readonly network: NetworkView;
  readonly candidates: readonly ServerSummary[];
}): ReactElement {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const patch = useNetworkMutation(
    (body: object) => api<NetworkView>(`/api/networks/${network.id}`, { method: 'PATCH', body }),
    'networks.saved',
  );
  const remove = useNetworkMutation(
    (serverId: string) =>
      api<NetworkView>(`/api/networks/${network.id}/members/${serverId}`, { method: 'DELETE' }),
    'networks.memberRemoved',
  );
  const del = useNetworkMutation(
    () => api(`/api/networks/${network.id}`, { method: 'DELETE' }),
    'networks.deleted',
  );
  return (
    <Card className="grid min-w-0 gap-5 p-4 sm:p-5">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          <Waypoints className="size-5 text-primary" aria-hidden />
          <span className="truncate">{network.name}</span>
        </CardTitle>
        <CardDescription>{t('networks.summary', { count: network.members.length })}</CardDescription>
      </CardHeader>

      <div className="grid gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">{t('networks.proxy')}</h3>
        <Link
          to={`/servers/${network.proxy.serverId}`}
          className="flex min-w-0 flex-wrap items-center gap-3 rounded-[12px] border border-border bg-secondary p-3 hover:border-primary"
        >
          <ServerIcon id={network.proxy.serverId} software="velocity" hasIcon={false} className="size-9" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{network.proxy.serverName}</p>
            <p className="truncate text-sm text-muted-foreground">
              {t('networks.address', { address: network.proxy.address })}
            </p>
          </div>
          <span className="text-sm tabular-nums text-muted-foreground">
            {t('networks.players', { count: network.proxy.players })}
          </span>
          <StatePill state={network.proxy.state} />
        </Link>
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">{t('networks.members')}</h3>
        {network.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('networks.noMembers')}</p>
        ) : null}
        <ul className="grid gap-2">
          {network.members.map((m) => (
            <li
              key={m.serverId}
              className="flex min-w-0 flex-wrap items-center gap-3 rounded-[12px] border border-border p-3"
            >
              <ServerIcon
                id={m.serverId}
                software={m.software as ServerSummary['software']}
                hasIcon={false}
                className="size-9"
              />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/servers/${m.serverId}`}
                  className="block truncate font-semibold hover:text-primary"
                >
                  {m.serverName}
                </Link>
                <p className="truncate font-mono text-xs text-muted-foreground">{m.name}</p>
              </div>
              {m.restartRequired ? <Pill tone="warn">{t('networks.restartRequired')}</Pill> : null}
              {m.isDefault ? (
                <Pill tone="accent" dot={false}>
                  <Crown className="size-3.5" aria-hidden />
                  {t('networks.landing')}
                </Pill>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => patch.mutate({ defaultMember: m.name })}>
                  {t('networks.makeLanding')}
                </Button>
              )}
              <span className="text-sm tabular-nums text-muted-foreground">
                {t('networks.players', { count: m.players })}
              </span>
              <StatePill state={m.state} />
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('networks.removeMember', { name: m.serverName })}
                onClick={() => remove.mutate(m.serverId)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        <AddMember network={network} candidates={candidates} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <label className="flex min-w-0 items-center gap-3 text-sm">
          <Switch
            checked={network.onlineMode}
            onCheckedChange={(onlineMode) => patch.mutate({ onlineMode })}
          />
          <span className="min-w-0">
            <span className="font-semibold">{t('networks.onlineMode')}</span>
            <span className="block text-muted-foreground">{t('networks.onlineModeHint')}</span>
          </span>
        </label>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          <Trash2 />
          {t('networks.delete')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('networks.deleteTitle', { name: network.name })}
        description={t('networks.deleteText')}
        confirmLabel={t('networks.delete')}
        onConfirm={async () => {
          await del.mutateAsync(undefined);
        }}
      />
    </Card>
  );
}

/** Admins: Velocity proxies with the servers behind them – one address, many servers. */
export function NetworksPage(): ReactElement {
  const { t } = useTranslation();
  const { data: networks } = useQuery(networksQuery);
  const { data: servers } = useQuery(serversQuery);
  const taken = new Set(
    (networks ?? []).flatMap((n) => [n.proxy.serverId, ...n.members.map((m) => m.serverId)]),
  );
  const free = (servers ?? []).filter((s) => !taken.has(s.id));
  const proxies = free.filter((s) => s.software === 'velocity');
  const candidates = free.filter((s) => NETWORK_MEMBER_SOFTWARE.some((sw) => sw === s.software));
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('networks.title')} subtitle={t('networks.subtitle')} />
      {networks && networks.length === 0 ? (
        <EmptyState
          icon={<Waypoints className="size-6" />}
          title={t('networks.emptyTitle')}
          text={t('networks.emptyText')}
        />
      ) : null}
      {networks?.map((n) => (
        <NetworkCard key={n.id} network={n} candidates={candidates} />
      ))}
      <CreateNetwork proxies={proxies} />
      <section className="grid gap-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">{t('networks.howTitle')}</h2>
        <ul className="grid list-disc gap-1 pl-5">
          <li>{t('networks.how1')}</li>
          <li>{t('networks.how2')}</li>
          <li>{t('networks.how3')}</li>
          <li>{t('networks.how4')}</li>
        </ul>
      </section>
    </div>
  );
}

export default NetworksPage;
