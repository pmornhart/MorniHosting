import { SOFTWARE, compareMcVersions, javaTagFor } from '@mornihosting/shared';
import type { servers } from '../db/schema.js';
import { readPropertiesFile, writePropertiesFile } from './properties-file.js';

/**
 * "Arbeitsspeicher im Leerlauf freigeben" (per server, off by default): the server stays online, but without players
 * it needs little memory and CPU time.
 *
 * - Java starts with a small heap instead of 1 GB and grows up to the server's RAM only while players need it.
 * - Aikar's garbage-collector settings stay, but without AlwaysPreTouch: that flag makes the whole start heap real
 *   memory at once, even on an empty server.
 * - G1 returns what it no longer needs: a periodic collection after a quiet minute, and a heap that shrinks when most
 *   of it is free (Min/MaxHeapFreeRatio). Memory freed outside the heap (chunk loading, compression) goes back every
 *   minute too (TrimNativeHeapInterval; a single trim after a player left gave back about 95 MB). Java 8 knows neither
 *   (the flags would stop the JVM from starting), so it only gets the free ratios.
 * - Minecraft (1.21.2+) pauses the world after a minute without players (pause-when-empty-seconds); Paper keeps
 *   plugins, chunk loading and logins running meanwhile. A player joining resumes it at once.
 *
 * Measured with Paper 26.1.2 + Java 25 (MoinMorni, 16.11.): see STAND.md.
 */

type ServerRow = typeof servers.$inferSelect;
type IdleRow = Pick<ServerRow, 'software' | 'version' | 'javaTag' | 'memoryMb'>;

/** Heap Java starts with when the option is on; it grows as soon as the server needs more. */
export const IDLE_INIT_MEMORY_MB = 256;
/** A quiet minute without any garbage collection → G1 looks for memory to give back. */
export const IDLE_GC_INTERVAL_MS = 60_000;
/** Every minute Java hands memory it freed outside the heap back to the system (glibc keeps it otherwise). */
export const IDLE_TRIM_INTERVAL_MS = 60_000;
/** G1 shrinks the heap when more than this share of it is free, and keeps at least the smaller one free. */
export const IDLE_MAX_HEAP_FREE_PERCENT = 30;
export const IDLE_MIN_HEAP_FREE_PERCENT = 10;
/** Seconds without players until Minecraft pauses the world (server.properties). */
export const IDLE_PAUSE_SECONDS = 60;
/** Paper's own default: never pause. Written back when the option is switched off. */
const PAUSE_NEVER = '-1';
export const PAUSE_PROPERTY = 'pause-when-empty-seconds';
/** The first Minecraft version that knows pause-when-empty-seconds. */
const PAUSE_SINCE = '1.21.2';

/** itzg uses Aikar's variant for big servers from 12 GB on (start-finalExec-jvmFlags). */
const BIG_HEAP_MB = 12_288;
// Values as in the image's script (percent, region size): the small variant and the one from 12 GB on.
const AIKAR_SMALL = { newSize: '30', maxNewSize: '40', region: '8M', reserve: '20', ihop: '15' } as const;
const AIKAR_BIG = { newSize: '40', maxNewSize: '50', region: '16M', reserve: '15', ihop: '20' } as const;

/** Aikar's flags exactly as the itzg image sets them (https://mcflags.emc.gs), only without -XX:+AlwaysPreTouch. */
function aikarWithoutPreTouch(memoryMb: number): string[] {
  const v = memoryMb >= BIG_HEAP_MB ? AIKAR_BIG : AIKAR_SMALL;
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    `-XX:G1NewSizePercent=${v.newSize}`,
    `-XX:G1MaxNewSizePercent=${v.maxNewSize}`,
    `-XX:G1HeapRegionSize=${v.region}`,
    `-XX:G1ReservePercent=${v.reserve}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${v.ihop}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ];
}

/**
 * Flags that hand unused memory back to the system. Java 8 knows neither the periodic collection (Java 12+) nor
 * native trimming (17.0.9, 21.0.1, 22+) – an unknown flag would stop the JVM, so it only gets the free ratios.
 */
function giveBack(row: IdleRow): string[] {
  const java8 = (row.javaTag ?? javaTagFor(row.software, row.version)) === 'java8';
  return [
    ...(java8
      ? []
      : [
          `-XX:G1PeriodicGCInterval=${IDLE_GC_INTERVAL_MS}`,
          `-XX:TrimNativeHeapInterval=${IDLE_TRIM_INTERVAL_MS}`,
        ]),
    `-XX:MinHeapFreeRatio=${IDLE_MIN_HEAP_FREE_PERCENT}`,
    `-XX:MaxHeapFreeRatio=${IDLE_MAX_HEAP_FREE_PERCENT}`,
  ];
}

/** Variables for the itzg container instead of the classic memory settings (see spec.ts). */
export function idleMemoryEnv(row: IdleRow): Record<string, string> {
  const init = `${Math.min(IDLE_INIT_MEMORY_MB, row.memoryMb)}M`;
  if (row.software === 'velocity') {
    // itzg/mc-proxy: MEMORY would set start = maximum; Velocity gets G1 explicitly (a small container could
    // otherwise end up with the serial collector, which only shrinks after a full collection).
    return {
      INIT_MEMORY: init,
      MAX_MEMORY: `${row.memoryMb}M`,
      JVM_XX_OPTS: ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', ...giveBack(row)].join(' '),
    };
  }
  return {
    INIT_MEMORY: init,
    USE_AIKAR_FLAGS: 'false',
    JVM_XX_OPTS: [...aikarWithoutPreTouch(row.memoryMb), ...giveBack(row)].join(' '),
  };
}

/** Minecraft servers (not the proxy, not other games) that know pause-when-empty-seconds. */
export function canPauseWhenEmpty(row: Pick<ServerRow, 'software' | 'version'>): boolean {
  const info = SOFTWARE[row.software];
  return info.edition === 'java' && !info.proxy && compareMcVersions(row.version, PAUSE_SINCE) >= 0;
}

/**
 * Before every start with the option on: pause the world after a minute without players – unless someone set their
 * own delay already (it stays).
 */
export function applyIdlePause(dir: string, row: ServerRow): void {
  if (!row.releaseIdleMemory || !canPauseWhenEmpty(row)) return;
  const current = Number(readPropertiesFile(dir).values[PAUSE_PROPERTY] ?? PAUSE_NEVER);
  if (Number.isFinite(current) && current > 0) return;
  writePropertiesFile(dir, { [PAUSE_PROPERTY]: String(IDLE_PAUSE_SECONDS) });
}

/** The option was switched off: our pause goes again (Paper's default, never pause); an own delay stays. */
export function clearIdlePause(dir: string, row: Pick<ServerRow, 'software' | 'version'>): void {
  if (!canPauseWhenEmpty(row)) return;
  if (readPropertiesFile(dir).values[PAUSE_PROPERTY] !== String(IDLE_PAUSE_SECONDS)) return;
  writePropertiesFile(dir, { [PAUSE_PROPERTY]: PAUSE_NEVER });
}
