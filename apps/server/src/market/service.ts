import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import {
  SOFTWARE,
  type InstallResult,
  type InstalledContent,
  type MarketInstallInput,
  type MarketSearchResult,
  type ContentSource,
  type MarketSource,
  type MarketVersion,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { installedContent } from '../db/schema.js';
import { assertSafeName, type FileService } from '../files/service.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { UpstreamError, upstreamToAppError } from '../lib/http-client.js';
import { HTTP_UNPROCESSABLE } from '../lib/http-status.js';
import { createKeyedLock } from '../lib/locks.js';
import { compareVersionNames } from '../lib/version-compare.js';
import type { ServerService } from '../servers/service.js';
import { createCurseForge } from './curseforge.js';
import { downloadVerified } from './download.js';
import { hangar } from './hangar.js';
import { identifyBySha1, modrinth, modrinthProjectUrl, projectsById } from './modrinth.js';
import { geysermc } from './geysermc.js';
import { spiget } from './spiget.js';
import {
  PAGE_SIZE,
  type DependencyRef,
  type Provider,
  type ResolvedInstall,
  type SearchQuery,
  type Target,
} from './types.js';

export { compareVersionNames };

/** Search, install (with dependencies), switch on/off, update and remove plugins and mods. */

const DISABLED_SUFFIX = '.disabled';
const JAR = '.jar';
const MAX_DEPENDENCY_DEPTH = 4;
const MAX_DOWNLOAD_FACTOR = 4;

type Row = typeof installedContent.$inferSelect;

interface Planned {
  readonly source: ContentSource;
  readonly resolved: ResolvedInstall;
  readonly dependencyOf: string | null;
}

export interface MarketService {
  readonly search: (
    serverId: string,
    source: MarketSource,
    query: SearchQuery,
  ) => Promise<MarketSearchResult>;
  readonly versions: (serverId: string, source: MarketSource, projectId: string) => Promise<MarketVersion[]>;
  readonly install: (serverId: string, input: MarketInstallInput, actor: Actor) => Promise<InstallResult>;
  /** Installs the newest fitting version from any content source (also GeyserMC), with dependencies. */
  readonly installFrom: (
    serverId: string,
    source: ContentSource,
    projectId: string,
    actor: Actor,
  ) => Promise<InstallResult>;
  readonly list: (serverId: string) => InstalledContent[];
  readonly checkUpdates: (serverId: string) => Promise<InstalledContent[]>;
  readonly update: (serverId: string, fileName: string, actor: Actor) => Promise<InstallResult>;
  readonly setEnabled: (serverId: string, fileName: string, enabled: boolean, actor: Actor) => void;
  readonly remove: (serverId: string, fileName: string, actor: Actor) => void;
  readonly upload: (serverId: string, fileName: string, stream: Readable, actor: Actor) => Promise<void>;
}

const keyOf = (source: string, projectId: string): string => `${source}:${projectId}`;
// Everything but letters and digits, to compare names across marketplaces: "Via-Version" and "viaversion" match.
// https://regex101.com/?regex=%5B%5Ea-z0-9%5D%2B&flags=g&testString=via-version
const NOT_ALNUM = /[^a-z0-9]+/g;
const nameKey = (name: string): string => `name:${name.toLowerCase().replace(NOT_ALNUM, '')}`;
const baseName = (fileName: string): string =>
  fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName;

/** Maps network failures of every provider call to one friendly error. */
async function wrapUpstream<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof UpstreamError) throw upstreamToAppError(err, 'market_unavailable');
    throw err;
  }
}

function isNewer(
  latest: { versionId: string; versionName: string },
  current: { versionId: string | null; versionName: string | null },
): boolean {
  if (latest.versionId === current.versionId) return false;
  const byName = current.versionName ? compareVersionNames(latest.versionName, current.versionName) : null;
  return byName === null ? true : byName > 0;
}

