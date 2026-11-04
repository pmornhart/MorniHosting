import fs from 'node:fs';
import os from 'node:os';
import type { HostInfo } from '@mornihosting/shared';
import type { DockerDriver } from '../docker/driver.js';
import { BYTES_PER_GB, BYTES_PER_MB, PERCENT } from '../lib/units.js';

/** Host load for the dashboard strip. /proc/stat inside a container still shows the host's CPU. */

interface CpuSample {
  readonly idle: number;
  readonly total: number;
}

const state: { last: CpuSample | null; percent: number | null } = { last: null, percent: null };
const IDLE_FIELD = 3;
const IOWAIT_FIELD = 4;

function readCpu(): CpuSample | null {
  try {
    const first = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0] ?? '';
    const values = first.trim().split(/\s+/).slice(1).map(Number); // eslint-disable-line ts-patterns/require-regex-example -- splits on runs of whitespace: "cpu  1 2" → ["cpu", "1", "2"]
    const idle = (values[IDLE_FIELD] ?? 0) + (values[IOWAIT_FIELD] ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

export function sampleHostCpu(): void {
  const now = readCpu();
  if (!now) return;
  if (state.last) {
    const total = now.total - state.last.total;
    const idle = now.idle - state.last.idle;
    state.percent = total > 0 ? ((total - idle) / total) * PERCENT : state.percent;
  }
  state.last = now;
}

/**
 * Inside a Proxmox container (LXC) the panel's own container sees the whole Proxmox host in /proc (e.g. 251 GB),
 * while Docker – running in the LXC with its virtual /proc – reports what the LXC really has (e.g. 8 GB).
 * The smaller one is the truth; it is remembered for the quota sliders, which need it right away.
 */
const known: { memoryBytes: number } = { memoryBytes: os.totalmem() };
const REFRESH_WAIT_MS = 3000;

/** RAM this machine really has, in MB. */
export function hostMemoryMb(): number {
  return Math.round(known.memoryBytes / BYTES_PER_MB);
}

/** Learns the machine's RAM again (quick: one Docker call, at most a few seconds). */
export async function refreshHostMemory(docker: DockerDriver): Promise<void> {
  try {
    const info = await Promise.race([
      docker.hostInfo(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), REFRESH_WAIT_MS)),
    ]);
    if (info) known.memoryBytes = Math.min(info.memoryBytes, os.totalmem());
  } catch {
    // Docker busy: the last known number stays.
  }
}

/** What the servers use right now: on a limited machine the host-wide /proc numbers would be someone else's. */
export interface ServerUsage {
  readonly cpuPercent: number;
  readonly memoryMb: number;
}

export async function hostInfo(
  docker: DockerDriver,
  dataDir: string,
  usage?: ServerUsage,
): Promise<HostInfo> {
  const info = await (async () => {
    try {
      return await docker.hostInfo();
    } catch {
      return { name: os.hostname(), cpus: os.cpus().length, memoryBytes: os.totalmem() };
    }
  })();
  known.memoryBytes = Math.min(info.memoryBytes, os.totalmem());
  const limited = known.memoryBytes < os.totalmem();
  const panelMb = process.memoryUsage().rss / BYTES_PER_MB;
  const disk = await (async () => {
    try {
      const s = await fs.promises.statfs(dataDir);
      return {
        total: (s.blocks * s.bsize) / BYTES_PER_GB,
        used: ((s.blocks - s.bfree) * s.bsize) / BYTES_PER_GB,
      };
    } catch {
      return null;
    }
  })();
  return {
    name: info.name,
    cpuPercent: limited && usage ? Math.min(usage.cpuPercent / info.cpus, PERCENT) : state.percent,
    cpuCores: info.cpus,
    memoryUsedMb: limited && usage ? usage.memoryMb + panelMb : (os.totalmem() - os.freemem()) / BYTES_PER_MB,
    memoryTotalMb: known.memoryBytes / BYTES_PER_MB,
    diskUsedGb: disk?.used ?? null,
    diskTotalGb: disk?.total ?? null,
  };
}
