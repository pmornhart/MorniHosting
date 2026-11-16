import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, '../../../proxmox/dauerbetrieb.sh');
/** The fake programs must be runnable. */
const EXECUTABLE = 0o755;
const MORNINET_CT = '105';

/**
 * pct with two containers (100 "mornihosting", 105 "morninet"); their state in "status-<id>" (default running).
 * Every call goes to "calls", every command run in a container to "exec-<id>". In the container, the guard's timer
 * is not running and only morni.net's start script exists.
 */
const FAKE_PCT = `#!/usr/bin/env bash
echo "pct $*" >>"$FAKE_DIR/calls"
cmd="$1"
shift
state() { cat "$FAKE_DIR/status-$1" 2>/dev/null || echo running; }
case "$cmd" in
  list) printf 'VMID       Status     Lock         Name\\n100        running                 mornihosting\\n105        running                 morninet\\n' ;;
  status) echo "status: $(state "$1")" ;;
  config) echo "rootfs: local-lvm:vm-$1-disk-0,size=100G" ;;
  start) echo running >"$FAKE_DIR/status-$1" ;;
  set) ;;
  exec)
    id="$1"
    shift
    [[ "$1" == -- ]] && shift
    [[ "$(state "$id")" == running ]] || exit 1
    echo "$*" >>"$FAKE_DIR/exec-$id"
    case "$1" in
      systemctl) exit 3 ;;
      test) [[ "$3" == /usr/local/sbin/morninet-guard ]] ;;
      *) exit 0 ;;
    esac ;;
esac
`;
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >>"$FAKE_DIR/calls"
[[ "$1" == is-active ]] && exit 3
exit 0
`;
const FAKE_RECORD = (name: string) => `#!/usr/bin/env bash\necho "${name} $*" >>"$FAKE_DIR/calls"\n`;
const FAKE_PVESM =
  '#!/usr/bin/env bash\nprintf "Name Type Status Total Used Available %%\\nlocal-lvm lvmthin active 1 1 1 20.00%%\\n"\n';

/** What morni.net's Proxmox one-liner hands the host guard for its container. */
const MORNINET = {
  MH_GUARD_NAME: 'morninet',
  MH_BRAND: 'morni.net',
  MH_INSTALL_DIR: '/opt/morninet',
  MH_CT_GUARD: '/usr/local/sbin/morninet-guard',
  MH_DATA_VOLUME: 'morninet-motor-data',
};

