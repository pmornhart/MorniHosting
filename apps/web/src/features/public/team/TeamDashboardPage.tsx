import {
  Ban,
  Clock,
  Gavel,
  History,
  Lock,
  MicOff,
  Radio,
  ScrollText,
  Search,
  ShieldCheck,
  Snowflake,
  SlidersHorizontal,
  Swords,
  Terminal,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import {
  TEAM_COMMANDS,
  type TeamBoardPlayer,
  type TeamCommand,
  type TeamSettings,
} from '@mornihosting/shared';
import { BrandMark, PlayerHead } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Pill } from '@/components/ui/pill';
import { setLanguage } from '@/i18n';
import { cn } from '@/lib/utils';
import { PlayerSheet } from './PlayerSheet';
import {
  can,
  useTeamAction,
  useTeamBoard,
  useTeamRules,
  useTeamSettings,
  type TeamRequest,
} from './team-api';
import { MorniCraftSections } from '@/features/servers/settings/MorniCraftCard';
import { MorniCraftRanks } from '@/features/servers/settings/MorniCraftRanks';
import { durationLabel, PunishDialog, RankPill, Tile, useLeft, type Board } from './team-ui';

const DEMO = import.meta.env.MODE === 'demo';
const TABS = ['players', 'jail', 'bans', 'history', 'rules', 'settings', 'commands'] as const;
type Tab = (typeof TABS)[number];
const MIN_RULE_ROWS = 6;
const SPARE_RULE_ROWS = 2;
const TIME = { hour: '2-digit', minute: '2-digit' } as const;
const DATE_TIME = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } as const;

/**
 * The team dashboard of a MorniCraft server (`/team/<server>#<key>`, from /teamdashboard in the game): everyone from
 * Moderator or owner sees who is online, who is in the jail, muted, frozen or banned, the punishments so far and the
 * rules – and gets exactly the buttons their rank allows. The key never leaves the browser except as a header.
 */
