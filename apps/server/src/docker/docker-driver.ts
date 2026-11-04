import os from 'node:os';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import Docker from 'dockerode';
import type { Config } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { PERCENT } from '../lib/units.js';
import { createLineSplitter } from './lines.js';
import { rconCommand } from './rcon.js';
import {
  DockerUnavailableError,
  type ContainerEvent,
  type ContainerState,
  type DockerDriver,
} from './driver.js';

/** Docker counts CPU limits in billionths of a core. */
const NANO_CPUS_PER_CORE = 1_000_000_000;
const LOG_MAX_SIZE = '10m';
const LOG_MAX_FILES = '3';
const HTTP_NOT_FOUND = 404;
const HTTP_NOT_MODIFIED = 304;
const CONTAINER_DATA_DIR = '/data';
const EVENT_ACTIONS: readonly ContainerEvent['action'][] = ['start', 'die', 'oom', 'destroy'];
const MANAGED_LABEL = 'mornihosting.server';
/** How often an image that is already there gets checked for a newer version (in the background). */
const IMAGE_REFRESH_MS = 24 * 60 * 60 * 1000;

interface DockerApiError {
  readonly statusCode?: number;
}

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null ? (err as DockerApiError).statusCode : undefined;
}

function connectionOptions(dockerHost: string): Docker.DockerOptions {
  const url = new URL(dockerHost);
  if (url.protocol === 'unix:') return { socketPath: url.pathname };
  return {
    host: url.hostname,
    port: Number(url.port),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  };
}

function toState(info: Docker.ContainerInspectInfo, network: string): ContainerState {
  const s = info.State;
  return {
    running: s.Running,
    status: s.Status,
    exitCode: s.Running ? null : s.ExitCode,
    oomKilled: s.OOMKilled,
    startedAt: s.StartedAt && !s.StartedAt.startsWith('0001') ? s.StartedAt : null,
    finishedAt: s.FinishedAt && !s.FinishedAt.startsWith('0001') ? s.FinishedAt : null,
    ip: info.NetworkSettings.Networks[network]?.IPAddress || null,
  };
}

function cpuPercent(stats: Docker.ContainerStats): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage ?? 0);
  const systemDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
  const cpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  // Without an earlier sample (first read, a container that just started) there is nothing to compare with.
  if (!stats.precpu_stats.system_cpu_usage || !stats.precpu_stats.cpu_usage?.total_usage) return 0;
  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  // Some hosts (LXC, cgroup v2) report odd counters now and then; more than all cores at full load is impossible.
  return Math.min((cpuDelta / systemDelta) * cpus * PERCENT, cpus * PERCENT);
}

