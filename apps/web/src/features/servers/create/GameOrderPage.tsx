import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, Check, Cpu, Dices, Gauge, Globe, KeyRound, Rocket, Users } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { GAMES, type CreateServerInput, type GameId } from '@mornihosting/shared';
import { Badge } from '@/components/art';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/misc';
import { confetti } from '@/lib/confetti';
import { formatMemoryMb } from '@/lib/format';
import { useServerMemoryCap } from '@/lib/my-quota';
import { PriceWithCoupon } from './coupon';
import { errorText } from '@/lib/query';
import { placeOrder, RequestSent } from './order-submit';
import { useSession } from '@/features/auth/session';
import { cn } from '@/lib/utils';
import { hostQuery } from '@/features/dashboard/HostStrip';
import { toNetbirdName, useAddressAutomation } from '@/features/netbird/netbird';
import { serversQuery } from '../live';
import { GameFieldsForm } from '../settings/GameSettingsCard';
import { AddOn, AddOnTile, OWN_TEXT_COLOUR, Section, nextFreePort, suggestName } from './order-parts';

const MB_PER_GB = 1024;
const BACKUP_TIME = '04:00';

/**
 * Ordering a server for another game (Factorio, Counter-Strike 2, …): the same steps as for Minecraft, with
 * the game's own packages, versions and settings. Nothing is chosen for the person.
 */
