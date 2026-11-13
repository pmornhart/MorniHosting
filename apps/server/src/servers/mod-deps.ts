import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries } from '../lib/zip.js';

/**
 * Which plugins and mods need something that is not installed – read straight from their own files (plugin.yml,
 * fabric.mod.json, mods.toml …), the same place the server reads it from. The crash helper uses it so a missing
 * mod is called a missing mod (with "install it" as the fix), not "switch the plugin off".
 */

const FOLDERS = ['plugins', 'mods'] as const;
const JAR = '.jar';
const DISABLED = '.jar.disabled';
const KB = 1024;
const DESCRIPTOR_KB = 256;
const NESTED_JAR_MB = 16;
const MAX_DESCRIPTOR_BYTES = DESCRIPTOR_KB * KB;
/** Mods bundle libraries as jars inside their jar (Fabric "jar-in-jar", Forge "JarJar"); those count as installed. */
const MAX_NESTED_JAR_BYTES = NESTED_JAR_MB * KB * KB;
const MAX_NESTING = 2;
const DESCRIPTORS = new Set([
  'plugin.yml',
  'paper-plugin.yml',
  'bungee.yml',
  'velocity-plugin.json',
  'fabric.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
]);
const NESTED_DIRS = ['META-INF/jars/', 'META-INF/jarjar/'];
/**
 * Which of those files each server software really reads. Many jars carry several at once (ViaVersion has a
 * plugin.yml and a fabric.mod.json that needs ViaFabric) – on Paper only the plugin files count, else a Paper server
 * would "miss" ViaFabric.
 */
const PLUGIN_FILES = ['plugin.yml', 'paper-plugin.yml'];
const PLATFORM_DESCRIPTORS: Readonly<Record<string, readonly string[]>> = {
  paper: PLUGIN_FILES,
  purpur: PLUGIN_FILES,
  custom: [...PLUGIN_FILES, 'bungee.yml'],
  velocity: ['velocity-plugin.json'],
  fabric: ['fabric.mod.json'],
  forge: ['META-INF/mods.toml'],
  neoforge: ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml'],
};
/** The descriptor files that count for this software (all of them when it is not known). */
const descriptorsFor = (software?: string): ReadonlySet<string> =>
  new Set(software ? (PLATFORM_DESCRIPTORS[software] ?? [...DESCRIPTORS]) : [...DESCRIPTORS]);
/** Provided by the game, the loader or Java itself – never a separate file. */
const BUILT_IN = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'quilt_loader',
  'forge',
  'neoforge',
  'javafml',
  'lowcodefml',
  'mixinextras',
  'velocity',
]);
/** Old names that mean the same mod today. */
const ALIASES: Readonly<Record<string, string>> = { fabric: 'fabric-api' };

// A YAML list written inline: "depend: [Vault, ProtocolLib]" → "Vault, ProtocolLib" (key given separately).
// https://regex101.com/?flavor=javascript&regex=%5Edepend%3A%5B%20%5Ct%5D*%5C%5B(%5B%5E%5C%5D%5D*)%5C%5D&flags=m&testString=name%3A%20Shop%0Adepend%3A%20%5BVault%2C%20ProtocolLib%5D
const inlineList = (key: string): RegExp => new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]`, 'm');
// A YAML list written as lines: "depend:\n  - Vault\n  - ProtocolLib" → "  - Vault\n  - ProtocolLib".
// https://regex101.com/?flavor=javascript&regex=%5Edepend%3A%5B%20%5Ct%5D*%5Cr%3F%5Cn((%3F%3A%5B%20%5Ct%5D*-%5B%5E%5Cn%5D*%5Cn%3F)%2B)&flags=m&testString=depend%3A%0A%20%20-%20Vault%0A%20%20-%20ProtocolLib%0Aversion%3A%201
const blockList = (key: string): RegExp =>
  new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]*-[^\\n]*\\n?)+)`, 'm');
// A single YAML value: "name: Essentials" or "depend: Vault" → "Essentials" / "Vault" (key given separately).
// https://regex101.com/?flavor=javascript&regex=%5Ename%3A%5B%20%5Ct%5D*%5B'%22%5D%3F(%5B%5E'%22%5Cs%23%5C%5B%5D%5B%5E'%22%5Cn%23%5D*%3F)%5B'%22%5D%3F%5B%20%5Ct%5D*%24&flags=m&testString=name%3A%20Essentials%0Aversion%3A%202
const singleValue = (key: string): RegExp =>
  new RegExp(`^${key}:[ \\t]*['"]?([^'"\\s#\\[][^'"\\n#]*?)['"]?[ \\t]*$`, 'm');
