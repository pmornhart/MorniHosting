import SAMPLE from './team-demo.json';
import {
  TEAM_ACTION_NEEDS,
  type TeamAbility,
  type TeamAction,
  type TeamBoardBan,
  type TeamBoardEntry,
  type TeamBoardHistory,
  type TeamBoardItem,
  type TeamBoardPlayer,
  type TeamBoardView,
} from '@mornihosting/shared';

/**
 * The team dashboard (/teamdashboard) in the demo: a made-up MorniCraft server with players, someone in the jail,
 * someone muted, bans and a history. The buttons work – the pretend game carries them out a moment later, as the
 * real plugin does. The banner switches between the views of an owner and a moderator.
 */

const SECONDS = 60;
const MINUTE_MS = SECONDS * 1000;
const HOUR_MS = SECONDS * MINUTE_MS;
const LINK_HOURS = 12;
const MAX_PLAYERS = 40;
const MAX_HISTORY = 200;
/** Moderator and up count as the team (index in the rank list). */
const TEAM_UP_TO = SAMPLE.ranks.findIndex((r) => r.id === 'moderator');

type Role = 'owner' | 'moderator';
/** Sent when the demo banner switches the role; the team page then asks again. */
export const TEAM_DEMO_EVENT = 'mh-team-demo';
const ABILITIES: Readonly<Record<Role, readonly TeamAbility[]>> = {
  owner: ['moderate', 'kick', 'ban', 'locate', 'ranks', 'rules'],
  moderator: ['moderate', 'kick', 'ban', 'locate'],
};
const RANKS = SAMPLE.ranks;
const ME: Readonly<Record<Role, { readonly name: string; readonly rankId: string }>> = {
  owner: { name: 'Morni_TV', rankId: 'owner' },
  moderator: { name: 'Lena', rankId: 'moderator' },
};

type Row = readonly (string | number | boolean)[];
const items = (rows: readonly Row[]): TeamBoardItem[] =>
  rows.map(([slot, id, count, enchanted]) => ({
    slot: Number(slot),
    id: String(id),
    count: Number(count),
    enchanted: enchanted === true,
  }));
const INVENTORIES: Readonly<Record<string, TeamBoardItem[]>> = {
  rich: items(SAMPLE.inventories.rich),
  poor: items(SAMPLE.inventories.poor),
};

function rankFields(
  rankId: string,
): Pick<TeamBoardPlayer, 'rank' | 'rankId' | 'rankColor' | 'rankOrder' | 'team'> {
  const order = Math.max(
    0,
    RANKS.findIndex((r) => r.id === rankId),
  );
  const rank = RANKS[order];
  return {
    rank: rank?.name ?? '',
    rankId,
    rankColor: rank?.color ?? '',
    rankOrder: order,
    team: order <= TEAM_UP_TO,
  };
}

const now = (): number => Date.now();
const minutesFromNow = (minutes: number): number => now() + minutes * MINUTE_MS;

function freshState() {
  return {
    role: 'owner' as Role,
    online: SAMPLE.players.map((p): TeamBoardPlayer => {
      const [x = 0, y = 0, z = 0] = p.where;
      return {
        ...SAMPLE.base,
        uuid: p.uuid,
        name: p.name,
        ...rankFields(p.rankId),
        afk: false,
        live: false,
        combat: false,
        frozen: false,
        jailReason: '',
        bedrock: false,
        jailedUntil: 'jailMinutes' in p && p.jailMinutes ? minutesFromNow(p.jailMinutes) : 0,
        mutedUntil: 'muteMinutes' in p && p.muteMinutes ? minutesFromNow(p.muteMinutes) : 0,
        inventory: INVENTORIES[p.inventory] ?? [],
        ender: items(SAMPLE.inventories.ender),
        where: { world: 'world', x, y, z },
        ...p.extra,
      };
    }),
    jailedOffline: SAMPLE.jailedOffline.map((e): TeamBoardEntry => ({
      uuid: e.uuid,
      name: e.name,
      until: minutesFromNow(e.inMinutes),
      reason: e.reason,
      online: false,
    })),
    mutedOffline: [] as TeamBoardEntry[],
    bans: SAMPLE.bans.map((b): TeamBoardBan => ({
      name: b.name,
      reason: b.reason,
      by: b.by,
      since: minutesFromNow(-b.minutesAgo),
      until: b.forMinutes ? minutesFromNow(b.forMinutes - b.minutesAgo) : 0,
    })),
    history: SAMPLE.history.map(({ minutesAgo, ...h }): TeamBoardHistory => ({
      ...h,
      at: minutesFromNow(-minutesAgo),
    })),
    rules: [...SAMPLE.rules],
  };
}

let state = freshState();

