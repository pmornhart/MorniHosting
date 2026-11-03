import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  Mic,
  Blocks,
  Check,
  Cpu,
  Dices,
  Gauge,
  Globe,
  Puzzle,
  Rocket,
  Settings2,
  ShieldCheck,
  Upload,
  Users,
  Zap,
} from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  CREATABLE_SOFTWARE,
  GAME_IDS,
  SOFTWARE,
  isGameId,
  type GameId,
  recommendedMemoryMb,
  type CreateServerInput,
  type SoftwareId,
  type VersionOption,
} from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Checkbox, Skeleton, Slider } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/art';
import { GameCard } from '@/components/game-card';
import { McBlock } from '@/components/mc-block';
import { ProjectLogo } from '@/components/project-logo';
import { confetti } from '@/lib/confetti';
import { PriceWithCoupon } from './coupon';
import { api } from '@/lib/api';
import { formatMemoryMb } from '@/lib/format';
import { errorText } from '@/lib/query';
import { useSession } from '@/features/auth/session';
import { cn } from '@/lib/utils';
import { hostQuery } from '@/features/dashboard/HostStrip';
import { toNetbirdName, useAddressAutomation } from '@/features/netbird/netbird';
import { GEYSER_SOFTWARE } from '../settings/GeyserCard';
import { VOICE_CHAT_SOFTWARE } from '../settings/VoiceChatCard';
import { serversQuery } from '../live';
import { GameOrderPage } from './GameOrderPage';
import { placeOrder, RequestSent } from './order-submit';
import {
  AddOn,
  AddOnTile,
  OWN_TEXT_COLOUR,
  Section,
  SoftwareIcon,
  nextFreePort,
  suggestName,
} from './order-parts';

/** What can be ordered, like at a hoster: Java, Bedrock, or a Java server Bedrock players can join (Geyser). */
const GAMES = ['java', 'bedrock', 'crossplay'] as const;
type Game = (typeof GAMES)[number];

const MB_PER_GB = 1024;
/* eslint-disable ts-patterns/no-magic-numbers -- the package table: GB, about how many players, and its stone */
type Tier =
  'stone' | 'copper' | 'iron' | 'gold' | 'emerald' | 'diamond' | 'amethyst' | 'redstone' | 'netherite';
/** The packages: memory and about how many players it carries (vanilla/Paper, a few plugins). */
const PLANS: readonly { readonly gb: number; readonly players: number; readonly tier: Tier }[] = [
  { gb: 2, players: 4, tier: 'stone' },
  { gb: 3, players: 6, tier: 'copper' },
  { gb: 4, players: 8, tier: 'iron' },
  { gb: 5, players: 10, tier: 'gold' },
  { gb: 6, players: 15, tier: 'emerald' },
  { gb: 8, players: 20, tier: 'diamond' },
  { gb: 10, players: 40, tier: 'amethyst' },
  { gb: 12, players: 50, tier: 'redstone' },
  { gb: 16, players: 100, tier: 'netherite' },
];
/** Each package is a Minecraft ore: the bigger, the rarer. The glow behind it takes the ore's colour. */
const TIER_GLOW: Readonly<Record<Tier, string>> = {
  stone: '#94a3b8',
  copper: '#ea7a3b',
  iron: '#e2c3a6',
  gold: '#facc15',
  emerald: '#22c55e',
  diamond: '#22d3ee',
  amethyst: '#a855f7',
  redstone: '#ef4444',
  netherite: '#a8a29e',
};
/* eslint-enable ts-patterns/no-magic-numbers */
/** Rough rule for a custom size between the packages: two players per GB. */
const PLAYERS_PER_GB = 2;
const MEMORY_STEP_MB = 512;
const MEMORY_MIN_MB = 1024;
/** Same ceiling as the server accepts (128 GB); the slider still stops at the machine's own RAM. */
const MEMORY_CAP_MB = 131072;
const FALLBACK_HOST_MB = 16384;
const EULA_URL = 'https://www.minecraft.net/eula';
const BACKUP_TIME = '04:00';

function isGame(value: string | null): value is Game {
  return GAMES.some((g) => g === value);
}

