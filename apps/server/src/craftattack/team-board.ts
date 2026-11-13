import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  TEAM_ABILITIES,
  TEAM_ACTION_NEEDS,
  TEAM_ACTIONS,
  type TeamAbility,
  type TeamBoardEntry,
  type TeamBoardPlayer,
  type TeamBoardView,
} from '@mornihosting/shared';
import { forbidden, notFound } from '../lib/errors.js';

/**
 * The team dashboard of a MorniCraft server: the plugin writes what is going on (team/state.json) and a file per
 * personal link (team/links/<sha256 of the key>.json, from /teamdashboard). The page sends the key, the panel checks
 * it and shows only what this team member may see; buttons become small request files the plugin carries out.
 */

const TEAM_DIR = ['plugins', 'MorniCraft', 'team'];
/** The key from the link: 48 hex characters (24 random bytes) – "0123…cdef" (48 long) yes, "xyz" or 47 characters no. */
// https://regex101.com/?flavor=javascript&regex=%5E%5B0-9a-f%5D%7B48%7D%24&testString=0123456789abcdef0123456789abcdef0123456789abcdef
const KEY = /^[0-9a-f]{48}$/;
/** The game writes every 5 seconds; older than this = the server is not running. */
const STALE_MS = 60_000;
const MAX_MINUTES = 43_200;
const MAX_REASON = 120;
const MAX_RANK_ID = 24;
const REQUEST_ID_BYTES = 4;
// A Minecraft name (letters, digits, _) or a Bedrock name via Floodgate: "Steve", ".BedrockKid" yes, "a/b" no.
// https://regex101.com/?flavor=javascript&regex=%5E%5C.%3F%5Cw%7B1%2C32%7D%24&testString=.BedrockKid
const PLAYER = /^\.?\w{1,32}$/;

const linkSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  rank: z.string(),
  rankColor: z.string(),
  op: z.boolean(),
  abilities: z.array(z.string()),
  until: z.number(),
});

const itemSchema = z.object({ slot: z.number(), id: z.string(), count: z.number(), enchanted: z.boolean() });
const playerSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  rank: z.string(),
  rankId: z.string(),
  rankColor: z.string(),
  rankOrder: z.number(),
  team: z.boolean(),
  ping: z.number(),
  world: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  health: z.number(),
  food: z.number(),
  gamemode: z.string(),
  afk: z.boolean(),
  live: z.boolean(),
  combat: z.boolean(),
  frozen: z.boolean(),
  jailedUntil: z.number(),
  jailReason: z.string(),
  mutedUntil: z.number(),
  bedrock: z.boolean(),
  playMinutes: z.number(),
  inventory: z.array(itemSchema).default([]),
  ender: z.array(itemSchema).default([]),
});
const offlineSchema = z.object({ uuid: z.string(), name: z.string(), until: z.number(), reason: z.string() });
const stateSchema = z.object({
  at: z.number(),
  server: z.string(),
  max: z.number(),
  online: z.array(playerSchema),
  jailedOffline: z.array(offlineSchema),
  mutedOffline: z.array(offlineSchema),
  ranks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
      symbol: z.string(),
      default: z.boolean(),
    }),
  ),
  bans: z
    .array(
      z.object({
        name: z.string(),
        reason: z.string(),
        by: z.string(),
        since: z.number(),
        until: z.number(),
      }),
    )
    .default([]),
  history: z
    .array(
      z.object({
        at: z.number(),
        type: z.string(),
        target: z.string(),
        by: z.string(),
        reason: z.string(),
        minutes: z.number(),
      }),
    )
    .default([]),
});

export const teamActionSchema = z.object({
  action: z.enum(TEAM_ACTIONS),
  target: z.string().regex(PLAYER),
  minutes: z.number().int().min(0).max(MAX_MINUTES).optional(),
  reason: z.string().trim().max(MAX_REASON).optional(),
  rank: z.string().max(MAX_RANK_ID).optional(),
});
export type TeamActionInput = z.infer<typeof teamActionSchema>;

