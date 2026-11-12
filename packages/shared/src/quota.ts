import { z } from 'zod';

/**
 * Quotas: how much each person may have in total across the servers they own. Admins have no limits.
 * null in a field means "no limit".
 */

const MAX_SERVERS = 1000;
const MAX_MEMORY_MB = 1_048_576;
const MAX_DISK_MB = 104_857_600;
const MAX_CPUS = 512;
/** Half a core is the smallest step that still makes sense for a game server. */
export const CPU_STEP = 0.5;
/** RAM one server may get when nobody set anything else (Philip: "normally at most 16 GB"). */
export const DEFAULT_SERVER_MEMORY_MB = 16_384;

export const quotaSchema = z.object({
  servers: z.number().int().min(0).max(MAX_SERVERS).nullable(),
  memoryMb: z.number().int().min(0).max(MAX_MEMORY_MB).nullable(),
  diskMb: z.number().int().min(0).max(MAX_DISK_MB).nullable(),
  cpus: z.number().min(0).max(MAX_CPUS).multipleOf(CPU_STEP).nullable(),
  /**
   * RAM a single server may have at most (MB); null = no limit. Missing (older clients and stored values
   * from before this field) = the default of 16 GB. Only admins can go above it.
   */
  serverMemoryMb: z.number().int().min(0).max(MAX_MEMORY_MB).nullable().default(DEFAULT_SERVER_MEMORY_MB),
});
export type Quota = z.infer<typeof quotaSchema>;

/** What admins have: nothing is limited. */
export const NO_QUOTA: Quota = {
  servers: null,
  memoryMb: null,
  diskMb: null,
  cpus: null,
  serverMemoryMb: null,
};
/** The defaults before an admin saved any: no totals, but at most 16 GB per server. */
export const DEFAULT_QUOTA: Quota = { ...NO_QUOTA, serverMemoryMb: DEFAULT_SERVER_MEMORY_MB };

/** Limits stored before `serverMemoryMb` existed lack it: then `fallback` applies (the default). */
export function withServerMemory(
  stored: Omit<Quota, 'serverMemoryMb'> & Partial<Quota>,
  fallback: number | null,
): Quota {
  return {
    ...stored,
    serverMemoryMb: stored.serverMemoryMb === undefined ? fallback : stored.serverMemoryMb,
  };
}

/** A person's own limits; null goes back to the defaults. */
export const userQuotaSchema = z.object({ quota: quotaSchema.nullable() });

export interface QuotaUsage {
  readonly servers: number;
  readonly memoryMb: number;
  /** Sum of the servers' disk limits (what is promised), and what the folders take right now. */
  readonly diskMb: number;
  readonly diskUsedMb: number;
  readonly cpus: number;
}

export interface QuotaUserView {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  /** Own limits, or null when the defaults apply. */
  readonly own: Quota | null;
  /** What applies right now (own limits or the defaults). */
  readonly effective: Quota;
  readonly usage: QuotaUsage;
}

/** What the signed-in person may order: the order pages and server settings offer no more than this. */
export interface MyQuota {
  /** RAM per server in MB; null = no limit (admins, or set so by an admin). */
  readonly serverMemoryMb: number | null;
}

export interface QuotaView {
  readonly defaults: Quota;
  readonly host: { readonly memoryMb: number; readonly cpus: number; readonly diskMb: number | null };
  readonly users: readonly QuotaUserView[];
}
