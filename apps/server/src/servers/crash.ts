import type { CrashInfo } from '@mornihosting/shared';
import { stripColours } from './log-parse.js';

/**
 * The crash helper: recognises typical failures in the last console lines and names
 * a rule the web app explains in plain words (crash.<ruleId>.title / .fix).
 */

export interface CrashContext {
  readonly lines: readonly string[];
  readonly oomKilled: boolean;
  readonly exitCode: number | null;
  readonly memoryMb: number;
  readonly javaTag: string | null;
  /** Java package → plugin or mod name (from plugin.yml / fabric.mod.json), to name the culprit of a stack trace. */
  readonly packages?: Readonly<Record<string, { readonly name: string; readonly file: string }>>;
}

interface CrashRule {
  readonly id: string;
  readonly detect: (ctx: CrashContext, text: string) => Readonly<Record<string, string>> | null;
}

const EXCERPT_LINES = 12;
/** Lines around an important one that belong to it (the stack trace below an error). */
const CONTEXT_AFTER = 3;
/** Killed with SIGKILL (128 + 9): without Docker's own OOM flag, the machine itself ran out of memory. */
const EXIT_KILLED = 137;
/** Error messages are cut here, so the explanation stays readable. */
const ERROR_MAX_CHARS = 160;
/** Java class file version 52 is Java 8; each newer Java adds one. */
const CLASS_VERSION_JAVA8 = 52;
const JAVA8 = 8;

