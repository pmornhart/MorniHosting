import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/netbird-proxy-ports.sh');
/** The fake programs must be runnable. */
const EXECUTABLE = 0o755;
/** The whole flow (finding the proxy, writing the compose file) only runs as root, like on the NetBird server. */
const AS_ROOT = process.getuid?.() === 0;

/** ufw: active, every "allow" written down. */
const FAKE_UFW = `#!/usr/bin/env bash
if [[ "$1" == "status" ]]; then echo "Status: active"; exit 0; fi
echo "$*" >>"$FAKE_DIR/ufw"
`;
/** firewalld: running, every call written down. */
const FAKE_FIREWALLD = `#!/usr/bin/env bash
if [[ "$1" == "--state" ]]; then echo running; exit 0; fi
echo "$*" >>"$FAKE_DIR/firewalld"
`;
/** docker: a netbird-proxy started by Docker Compose from $FAKE_DIR/netbird; "compose" written down. */
const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1 $2" in
  "ps -a") echo netbird-proxy ;;
  "inspect -f")
    case "$3" in
      *working_dir*) echo "$FAKE_DIR/netbird" ;;
      *config_files*) echo "$FAKE_DIR/netbird/docker-compose.yml" ;;
      *compose.service*) echo netbird-proxy ;;
      *compose.project*) echo netbird ;;
      *NetworkMode*) echo bridge ;;
    esac ;;
  "compose -p") echo "$*" >>"$FAKE_DIR/compose" ;;
esac
`;

describe('netbird-proxy-ports.sh: Minecraft ports on a self-hosted NetBird proxy', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
  /** Loads the script's functions only (NETBIRD_PORTS_LIB) and runs `command` with them. */
  const lib = (command: string, extra: Record<string, string> = {}) =>
    run('bash', ['-c', `source "${SCRIPT}"; ${command}`], {
      env: { ...env, NETBIRD_PORTS_LIB: '1', ...extra },
    });
  const fake = (name: string, body: string) =>
    fs.writeFileSync(path.join(file('bin'), name), body, { mode: EXECUTABLE });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-proxy-ports-'));
    fs.mkdirSync(file('bin'));
    env = { PATH: `${file('bin')}:/usr/bin:/bin`, FAKE_DIR: root };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('opens UDP on the Java ports too (voice chat at a Velocity proxy), next to everything opened before', async () => {
    const { stdout } = await lib('ports_yaml netbird-proxy');
    expect(stdout).toContain('  netbird-proxy:\n    ports:\n');
    expect(stdout).toContain('"25565-25575:25565-25575/tcp"');
    expect(stdout).toContain('"25565-25575:25565-25575/udp"');
    expect(stdout).toContain('"19132-19140:19132-19140/udp"');
    expect(stdout).toContain('"19132-19140:19132-19140/tcp"');
    expect(stdout).toContain('"24454-24460:24454-24460/udp"');
    // Own ranges: the UDP range follows the Java range unless set on its own.
    const own = await lib('ports_yaml proxy', { MC_TCP: '25565-25600' });
    expect(own.stdout).toContain('"25565-25600:25565-25600/udp"');
    const apart = await lib('ports_yaml proxy', { MC_JAVA_UDP: '25565' });
    expect(apart.stdout).toContain('"25565:25565/udp"');
  });

  it('ufw and firewalld get the UDP range of the Java ports as well', async () => {
    fake('ufw', FAKE_UFW);
    await lib('open_firewall');
    expect(read('ufw').split('\n').filter(Boolean)).toEqual([
      'allow 25565:25575/tcp',
      'allow 25565:25575/udp',
      'allow 19132:19140/udp',
      'allow 19132:19140/tcp',
      'allow 24454:24460/udp',
    ]);
    fs.rmSync(path.join(file('bin'), 'ufw'));
    fake('firewall-cmd', FAKE_FIREWALLD);
    await lib('open_firewall');
    expect(read('firewalld')).toContain('--add-port=25565-25575/udp');
    expect(read('firewalld')).toContain('--add-port=25565-25575/tcp');
    expect(read('firewalld')).toContain('--reload');
  });

  it('refuses ranges that are not ports', async () => {
    await expect(lib('check_ranges', { MC_JAVA_UDP: '25565/udp' })).rejects.toThrow();
    await expect(lib('check_ranges', { MC_TCP: '25565-25575' })).resolves.toBeDefined();
  });

  it.skipIf(!AS_ROOT)('a second run brings the new UDP range along and keeps everything else', async () => {
    fake('docker', FAKE_DOCKER);
    fs.mkdirSync(file('netbird'));
    fs.writeFileSync(file('netbird/docker-compose.yml'), 'services: {}\n');
    fs.writeFileSync(file('netbird/.env'), 'NETBIRD_DOMAIN=netbird.example.de\n');
    // What the first version of the script wrote (no UDP on the Java ports yet).
    fs.writeFileSync(
      file('netbird/mornihosting-ports.yml'),
      '# Von MorniHosting angelegt: Minecraft-Ports\nservices:\n  netbird-proxy:\n    ports:\n      - "25565-25575:25565-25575/tcp"\n',
    );
    const { stdout } = await run('bash', [SCRIPT], { env });
    expect(stdout).toContain('Proxy läuft mit den Minecraft-Ports');
    expect(read('netbird/mornihosting-ports.yml')).toContain('"25565-25575:25565-25575/udp"');
    expect(read('netbird/mornihosting-ports.yml')).toContain('"25565-25575:25565-25575/tcp"');
    expect(read('netbird/.env')).toContain(
      `COMPOSE_FILE=${file('netbird/docker-compose.yml')}:${file('netbird/mornihosting-ports.yml')}`,
    );
    expect(read('compose')).toContain('up -d --no-deps netbird-proxy');
    // Again: the .env keeps one COMPOSE_FILE line.
    await run('bash', [SCRIPT], { env });
    expect(
      read('netbird/.env')
        .split('\n')
        .filter((line) => line.startsWith('COMPOSE_FILE=')),
    ).toHaveLength(1);
  });
});
