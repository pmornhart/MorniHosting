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
const CTID = '100';
/** Seconds: a Proxmox task that has only just started, and one that has been hanging for a long time. */
const FRESH_TASK = 30;
const HUNG_TASK = 900;

/**
 * pct: container state in files – "status" (running/stopped), "config" (with "lock: …"), "start-fails" (reason).
 * Every call is written to "calls".
 */
const FAKE_PCT = `#!/usr/bin/env bash
echo "pct $*" >>"$FAKE_DIR/calls"
case "$1" in
  status) echo "status: $(cat "$FAKE_DIR/status")" ;;
  config) cat "$FAKE_DIR/config" ;;
  start)
    lock="$(awk '/^lock:/ { print $2 }' "$FAKE_DIR/config")"
    if [[ -n "$lock" ]]; then echo "CT is locked ($lock)" >&2; exit 255; fi
    if [[ -s "$FAKE_DIR/start-fails" ]]; then echo "run_buffer: 571 Script exited with status 1" >&2; cat "$FAKE_DIR/start-fails" >&2; exit 255; fi
    echo running >"$FAKE_DIR/status" ;;
  unlock) sed -i '/^lock:/d' "$FAKE_DIR/config" ;;
  unmount) ;;
  exec)
    [[ "$(cat "$FAKE_DIR/status")" == running ]] || exit 1
    shift 3
    [[ "$1 $2" == "bash /opt/mornihosting/scripts/guard.sh" && "$3" == event ]] && { shift 3; echo "$*" >>"$FAKE_DIR/events"; }
    exit 0 ;;
  fstrim) echo "real pct fstrim must not run" >&2; exit 1 ;;
esac
`;
/** pgrep/ps: processes from "procs" (one per line: pid seconds command line). */
const FAKE_PGREP = `#!/usr/bin/env bash
[[ "$1" == -f ]] || exit 1
[[ -f "$FAKE_DIR/procs" ]] || exit 1
found=1
while read -r pid _ cmd; do
  if grep -qE -- "$2" <<<"$cmd"; then echo "$pid"; found=0; fi
done <"$FAKE_DIR/procs"
exit $found
`;
const FAKE_PKILL = `#!/usr/bin/env bash
echo "pkill $*" >>"$FAKE_DIR/calls"
[[ -f "$FAKE_DIR/procs" ]] || exit 1
grep -vE -- "$2" "$FAKE_DIR/procs" >"$FAKE_DIR/procs.new" || true
mv "$FAKE_DIR/procs.new" "$FAKE_DIR/procs"
`;
const FAKE_PS = `#!/usr/bin/env bash
pid="\${@: -1}"
awk -v pid="$pid" '$1 == pid { print $2 }' "$FAKE_DIR/procs"
`;
const FAKE_SYSTEMD_RUN = `#!/usr/bin/env bash
echo "systemd-run $*" >>"$FAKE_DIR/calls"
`;
const FAKE_SYSTEMCTL = '#!/usr/bin/env bash\nexit 3\n';
const FAKE_LXC_INFO = '#!/usr/bin/env bash\necho 4242\n';
const FAKE_PVESM =
  '#!/usr/bin/env bash\nprintf "Name Type Status Total Used Available %%\\nlocal-lvm lvmthin active 1 1 1 20.00%%\\n"\n';
const FAKE_ID = '#!/usr/bin/env bash\necho 0\n';
const FAKE_CURL = '#!/usr/bin/env bash\nexit 0\n';

const CONFIG = [
  'arch: amd64',
  'hostname: mornihosting',
  'rootfs: local-lvm:vm-100-disk-0,size=100G',
  'mp0: local-lvm:vm-100-disk-1,mp=/srv/data,size=50G',
  'mp1: /mnt/backups,mp=/backups',
  'mp2: local-lvm:vm-100-disk-2,mp=/ro,ro=1',
  '',
].join('\n');

