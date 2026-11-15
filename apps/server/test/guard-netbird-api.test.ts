import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNetbirdClient, unreachableReason } from '../src/netbird/client.js';
import { AppError } from '../src/lib/errors.js';

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/guard.sh');
/** The fake programs must be runnable. */
const EXECUTABLE = 0o755;
const NETBIRD_IP = '203.0.113.9';

/** netbird with one exit (selected or not, from a file). */
const FAKE_NETBIRD = `#!/usr/bin/env bash
if [[ "$1 $2" == "networks ls" ]]; then
  printf 'Available Networks:\\n\\n  - ID: MorniHosting Ausgang\\n    Network: 0.0.0.0/0\\n    Status: %s\\n' "$(cat "$FAKE_DIR/exit")"
fi
`;
/** ip: the normal way out, and every route that gets set is written down. */
const FAKE_IP = `#!/usr/bin/env bash
if [[ "$*" == "-4 route show table main default" ]]; then echo "default via 192.0.2.1 dev eth0 proto static"; exit 0; fi
if [[ "$1 $2" == "route replace" ]]; then echo "$3 $4 $5 $6 $7" >>"$FAKE_DIR/routes"; exit 0; fi
`;
/** curl: up, down, or only once the route around the exit is there. */
const FAKE_CURL = `#!/usr/bin/env bash
case "$(cat "$FAKE_DIR/api")" in
  up) exit 0 ;;
  bypass) grep -q '^${NETBIRD_IP}/32 via 192.0.2.1' "$FAKE_DIR/routes" 2>/dev/null && exit 0 || exit 28 ;;
esac
exit 28
`;
const FAKE_GETENT = `#!/usr/bin/env bash
[[ "$1" == "ahostsv4" ]] && printf '${NETBIRD_IP}    STREAM %s\\n${NETBIRD_IP}    DGRAM\\n' "$2"
`;
const FAKE_DOCKER = '#!/usr/bin/env bash\nexit 1\n';

interface GuardEvent {
  readonly key: string;
  readonly status: string;
  readonly what: string;
}

describe('guard.sh: the panel reaches NetBird even behind the exit (Philip: "NetBird nicht erreichbar")', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const set = (file: string, value: string) => fs.writeFileSync(path.join(root, file), value);
  const guard = () => run('bash', [SCRIPT, 'netbird-api'], { env });
  const routes = () =>
    fs.existsSync(path.join(root, 'routes')) ? fs.readFileSync(path.join(root, 'routes'), 'utf8') : '';
  const events = (): GuardEvent[] => {
    const file = path.join(root, 'state', 'events-pending.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GuardEvent);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-guard-nb-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const fakes = {
      netbird: FAKE_NETBIRD,
      ip: FAKE_IP,
      curl: FAKE_CURL,
      getent: FAKE_GETENT,
      docker: FAKE_DOCKER,
    };
    Object.entries(fakes).forEach(([name, body]) =>
      fs.writeFileSync(path.join(bin, name), body, { mode: EXECUTABLE }),
    );
    fs.mkdirSync(path.join(root, 'install'));
    fs.writeFileSync(
      path.join(root, 'install', '.env'),
      'MH_SECRET=x\nMH_NETBIRD_API=https://netbird.example.de/\n',
    );
    set('exit', 'Selected');
    env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_DIR: root,
      MH_INSTALL_DIR: path.join(root, 'install'),
      MH_GUARD_STATE_DIR: path.join(root, 'state'),
      MH_GUARD_LOG: path.join(root, 'guard.log'),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('does nothing while the panel reaches NetBird', async () => {
    set('api', 'up');
    await guard();
    await guard();
    expect(routes()).toBe('');
    expect(events()).toEqual([]);
  });

  it('behind the exit: after two failed checks only the NetBird server goes around the exit, and stays so', async () => {
    set('api', 'bypass');
    await guard();
    expect(routes()).toBe('');
    await guard();
    expect(routes()).toContain(`${NETBIRD_IP}/32 via 192.0.2.1 dev eth0`);
    expect(events().map((e) => `${e.key} ${e.status}`)).toEqual(['netbird:api fixed']);
    expect(events()[0]?.what).toContain('netbird.example.de');
    // After a restart the route is gone – the guard sets it again before it checks.
    fs.rmSync(path.join(root, 'routes'));
    await guard();
    expect(routes()).toContain(`${NETBIRD_IP}/32`);
    expect(events()).toHaveLength(1);
  });

  it('when even that does not help: one message, then "wieder erreichbar"', async () => {
    set('api', 'down');
    await guard();
    await guard();
    await guard();
    expect(events().map((e) => `${e.key} ${e.status}`)).toEqual(['netbird:api action']);
    set('api', 'up');
    await guard();
    expect(events().map((e) => `${e.key} ${e.status}`)).toEqual(['netbird:api action', 'netbird:api ok']);
  });

  it('without an exit nothing is rerouted', async () => {
    set('exit', 'Not Selected');
    set('api', 'down');
    await guard();
    await guard();
    expect(routes()).toBe('');
    expect(events().map((e) => `${e.key} ${e.status}`)).toEqual(['netbird:api action']);
  });
});

describe('NetBird client: says why NetBird is not reachable', () => {
  it('reads the reason from the error chain', () => {
    const dns = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND netbird.example.de'), { code: 'ENOTFOUND' }),
    });
    expect(unreachableReason(new Error('wrapped', { cause: dns }))).toBe('dns');
    expect(unreachableReason(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
    expect(unreachableReason(new Error('something else'))).toBeNull();
  });

  it('a closed port comes back as "refused" with the host', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const client = createNetbirdClient(`http://127.0.0.1:${port}`, 'nbp_test');
    const failure = await client.peers().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('netbird_unreachable_refused');
    expect((failure as AppError).params).toEqual({ host: `127.0.0.1:${port}` });
  });
});