/** Banner switch: see the dashboard as owner or as moderator. */
export function teamDemoRole(): Role {
  return state.role;
}
export function setTeamDemoRole(role: Role): void {
  state = { ...state, role };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function entries(kind: 'jail' | 'mute'): TeamBoardEntry[] {
  const t = now();
  const field = kind === 'jail' ? 'jailedUntil' : 'mutedUntil';
  const online = state.online
    .filter((p) => p[field] > t)
    .map((p) => ({
      uuid: p.uuid,
      name: p.name,
      until: p[field],
      reason: kind === 'jail' ? p.jailReason : '',
      online: true,
    }));
  const offline = (kind === 'jail' ? state.jailedOffline : state.mutedOffline).filter((e) => e.until > t);
  return [...online, ...offline];
}

export function teamDemoView(): TeamBoardView {
  const role = state.role;
  const abilities = ABILITIES[role];
  const me = ME[role];
  const rank = RANKS.find((r) => r.id === me.rankId);
  const t = now();
  const locate = abilities.includes('locate');
  return {
    server: 'mornicraft',
    locale: 'de',
    at: t,
    live: true,
    max: MAX_PLAYERS,
    me: {
      uuid: state.online.find((p) => p.name === me.name)?.uuid ?? '',
      name: me.name,
      rank: rank?.name ?? '',
      rankColor: rank?.color ?? '',
      abilities,
      until: t + LINK_HOURS * HOUR_MS,
    },
    online: state.online.map((p) => (locate ? p : { ...p, where: undefined })),
    jailed: entries('jail'),
    muted: entries('mute'),
    ranks: abilities.includes('ranks') ? RANKS.map((r) => ({ ...r })) : [],
    bans: state.bans.filter((b) => b.until === 0 || b.until > t),
    history: state.history,
    rules: state.rules,
  };
}

interface Request {
  readonly action: TeamAction;
  readonly target: string;
  readonly minutes?: number;
  readonly reason?: string;
  readonly rank?: string;
}

const until = (minutes: number | undefined): number => (minutes ? now() + minutes * MINUTE_MS : 0);

function change(name: string, patch: (p: TeamBoardPlayer) => Partial<TeamBoardPlayer>): boolean {
  const found = state.online.some((p) => same(p.name, name));
  state.online = state.online.map((p) => (same(p.name, name) ? { ...p, ...patch(p) } : p));
  return found;
}

/** What each button does in the pretend game. */
const EFFECTS: Readonly<Record<TeamAction, (r: Request) => string>> = {
  jail: (r) => {
    const end = until(r.minutes);
    if (!change(r.target, () => ({ jailedUntil: end, jailReason: r.reason ?? '', gamemode: 'adventure' })))
      state.jailedOffline = [
        ...state.jailedOffline.filter((e) => !same(e.name, r.target)),
        { uuid: '', name: r.target, until: end, reason: r.reason ?? '', online: false },
      ];
    return 'jail';
  },
  free: (r) => {
    change(r.target, () => ({ jailedUntil: 0, jailReason: '', gamemode: 'survival' }));
    state.jailedOffline = state.jailedOffline.filter((e) => !same(e.name, r.target));
    return 'free';
  },
  mute: (r) => {
    const end = until(r.minutes);
    if (!change(r.target, () => ({ mutedUntil: end })))
      state.mutedOffline = [
        ...state.mutedOffline.filter((e) => !same(e.name, r.target)),
        { uuid: '', name: r.target, until: end, reason: r.reason ?? '', online: false },
      ];
    return 'mute';
  },
  unmute: (r) => {
    change(r.target, () => ({ mutedUntil: 0 }));
    state.mutedOffline = state.mutedOffline.filter((e) => !same(e.name, r.target));
    return 'unmute';
  },
  freeze: (r) => {
    const was = state.online.find((p) => same(p.name, r.target))?.frozen ?? false;
    change(r.target, () => ({ frozen: !was }));
    return was ? 'unfreeze' : 'freeze';
  },
  kick: (r) => {
    state.online = state.online.filter((p) => !same(p.name, r.target));
    return 'kick';
  },
  ban: (r) => {
    state.online = state.online.filter((p) => !same(p.name, r.target));
    state.bans = [
      ...state.bans.filter((b) => !same(b.name, r.target)),
      {
        name: r.target,
        reason: r.reason ?? '',
        by: ME[state.role].name,
        since: now(),
        until: until(r.minutes),
      },
    ];
    return 'ban';
  },
  unban: (r) => {
    state.bans = state.bans.filter((b) => !same(b.name, r.target));
    return 'unban';
  },
  rank: (r) => {
    const order = RANKS.findIndex((x) => x.id === r.rank);
    const rank = RANKS[order];
    if (rank)
      change(r.target, () => ({
        rank: rank.name,
        rankId: rank.id,
        rankColor: rank.color,
        rankOrder: order,
        team: order <= TEAM_UP_TO,
      }));
    return '';
  },
};

/** Carries out a button; false when this role may not use it. */
export function teamDemoAction(request: Request): boolean {
  if (!ABILITIES[state.role].includes(TEAM_ACTION_NEEDS[request.action])) return false;
  const type = EFFECTS[request.action](request);
  if (type)
    state.history = [
      {
        at: now(),
        type,
        target: request.target,
        by: ME[state.role].name,
        reason: request.reason ?? '',
        minutes: request.minutes ?? 0,
      },
      ...state.history,
    ].slice(0, MAX_HISTORY);
  return true;
}

export function teamDemoRules(rules: readonly string[]): boolean {
  if (!ABILITIES[state.role].includes('rules')) return false;
  state.rules = [...rules];
  return true;
}