describe('dauerbetrieb.sh for a second product on the same Proxmox host (morni.net next to MorniHosting)', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
  const lines = (name: string) => read(name).split('\n').filter(Boolean);
  const hostguard = () =>
    run('bash', [SCRIPT, 'hostguard'], {
      env: {
        ...env,
        ...MORNINET,
        CTID: MORNINET_CT,
        MH_HOST_GUARD_CONF: file('etc/morninet-host-guard.conf'),
      },
    });
  /** The installed copy, run like its timer does – without any product settings in the environment. */
  const installed = (command: string) =>
    run(file('sbin/morninet-host-guard'), [command], {
      env: { ...env, MH_HOST_GUARD_CONF: file('etc/morninet-host-guard.conf') },
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-host-guard-product-'));
    ['bin', 'etc', 'units', 'sbin', 'tasks'].forEach((dir) => fs.mkdirSync(file(dir)));
    const fakes: Record<string, string> = {
      pct: FAKE_PCT,
      systemctl: FAKE_SYSTEMCTL,
      'systemd-run': FAKE_RECORD('systemd-run'),
      pgrep: '#!/usr/bin/env bash\nexit 1\n',
      'lxc-info': '#!/usr/bin/env bash\necho 4242\n',
      pvesm: FAKE_PVESM,
      id: '#!/usr/bin/env bash\necho 0\n',
      curl: '#!/usr/bin/env bash\nexit 0\n',
    };
    Object.entries(fakes).forEach(([name, body]) =>
      fs.writeFileSync(path.join(file('bin'), name), body, { mode: EXECUTABLE }),
    );
    fs.writeFileSync(file('tasks/index'), '');
    // MorniHosting's own host guard is already there.
    fs.writeFileSync(file('units/mornihosting-host-guard.service'), 'MorniHosting\n');
    fs.writeFileSync(file('etc/mornihosting-host-guard.conf'), 'CTID=100\n');
    env = {
      PATH: `${file('bin')}:${process.env.PATH ?? ''}`,
      FAKE_DIR: root,
      MH_UNIT_DIR: file('units'),
      MH_WRAPPER_DIR: file('sbin'),
      MH_HOST_GUARD_STATE_DIR: file('state'),
      MH_HOST_GUARD_LOG: file('guard.log'),
      MH_PVE_TASK_DIR: file('tasks'),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('hostguard: own units, own configuration and its own copy of the script – MorniHosting keeps its own', async () => {
    await hostguard();
    const service = read('units/morninet-host-guard.service');
    expect(service).toContain(`Description=morni.net: Container ${MORNINET_CT} am Laufen halten`);
    expect(service).toContain('Environment=MH_GUARD_NAME=morninet');
    expect(service).toContain(`ExecStart=${file('sbin/morninet-host-guard')} guard`);
    expect(read('units/morninet-host-guard.timer')).toContain(
      'Description=morni.net Host-Wächter jede Minute',
    );
    expect(lines('etc/morninet-host-guard.conf')).toEqual([
      `CTID=${MORNINET_CT}`,
      'MH_BRAND=morni.net',
      'MH_INSTALL_DIR=/opt/morninet',
      'MH_CT_GUARD=/usr/local/sbin/morninet-guard',
      'MH_DATA_VOLUME=morninet-motor-data',
    ]);
    expect(fs.statSync(file('sbin/morninet-host-guard')).mode & EXECUTABLE).toBe(EXECUTABLE);
    expect(read('calls')).toContain(`pct set ${MORNINET_CT} --onboot 1 --startup order=1,up=30`);
    expect(read('calls')).toContain('systemctl enable --now morninet-host-guard.timer');
    // MorniHosting's host guard is untouched.
    expect(read('units/mornihosting-host-guard.service')).toBe('MorniHosting\n');
    expect(read('etc/mornihosting-host-guard.conf')).toBe('CTID=100\n');
    expect(read('calls')).not.toContain('mornihosting-host-guard');
  });

  it("the installed copy knows its product: starts morni.net's container and reports through morni.net's guard", async () => {
    await hostguard();
    fs.writeFileSync(file(`status-${MORNINET_CT}`), 'stopped');
    await installed('guard');
    expect(read(`status-${MORNINET_CT}`).trim()).toBe('running');
    expect(read('calls')).not.toContain('pct start 100');
    const reported = lines(`exec-${MORNINET_CT}`).find((l) => l.includes(' event host '));
    expect(reported).toContain(
      '/usr/local/sbin/morninet-guard event host container fixed morni.net-Container',
    );
    // Next minute it runs: the container's guard is not running, so it is set up with morni.net's start script.
    await installed('guard');
    expect(lines(`exec-${MORNINET_CT}`)).toEqual(
      expect.arrayContaining([
        'systemctl is-active --quiet morninet-guard.timer',
        'test -f /usr/local/sbin/morninet-guard',
        '/usr/local/sbin/morninet-guard install',
      ]),
    );
    expect(read('calls')).toContain('systemd-run --unit=morninet-fstrim-105');
    expect(fs.existsSync(file('exec-100'))).toBe(false);
  });

  it("finds its container by the product's name, and uninstall removes only its own", async () => {
    const { stdout } = await run('bash', [SCRIPT, 'status'], {
      env: { ...env, MH_GUARD_NAME: 'morninet', MH_HOST_GUARD_CONF: file('etc/none.conf') },
    });
    expect(stdout).toContain(`Container ${MORNINET_CT}:  running`);
    await hostguard();
    await installed('uninstall');
    expect(fs.existsSync(file('units/morninet-host-guard.service'))).toBe(false);
    expect(fs.existsSync(file('sbin/morninet-host-guard'))).toBe(false);
    expect(read('units/mornihosting-host-guard.service')).toBe('MorniHosting\n');
  });

  it('refuses a name that would leave its folders', async () => {
    await expect(
      run('bash', [SCRIPT, 'status'], { env: { ...env, MH_GUARD_NAME: '../etc' } }),
    ).rejects.toThrow('Ungültiger Name');
  });
});
