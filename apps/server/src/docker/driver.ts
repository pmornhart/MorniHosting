export interface PortBinding {
  readonly containerPort: number;
  readonly hostPort: number;
  readonly protocol: 'tcp' | 'udp';
}

export interface ContainerSpec {
  /** Container name; also its host name on the Minecraft network. */
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly ports: readonly PortBinding[];
  readonly memoryLimitBytes: number;
  /** CPU cores the container may use; missing = all. */
  readonly cpus?: number;
  /** Server folder as the panel sees it, e.g. /data/servers/abc. */
  readonly dataDir: string;
  /** Folders of dataDir and where they appear in the container (default: all of it at /data, as itzg expects). */
  readonly mounts?: readonly { readonly subdir: string; readonly path: string }[];
  readonly labels: Readonly<Record<string, string>>;
  /** Replaces the image's start command (e.g. the HTTPS gateway runs Caddy with its own config). */
  readonly command?: readonly string[];
  /** Helpers like the HTTPS gateway come back after a reboot; Minecraft servers are started by the panel. */
  readonly restart?: 'no' | 'unless-stopped';
}

export interface ContainerState {
  readonly running: boolean;
  readonly status: string;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Address on the Minecraft network, while running. */
  readonly ip: string | null;
}

export interface ContainerStats {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly memoryLimitBytes: number;
  /** Bytes received and sent by the container since it started. */
  readonly rxBytes: number;
  readonly txBytes: number;
}

/** How a console command reaches the server process. */
export type CommandChannel =
  | { readonly kind: 'rcon'; readonly host: string; readonly port: number; readonly password: string }
  | { readonly kind: 'exec'; readonly argv: readonly string[] }
  | { readonly kind: 'stdin' }
  /** The game has no console the panel can type into. */
  | { readonly kind: 'none' };

export interface ContainerEvent {
  readonly containerId: string;
  readonly action: 'start' | 'die' | 'oom' | 'destroy';
}

export interface HostDockerInfo {
  readonly name: string;
  readonly cpus: number;
  readonly memoryBytes: number;
}

export type PullProgress = (percent: number | null, status: string) => void;
export type LogListener = (line: string) => void;

export interface DockerDriver {
  readonly kind: 'docker' | 'fake';
  readonly ping: () => Promise<void>;
  readonly ensureImage: (image: string, onProgress?: PullProgress) => Promise<void>;
  readonly ensureNetwork: (name: string) => Promise<void>;
  readonly createContainer: (spec: ContainerSpec) => Promise<string>;
  readonly removeContainer: (id: string) => Promise<void>;
  readonly start: (id: string) => Promise<void>;
  readonly stop: (id: string, timeoutSeconds: number) => Promise<void>;
  readonly kill: (id: string) => Promise<void>;
  readonly inspect: (id: string) => Promise<ContainerState | null>;
  /**
   * Streams log lines (the last `tail` old ones first, or all of them) until the container
   * stops or the returned function is called. Only a running container has a live stream.
   */
  readonly followLogs: (id: string, tail: number | 'all', onLine: LogListener) => Promise<() => void>;
  readonly stats: (id: string) => Promise<ContainerStats | null>;
  readonly sendCommand: (id: string, command: string, channel: CommandChannel) => Promise<string>;
  readonly onContainerEvent: (listener: (event: ContainerEvent) => void) => () => void;
  readonly hostInfo: () => Promise<HostDockerInfo>;
  /** Host path of the panel's data folder, needed to bind server folders into new containers. */
  readonly resolveHostDataDir: () => Promise<string>;
  readonly close: () => void;
}

export class DockerUnavailableError extends Error {
  override readonly name = 'DockerUnavailableError';
}