export function GameOrderPage({ game: id }: { game: GameId }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const game = GAMES[id];
  const { data: servers = [] } = useQuery(serversQuery);
  const { data: host } = useQuery(hostQuery);
  const address = useAddressAutomation();
  const memoryCap = useServerMemoryCap();

  const [gb, setGb] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [subdomain, setSubdomain] = useState('');
  const [nameIdea, setNameIdea] = useState(suggestName);
  const [displayName, setDisplayName] = useState('');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [backups, setBackups] = useState(false);
  const [startNow, setStartNow] = useState(false);
  const [coupon, setCoupon] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [portPick, setPortPick] = useState<number | null>(null);

  const [main] = game.ports;
  const port = portPick ?? nextFreePort(main.defaultPort, servers);
  const addressName = toNetbirdName(subdomain, '');
  const name = displayName.trim() || subdomain.trim();
  const hostname = address && addressName ? `${addressName}.${address.domain}` : null;
  const hostTotalGb = host ? host.memoryTotalMb / MB_PER_GB : null;
  // Packages above the person's RAM per server (normally 16 GB) cannot be picked; admins have no limit.
  const overCap = (size: number): boolean => memoryCap !== null && size * MB_PER_GB > memoryCap;
  const capText = memoryCap === null ? '' : t('order.memoryCap', { ram: formatMemoryMb(memoryCap) });
  const playersFor = (size: number): number =>
    Math.min(game.maxPlayers, Math.round(size * game.playersPerGb));

  const { me } = useSession();
  const [requestSent, setRequestSent] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      if (gb === null || version === null) throw new Error('incomplete order');
      const body: CreateServerInput = {
        name,
        edition: id,
        software: id,
        version,
        memoryMb: gb * MB_PER_GB,
        port,
        eula: true,
        autoStart: true,
        startNow,
        gameSettings: settings,
        ...(address && addressName ? { netbirdName: addressName } : {}),
        ...(coupon ? { coupon } : {}),
        addOns: { geyser: false, via: false, voice: false, backups, craftattack: false },
      };
      const server = await placeOrder(body, me.user.canCreateServers);
      if (!server) return null;
      return server;
    },
    onSuccess: (server) => {
      if (!server) {
        confetti();
        setRequestSent(true);
        return;
      }
      confetti();
      void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate(`/servers/${server.id}`);
    },
    onError: () => undefined,
  });

  const ready =
    gb !== null && version !== null && Boolean(name) && terms && (!address || Boolean(addressName));
  const joinAt = hostname ? `${hostname}:${port}` : `Port ${port}`;

  if (requestSent) return <RequestSent />;

  return (
    <div className="grid gap-5">
      <header className="grid gap-3 rounded-[16px] border border-border bg-card bg-[radial-gradient(ellipse_at_0%_0%,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_60%)] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-3 text-2xl font-extrabold tracking-[-0.02em] sm:text-3xl">
            <Badge glyph={`game-${id}`} className="size-11" />
            {t('games.orderTitle', { game: game.label })}
          </h1>
          <Link
            to="/servers/new"
            className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            <ArrowLeft className="size-4" />
            {t('order.backToGames')}
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">{t(`games.${id}.about`)}</p>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-[16px] border border-border bg-card">
          <Section
            number={1}
            icon={<Gauge className="size-5" />}
            title={t('order.performance')}
            text={t('games.performanceText')}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {game.packagesGb.map((size) => {
                const selected = gb === size;
                const tooBig = (hostTotalGb !== null && size > hostTotalGb) || overCap(size);
                return (
                  <button
                    key={size}
                    type="button"
                    aria-pressed={selected}
                    disabled={tooBig}
                    title={overCap(size) ? capText : undefined}
                    style={OWN_TEXT_COLOUR}
                    onClick={() => setGb(size)}
                    className={cn(
                      'relative grid justify-items-center gap-1.5 rounded-[14px] border border-border bg-secondary/50 px-3 py-4 text-center transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-40',
                      selected && 'border-primary bg-accent ring-1 ring-primary',
                    )}
                  >
                    {size === game.recommendedGb ? (
                      <span className="absolute -top-2.5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground">
                        {t('order.recommended')}
                      </span>
                    ) : null}
                    <span className="text-2xl font-extrabold">
                      {size} GB <span className="text-muted-foreground">RAM</span>
                    </span>
                    <span className="flex items-center gap-1 rounded-[8px] border border-border px-2 py-0.5 text-xs">
                      ~{playersFor(size)} <Users className="size-3.5" aria-hidden />
                    </span>
                    <span className="text-sm font-semibold">{t('landing.free')}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-sm text-muted-foreground">
              {t(`games.${id}.memoryHint`, { gb: game.recommendedGb })}
            </p>
            {game.packagesGb.some(overCap) ? (
              <p className="text-sm text-muted-foreground">{capText}</p>
            ) : null}
          </Section>

          <Section
            number={2}
            icon={<Cpu className="size-5" />}
            title={t('games.versionTitle')}
            text={t('games.versionText')}
          >
            <div className="flex flex-wrap gap-2">
              {game.versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={version === v.id}
                  style={OWN_TEXT_COLOUR}
                  onClick={() => setVersion(v.id)}
                  className={cn(
                    'grid gap-0.5 rounded-[10px] border border-border bg-secondary/60 px-3 py-2 text-left text-sm hover:border-primary',
                    version === v.id && 'border-primary bg-accent',
                  )}
                >
                  <span className="font-semibold">{t(`games.versions.${v.id}`)}</span>
                  <span className="text-xs text-muted-foreground">{t(`games.versions.${v.id}Text`)}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section
            number={3}
            icon={<Globe className="size-5" />}
            title={t('order.name')}
            text={t('order.nameText')}
          >
            <div className="flex items-stretch overflow-hidden rounded-[12px] border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
              <input
                aria-label={t('order.name')}
                value={subdomain}
                maxLength={40}
                spellCheck={false}
                autoComplete="off"
                placeholder={nameIdea}
                onChange={(e) => setSubdomain(e.target.value)}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-base outline-none"
              />
              <button
                type="button"
                style={OWN_TEXT_COLOUR}
                title={t('order.nameIdea')}
                aria-label={t('order.nameIdea')}
                onClick={() => {
                  setSubdomain(nameIdea);
                  setNameIdea(suggestName());
                }}
                className="flex items-center border-l border-input px-3 text-muted-foreground hover:text-primary"
              >
                <Dices className="size-4" aria-hidden />
              </button>
              {address ? (
                <span className="flex items-center border-l border-input bg-secondary px-3 font-mono text-sm text-muted-foreground">
                  .{address.domain}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {hostname ? t('games.addressReady', { address: `${hostname}:${port}` }) : null}
              {address && !hostname ? t('order.pickName', { domain: address.domain }) : null}
              {address ? null : t('order.noDomain')}
            </p>
            <Field id="game-server-name" label={t('order.displayName')} hint={t('order.displayNameHint')}>
              <Input
                id="game-server-name"
                maxLength={40}
                value={displayName}
                placeholder={subdomain}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
          </Section>

          <Section
            number={4}
            icon={<KeyRound className="size-5" />}
            title={t('games.settingsTitle')}
            text={t('games.settingsText')}
          >
            <GameFieldsForm
              game={id}
              values={settings}
              secretsSet={[]}
              onChange={setSettings}
              filter={(f) => f.onOrder === true}
            />
            {game.fields.some((f) => !f.onOrder) ? (
              <details className="rounded-[12px] border border-border p-3 text-sm">
                <summary className="cursor-pointer font-semibold">{t('games.moreSettings')}</summary>
                <div className="mt-3">
                  <GameFieldsForm
                    game={id}
                    values={settings}
                    secretsSet={[]}
                    onChange={setSettings}
                    filter={(f) => !f.onOrder}
                  />
                </div>
              </details>
            ) : null}
            <AddOn
              icon={
                <AddOnTile>
                  <Archive className="size-5 text-primary" aria-hidden />
                </AddOnTile>
              }
              title={t('order.backups')}
              text={t('order.backupsText', { time: BACKUP_TIME })}
              on={backups}
              recommended
              onChange={setBackups}
            />
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-muted-foreground">
                {t('order.advanced')}
              </summary>
              <div className="mt-3 max-w-[220px]">
                <Field
                  id="game-server-port"
                  label={t('create.port')}
                  hint={t('create.portHint', { port: main.defaultPort })}
                >
                  <Input
                    id="game-server-port"
                    type="number"
                    inputMode="numeric"
                    value={port}
                    onChange={(e) => setPortPick(Number(e.target.value) || null)}
                  />
                </Field>
              </div>
            </details>
          </Section>
        </div>

        <aside className="grid gap-4 rounded-[16px] border border-border bg-card p-5 lg:sticky lg:top-4">
          <h2 className="text-lg font-bold">{t('order.summary')}</h2>
          <dl className="grid gap-3 text-sm">
            <div className="flex justify-between gap-3 border-b border-border pb-3">
              <dt>
                <b className="block">{t('games.orderTitle', { game: game.label })}</b>
                <span className="font-mono text-xs uppercase text-muted-foreground">{name || '–'}</span>
              </dt>
              <dd className="font-semibold">{coupon ? t('order.coupon.paid') : t('landing.free')}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-border pb-3">
              <dt className="text-muted-foreground">{t('order.performance')}</dt>
              <dd className="text-right font-semibold">
                {gb === null ? '–' : `${gb} GB · ~${playersFor(gb)} ${t('order.players')}`}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-border pb-3">
              <dt className="text-muted-foreground">{t('games.versionTitle')}</dt>
              <dd className="text-right font-semibold">
                {version ? `${game.label} · ${t(`games.versions.${version}`)}` : '–'}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-border pb-3">
              <dt className="text-muted-foreground">{t('order.address')}</dt>
              <dd className="break-all text-right font-mono text-xs font-semibold">{joinAt}</dd>
            </div>
            {backups ? (
              <div className="flex justify-between gap-3 border-b border-border pb-3">
                <dt className="text-muted-foreground">{t('order.addOns')}</dt>
                <dd className="text-right font-semibold">{t('order.backups')}</dd>
              </div>
            ) : null}
          </dl>
          <div>
            <PriceWithCoupon onChange={setCoupon} />
            <p className="text-xs text-muted-foreground">
              {t('games.downloadNote', { gb: game.downloadGb })}
            </p>
          </div>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox checked={startNow} onCheckedChange={(v) => setStartNow(v === true)} />
            {t('order.startNow')}
          </label>
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox checked={terms} onCheckedChange={(v) => setTerms(v === true)} />
            <span>{t('games.terms', { game: game.label })}</span>
          </label>
          {create.error ? (
            <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">{errorText(create.error)}</p>
          ) : null}
          <Button size="lg" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            <Rocket />
            {create.isPending
              ? t('create.creating')
              : me.user.canCreateServers
                ? t('create.submit')
                : t('requests.submit')}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5" />
            {t('order.changeLater')}
          </p>
        </aside>
      </div>
    </div>
  );
}