export function createDockerDriver(config: Config): DockerDriver {
  const docker = new Docker(connectionOptions(config.dockerHost));
  const cleanups = new Set<() => void>();
  const cache: { hostDataDir: string | null } = { hostDataDir: null };

  const resolveHostDataDir = async (): Promise<string> => {
    if (config.hostDataDir) return config.hostDataDir;
    if (cache.hostDataDir) return cache.hostDataDir;
    try {
      const self = await docker.getContainer(os.hostname()).inspect();
      const mount = self.Mounts.find((m) => path.resolve(m.Destination) === config.dataDir);
      if (!mount) throw new DockerUnavailableError(`no mount for ${config.dataDir} on the panel container`);
      cache.hostDataDir = mount.Source;
      return mount.Source;
    } catch (err) {
      if (statusOf(err) !== HTTP_NOT_FOUND) throw err;
      // Not running in a container (development): the data folder is already a host path.
      cache.hostDataDir = config.dataDir;
      return config.dataDir;
    }
  };

  const pulledAt = new Map<string, number>();
  const refreshing = new Set<string>();
  const pullImage = async (
    image: string,
    onProgress: Parameters<DockerDriver['ensureImage']>[1],
  ): Promise<void> => {
    // dockerode resolves pull() to the Node stream of progress events.
    const stream = (await docker.pull(image)) as unknown as Readable;
    const layers = new Map<string, { current: number; total: number }>();
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { id?: string; status?: string; progressDetail?: { current?: number; total?: number } }) => {
          if (event.id && event.progressDetail?.total) {
            layers.set(event.id, {
              current: event.progressDetail.current ?? 0,
              total: event.progressDetail.total,
            });
          }
          const totals = [...layers.values()].reduce(
            (acc, l) => ({ current: acc.current + l.current, total: acc.total + l.total }),
            { current: 0, total: 0 },
          );
          onProgress?.(
            totals.total ? Math.round((totals.current / totals.total) * PERCENT) : null,
            event.status ?? '',
          );
        },
      );
    });
  };

  const driver: DockerDriver = {
    kind: 'docker',
    ping: async () => {
      try {
        await docker.ping();
      } catch (err) {
        throw new DockerUnavailableError(errorMessage(err), { cause: err });
      }
    },
    ensureImage: async (image, onProgress) => {
      const present = await (async (): Promise<boolean> => {
        try {
          await docker.getImage(image).inspect();
          return true;
        } catch (err) {
          if (statusOf(err) !== HTTP_NOT_FOUND) throw err;
          return false;
        }
      })();
      // An image that is there gets refreshed once a day: old ones talk to services that changed meanwhile
      // (e.g. PaperMC's API v2 is gone, old itzg images then hang at "Resolving type given PAPER").
      // That happens in the background, so a start never waits for it; the panel also refreshes all images it
      // uses right after it starts and then twice a day, so the next start already has the new one.
      if (present) {
        if (Date.now() - (pulledAt.get(image) ?? 0) < IMAGE_REFRESH_MS || refreshing.has(image)) return;
        refreshing.add(image);
        void (async () => {
          try {
            await pullImage(image, undefined);
          } catch {
            // Offline or a locally built image: the one we have still works.
          } finally {
            pulledAt.set(image, Date.now());
            refreshing.delete(image);
          }
        })();
        return;
      }
      await pullImage(image, onProgress);
      pulledAt.set(image, Date.now());
    },
    ensureNetwork: async (name) => {
      try {
        await docker.getNetwork(name).inspect();
      } catch (err) {
        if (statusOf(err) !== HTTP_NOT_FOUND) throw err;
        await docker.createNetwork({
          Name: name,
          Driver: 'bridge',
          Labels: { 'mornihosting.network': 'true' },
        });
      }
    },
    createContainer: async (spec) => {
      const hostData = await resolveHostDataDir();
      const relative = path.relative(config.dataDir, spec.dataDir);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('server folder outside the data folder');
      const mounts = spec.mounts ?? [{ subdir: '', path: CONTAINER_DATA_DIR }];
      if (mounts.some((m) => path.isAbsolute(m.subdir) || m.subdir.split('/').includes('..')))
        throw new Error('mount outside the server folder');
      const exposed = Object.fromEntries(spec.ports.map((p) => [`${p.containerPort}/${p.protocol}`, {}]));
      const bindings = Object.fromEntries(
        spec.ports.map((p) => [`${p.containerPort}/${p.protocol}`, [{ HostPort: String(p.hostPort) }]]),
      );
      const container = await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        ...(spec.command ? { Cmd: [...spec.command] } : {}),
        Labels: { ...spec.labels, [MANAGED_LABEL]: 'true' },
        ExposedPorts: exposed,
        OpenStdin: true,
        StdinOnce: false,
        Tty: false,
        HostConfig: {
          Binds: mounts.map(
            (m) => `${path.posix.join(hostData, ...relative.split(path.sep), m.subdir)}:${m.path}`,
          ),
          PortBindings: bindings,
          Memory: spec.memoryLimitBytes,
          ...(spec.cpus ? { NanoCpus: Math.round(spec.cpus * NANO_CPUS_PER_CORE) } : {}),
          NetworkMode: config.mcNetwork,
          RestartPolicy: { Name: spec.restart ?? 'no' },
          SecurityOpt: ['no-new-privileges:true'],
          LogConfig: { Type: 'json-file', Config: { 'max-size': LOG_MAX_SIZE, 'max-file': LOG_MAX_FILES } },
          Init: true,
        },
        NetworkingConfig: { EndpointsConfig: { [config.mcNetwork]: { Aliases: [spec.name] } } },
      });
      return container.id;
    },
    removeContainer: async (id) => {
      try {
        await docker.getContainer(id).remove({ force: true, v: true });
      } catch (err) {
        if (statusOf(err) !== HTTP_NOT_FOUND) throw err;
      }
    },
    start: async (id) => {
      try {
        await docker.getContainer(id).start();
      } catch (err) {
        if (statusOf(err) !== HTTP_NOT_MODIFIED) throw err;
      }
    },
    stop: async (id, timeoutSeconds) => {
      try {
        await docker.getContainer(id).stop({ t: timeoutSeconds });
      } catch (err) {
        if (statusOf(err) !== HTTP_NOT_MODIFIED) throw err;
      }
    },
    kill: async (id) => {
      await docker.getContainer(id).kill();
    },
    inspect: async (id) => {
      try {
        return toState(await docker.getContainer(id).inspect(), config.mcNetwork);
      } catch (err) {
        if (statusOf(err) === HTTP_NOT_FOUND) return null;
        throw err;
      }
    },
    followLogs: async (id, tail, onLine) => {
      const stream = (await docker.getContainer(id).logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: tail === 'all' ? undefined : tail,
      })) as unknown as Readable; // dockerode types `follow: true` as a stream at runtime
      const out = new PassThrough();
      const splitter = createLineSplitter(onLine);
      out.on('data', (chunk: Buffer) => splitter.push(chunk.toString('utf8')));
      docker.modem.demuxStream(stream, out, out);
      const stop = (): void => {
        stream.destroy();
        out.destroy();
        splitter.flush();
        cleanups.delete(stop);
      };
      stream.on('end', stop);
      stream.on('error', stop);
      cleanups.add(stop);
      return stop;
    },
    stats: async (id) => {
      try {
        const s = await docker.getContainer(id).stats({ stream: false });
        const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
        const limit = s.memory_stats.limit ?? 0;
        const used = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
        return {
          cpuPercent: cpuPercent(s),
          // Never more than the container may use (odd counters on some hosts would draw spikes in the chart).
          memoryBytes: limit ? Math.min(used, limit) : used,
          memoryLimitBytes: limit,
          rxBytes: Object.values(s.networks ?? {}).reduce((sum, n) => sum + n.rx_bytes, 0),
          txBytes: Object.values(s.networks ?? {}).reduce((sum, n) => sum + n.tx_bytes, 0),
        };
      } catch (err) {
        if (statusOf(err) === HTTP_NOT_FOUND) return null;
        throw err;
      }
    },
    sendCommand: async (id, command, channel) => {
      if (channel.kind === 'none') throw new Error('this game has no console');
      if (channel.kind === 'rcon') return rconCommand(channel.host, channel.port, channel.password, command);
      const container = docker.getContainer(id);
      if (channel.kind === 'exec') {
        const exec = await container.exec({
          Cmd: [...channel.argv, command],
          AttachStdout: false,
          AttachStderr: false,
        });
        await exec.start({ Detach: true });
        return '';
      }
      const stream = await container.attach({ stream: true, stdin: true, hijack: true });
      stream.write(`${command}\n`);
      stream.end();
      return '';
    },
    onContainerEvent: (listener) => {
      const state: { stream: Readable | null; closed: boolean } = { stream: null, closed: false };
      const subscribe = async (): Promise<void> => {
        const stream = (await docker.getEvents({
          filters: { type: ['container'], label: [MANAGED_LABEL], event: [...EVENT_ACTIONS] },
        })) as unknown as Readable; // getEvents without a callback resolves to the raw event stream
        state.stream = stream;
        const splitter = createLineSplitter((line) => {
          // Docker API 1.44+ dropped the top-level "id"; the container id lives in Actor.ID.
          const event = JSON.parse(line) as { id?: string; Action?: string; Actor?: { ID?: string } };
          const action = EVENT_ACTIONS.find((a) => a === event.Action);
          const containerId = event.Actor?.ID ?? event.id;
          if (containerId && action) listener({ containerId, action });
        });
        stream.on('data', (chunk: Buffer) => splitter.push(chunk.toString('utf8')));
        stream.on('error', () => undefined);
      };
      void (async () => {
        try {
          await subscribe();
        } catch (err) {
          if (!state.closed) process.emitWarning(`Docker-Ereignisse nicht verfügbar: ${errorMessage(err)}`);
        }
      })();
      return () => {
        state.closed = true;
        state.stream?.destroy();
      };
    },
    hostInfo: async () => {
      const info = (await docker.info()) as { Name?: string; NCPU?: number; MemTotal?: number };
      return {
        name: info.Name ?? os.hostname(),
        cpus: info.NCPU ?? os.cpus().length,
        memoryBytes: info.MemTotal ?? os.totalmem(),
      };
    },
    resolveHostDataDir,
    close: () => {
      [...cleanups].forEach((stop) => stop());
    },
  };
  return driver;
}