// Quotes and a leading "- " around a YAML list item: "  - 'Vault'" → "Vault".
// https://regex101.com/?flavor=javascript&regex=%5E%5Cs*-%3F%5Cs*%5B'%22%5D%3F%7C%5B'%22%5D%3F%5Cs*%24&flags=g&testString=%20%20-%20'Vault'
const LIST_ITEM_DECORATION = /^\s*-?\s*['"]?|['"]?\s*$/g;
// TOML tables: splits "[[mods]]\nmodId=…\n[[dependencies.x]]\n…" before every "[[" at a line start.
// https://regex101.com/?flavor=javascript&regex=%5E(%3F%3D%5C%5B%5C%5B)&flags=m&testString=%5B%5Bmods%5D%5D%0AmodId%3D%22a%22%0A%5B%5Bdependencies.a%5D%5D%0AmodId%3D%22b%22
const TOML_TABLE = /^(?=\[\[)/m;
// A TOML string field: 'modId="cloth_config"' → "cloth_config" (key given separately).
// https://regex101.com/?flavor=javascript&regex=%5E%5Cs*modId%5Cs*%3D%5Cs*%5B%22'%5D(%5B%5E%22'%5D%2B)%5B%22'%5D&flags=m&testString=%5B%5Bdependencies.x%5D%5D%0A%20%20%20%20modId%3D%22cloth_config%22
const tomlString = (key: string): RegExp => new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm');
// A required TOML dependency: 'mandatory=true' (Forge) or 'type="required"' (NeoForge); "mandatory=false" does not match.
// https://regex101.com/?flavor=javascript&regex=%5E%5Cs*(%3F%3Amandatory%5Cs*%3D%5Cs*true%7Ctype%5Cs*%3D%5Cs*%5B%22'%5Drequired%5B%22'%5D)&flags=im&testString=mandatory%3Dtrue%0Atype%3D%22required%22%0Amandatory%3Dfalse
const TOML_REQUIRED = /^\s*(?:mandatory\s*=\s*true|type\s*=\s*["']required["'])/im;

export interface JarDescription {
  /** Names a dependency can refer to: plugin name, mod id, "provides". Lower case. */
  readonly ids: readonly string[];
  readonly name: string;
  /** Required dependencies (ids as written in the file). */
  readonly needs: readonly string[];
}

export interface MissingDependency {
  /** The plugin or mod that needs it, and its jar ("mods/sodium-extra.jar"). */
  readonly by: string;
  readonly byFile: string;
  /** What is missing, as the plugin or mod calls it ("fabric-api", "Vault"). */
  readonly dependency: string;
  /** It is there, only switched off ("mods/fabric-api.jar.disabled"). */
  readonly disabledFile: string | null;
}

const low = (s: string): string => s.trim().toLowerCase();

function yamlList(text: string, key: string): string[] {
  const inline = text.match(inlineList(key))?.[1];
  if (inline !== undefined)
    return inline
      .split(',')
      .map((s) => s.replace(LIST_ITEM_DECORATION, ''))
      .filter(Boolean);
  const block = text.match(blockList(key))?.[1];
  if (block !== undefined)
    return block
      .split('\n')
      .map((s) => s.replace(LIST_ITEM_DECORATION, ''))
      .filter(Boolean);
  const single = text.match(singleValue(key))?.[1];
  return single ? [single.trim()] : [];
}

function fromYaml(text: string, required: boolean): JarDescription | null {
  const name = text.match(singleValue('name'))?.[1]?.trim();
  if (!name) return null;
  return {
    name,
    ids: [name, ...yamlList(text, 'provides')].map(low),
    // paper-plugin.yml writes its dependencies differently; Paper names missing ones clearly in the log anyway.
    needs: required ? yamlList(text, 'depend') : [],
  };
}

function fromFabric(text: string): JarDescription | null {
  try {
    const json = JSON.parse(text) as {
      id?: unknown;
      name?: unknown;
      provides?: unknown;
      depends?: unknown;
    };
    if (typeof json.id !== 'string') return null;
    const provides = Array.isArray(json.provides) ? json.provides.filter((p) => typeof p === 'string') : [];
    const depends = json.depends && typeof json.depends === 'object' ? Object.keys(json.depends) : [];
    return {
      name: typeof json.name === 'string' ? json.name : json.id,
      ids: [json.id, ...provides].map(low),
      needs: depends,
    };
  } catch {
    return null;
  }
}

function fromVelocity(text: string): JarDescription | null {
  try {
    const json = JSON.parse(text) as { id?: unknown; name?: unknown; dependencies?: unknown };
    if (typeof json.id !== 'string') return null;
    const deps = Array.isArray(json.dependencies)
      ? (json.dependencies as { id?: unknown; optional?: unknown }[])
      : [];
    return {
      name: typeof json.name === 'string' ? json.name : json.id,
      ids: [low(json.id)],
      needs: deps.filter((d) => typeof d.id === 'string' && d.optional !== true).map((d) => String(d.id)),
    };
  } catch {
    return null;
  }
}

/** Forge/NeoForge mods.toml: one jar can hold several mods; each lists its dependencies in its own tables. */
function fromToml(text: string): JarDescription | null {
  const tables = text.split(TOML_TABLE);
  const ids = tables
    .filter((t) => t.startsWith('[[mods]]'))
    .map((t) => t.match(tomlString('modId'))?.[1])
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return null;
  const displayName = tables.find((t) => t.startsWith('[[mods]]'))?.match(tomlString('displayName'))?.[1];
  const needs = tables
    .filter((t) => t.startsWith('[[dependencies.') && TOML_REQUIRED.test(t))
    .map((t) => t.match(tomlString('modId'))?.[1])
    .filter((id): id is string => Boolean(id));
  return { name: displayName ?? ids[0] ?? '', ids: ids.map(low), needs };
}

const PARSERS: Readonly<Record<string, (text: string) => JarDescription | null>> = {
  'plugin.yml': (t) => fromYaml(t, true),
  'paper-plugin.yml': (t) => fromYaml(t, false),
  'bungee.yml': (t) => fromYaml(t, true),
  'velocity-plugin.json': fromVelocity,
  'fabric.mod.json': fromFabric,
  'META-INF/mods.toml': fromToml,
  'META-INF/neoforge.mods.toml': fromToml,
};

const isNestedJar = (name: string): boolean =>
  name.endsWith(JAR) &&
  NESTED_DIRS.some((dir) => name.startsWith(dir) && !name.slice(dir.length).includes('/'));

/** Everything one jar declares, plus the ids of the jars bundled inside it. */
export async function describeJar(
  source: string | Buffer,
  depth = 0,
  wanted: ReadonlySet<string> = DESCRIPTORS,
): Promise<{
  readonly main: JarDescription | null;
  readonly bundled: readonly string[];
  readonly foreign: boolean;
}> {
  const entries = await readZipEntries(
    source,
    (name) => DESCRIPTORS.has(name) || (depth < MAX_NESTING && isNestedJar(name)),
    MAX_NESTED_JAR_BYTES,
  );
  // Only descriptors of another software (a Fabric mod in a Paper server's plugins folder): it can't load there.
  const names = [...entries.keys()].filter((name) => DESCRIPTORS.has(name));
  const foreign = names.length > 0 && !names.some((name) => wanted.has(name));
  const descriptions = [...entries]
    .filter(([name, bytes]) => wanted.has(name) && bytes.length <= MAX_DESCRIPTOR_BYTES)
    .map(([name, bytes]) => PARSERS[name]?.(bytes.toString('utf8')) ?? null)
    .filter((d): d is JarDescription => d !== null);
  const main = descriptions[0]
    ? {
        name: descriptions[0].name,
        ids: [...new Set(descriptions.flatMap((d) => d.ids))],
        needs: [...new Set(descriptions.flatMap((d) => d.needs))],
      }
    : null;
  const nested = await Promise.all(
    [...entries]
      .filter(([name]) => isNestedJar(name))
      .map(async ([, bytes]) => {
        try {
          const inner = await describeJar(bytes, depth + 1, wanted);
          return [...(inner.main?.ids ?? []), ...inner.bundled];
        } catch {
          return [];
        }
      }),
  );
  return { main, bundled: nested.flat(), foreign };
}

function jarsIn(serverDir: string, suffix: string): string[] {
  return FOLDERS.flatMap((folder) => {
    try {
      return fs
        .readdirSync(path.join(serverDir, folder))
        .filter((name) => name.toLowerCase().endsWith(suffix))
        .map((name) => `${folder}/${name}`);
    } catch {
      return [];
    }
  });
}

async function describeAll(
  serverDir: string,
  files: readonly string[],
  software?: string,
): Promise<
  {
    readonly file: string;
    readonly main: JarDescription | null;
    readonly bundled: readonly string[];
    readonly foreign: boolean;
  }[]
> {
  const wanted = descriptorsFor(software);
  return Promise.all(
    files.map(async (file) => {
      try {
        return { file, ...(await describeJar(path.join(serverDir, file), 0, wanted)) };
      } catch {
        return { file, main: null, bundled: [], foreign: false };
      }
    }),
  );
}

/** Jars (switched on) that are made for another software only – e.g. a Fabric mod in a Paper server's plugins. */
export async function foreignJars(serverDir: string, software: string): Promise<string[]> {
  if (!PLATFORM_DESCRIPTORS[software]) return [];
  const active = await describeAll(serverDir, jarsIn(serverDir, JAR), software);
  return active.filter((j) => j.foreign).map((j) => j.file);
}

/** Required plugins/mods that no installed (switched on) jar provides. */
export async function missingDependencies(
  serverDir: string,
  software?: string,
): Promise<MissingDependency[]> {
  const active = await describeAll(serverDir, jarsIn(serverDir, JAR), software);
  const switchedOff = await describeAll(serverDir, jarsIn(serverDir, DISABLED), software);
  const installed = new Set(active.flatMap((j) => [...(j.main?.ids ?? []), ...j.bundled]));
  const disabledFor = (id: string): string | null =>
    switchedOff.find((j) => j.main?.ids.includes(id))?.file ?? null;
  return active.flatMap((jar) =>
    (jar.main?.needs ?? [])
      .map((need) => ALIASES[low(need)] ?? need)
      .filter((need) => !BUILT_IN.has(low(need)) && !installed.has(low(need)))
      .map((need) => ({
        by: jar.main?.name ?? path.basename(jar.file),
        byFile: jar.file,
        dependency: need,
        disabledFile: disabledFor(low(need)),
      })),
  );
}