export function createMarketService(
  ctx: AppContext,
  servers: ServerService,
  files: FileService,
): MarketService {
  const providers: Readonly<Record<ContentSource, Provider>> = {
    modrinth,
    geysermc,
    hangar,
    spiget,
    curseforge: createCurseForge(() => ctx.settings.curseforgeKey()),
  };
  const updates = new Map<string, Map<string, { versionId: string; versionName: string }>>();

  const withLock = createKeyedLock();

  const targetOf = (serverId: string): Target => {
    const row = servers.row(serverId);
    const software = SOFTWARE[row.software];
    if (software.content === 'none' || !software.contentDir) throw badRequest('no_content_support');
    return { software, version: row.version };
  };
  const contentDir = (serverId: string): string => {
    const dir = targetOf(serverId).software.contentDir ?? '';
    return path.join(servers.dir(serverId), dir);
  };
  const rowsOf = (serverId: string): Row[] =>
    ctx.db.select().from(installedContent).where(eq(installedContent.serverId, serverId)).all();
  const providerOf = (source: ContentSource): Provider => providers[source];

  const plan = async (
    target: Target,
    refs: readonly (DependencyRef & { dependencyOf: string })[],
    seen: ReadonlySet<string>,
    depth: number,
  ): Promise<{ planned: Planned[]; seen: ReadonlySet<string> }> => {
    const [head, ...tail] = refs;
    if (!head) return { planned: [], seen };
    if (seen.has(keyOf(head.source, head.projectId)) || depth > MAX_DEPENDENCY_DEPTH) {
      return plan(target, tail, seen, depth);
    }
    const resolved = await providerOf(head.source).resolve(target, head.projectId);
    // The same plugin may already be there from another marketplace: never install it twice.
    if (seen.has(nameKey(resolved.projectName))) {
      return plan(target, tail, new Set([...seen, keyOf(head.source, head.projectId)]), depth);
    }
    const afterSelf = new Set([
      ...seen,
      keyOf(head.source, head.projectId),
      keyOf(head.source, resolved.projectId),
      nameKey(resolved.projectName),
    ]);
    const deps = await plan(
      target,
      resolved.dependencies.map((d) => ({ ...d, dependencyOf: resolved.projectName })),
      afterSelf,
      depth + 1,
    );
    const rest = await plan(target, tail, deps.seen, depth);
    return {
      planned: [
        { source: head.source, resolved, dependencyOf: head.dependencyOf },
        ...deps.planned,
        ...rest.planned,
      ],
      seen: rest.seen,
    };
  };

  const place = async (serverId: string, item: Planned): Promise<string> => {
    const dir = contentDir(serverId);
    const fileName = path.basename(item.resolved.file.fileName);
    assertSafeName(fileName);
    if (!fileName.toLowerCase().endsWith(JAR)) throw badRequest('extension_not_allowed');
    const temp = await downloadVerified(
      item.resolved.file,
      dir,
      ctx.config.pluginUploadBytes * MAX_DOWNLOAD_FACTOR,
      path.join(ctx.config.dataDir, 'cache', 'downloads'),
    );
    const existing = ctx.db
      .select()
      .from(installedContent)
      .where(
        and(
          eq(installedContent.serverId, serverId),
          eq(installedContent.provider, item.source),
          eq(installedContent.projectId, item.resolved.projectId),
        ),
      )
      .get();
    const wasDisabled = existing ? fs.existsSync(path.join(dir, existing.fileName + DISABLED_SUFFIX)) : false;
    if (existing && existing.fileName !== fileName) {
      fs.rmSync(path.join(dir, existing.fileName), { force: true });
      fs.rmSync(path.join(dir, existing.fileName + DISABLED_SUFFIX), { force: true });
    }
    fs.renameSync(temp, path.join(dir, wasDisabled ? fileName + DISABLED_SUFFIX : fileName));
    const values = {
      serverId,
      provider: item.source,
      projectId: item.resolved.projectId,
      projectName: item.resolved.projectName,
      versionId: item.resolved.versionId,
      versionName: item.resolved.versionName,
      fileName,
      iconUrl: item.resolved.iconUrl,
      dependencyOf: item.dependencyOf,
    };
    if (existing)
      ctx.db.update(installedContent).set(values).where(eq(installedContent.id, existing.id)).run();
    else ctx.db.insert(installedContent).values(values).run();
    updates.get(serverId)?.delete(fileName);
    return fileName;
  };

  const placeAll = async (
    serverId: string,
    items: readonly Planned[],
  ): Promise<InstallResult['installed']> => {
    const [head, ...tail] = items;
    if (!head) return [];
    const fileName = await place(serverId, head);
    const rest = await placeAll(serverId, tail);
    return [{ name: head.resolved.projectName, fileName, dependency: head.dependencyOf !== null }, ...rest];
  };

  const installResolved = async (
    serverId: string,
    source: ContentSource,
    root: ResolvedInstall,
    actor: Actor,
  ): Promise<InstallResult> => {
    const target = targetOf(serverId);
    const rows = rowsOf(serverId);
    const twin = rows.find(
      (r) =>
        nameKey(r.projectName) === nameKey(root.projectName) &&
        (r.provider !== source || r.projectId !== root.projectId),
    );
    if (twin) throw conflict('content_already_installed', { name: twin.projectName, file: twin.fileName });
    const installedKeys = rows.flatMap((r) => [
      ...(r.projectId ? [keyOf(r.provider, r.projectId)] : []),
      nameKey(r.projectName),
    ]);
    const deps = await plan(
      target,
      root.dependencies.map((d) => ({ ...d, dependencyOf: root.projectName })),
      new Set([...installedKeys, keyOf(source, root.projectId), nameKey(root.projectName)]),
      1,
    );
    const planned: Planned[] = [{ source, resolved: root, dependencyOf: null }, ...deps.planned];
    const installed = await placeAll(serverId, planned);
    const manual = planned.flatMap((p) => p.resolved.manual);
    ctx.audit.record(actor, 'content.install', serverId, {
      source,
      project: root.projectName,
      version: root.versionName,
      dependencies: deps.planned.map((p) => p.resolved.projectName),
    });
    return { installed, manual };
  };

  const toEntry = (
    serverId: string,
    dir: string,
    name: string,
    byFile: ReadonlyMap<string, Row>,
  ): InstalledContent => {
    const stat = fs.statSync(path.join(dir, name));
    const base = baseName(name);
    const row = byFile.get(base);
    const contentKind = targetOf(serverId).software.content === 'mods' ? 'mods' : 'plugins';
    const urls: Readonly<Record<string, (id: string) => string>> = {
      modrinth: (id) => modrinthProjectUrl(contentKind, id),
      hangar: (id) => `https://hangar.papermc.io/${id}`,
      spiget: (id) => `https://www.spigotmc.org/resources/${id}/`,
      curseforge: (id) => `https://www.curseforge.com/projects/${id}`,
      geysermc: () => 'https://geysermc.org/download',
    };
    return {
      fileName: name,
      enabled: !name.endsWith(DISABLED_SUFFIX),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      source: row ? (row.provider as InstalledContent['source']) : 'upload',
      projectId: row?.projectId ?? null,
      name: row?.projectName ?? base.replace(/\.jar$/i, ''), // eslint-disable-line ts-patterns/require-regex-example -- drops the extension: "Chunky-1.4.jar" → "Chunky-1.4"
      versionName: row?.versionName ?? null,
      iconUrl: row?.iconUrl ?? null,
      url: row?.projectId ? (urls[row.provider]?.(row.projectId) ?? null) : null,
      dependencyOf: row?.dependencyOf ?? null,
      update: updates.get(serverId)?.get(base) ?? null,
    };
  };

  const list = (serverId: string): InstalledContent[] => {
    const dir = contentDir(serverId);
    if (!fs.existsSync(dir)) return [];
    const rows = rowsOf(serverId);
    const byFile = new Map(rows.map((r) => [r.fileName, r]));
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && baseName(d.name).toLowerCase().endsWith(JAR))
      .map((d) => d.name);
    const present = new Set(names.map(baseName));
    rows
      .filter((r) => !present.has(r.fileName))
      .forEach((r) => ctx.db.delete(installedContent).where(eq(installedContent.id, r.id)).run());
    return names
      .map((name) => toEntry(serverId, dir, name, byFile))
      .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  };

  /** Files nobody installed through the panel: ask Modrinth whether it knows them by hash. */
  const identifyUnknown = async (serverId: string): Promise<void> => {
    const dir = contentDir(serverId);
    const unknown = list(serverId).filter((e) => e.source === 'upload');
    if (!unknown.length) return;
    const hashed = unknown.map((e) => ({
      entry: e,
      sha1: crypto
        .createHash('sha1')
        .update(fs.readFileSync(path.join(dir, e.fileName)))
        .digest('hex'),
    }));
    const found = await identifyBySha1(hashed.map((h) => h.sha1));
    const projects = await projectsById([...new Set([...found.values()].map((v) => v.projectId))]);
    hashed.forEach(({ entry, sha1 }) => {
      const hit = found.get(sha1);
      const project = hit ? projects.get(hit.projectId) : undefined;
      if (!hit || !project) return;
      ctx.db
        .insert(installedContent)
        .values({
          serverId,
          provider: 'modrinth',
          projectId: hit.projectId,
          projectName: project.name,
          versionId: hit.versionId,
          versionName: hit.versionName,
          fileName: baseName(entry.fileName),
          iconUrl: project.iconUrl,
        })
        .run();
    });
  };

  const identifyUnknownSafely = async (serverId: string): Promise<void> => {
    try {
      await identifyUnknown(serverId);
    } catch (err) {
      // Identifying hand-added files is a bonus; updates for known ones still work.
      ctx.log.warn({ err }, 'modrinth hash lookup failed');
    }
  };

  return {
    search: (serverId, source, query) =>
      wrapUpstream(async () => {
        const target = targetOf(serverId);
        const result = await providerOf(source).search(target, query);
        const rows = rowsOf(serverId);
        const installed = new Set([
          ...rows.flatMap((r) => (r.projectId && r.provider === source ? [r.projectId] : [])),
          ...rows.map((r) => nameKey(r.projectName)),
        ]);
        return {
          hits: result.hits.map((h) => ({
            ...h,
            installed: installed.has(h.id) || installed.has(nameKey(h.name)),
          })),
          total: result.total,
          pageSize: PAGE_SIZE,
        };
      }),

    versions: (serverId, source, projectId) =>
      wrapUpstream(() => providerOf(source).versions(targetOf(serverId), projectId)),

    install: (serverId, input, actor) =>
      withLock(serverId, () =>
        wrapUpstream(async () => {
          const root = await providerOf(input.source).resolve(
            targetOf(serverId),
            input.projectId,
            input.versionId,
          );
          return installResolved(serverId, input.source, root, actor);
        }),
      ),

    installFrom: (serverId, source, projectId, actor) =>
      withLock(serverId, () =>
        wrapUpstream(async () => {
          const root = await providerOf(source).resolve(targetOf(serverId), projectId);
          return installResolved(serverId, source, root, actor);
        }),
      ),

    list,

    checkUpdates: (serverId) =>
      withLock(serverId, () =>
        wrapUpstream(async () => {
          const target = targetOf(serverId);
          await identifyUnknownSafely(serverId);
          const rows = rowsOf(serverId).filter((r) => r.projectId && r.provider !== 'upload');
          const results = await Promise.allSettled(
            rows.map(async (r) => ({
              row: r,
              latest: await providerOf(r.provider as ContentSource).resolve(target, r.projectId ?? ''),
            })),
          );
          const found = results.flatMap((res) =>
            res.status === 'fulfilled' &&
            isNewer(res.value.latest, {
              versionId: res.value.row.versionId,
              versionName: res.value.row.versionName,
            })
              ? [
                  [
                    res.value.row.fileName,
                    { versionId: res.value.latest.versionId, versionName: res.value.latest.versionName },
                  ] as const,
                ]
              : [],
          );
          updates.set(serverId, new Map(found));
          return list(serverId);
        }),
      ),

    update: (serverId, fileName, actor) =>
      withLock(serverId, () =>
        wrapUpstream(async () => {
          const row = rowsOf(serverId).find((r) => r.fileName === baseName(fileName));
          if (!row?.projectId || row.provider === 'upload') throw notFound('not_found');
          const source = row.provider as ContentSource;
          const root = await providerOf(source).resolve(targetOf(serverId), row.projectId);
          if (!isNewer(root, row)) {
            throw new AppError(HTTP_UNPROCESSABLE, 'content_up_to_date');
          }
          return installResolved(serverId, source, root, actor);
        }),
      ),

    setEnabled: (serverId, fileName, enabled, actor) => {
      const dir = contentDir(serverId);
      const base = baseName(path.basename(fileName));
      assertSafeName(base);
      const on = path.join(dir, base);
      const off = on + DISABLED_SUFFIX;
      const [from, to] = enabled ? [off, on] : [on, off];
      if (!fs.existsSync(from)) {
        if (fs.existsSync(to)) return;
        throw notFound();
      }
      fs.renameSync(from, to);
      ctx.audit.record(actor, enabled ? 'content.enable' : 'content.disable', serverId, { file: base });
    },

    remove: (serverId, fileName, actor) => {
      const dir = contentDir(serverId);
      const name = path.basename(fileName);
      assertSafeName(name);
      if (!fs.existsSync(path.join(dir, name))) throw notFound();
      const relativeDir = path.relative(servers.dir(serverId), dir);
      files.remove(serverId, [path.join(relativeDir, name)]);
      ctx.db
        .delete(installedContent)
        .where(and(eq(installedContent.serverId, serverId), eq(installedContent.fileName, baseName(name))))
        .run();
      ctx.audit.record(actor, 'content.remove', serverId, { file: name });
    },

    upload: async (serverId, fileName, stream, actor) => {
      const name = path.basename(fileName);
      if (!name.toLowerCase().endsWith(JAR)) throw badRequest('extension_not_allowed');
      const relativeDir = path.relative(servers.dir(serverId), contentDir(serverId));
      await files.upload(serverId, relativeDir, name, stream);
      ctx.audit.record(actor, 'content.upload', serverId, { file: name });
    },
  };
}