export function TeamDashboardPage(): ReactElement {
  const { t } = useTranslation();
  const { slug = '' } = useParams();
  // The demo has no real link; any key opens it there.
  const [key] = useState(() => window.location.hash.replace(/^#/, '') || (DEMO ? 'demo' : '')); // eslint-disable-line ts-patterns/require-regex-example -- "#abc" → "abc"
  const { data, error, isLoading } = useTeamBoard(slug, key);
  const action = useTeamAction(slug, key);
  const left = useLeft();
  const [tab, setTab] = useState<Tab>('players');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<TeamBoardPlayer | null>(null);
  const [punish, setPunish] = useState<{ action: 'jail' | 'mute' | 'ban' | 'kick'; name: string } | null>(
    null,
  );
  const locale = data?.locale;
  useEffect(() => {
    if (locale) setLanguage(locale);
  }, [locale]);
  // Keep the open player's card up to date with every refresh.
  const fresh = open ? (data?.online.find((p) => p.uuid === open.uuid) ?? open) : null;
  const players = useMemo(
    () => (data?.online ?? []).filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [data, query],
  );

  if (!key || error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-4 text-center">
        <div className="grid max-w-sm gap-3">
          <BrandMark className="mx-auto size-12" />
          <h1 className="text-xl font-bold">{t('teamBoard.closed')}</h1>
          <p className="text-sm text-muted-foreground">{t('teamBoard.closedText')}</p>
        </div>
      </main>
    );
  }
  if (isLoading || !data) {
    return (
      <main className="min-h-dvh bg-background px-4 py-8">
        <div className="mx-auto grid max-w-6xl gap-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-24" />
          <Skeleton className="h-96" />
        </div>
      </main>
    );
  }

  const send = (request: TeamRequest): void => {
    action.mutate(request);
    setPunish(null);
  };
  const frozen = data.online.filter((p) => p.frozen);
  const visibleTabs = TABS.filter(
    (x) => (x !== 'bans' || can(data, 'ban')) && (x !== 'settings' || data.settings !== null),
  );

  return (
    <main className="min-h-dvh bg-background px-4 py-6 sm:py-8">
      <div className="mx-auto grid max-w-6xl gap-5">
        <Card className="relative overflow-hidden p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-primary/15 blur-3xl"
          />
          <div className="relative flex flex-wrap items-center gap-4">
            <BrandMark className="size-12" />
            <div className="min-w-48 flex-1">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {data.server || 'MorniCraft'}
              </p>
              <h1 className="text-2xl font-bold">{t('teamBoard.title')}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                <PlayerHead
                  name={data.me.name}
                  skin={data.me.uuid || undefined}
                  className="size-6 rounded-md"
                />
                <span className="font-semibold">{data.me.name}</span>
                <RankPill name={data.me.rank} color={data.me.rankColor || '#34d399'} />
              </div>
            </div>
            <div className="grid w-full justify-items-start gap-1.5 sm:w-auto sm:justify-items-end sm:text-right">
              {data.live ? (
                <Pill tone="ok" ping>
                  {t('teamBoard.live')}
                </Pill>
              ) : (
                <Pill tone="bad">{t('teamBoard.offline')}</Pill>
              )}
              <p className="text-xs text-muted-foreground">
                {t('teamBoard.validUntil', {
                  time: new Date(data.me.until).toLocaleTimeString(undefined, TIME),
                })}
              </p>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile
            icon={<Users className="size-5" />}
            label={t('teamBoard.tiles.online')}
            value={`${data.online.length}/${data.max}`}
            tone="ok"
          />
          <Tile
            icon={<Lock className="size-5" />}
            label={t('teamBoard.tiles.jailed')}
            value={data.jailed.length}
            tone="bad"
          />
          <Tile
            icon={<MicOff className="size-5" />}
            label={t('teamBoard.tiles.muted')}
            value={data.muted.length}
            tone="warn"
          />
          <Tile
            icon={<Snowflake className="size-5" />}
            label={t('teamBoard.tiles.frozen')}
            value={frozen.length}
            tone="info"
          />
          <Tile
            icon={<Swords className="size-5" />}
            label={t('teamBoard.tiles.combat')}
            value={data.online.filter((p) => p.combat).length}
            tone="warn"
          />
          <Tile
            icon={<Ban className="size-5" />}
            label={t('teamBoard.tiles.banned')}
            value={data.bans.length}
            tone="bad"
          />
        </div>

        <div className="flex flex-wrap gap-1.5 rounded-2xl border border-border bg-card p-1.5">
          {visibleTabs.map((x) => (
            <button
              key={x}
              type="button"
              onClick={() => setTab(x)}
              style={{ color: 'inherit' }}
              className={cn(
                'flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition',
                tab === x ? 'bg-primary/15 text-primary' : 'hover:bg-secondary',
              )}
            >
              {
                {
                  players: <Users className="size-4" />,
                  jail: <Lock className="size-4" />,
                  bans: <Gavel className="size-4" />,
                  history: <History className="size-4" />,
                  rules: <ScrollText className="size-4" />,
                  commands: <Terminal className="size-4" />,
                  settings: <SlidersHorizontal className="size-4" />,
                }[x]
              }
              {t(`teamBoard.tabs.${x}`)}
            </button>
          ))}
        </div>

        {tab === 'players' ? (
          <section className="grid gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder={t('teamBoard.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {players.length === 0 ? (
              <Card className="p-8 text-center text-sm text-muted-foreground">{t('teamBoard.nobody')}</Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {players.map((p) => (
                  <button
                    key={p.uuid}
                    type="button"
                    onClick={() => setOpen(p)}
                    style={{ color: 'inherit' }}
                    className="mh-lift grid gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-primary/50"
                  >
                    <div className="flex items-center gap-3">
                      <PlayerHead
                        name={p.name}
                        skin={p.bedrock ? undefined : p.uuid}
                        className="size-11 rounded-lg"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{p.name}</p>
                        <RankPill name={p.rank} color={p.rankColor} />
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground">{p.ping} ms</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {p.jailedUntil ? (
                        <Pill tone="bad">
                          <Lock className="size-3" /> {left(p.jailedUntil)}
                        </Pill>
                      ) : null}
                      {p.mutedUntil ? (
                        <Pill tone="warn">
                          <MicOff className="size-3" /> {left(p.mutedUntil)}
                        </Pill>
                      ) : null}
                      {p.frozen ? (
                        <Pill tone="accent">
                          <Snowflake className="size-3" /> {t('teamBoard.frozen')}
                        </Pill>
                      ) : null}
                      {p.combat ? (
                        <Pill tone="warn">
                          <Swords className="size-3" /> {t('teamBoard.combat')}
                        </Pill>
                      ) : null}
                      {p.live ? (
                        <Pill tone="bad">
                          <Radio className="size-3" /> LIVE
                        </Pill>
                      ) : null}
                      {p.afk ? <Pill tone="neutral">AFK</Pill> : null}
                      {p.bedrock ? <Pill tone="neutral">Bedrock</Pill> : null}
                      {p.team ? (
                        <Pill tone="ok">
                          <ShieldCheck className="size-3" /> {t('teamBoard.teamMember')}
                        </Pill>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {tab === 'jail' ? (
          <section className="grid gap-4 lg:grid-cols-2">
            <Card className="grid gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 font-semibold">
                  <Lock className="size-4 text-red-400" /> {t('teamBoard.jailed')}
                </h2>
                <Button size="sm" variant="secondary" onClick={() => setPunish({ action: 'jail', name: '' })}>
                  {t('teamBoard.do.jail')}
                </Button>
              </div>
              {data.jailed.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('teamBoard.nobodyJailed')}</p>
              ) : (
                data.jailed.map((e) => (
                  <div key={e.uuid} className="flex items-center gap-3 rounded-xl border border-border p-3">
                    <PlayerHead name={e.name} skin={e.uuid} className="size-9 rounded-md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {e.name}{' '}
                        {e.online ? null : (
                          <span className="text-xs text-muted-foreground">
                            ({t('teamBoard.offlineShort')})
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{e.reason || '–'}</p>
                    </div>
                    <span className="flex items-center gap-1 text-sm font-semibold tabular-nums text-red-400">
                      <Clock className="size-3.5" /> {left(e.until)}
                    </span>
                    <Button size="sm" onClick={() => send({ action: 'free', target: e.name })}>
                      {t('teamBoard.do.free')}
                    </Button>
                  </div>
                ))
              )}
            </Card>
            <Card className="grid gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 font-semibold">
                  <MicOff className="size-4 text-amber-400" /> {t('teamBoard.muted')}
                </h2>
                <Button size="sm" variant="secondary" onClick={() => setPunish({ action: 'mute', name: '' })}>
                  {t('teamBoard.do.mute')}
                </Button>
              </div>
              {data.muted.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('teamBoard.nobodyMuted')}</p>
              ) : (
                data.muted.map((e) => (
                  <div key={e.uuid} className="flex items-center gap-3 rounded-xl border border-border p-3">
                    <PlayerHead name={e.name} skin={e.uuid} className="size-9 rounded-md" />
                    <p className="min-w-0 flex-1 truncate font-medium">{e.name}</p>
                    <span className="text-sm font-semibold tabular-nums text-amber-400">{left(e.until)}</span>
                    <Button size="sm" onClick={() => send({ action: 'unmute', target: e.name })}>
                      {t('teamBoard.do.unmute')}
                    </Button>
                  </div>
                ))
              )}
              {frozen.length ? (
                <>
                  <h2 className="mt-2 flex items-center gap-2 font-semibold">
                    <Snowflake className="size-4 text-sky-400" /> {t('teamBoard.frozenList')}
                  </h2>
                  {frozen.map((p) => (
                    <div key={p.uuid} className="flex items-center gap-3 rounded-xl border border-border p-3">
                      <PlayerHead name={p.name} skin={p.uuid} className="size-9 rounded-md" />
                      <p className="min-w-0 flex-1 truncate font-medium">{p.name}</p>
                      <Button size="sm" onClick={() => send({ action: 'freeze', target: p.name })}>
                        {t('teamBoard.do.unfreeze')}
                      </Button>
                    </div>
                  ))}
                </>
              ) : null}
            </Card>
          </section>
        ) : null}

        {tab === 'bans' ? (
          <Card className="grid gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-semibold">
                <Gavel className="size-4 text-red-400" /> {t('teamBoard.bans')}
              </h2>
              <Button size="sm" variant="danger" onClick={() => setPunish({ action: 'ban', name: '' })}>
                {t('teamBoard.do.ban')}
              </Button>
            </div>
            {data.bans.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('teamBoard.nobodyBanned')}</p>
            ) : (
              data.bans.map((b) => (
                <div
                  key={b.name}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3"
                >
                  <PlayerHead name={b.name} className="size-9 rounded-md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{b.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {b.reason || '–'} · {t('teamBoard.by', { name: b.by })}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-red-400">
                    {b.until ? left(b.until) : t('teamBoard.forever')}
                  </span>
                  <Button size="sm" onClick={() => send({ action: 'unban', target: b.name })}>
                    {t('teamBoard.do.unban')}
                  </Button>
                </div>
              ))
            )}
          </Card>
        ) : null}

        {tab === 'history' ? (
          <Card className="grid gap-2 p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <History className="size-4 text-primary" /> {t('teamBoard.history')}
            </h2>
            {data.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('teamBoard.noHistory')}</p>
            ) : (
              data.history.map((h) => (
                <div
                  key={`${h.at}-${h.target}-${h.type}`}
                  className="flex flex-wrap items-center gap-2 border-b border-border/60 py-2 text-sm last:border-0"
                >
                  <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">
                    {new Date(h.at).toLocaleString(undefined, DATE_TIME)}
                  </span>
                  <Pill tone={['free', 'unmute', 'unfreeze', 'unban'].includes(h.type) ? 'ok' : 'bad'}>
                    {t(`teamBoard.type.${h.type}`, { defaultValue: h.type })}
                  </Pill>
                  <span className="font-medium">{h.target}</span>
                  {h.minutes ? (
                    <span className="text-muted-foreground">· {durationLabel(t, h.minutes)}</span>
                  ) : null}
                  {h.reason ? <span className="text-muted-foreground">· „{h.reason}“</span> : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t('teamBoard.by', { name: h.by })}
                  </span>
                </div>
              ))
            )}
          </Card>
        ) : null}

        {tab === 'rules' ? (
          <RulesCard slug={slug} teamKey={key} rules={data.rules} editable={can(data, 'rules')} />
        ) : null}

        {tab === 'commands' ? <CommandsCard board={data} /> : null}

        {tab === 'settings' && data.settings ? (
          <SettingsCard
            slug={slug}
            teamKey={key}
            settings={data.settings}
            info={data.settingsInfo}
            knownNames={[...data.online.map((p) => p.name), ...data.history.map((h) => h.target)]}
          />
        ) : null}
      </div>

      <PlayerSheet
        player={fresh}
        board={data}
        onClose={() => setOpen(null)}
        onSend={send}
        onPunish={(a, name) => setPunish({ action: a, name })}
        busy={action.isPending}
      />
      <PunishDialog
        action={punish?.action ?? null}
        name={punish?.name ?? ''}
        busy={action.isPending}
        onClose={() => setPunish(null)}
        onSend={(r) => (punish ? send({ action: punish.action, ...r }) : undefined)}
      />
    </main>
  );
}