// Class version error: captures the needed class file version. "...compiled by a more recent version of the Java Runtime (class file version 65.0)..." → "65".
// https://regex101.com/?flavor=javascript&regex=class%20file%20version%20(%5Cd%2B)&flags=gm&testString=(class%20file%20version%2065.0)%2C%20this%20version%20only%20recognizes%20class%20file%20versions%20up%20to%2061.0%0Aclass%20file
const CLASS_VERSION = /class file version (\d+)/;
// Paper's Java check: captures the Java version it asks for. "You need Java 21 or newer" or "requires running the server with Java 21" → "21".
// https://regex101.com/?flavor=javascript&regex=(%3F%3Arequires%20running%20the%20server%20with%7Cneed%7Cuse)%20Java%20(%5Cd%2B)&flags=gim&testString=This%20version%20requires%20running%20the%20server%20with%20Java%2021%20or%20above%0AYou%20need%20Java%2021%20or%20newer%0AJava%20is%20fine
const NEEDS_JAVA = /(?:requires running the server with|need|use) Java (\d+)/i;
// Bukkit missing dependency: captures plugin file and missing names. "Could not load 'plugins/Shop.jar' in folder 'plugins'" + "Unknown/missing dependency plugins: [Vault]".
// https://regex101.com/?flavor=javascript&regex=Unknown%5C%2Fmissing%20dependency%20plugins%3A%20%5C%5B(%5B%5E%5C%5D%5D%2B)%5C%5D&flags=gm&testString=org.bukkit.plugin.UnknownDependencyException%3A%20Unknown%2Fmissing%20dependency%20plugins%3A%20%5BVault%5D.%20Please%20download%20and%20install%20these%20plugins%0Adependency
const BUKKIT_MISSING = /Unknown\/missing dependency plugins: \[([^\]]+)\]/;
// The plugin that failed to load: "Could not load 'plugins/Shop.jar' in folder 'plugins'" → "Shop.jar".
// https://regex101.com/?flavor=javascript&regex=Could%20not%20load%20'plugins%5C%2F(%5B%5E'%5D%2B)'&flags=gm&testString=Could%20not%20load%20'plugins%2FShop.jar'%20in%20folder%20'plugins'%0ACould%20not%20load
const BUKKIT_COULD_NOT_LOAD = /Could not load 'plugins\/([^']+)'/;
// Fabric/Quilt missing mod: captures mod and dependency. "Mod 'Sodium Extra' (sodium-extra) 0.5.4 requires any version of sodium, which is missing!" → ("Sodium Extra", "sodium").
// https://regex101.com/?flavor=javascript&regex=Mod%20'(%5B%5E'%5D%2B)'.*%3Frequires%20(%3F%3Aany%20version%20of%20%7Cversion%20%5CS%2B%20of%20)%3F(%5CS%2B)%2C%20which%20is%20missing&flags=gm&testString=Mod%20'Sodium%20Extra'%20(sodium-extra)%200.5.4%20requires%20any%20version%20of%20sodium%2C%20which%20is%20missing!%0AMod%20loaded
const FABRIC_MISSING = /Mod '([^']+)'.*?requires (?:any version of |version \S+ of )?(\S+), which is missing/;
// Forge/NeoForge missing mod: "Missing or unsupported mandatory dependencies:" matches; "dependencies resolved" does not.
// https://regex101.com/?flavor=javascript&regex=Missing%20or%20unsupported%20mandatory%20dependencies&flags=gm&testString=Missing%20or%20unsupported%20mandatory%20dependencies%3A%0Adependencies%20resolved
const FORGE_MISSING = /Missing or unsupported mandatory dependencies/;
// A plugin that threw while starting: "Error occurred while enabling Essentials v2.21.0 (Is it up to date?)" → "Essentials".
// https://regex101.com/?flavor=javascript&regex=Error%20occurred%20while%20enabling%20(%5CS%2B)&flags=gm&testString=Error%20occurred%20while%20enabling%20Essentials%20v2.21.0%20(Is%20it%20up%20to%20date%3F)%0AEnabling%20Essentials
const PLUGIN_ENABLE_ERROR = /Error occurred while enabling (\S+)/;
// Port taken: matches "**** FAILED TO BIND TO PORT!" and "java.net.BindException: Address already in use"; rejects "Starting Minecraft server on *:25565".
// https://regex101.com/?flavor=javascript&regex=FAILED%20TO%20BIND%20TO%20PORT%7CAddress%20already%20in%20use&flags=gm&testString=****%20FAILED%20TO%20BIND%20TO%20PORT!%0Ajava.net.BindException%3A%20Address%20already%20in%20use%0AStarting%20Minecraft%20server%20on%20*%3A25565
const PORT_IN_USE = /FAILED TO BIND TO PORT|Address already in use/;
// Out of memory inside Java: "java.lang.OutOfMemoryError: Java heap space" matches; "Memory: 2 GB" does not.
// https://regex101.com/?flavor=javascript&regex=OutOfMemoryError&flags=gm&testString=java.lang.OutOfMemoryError%3A%20Java%20heap%20space%0AMemory%3A%202%20GB
const OUT_OF_MEMORY = /OutOfMemoryError/;
// EULA not accepted: "You need to agree to the EULA in order to run the server" matches.
// https://regex101.com/?flavor=javascript&regex=agree%20to%20the%20EULA&flags=gim&testString=You%20need%20to%20agree%20to%20the%20EULA%20in%20order%20to%20run%20the%20server.%0AEULA%20accepted
const EULA = /agree to the EULA/i;
// Broken world files: "Failed to load level" or "Exception reading /data/world/level.dat" match; "Preparing level" does not.
// https://regex101.com/?flavor=javascript&regex=Failed%20to%20load%20level%7CException%20reading%20.*level%5C.dat%7CCorrupted%20chunk&flags=gm&testString=Failed%20to%20load%20level%0AException%20reading%20%2Fdata%2Fworld%2Flevel.dat%0APreparing%20level
const WORLD_BROKEN = /Failed to load level|Exception reading .*level\.dat|Corrupted chunk/;
// Mods for another game version: "requires minecraft 1.20.1" or "Incompatible mod set!" match.
// https://regex101.com/?flavor=javascript&regex=Incompatible%20mods%3F%20(%3Fset%7Cfound)%7Crequires%20(%3F%3Aversion%20%5CS%2B%20of%20)%3Fminecraft&flags=gim&testString=Incompatible%20mod%20set!%0AMod%20x%20requires%20version%201.20.1%20of%20minecraft%0Aminecraft%20started
const MOD_VERSION_MISMATCH = /Incompatible mods? (?:set|found)|requires (?:version \S+ of )?minecraft/i;
// Version download failed: "Could not find a version matching" or "No release found for version" match.
// https://regex101.com/?flavor=javascript&regex=Could%20not%20find%20a%20version%7CNo%20(%3F%3Arelease%7Cbuild)s%3F%20found%20for%7Cinvalid%20version&flags=gim&testString=Could%20not%20find%20a%20version%20matching%201.99%0ANo%20builds%20found%20for%20version%201.99%0AVersion%20ok
const VERSION_NOT_FOUND = /Could not find a version|No (?:release|build)s? found for|invalid version/i;