describe('dauerbetrieb.sh: the host guard keeps the container running (Philip: "CT is locked (fstrim)")', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const file = (name: string) => path.join(root, name);
  const set = (name: string, value: string) => fs.writeFileSync(file(name), value);
  const read = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
  const status = () => read('status').trim();
  const guard = () => run('bash', [SCRIPT, 'guard'], { env });
  const starts = () =>
    read('calls')
      .split('\n')
      .filter((line) => line.startsWith('pct start')).length;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-host-guard-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const fakes = {
      pct: FAKE_PCT,
      pgrep: FAKE_PGREP,
      pkill: FAKE_PKILL,
      ps: FAKE_PS,
      'systemd-run': FAKE_SYSTEMD_RUN,
      systemctl: FAKE_SYSTEMCTL,
      'lxc-info': FAKE_LXC_INFO,
      pvesm: FAKE_PVESM,
      id: FAKE_ID,
      curl: FAKE_CURL,
    };
    Object.entries(fakes).forEach(([name, body]) =>
      fs.writeFileSync(path.join(bin, name), body, { mode: EXECUTABLE }),
    );
    fs.mkdirSync(file('tasks'));
    set('tasks/index', '');
    set('config', CONFIG);
    env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_DIR: root,
      CTID,
      MH_HOST_GUARD_STATE_DIR: file('state'),
      MH_HOST_GUARD_LOG: file('guard.log'),
      MH_PVE_TASK_DIR: file('tasks'),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a hanging fstrim on a stopped container is ended and the container starts', async () => {
    set('status', 'stopped');
    set('config', `${CONFIG}lock: fstrim\n`);
    set('procs', `777 ${HUNG_TASK} /usr/bin/perl /usr/sbin/pct fstrim ${CTID}\n`);
    await guard();
    expect(read('calls')).toContain(`pkill -f pct fstrim ${CTID}`);
    expect(read('calls')).toContain(`pct unmount ${CTID}`);
    expect(read('config')).not.toContain('lock:');
    expect(status()).toBe('running');
    expect(read('guard.log')).toContain('der Start geht vor');
  });

  it('does not start the container in the middle of a reboot from the Proxmox interface', async () => {
    set('status', 'stopped');
    set('procs', `900 ${FRESH_TASK} task UPID:pve:00001234:00ABCDEF:6743A1B2:vzreboot:${CTID}:root@pam:\n`);
    await guard();
    expect(starts()).toBe(0);
    // A task that has been hanging for 15 minutes no longer holds the guard back.
    set('procs', `900 ${HUNG_TASK} task UPID:pve:00001234:00ABCDEF:6743A1B2:vzreboot:${CTID}:root@pam:\n`);
    await guard();
    expect(status()).toBe('running');
  });

  it('leaves the container alone during a backup and for other containers’ tasks it still works', async () => {
    set('status', 'stopped');
    set('config', `${CONFIG}lock: backup\n`);
    await guard();
    expect(starts()).toBe(0);
    set('config', CONFIG);
    set('procs', `901 ${FRESH_TASK} task UPID:pve:00001235:00ABCDEF:6743A1B2:vzreboot:101:root@pam:\n`);
    await guard();
    expect(status()).toBe('running');
  });

  it('when the start fails: the reason from Proxmox, one message per outage, then "läuft wieder"', async () => {
    set('status', 'stopped');
    set('start-fails', `startup for container '${CTID}' failed`);
    await guard();
    await guard();
    expect(read('guard.log')).toContain(`(startup for container '${CTID}' failed)`);
    // The container is off, so the message waits on the host and goes out once it runs again.
    // One line per message, escaped for the shell (printf %q).
    const pending = read(`state/pending-${CTID}`).split('\n').filter(Boolean);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain('startet\\ nicht');
    expect(pending[0]).toContain(`Proxmox sagt: startup for container \\'${CTID}\\' failed`);
    set('start-fails', '');
    await guard();
    expect(status()).toBe('running');
    await guard();
    expect(read('events')).toContain('läuft wieder');
    expect(read('events')).not.toContain('neu gestartet');
  });

  it('gives space back in the background, without locking the container', async () => {
    set('status', 'running');
    await guard();
    const calls = read('calls');
    expect(calls).not.toContain('pct fstrim');
    expect(calls).toContain(`systemd-run --unit=mornihosting-fstrim-${CTID}`);
    expect(calls).toContain('/proc/4242/root/ /proc/4242/root/srv/data');
    // Neither the host folder (mp1) nor the read-only drive (mp2).
    expect(calls).not.toContain('/proc/4242/root/backups');
    expect(calls).not.toContain('/proc/4242/root/ro');
    expect(read('config')).not.toContain('lock:');
  });
});