/** The server rules (/rules): owners and admins change them here, the game shows them at once. */
function RulesCard({
  slug,
  teamKey,
  rules,
  editable,
}: {
  slug: string;
  teamKey: string;
  rules: readonly string[];
  editable: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const save = useTeamRules(slug, teamKey);
  const [text, setText] = useState(rules.join('\n'));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setText(rules.join('\n'));
  }, [rules, touched]);
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <Card className="grid gap-3 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <ScrollText className="size-4 text-primary" /> {t('teamBoard.rules')}
      </h2>
      {editable ? (
        <>
          <p className="text-sm text-muted-foreground">{t('teamBoard.rulesHint')}</p>
          <textarea
            value={text}
            rows={Math.max(MIN_RULE_ROWS, lines.length + SPARE_RULE_ROWS)}
            onChange={(e) => {
              setText(e.target.value);
              setTouched(true);
            }}
            className="w-full rounded-xl border border-input bg-background p-3 text-sm"
          />
          <div className="flex items-center gap-3">
            <Button
              disabled={save.isPending || lines.length === 0}
              onClick={() => save.mutate(lines, { onSuccess: () => setTouched(false) })}
            >
              {t('teamBoard.saveRules')}
            </Button>
            {save.isSuccess && !touched ? (
              <span className="text-sm text-emerald-400">{t('teamBoard.saved')}</span>
            ) : null}
          </div>
        </>
      ) : (
        <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
          {rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** The commands of the team in the game: what this rank may use first, the rest greyed out below. */
function CommandsCard({ board }: { board: Board }): ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('en') ? 'en' : 'de';
  const mine = TEAM_COMMANDS.filter((c) => can(board, c.needs));
  const others = TEAM_COMMANDS.filter((c) => !can(board, c.needs));
  const row = (c: TeamCommand, allowed: boolean): ReactElement => (
    <div
      key={c.use.de}
      className={cn(
        'grid gap-1 rounded-xl border border-border px-3 py-2.5 sm:grid-cols-[minmax(0,18rem)_1fr] sm:items-center sm:gap-4',
        !allowed && 'opacity-50',
      )}
    >
      <code className="min-w-0 break-words font-mono text-[13px] font-semibold text-primary">
        {c.use[lang]}
      </code>
      <span className="text-sm text-muted-foreground">{c.text[lang]}</span>
    </div>
  );
  return (
    <Card className="grid gap-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Terminal className="size-4 text-primary" /> {t('teamBoard.commands.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('teamBoard.commands.text', { rank: board.me.rank || t('teamBoard.commands.team') })}
        </p>
      </div>
      <div className="grid gap-1.5">{mine.map((c) => row(c, true))}</div>
      {others.length ? (
        <div className="grid gap-1.5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Lock className="size-4 text-muted-foreground" /> {t('teamBoard.commands.ownerOnly')}
          </p>
          {others.map((c) => row(c, false))}
        </div>
      ) : null}
    </Card>
  );
}

/** The server's settings (TNT, spawn protection, start elytra …) – the same switches as in the panel. */
function SettingsCard({
  slug,
  teamKey,
  settings,
  info,
  knownNames,
}: {
  slug: string;
  teamKey: string;
  settings: TeamSettings;
  info: TeamBoardView['settingsInfo'];
  knownNames: readonly string[];
}): ReactElement {
  const { t } = useTranslation();
  const save = useTeamSettings(slug, teamKey);
  const [draft, setDraft] = useState<TeamSettings>(settings);
  const [base, setBase] = useState(settings);
  // The page reloads every few seconds: take over changes from elsewhere only while nothing is being edited here.
  useEffect(() => {
    if (JSON.stringify(draft) === JSON.stringify(base)) setDraft(settings);
    setBase(settings);
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the server's values change
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  return (
    <Card className="grid gap-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <SlidersHorizontal className="size-4 text-primary" /> {t('teamBoard.settings.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('teamBoard.settings.text')}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <MorniCraftSections draft={draft} set={(patch) => setDraft({ ...draft, ...patch })} />
      </div>
      <MorniCraftRanks
        knownNames={knownNames}
        ranks={draft.ranks}
        panelMembers={info?.panelMembers ?? { owner: [], moderator: [] }}
        badges={draft.badges}
        badgesReady={info?.badgesReady ?? false}
        onBadges={(on) => setDraft({ ...draft, badges: on })}
        badgesRequired={draft.badgesRequired}
        onBadgesRequired={(on) => setDraft({ ...draft, badgesRequired: on })}
        onChange={(ranks) => setDraft({ ...draft, ranks })}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {save.isSuccess && !dirty ? (
          <span className="text-sm text-emerald-400">{t('teamBoard.settings.saved')}</span>
        ) : null}
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
          {t('teamBoard.settings.save')}
        </Button>
      </div>
    </Card>
  );
}