// Game files could not be downloaded: "[init] [ERROR] Failed to download paper", "UnknownHostException: fill.papermc.io" match; "Downloaded paper" does not.
// https://regex101.com/?flavor=javascript&regex=Failed%20to%20download%7CUnknownHostException%7Ccertification%20path%7CConnection%20timed%20out&flags=gm&testString=%5Binit%5D%20%5BERROR%5D%20Failed%20to%20download%20paper%0Ajava.net.UnknownHostException%3A%20fill.papermc.io%0ADownloaded%20paper
const DOWNLOAD_FAILED = /Failed to download|UnknownHostException|certification path|Connection timed out/;

// No room left on the disk: "java.io.IOException: No space left on device" matches; "space" alone does not.
// https://regex101.com/?flavor=javascript&regex=No%20space%20left%20on%20device%7CDisk%20quota%20exceeded&flags=gm&testString=java.io.IOException%3A%20No%20space%20left%20on%20device%0Aspace
const DISK_FULL = /No space left on device|Disk quota exceeded/;
// Paper/Spigot watchdog: "The server has stopped responding! This is (probably) not a Paper bug." matches.
// https://regex101.com/?flavor=javascript&regex=The%20server%20has%20stopped%20responding%7CWatchdog%20Thread%7CA%20single%20server%20tick%20took&flags=gm&testString=The%20server%20has%20stopped%20responding!%0AA%20single%20server%20tick%20took%2060.00%20seconds%0Aserver%20responding
const WATCHDOG = /The server has stopped responding|Watchdog Thread|A single server tick took/;
// The world is open elsewhere: "Failed to acquire directory lock" or "session.lock: already locked" match.
// https://regex101.com/?flavor=javascript&regex=directory%20lock%7Csession%5C.lock&flags=gim&testString=Failed%20to%20acquire%20directory%20lock%0A%2Fdata%2Fworld%2Fsession.lock%3A%20already%20locked%0Aworld%20saved
const WORLD_LOCKED = /directory lock|session\.lock/i;
// No right to read/write files: "java.nio.file.AccessDeniedException: /data/world" or "Permission denied" match.
// https://regex101.com/?flavor=javascript&regex=AccessDeniedException%7CPermission%20denied&flags=gm&testString=java.nio.file.AccessDeniedException%3A%20%2Fdata%2Fworld%0Abash%3A%20.%2Frun.sh%3A%20Permission%20denied%0Apermission%20ok
const PERMISSION_DENIED = /AccessDeniedException|Permission denied/;
// A broken config file (YAML/JSON/TOML): "InvalidConfigurationException", "while scanning a simple key", "JsonSyntaxException" match.
// https://regex101.com/?flavor=javascript&regex=InvalidConfigurationException%7CScannerException%7CParserException%7Cwhile%20(%3F%3Ascanning%7Cparsing)%20a%7CJsonSyntaxException%7CMalformedJsonException%7CParsingException&flags=gm&testString=org.bukkit.configuration.InvalidConfigurationException%0Awhile%20scanning%20a%20simple%20key%0Acom.google.gson.JsonSyntaxException%0Aconfig%20loaded
const CONFIG_BROKEN =
  /InvalidConfigurationException|ScannerException|ParserException|while (?:scanning|parsing) a|JsonSyntaxException|MalformedJsonException|ParsingException/;
// Code built for another server version: "java.lang.NoSuchMethodError: …", "NoClassDefFoundError", "Unsupported API version 1.22" match.
// https://regex101.com/?flavor=javascript&regex=NoSuchMethodError%7CNoSuchFieldError%7CNoClassDefFoundError%7CClassNotFoundException%7CIncompatibleClassChangeError%7CAbstractMethodError%7CUnsupported%20API%20version&flags=gm&testString=java.lang.NoSuchMethodError%3A%20'void%20org.bukkit.X.y()'%0Ajava.lang.NoClassDefFoundError%3A%20net%2Fminecraft%2FX%0AUnsupported%20API%20version%201.22%0Amethod%20ok
const INCOMPATIBLE_CODE =
  /NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|ClassNotFoundException|IncompatibleClassChangeError|AbstractMethodError|Unsupported API version/;