/** Step 0: which game, like the hoster's game selection. */
function GamePicker({ onPick }: { onPick: (game: Game | GameId) => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-3xl font-extrabold tracking-[-0.02em]">{t('order.pickTitle')}</h1>
        <p className="mt-1 text-muted-foreground">{t('order.pickText')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {GAMES.map((g) => (
          <GameCard key={g} game={g} onStart={() => onPick(g)} />
        ))}
      </div>
      <h2 className="mt-2 text-xl font-bold">{t('games.moreTitle')}</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {GAME_IDS.map((g) => (
          <GameCard key={g} game={g} onStart={() => onPick(g)} />
        ))}
      </div>
      <Button asChild variant="ghost" className="justify-self-start">
        <Link to="/servers/import">
          <Upload />
          {t('create.importInstead')}
        </Link>
      </Button>
    </div>
  );
}

/** Ordering a server like at a hoster: package, software, name, add-ons – and an order summary. Free, it's yours. */
export function CreateServerPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const gameParam = params.get('game');
  const otherGame = gameParam && isGameId(gameParam) ? gameParam : null;
  const game: Game | null = isGame(gameParam) ? gameParam : null;
  const { data: servers = [] } = useQuery(serversQuery);
  const { data: host } = useQuery(hostQuery);
  const address = useAddressAutomation();

  const edition = game === 'bedrock' ? 'bedrock' : 'java';
  const softwareChoices = CREATABLE_SOFTWARE[edition].filter(
    (id) => game !== 'crossplay' || GEYSER_SOFTWARE.includes(id),
  );
  const [softwarePick, setSoftwarePick] = useState<SoftwareId | null>(null);
  // Nothing is chosen for the person; only a single possibility (Bedrock) counts as chosen.
  const onlyChoice = softwareChoices.length === 1 ? (softwareChoices[0] ?? null) : null;
  const software: SoftwareId | null =
    softwarePick && softwareChoices.includes(softwarePick) ? softwarePick : onlyChoice;
  const portSoftware: SoftwareId = software ?? softwareChoices[0] ?? 'paper';
  const [version, setVersion] = useState('');
  const [showUnstable, setShowUnstable] = useState(false);
  const [memoryPick, setMemoryPick] = useState<number | null>(null);
  const [custom, setCustom] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [nameIdea, setNameIdea] = useState(suggestName);
  const [displayName, setDisplayName] = useState('');
  const [portPick, setPortPick] = useState<number | null>(null);
  const [addOns, setAddOns] = useState({ geyser: false, voice: false, backups: false });
  const [startNow, setStartNow] = useState(false);
  const [coupon, setCoupon] = useState<string | null>(null);
  const [eula, setEula] = useState(false);

  const geyserPossible = edition === 'java' && software !== null && GEYSER_SOFTWARE.includes(software);
  const geyser = game === 'crossplay' || (geyserPossible && addOns.geyser);

  const versions = useQuery({
    queryKey: ['versions', software],
    queryFn: () => api<VersionOption[]>(`/api/versions/${software ?? ''}`),
    enabled: game !== null && software !== null,
  });
  const versionList = useMemo(
    () => (versions.data ?? []).filter((v) => showUnstable || v.stable),
    [versions.data, showUnstable],
  );
  const latestStable = versions.data?.find((v) => v.stable)?.id ?? '';
  // The newest stable version is the one choice made for the person (Philip's wish); a picked one counts
  // while the list offers it (switching Geyser on Vanilla changes the list).
  const chosenVersion = versions.data?.some((v) => v.id === version) ? version : latestStable;

  const recommendedMb = recommendedMemoryMb(portSoftware);
  const recommendedPlan = PLANS.find((p) => p.gb * MB_PER_GB >= recommendedMb) ?? PLANS[PLANS.length - 1];
  const memoryMb = memoryPick;
  const hostTotal = host?.memoryTotalMb ?? FALLBACK_HOST_MB;
  const hostFree = host ? host.memoryTotalMb - host.memoryUsedMb : null;
  const maxMemory = Math.max(
    MEMORY_MIN_MB,
    Math.min(MEMORY_CAP_MB, Math.floor(hostTotal / MEMORY_STEP_MB) * MEMORY_STEP_MB),
  );
  const plan = custom ? undefined : PLANS.find((p) => p.gb * MB_PER_GB === memoryMb);
  const players =
    memoryMb === null
      ? null
      : (plan?.players ?? Math.max(1, Math.round((memoryMb / MB_PER_GB) * PLAYERS_PER_GB)));
  const memoryText =
    memoryMb === null ? '–' : `${formatMemoryMb(memoryMb)} · ~${players} ${t('order.players')}`;
  const overHostFree = hostFree !== null && memoryMb !== null && memoryMb > hostFree;

  const defaultPort = SOFTWARE[portSoftware].defaultPort;
  const port = portPick ?? nextFreePort(defaultPort, servers);
  const voicePossible = software !== null && VOICE_CHAT_SOFTWARE.includes(software);
  const voice = voicePossible && addOns.voice;
  const addressName = toNetbirdName(subdomain, '');
  const name = displayName.trim() || subdomain.trim();
  const hostname = address && addressName ? `${addressName}.${address.domain}` : null;

  const { me } = useSession();
  const [requestSent, setRequestSent] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      if (software === null || memoryMb === null) throw new Error('incomplete order');
      const body: CreateServerInput = {
        name,
        edition,
        software,
        version: chosenVersion,
        memoryMb,
        port,
        eula: true,
        autoStart: true,
        startNow,
        ...(address && addressName ? { netbirdName: addressName } : {}),
        ...(coupon ? { coupon } : {}),
        // The panel sets these up itself, one after another, before the first start.
        addOns: { geyser, voice, backups: addOns.backups },
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

  if (requestSent) return <RequestSent />;
  if (otherGame) return <GameOrderPage key={otherGame} game={otherGame} />;
  if (!game) return <GamePicker onPick={(g) => setParams({ game: g })} />;

  const ready =
    software !== null &&
    memoryMb !== null &&
    Boolean(chosenVersion) &&
    Boolean(name) &&
    eula &&
    (!address || Boolean(addressName));
  const features = [
    { key: 'panel', icon: Blocks },
    { key: 'instant', icon: Rocket },
    { key: 'secure', icon: ShieldCheck },
    { key: 'fast', icon: Zap },
  ] as const;

  return (
    <div className="grid gap-5">
      <header className="grid gap-3 rounded-[16px] border border-border bg-card bg-[radial-gradient(ellipse_at_0%_0%,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_60%)] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-3 text-2xl font-extrabold tracking-[-0.02em] sm:text-3xl">
            <McBlock kind={game === 'bedrock' ? 'diamond' : 'grass'} className="size-11" />
            {t(`order.title.${game}`)}
          </h1>
          <Link
            to="/servers/new"
            className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            <ArrowLeft className="size-4" />
            {t('order.backToGames')}
          </Link>
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {features.map(({ key, icon: Icon }) => (
            <li key={key} className="flex items-center gap-1.5">
              <Icon className="size-4 text-primary" aria-hidden />
              {t(`landing.perks.${key}`)}
            </li>
          ))}
        </ul>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-[16px] border border-border bg-card">
          <Section
            number={1}
            icon={<Gauge className="size-5" />}
            title={t('order.performance')}
            text={t('order.performanceText')}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {PLANS.map((p) => {
                const mb = p.gb * MB_PER_GB;
                const selected = !custom && memoryMb === mb;
                const tooBig = mb > hostTotal;
                return (
                  <button
                    key={p.gb}
                    type="button"
                    aria-pressed={selected}
                    disabled={tooBig}
                    style={OWN_TEXT_COLOUR}
                    onClick={() => {
                      setCustom(false);
                      setMemoryPick(mb);
                    }}
                    className={cn(
                      'group relative grid justify-items-center gap-2 rounded-[14px] border border-border bg-secondary/50 px-3 py-4 text-center text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-40',
                      selected && 'border-primary bg-accent ring-1 ring-primary',
                    )}
                  >
                    {p === recommendedPlan ? (
                      <span className="absolute -top-2.5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground">
                        {t('order.recommended')}
                      </span>
                    ) : null}
                    <span
                      className="grid size-[76px] place-items-center rounded-full"
                      style={{
                        background: `radial-gradient(circle, ${TIER_GLOW[p.tier]}55, transparent 68%)`,
                      }}
                    >
                      <McBlock
                        kind={p.tier}
                        className="size-[60px] transition-transform group-hover:-translate-y-0.5 group-hover:scale-110"
                      />
                    </span>
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                      {t(`order.tiers.${p.tier}`)}
                    </span>
                    <span className="-mt-1 text-xl font-extrabold">
                      {p.gb} GB <span className="text-muted-foreground">RAM</span>
                    </span>
                    <span className="flex items-center gap-1 rounded-[8px] border border-border px-2 py-0.5 text-xs">
                      ~{p.players} <Users className="size-3.5" aria-hidden />
                    </span>
                    <span className="text-sm font-semibold">{t('landing.free')}</span>
                  </button>
                );
              })}
            </div>
            <div
              className={cn(
                'grid gap-3 rounded-[14px] border border-dashed border-border p-4',
                custom && 'border-solid border-primary bg-accent',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-semibold">
                  <Settings2 className="size-4 text-primary" aria-hidden />
                  {t('order.custom')}
                </span>
                {custom ? (
                  <span className="text-sm font-semibold">{memoryText}</span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setCustom(true);
                      setMemoryPick(memoryMb ?? recommendedMb);
                    }}
                  >
                    {t('order.customize')}
                  </Button>
                )}
              </div>
              {custom ? (
                <>
                  <Slider
                    value={[memoryMb ?? recommendedMb]}
                    min={MEMORY_MIN_MB}
                    max={maxMemory}
                    step={MEMORY_STEP_MB}
                    onValueChange={([value]) => setMemoryPick(value ?? memoryMb)}
                    aria-label={t('order.custom')}
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{formatMemoryMb(MEMORY_MIN_MB)}</span>
                    <span>{formatMemoryMb(maxMemory)}</span>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('order.customText')}</p>
              )}
            </div>
            <p className={cn('text-sm', overHostFree ? 'text-warning' : 'text-muted-foreground')}>
              {overHostFree ? t('create.ramWarn') : null}
              {!overHostFree && software
                ? t('order.recommendation', {
                    software: SOFTWARE[software].label,
                    ram: formatMemoryMb(recommendedMb),
                  })
                : null}
              {!overHostFree && !software ? t('order.pickPlan') : null}
            </p>
          </Section>

          <Section
            number={2}
            icon={<Cpu className="size-5" />}
            title={t('order.software')}
            text={t('order.softwareText')}
          >
            {softwareChoices.length > 1 ? (
              <div className="flex flex-wrap gap-2">
                {softwareChoices.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={software === id}
                    style={OWN_TEXT_COLOUR}
                    onClick={() => {
                      setSoftwarePick(id);
                      setVersion('');
                      setPortPick(null);
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-[10px] border border-border bg-secondary/60 px-3 py-2 text-sm font-semibold hover:border-primary',
                      software === id && 'border-primary bg-accent',
                    )}
                    title={t(`create.software.${id}`)}
                  >
                    <SoftwareIcon id={id} />
                    {SOFTWARE[id].label}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {software ? t(`create.software.${software}`) : t('order.pickSoftware')}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid min-w-[180px] gap-2 text-sm font-semibold">
                {t('order.version')}
                {software && versions.isPending ? (
                  <Skeleton className="h-10" />
                ) : (
                  <Select value={chosenVersion} onValueChange={setVersion} disabled={!software}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('order.pickVersion')} />
                    </SelectTrigger>
                    <SelectContent>
                      {versionList.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.id === latestStable ? `${v.id} · ${t('create.latest')}` : v.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm font-semibold">
                <Switch checked={showUnstable} onCheckedChange={setShowUnstable} />
                {t('create.showUnstable')}
              </label>
            </div>
            {versions.error ? (
              <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
                {t('create.versionsFailed')} {errorText(versions.error)}
              </p>
            ) : null}
          </Section>

          <Section
            number={3}
            icon={<Globe className="size-5" />}
            title={t('order.name')}
            text={t('order.nameText')}
          >
            <div className="flex items-stretch overflow-hidden rounded-[12px] border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
              <input
                id="server-address"
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
              {hostname ? t('order.addressReady', { hostname }) : null}
              {address && !hostname ? t('order.pickName', { domain: address.domain }) : null}
              {address ? null : t('order.noDomain')}
            </p>
            {hostname && (edition === 'bedrock' || geyser) ? (
              <p className="rounded-[10px] bg-secondary px-3 py-2 text-sm text-muted-foreground">
                {edition === 'bedrock'
                  ? t('order.bedrockJoin', { hostname, port })
                  : t('order.geyserJoin', { hostname })}
              </p>
            ) : null}
            <Field id="server-name" label={t('order.displayName')} hint={t('order.displayNameHint')}>
              <Input
                id="server-name"
                maxLength={40}
                value={displayName}
                placeholder={subdomain}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
          </Section>

          <Section
            number={4}
            icon={<Puzzle className="size-5" />}
            title={t('order.addOns')}
            text={t('order.addOnsText')}
          >
            {edition === 'java' ? (
              <AddOn
                icon={
                  <AddOnTile>
                    <ProjectLogo
                      project="geyser"
                      className="size-7 rounded-[6px]"
                      fallback={<Badge glyph="crossplay" className="size-7" />}
                    />
                  </AddOnTile>
                }
                title={t('order.geyser')}
                text={geyserPossible ? t('order.geyserText') : t('order.notForSoftware')}
                on={geyser}
                locked={game === 'crossplay' || !geyserPossible}
                recommended={game !== 'crossplay' && geyserPossible}
                onChange={(on) => setAddOns({ ...addOns, geyser: on })}
              />
            ) : null}
            <AddOn
              icon={
                <AddOnTile>
                  <ProjectLogo
                    project="voicechat"
                    className="size-7 rounded-[6px]"
                    fallback={<Mic className="size-5 text-primary" aria-hidden />}
                  />
                </AddOnTile>
              }
              title={t('order.voice')}
              text={voicePossible ? t('order.voiceText') : t('order.notForSoftware')}
              on={voice}
              locked={!voicePossible}
              onChange={(on) => setAddOns({ ...addOns, voice: on })}
            />
            <AddOn
              icon={
                <AddOnTile>
                  <Archive className="size-5 text-primary" aria-hidden />
                </AddOnTile>
              }
              title={t('order.backups')}
              text={t('order.backupsText', { time: BACKUP_TIME })}
              on={addOns.backups}
              recommended
              onChange={(on) => setAddOns({ ...addOns, backups: on })}
            />
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-muted-foreground">
                {t('order.advanced')}
              </summary>
              <div className="mt-3 max-w-[220px]">
                <Field
                  id="server-port"
                  label={t('create.port')}
                  hint={t('create.portHint', { port: defaultPort })}
                >
                  <Input
                    id="server-port"
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
                <b className="block">{t(`order.title.${game}`)}</b>
                <span className="font-mono text-xs uppercase text-muted-foreground">{name || '–'}</span>
              </dt>
              <dd className="font-semibold">{coupon ? t('order.coupon.paid') : t('landing.free')}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-border pb-3">
              <dt className="text-muted-foreground">{t('order.performance')}</dt>
              <dd className="text-right font-semibold">{memoryText}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-border pb-3">
              <dt className="text-muted-foreground">{t('order.software')}</dt>
              <dd className="text-right font-semibold">
                {software ? `${SOFTWARE[software].label} ${chosenVersion}` : '–'}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-border pb-3">
              <dt className="text-muted-foreground">{t('order.address')}</dt>
              <dd className="break-all text-right font-mono text-xs font-semibold">
                {hostname ?? `Port ${port}`}
              </dd>
            </div>
            {geyser || voice || addOns.backups ? (
              <div className="flex justify-between gap-3 border-b border-border pb-3">
                <dt className="text-muted-foreground">{t('order.addOns')}</dt>
                <dd className="grid text-right font-semibold">
                  {geyser ? <span>{t('order.geyser')}</span> : null}
                  {voice ? <span>{t('order.voice')}</span> : null}
                  {addOns.backups ? <span>{t('order.backups')}</span> : null}
                </dd>
              </div>
            ) : null}
          </dl>
          <div>
            <PriceWithCoupon onChange={setCoupon} />
            {coupon ? null : <p className="text-xs text-muted-foreground">{t('order.priceNote')}</p>}
          </div>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox id="start-now" checked={startNow} onCheckedChange={(v) => setStartNow(v === true)} />
            {t('order.startNow')}
          </label>
          <div className="flex items-start gap-2.5 text-sm">
            <Checkbox id="eula" checked={eula} onCheckedChange={(v) => setEula(v === true)} />
            <label htmlFor="eula">
              {t('create.eula')}{' '}
              <a
                href={EULA_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary hover:underline"
              >
                {t('create.eulaLink')}
              </a>
            </label>
          </div>
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
