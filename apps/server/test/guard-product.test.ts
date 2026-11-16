import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/guard.sh');
/** The fake programs must be runnable. */
const EXECUTABLE = 0o755;

/** systemctl: every call written down, nothing really switched. */
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/systemctl"
exit 0
`;
/** docker: only "volume inspect" answers – with a folder per volume name. */
const FAKE_DOCKER = `#!/usr/bin/env bash
if [[ "$1 $2" == "volume inspect" ]]; then
  name="\${@: -1}"
  mkdir -p "$FAKE_DIR/volumes/$name"
  echo "$FAKE_DIR/volumes/$name"
  exit 0
fi
exit 1
`;
/** netbird: two exits for all traffic, both switched off; every "select" written down. */
const FAKE_NETBIRD = `#!/usr/bin/env bash
if [[ "$1 $2" == "networks ls" ]]; then
  printf 'Available Networks:\\n\\n'
  printf '  - ID: MorniHosting Ausgang\\n    Network: 0.0.0.0/0\\n    Status: Not Selected\\n'
  printf '  - ID: morni.net Ausgang\\n    Network: 0.0.0.0/0\\n    Status: Not Selected\\n'
  exit 0
fi
if [[ "$1 $2" == "networks select" ]]; then echo "$3 $4" >>"$FAKE_DIR/selected"; exit 0; fi
exit 0
`;
const FAKE_OK = '#!/usr/bin/env bash\nexit 0\n';

/** What another product (morni.net, MorniHosting as its motor) sets for its guard. */
const MORNINET = {
  MH_BRAND: 'morni.net',
  MH_GUARD_NAME: 'morninet',
  MH_DATA_VOLUME: 'morninet-motor-data',
  MH_GUARD_CONTAINERS: 'morninet morninet-motor morninet-socket-proxy',
};

describe('guard.sh for another product (morni.net runs MorniHosting as its motor)', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
  const guard = (args: string[], extra: Record<string, string> = {}) =>
    run('bash', [SCRIPT, ...args], { env: { ...env, ...extra } });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-guard-product-'));
    const bin = file('bin');
    fs.mkdirSync(bin);
    const fakes = {
      systemctl: FAKE_SYSTEMCTL,
      docker: FAKE_DOCKER,
      netbird: FAKE_NETBIRD,
      curl: FAKE_OK,
      sleep: FAKE_OK,
    };
    Object.entries(fakes).forEach(([name, body]) =>
      fs.writeFileSync(path.join(bin, name), body, { mode: EXECUTABLE }),
    );
    env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_DIR: root,
      MH_GUARD_STATE_DIR: file('state'),
      MH_GUARD_LOG: file('guard.log'),
      MH_UNIT_DIR: file('units'),
      MH_WRAPPER_DIR: file('sbin'),
      MH_DOCKER_DAEMON_JSON: file('daemon.json'),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('install: own timer and an own start script that brings the settings along', async () => {
    const { stdout } = await guard(['install'], { ...MORNINET, MH_INSTALL_DIR: '/opt/morninet' });
    const wrapper = read('sbin/morninet-guard');
    expect(wrapper).toContain('export MH_BRAND=morni.net');
    expect(wrapper).toContain('export MH_DATA_VOLUME=morninet-motor-data');
    expect(wrapper).toContain(`exec bash ${SCRIPT} "$@"`);
    expect(fs.statSync(file('sbin/morninet-guard')).mode & EXECUTABLE).toBe(EXECUTABLE);
    expect(read('units/morninet-guard.service')).toContain(`ExecStart=${file('sbin/morninet-guard')} check`);
    expect(read('units/morninet-guard.service')).toContain('Description=morni.net:');
    expect(read('units/morninet-guard.timer')).toContain('morni.net-Wächter');
    expect(fs.existsSync(file('units/mornihosting-guard.service'))).toBe(false);
    expect(read('systemctl')).toContain('enable --now morninet-guard.timer');
    // MorniHosting's own old units belong to MorniHosting: left alone.
    expect(read('systemctl')).not.toContain('mornihosting-netbird');
    expect(stdout).toContain(`Status: ${file('sbin/morninet-guard')} status`);
  });

  it('install without settings stays MorniHosting as before: no start script, the script itself in the timer', async () => {
    await guard(['install']);
    expect(fs.existsSync(file('sbin/mornihosting-guard'))).toBe(false);
    expect(read('units/mornihosting-guard.service')).toContain(`ExecStart=${SCRIPT} check`);
    expect(read('systemctl')).toContain('disable --now mornihosting-netbird.timer');
  });

  it("messages land in the data volume of the product's motor", async () => {
    await guard(
      ['event', 'container', 'dns', 'fixed', 'DNS repariert', 'Feste DNS-Server eingetragen.'],
      MORNINET,
    );
    expect(read('volumes/morninet-motor-data/guard/events.jsonl')).toContain('"title":"DNS repariert"');
    expect(fs.existsSync(file('volumes/mornihosting-data'))).toBe(false);
    await guard(['event', 'container', 'dns', 'fixed', 'DNS repariert', 'Wieder da.']);
    expect(read('volumes/mornihosting-data/guard/events.jsonl')).toContain('"what":"Wieder da."');
  });

  it("only its own exit is switched on again, not the other product's", async () => {
    await guard(['exit'], MORNINET);
    expect(read('selected').trim()).toBe('morni.net Ausgang');
    fs.rmSync(file('selected'));
    fs.rmSync(file('state'), { recursive: true, force: true });
    await guard(['exit']);
    expect(read('selected').trim()).toBe('MorniHosting Ausgang');
  });
});