// A Java error line: "Caused by: java.lang.NullPointerException: Cannot invoke …" → "java.lang.NullPointerException: Cannot invoke …".
// https://regex101.com/?flavor=javascript&regex=((%3F%3A%5Ba-z%5D%5B%5Cw%24%5D*%5C.)%2B%5BA-Z%5D%5B%5Cw%24%5D*(%3F%3AException%7CError)%5Cb(%3F%3A%3A.*)%3F)&flags=gm&testString=Caused%20by%3A%20java.lang.NullPointerException%3A%20Cannot%20invoke%20x%0A%5B10%3A00%3A00%20INFO%5D%3A%20Done%20(3.2s)!
const JAVA_ERROR = /((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\b(?::.*)?)/;
// A stack frame: "	at com.earth2me.essentials.Essentials.onEnable(Essentials.java:42)" → "com.earth2me.essentials.Essentials".
// https://regex101.com/?flavor=javascript&regex=%5Cbat%20(%5B%5Cw%24.%5D%2B)%5C.%5B%5Cw%24%3C%3E%5D%2B%5C(&flags=gm&testString=%09at%20com.earth2me.essentials.Essentials.onEnable(Essentials.java%3A42)%0Aat%20the%20spawn
const STACK_FRAME = /\bat ([\w$.]+)\.[\w$<>]+\(/;
// Lines worth showing: errors, warnings with exceptions, stack starts. "[10:00:00 ERROR]: x", "Caused by: y", "FATAL" match.
// https://regex101.com/?flavor=javascript&regex=%5CbERROR%5Cb%7C%5CbFATAL%5Cb%7CSEVERE%7CCaused%20by%3A%7CException%7CError%3A%7Cstopped%20responding&flags=gm&testString=%5B10%3A00%3A00%20ERROR%5D%3A%20x%0ACaused%20by%3A%20y%0A%5B10%3A00%3A00%20INFO%5D%3A%20Done
const IMPORTANT_LINE = /\bERROR\b|\bFATAL\b|SEVERE|Caused by:|Exception|Error:|stopped responding/;
/** Frames from the game and Java itself never point at a plugin. */
const SYSTEM_PACKAGES = [
  'java.',
  'javax.',
  'jdk.',
  'sun.',
  'net.minecraft.',
  'com.mojang.',
  'org.bukkit.',
  'org.spigotmc.',
  'io.papermc.',
  'com.destroystokyo.',
  'net.fabricmc.',
  'net.minecraftforge.',
  'net.neoforged.',
  'cpw.mods.',
];

/** The plugin or mod whose code appears first in the stack traces (that is the one that threw). */
function culpritOf(
  lines: readonly string[],
  packages: CrashContext['packages'],
): { readonly plugin: string; readonly file: string } | null {
  if (!packages) return null;
  const prefixes = Object.keys(packages).sort((a, b) => b.length - a.length);
  const owner = lines
    .map((line) => line.match(STACK_FRAME)?.[1])
    .filter((cls): cls is string => Boolean(cls) && !SYSTEM_PACKAGES.some((p) => cls?.startsWith(p)))
    .map((cls) => prefixes.find((prefix) => cls === prefix || cls.startsWith(`${prefix}.`)))
    .find((prefix): prefix is string => prefix !== undefined);
  const found = owner ? packages[owner] : undefined;
  return found ? { plugin: found.name, file: found.file } : null;
}

/** The root cause: the last "Caused by" error, otherwise the last Java error line. */
function mainError(lines: readonly string[]): string | null {
  const errors = lines.map((line) => line.match(JAVA_ERROR)?.[1]).filter((e): e is string => Boolean(e));
  const rootCause = [...lines]
    .reverse()
    .find((line) => line.includes('Caused by:'))
    ?.match(JAVA_ERROR)?.[1];
  const error = rootCause ?? errors.at(-1) ?? null;
  return error ? error.slice(0, ERROR_MAX_CHARS) : null;
}

/** The lines that explain the crash (errors and the stack lines right below), else the last lines. */
function importantLines(lines: readonly string[]): string[] {
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!IMPORTANT_LINE.test(line)) return;
    [...Array(CONTEXT_AFTER + 1).keys()].forEach((offset) => {
      if (i + offset < lines.length) keep.add(i + offset);
    });
  });
  const picked = [...keep].sort((a, b) => a - b).map((i) => lines[i] ?? '');
  return (picked.length ? picked : lines).slice(-EXCERPT_LINES);
}

function javaFromClassVersion(classVersion: number): string {
  return String(classVersion - CLASS_VERSION_JAVA8 + JAVA8);
}