const teamDir = (serverDir: string): string => path.join(serverDir, ...TEAM_DIR);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The team member behind a key – or "not found" (unknown, expired). */
function linkOf(serverDir: string, key: string): z.infer<typeof linkSchema> {
  if (!KEY.test(key)) throw notFound('team_link_unknown');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const link = linkSchema.safeParse(readJson(path.join(teamDir(serverDir), 'links', `${hash}.json`)));
  if (!link.success || link.data.until < Date.now()) throw notFound('team_link_unknown');
  return link.data;
}

export function teamView(
  serverDir: string,
  key: string,
  locale: 'de' | 'en',
  rules: readonly string[],
): TeamBoardView {
  const link = linkOf(serverDir, key);
  const abilities = TEAM_ABILITIES.filter((a) => link.abilities.includes(a));
  const parsed = stateSchema.safeParse(readJson(path.join(teamDir(serverDir), 'state.json')));
  const state = parsed.success ? parsed.data : null;
  const now = Date.now();
  const locate = abilities.includes('locate');
  const online: TeamBoardPlayer[] = (state?.online ?? [])
    .map(({ world, x, y, z: zz, ...rest }) => ({
      ...rest,
      ...(locate ? { where: { world, x, y, z: zz } } : {}),
    }))
    .sort((a, b) => a.rankOrder - b.rankOrder || a.name.localeCompare(b.name));
  const fromOnline = (until: (p: TeamBoardPlayer) => number, reason: (p: TeamBoardPlayer) => string) =>
    online
      .filter((p) => until(p) > now)
      .map((p): TeamBoardEntry => ({
        uuid: p.uuid,
        name: p.name,
        until: until(p),
        reason: reason(p),
        online: true,
      }));
  const offline = (list: z.infer<typeof offlineSchema>[]): TeamBoardEntry[] =>
    list.filter((e) => e.until > now).map((e) => ({ ...e, online: false }));
  return {
    server: state?.server ?? '',
    locale,
    at: state?.at ?? 0,
    live: state !== null && now - state.at < STALE_MS,
    max: state?.max ?? 0,
    me: {
      uuid: link.uuid,
      name: link.name,
      rank: link.rank,
      rankColor: link.rankColor,
      abilities,
      until: link.until,
    },
    online,
    jailed: [
      ...fromOnline(
        (p) => p.jailedUntil,
        (p) => p.jailReason,
      ),
      ...offline(state?.jailedOffline ?? []),
    ],
    muted: [
      ...fromOnline(
        (p) => p.mutedUntil,
        () => '',
      ),
      ...offline(state?.mutedOffline ?? []),
    ],
    rules,
    bans: (state?.bans ?? []).filter((b) => b.until === 0 || b.until > now),
    history: state?.history ?? [],
    ranks: abilities.includes('ranks')
      ? (state?.ranks ?? []).map(({ id, name, color }) => ({ id, name, color }))
      : [],
  };
}

/** Throws unless the key is valid and its holder may do this. */
export function assertTeamAbility(serverDir: string, key: string, ability: TeamAbility): void {
  if (!linkOf(serverDir, key).abilities.includes(ability)) throw forbidden('team_not_allowed');
}

/** A button on the page: checked against what this team member may do, then handed to the game. */
export function teamAction(serverDir: string, key: string, input: TeamActionInput): void {
  const link = linkOf(serverDir, key);
  if (!link.abilities.includes(TEAM_ACTION_NEEDS[input.action])) throw forbidden('team_not_allowed');
  const dir = path.join(teamDir(serverDir), 'actions');
  fs.mkdirSync(dir, { recursive: true });
  const request = {
    action: input.action,
    target: input.target,
    minutes: input.minutes ?? 0,
    reason: input.reason ?? '',
    rank: input.rank ?? '',
    by: link.name,
  };
  // Written next to it first, then moved: the game never reads half a file.
  const name = `${Date.now()}-${crypto.randomBytes(REQUEST_ID_BYTES).toString('hex')}`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(request));
  fs.renameSync(tmp, path.join(dir, `${name}.json`));
}

/** The address the plugin hands out with /teamdashboard. */
export const teamLink = (domain: string, slug: string): string => `https://${domain}/team/${slug}`;