const RULES: readonly CrashRule[] = [
  {
    id: 'out-of-memory',
    detect: (ctx, text) =>
      ctx.oomKilled || OUT_OF_MEMORY.test(text) ? { memoryMb: String(ctx.memoryMb) } : null,
  },
  { id: 'disk-full', detect: (_ctx, text) => (DISK_FULL.test(text) ? {} : null) },
  {
    id: 'host-out-of-memory',
    detect: (ctx) => (ctx.exitCode === EXIT_KILLED ? { memoryMb: String(ctx.memoryMb) } : null),
  },
  {
    id: 'wrong-java',
    detect: (_ctx, text) => {
      const classVersion = text.match(CLASS_VERSION);
      if (classVersion?.[1]) return { java: javaFromClassVersion(Number(classVersion[1])) };
      const needs = text.match(NEEDS_JAVA);
      return needs?.[1] ? { java: needs[1] } : null;
    },
  },
  {
    id: 'missing-dependency',
    detect: (_ctx, text) => {
      const bukkit = text.match(BUKKIT_MISSING);
      if (bukkit?.[1]) return { dependency: bukkit[1], plugin: text.match(BUKKIT_COULD_NOT_LOAD)?.[1] ?? '' };
      const fabric = text.match(FABRIC_MISSING);
      if (fabric?.[1] && fabric[2]) return { plugin: fabric[1], dependency: fabric[2] };
      return FORGE_MISSING.test(text) ? { plugin: '', dependency: '' } : null;
    },
  },
  {
    id: 'plugin-incompatible',
    detect: (ctx, text) => {
      if (!INCOMPATIBLE_CODE.test(text)) return null;
      return culpritOf(ctx.lines, ctx.packages);
    },
  },
  { id: 'port-in-use', detect: (_ctx, text) => (PORT_IN_USE.test(text) ? {} : null) },
  { id: 'world-locked', detect: (_ctx, text) => (WORLD_LOCKED.test(text) ? {} : null) },
  { id: 'eula', detect: (_ctx, text) => (EULA.test(text) ? {} : null) },
  { id: 'version-not-found', detect: (_ctx, text) => (VERSION_NOT_FOUND.test(text) ? {} : null) },
  { id: 'download-failed', detect: (_ctx, text) => (DOWNLOAD_FAILED.test(text) ? {} : null) },
  { id: 'mod-version-mismatch', detect: (_ctx, text) => (MOD_VERSION_MISMATCH.test(text) ? {} : null) },
  { id: 'world-broken', detect: (_ctx, text) => (WORLD_BROKEN.test(text) ? {} : null) },
  {
    id: 'plugin-error',
    detect: (_ctx, text) => {
      const m = text.match(PLUGIN_ENABLE_ERROR);
      return m?.[1] ? { plugin: m[1] } : null;
    },
  },
  {
    id: 'config-broken-plugin',
    detect: (ctx, text) => (CONFIG_BROKEN.test(text) ? culpritOf(ctx.lines, ctx.packages) : null),
  },
  { id: 'config-broken', detect: (_ctx, text) => (CONFIG_BROKEN.test(text) ? {} : null) },
  {
    id: 'watchdog-plugin',
    detect: (ctx, text) => (WATCHDOG.test(text) ? culpritOf(ctx.lines, ctx.packages) : null),
  },
  { id: 'watchdog', detect: (_ctx, text) => (WATCHDOG.test(text) ? {} : null) },
  { id: 'permission-denied', detect: (_ctx, text) => (PERMISSION_DENIED.test(text) ? {} : null) },
  {
    // No known pattern, but a plugin's code threw: that plugin is the best lead.
    id: 'plugin-error',
    detect: (ctx) => culpritOf(ctx.lines, ctx.packages),
  },
];

/**
 * Picks the first rule that explains the crash, or "unknown". Always names the root error ("error") and keeps
 * the lines that matter (errors and their stack) instead of just the last ones.
 */
export function analyseCrash(ctx: CrashContext): CrashInfo {
  const lines = ctx.lines.map(stripColours);
  const text = lines.join('\n');
  const hit = RULES.map((rule) => [rule.id, rule.detect(ctx, text)] as const).find(
    ([, params]) => params !== null,
  );
  const error = mainError(lines);
  return {
    at: new Date().toISOString(),
    ruleId: hit?.[0] ?? (error ? 'unknown-error' : 'unknown'),
    params: {
      exitCode: String(ctx.exitCode ?? ''),
      ...(error ? { error } : {}),
      ...hit?.[1],
    },
    excerpt: importantLines(lines),
  };
}
