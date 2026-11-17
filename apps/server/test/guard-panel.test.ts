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

/**
 * docker: every container is a file "$FAKE_DIR/c/<name>" with "<status>|<health>" (health empty = no healthcheck,
 * like the socket proxy). "restart" takes "$FAKE_DIR/after/<name>" if there is one, "compose up" brings back missing
 * containers as running. Every restart and compose call is written down.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
c="$FAKE_DIR/c"
case "$1" in
  info) exit 0 ;;
  volume) exit 1 ;;
  ps) ls "$c"; exit 0 ;;
  inspect)
    name="\${@: -1}"
    [[ -f "$c/$name" ]] || exit 1
    if [[ "$3" == *Health.Log* ]]; then
      [[ -f "$FAKE_DIR/reason/$name" ]] && cat "$FAKE_DIR/reason/$name"
      exit 0
    fi
    if [[ "$3" == *State.Running* ]]; then
      IFS='|' read -r status health <"$c/$name"
      running=false; [[ "$status" == running ]] && running=true
      echo "$running $health"
      exit 0
    fi
    cat "$c/$name"
    exit 0 ;;
  restart)
    echo "restart $2" >>"$FAKE_DIR/calls"
    [[ -f "$FAKE_DIR/after/$2" ]] && cp "$FAKE_DIR/after/$2" "$c/$2"
    exit 0 ;;
  compose)
    echo "compose $*" >>"$FAKE_DIR/calls"
    for name in $WANTED; do [[ -f "$c/$name" ]] || echo "running|healthy" >"$c/$name"; done
    exit 0 ;;
  rm) exit 0 ;;
esac
exit 0
`;

const CONTAINERS = ['moinmorni', 'moinmorni-motor', 'moinmorni-socket-proxy'];
/** The guard waits for this many sick checks in a row before it restarts anything. */
const CHECKS_UNTIL_RESTART = 3;

interface GuardEvent {
  key: string;
  status: string;
  title: string;
  what: string;
  command?: string;
}

describe('guard.sh keeps the panel running – and says honestly what happened', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
  const setState = (name: string, state: string) => fs.writeFileSync(path.join(root, 'c', name), `${state}\n`);
  const afterRestart = (name: string, state: string) => fs.writeFileSync(path.join(root, 'after', name), `${state}\n`);
  const check = () => run('bash', [SCRIPT, 'panel'], { env });
  const checks = async (times: number) => {
    for (let i = 0; i < times; i += 1) await check();
  };
  const events = (): GuardEvent[] =>
    read('state/events-pending.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GuardEvent);
  const calls = () => read('calls').split('\n').filter(Boolean);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-guard-panel-'));
    ['bin', 'c', 'after', 'reason', 'install'].forEach((dir) => fs.mkdirSync(file(dir)));
    fs.writeFileSync(path.join(root, 'bin', 'docker'), FAKE_DOCKER, { mode: EXECUTABLE });
    fs.writeFileSync(path.join(root, 'install', 'docker-compose.yml'), 'services: {}\n');
    setState('moinmorni', 'running|healthy');
    setState('moinmorni-motor', 'running|healthy');
    setState('moinmorni-socket-proxy', 'running|');
    env = {
      PATH: `${file('bin')}:${process.env.PATH ?? ''}`,
      FAKE_DIR: root,
      WANTED: CONTAINERS.join(' '),
      MH_BRAND: 'MoinMorni',
      MH_GUARD_NAME: 'moinmorni',
      MH_GUARD_CONTAINERS: CONTAINERS.join(' '),
      MH_INSTALL_DIR: file('install'),
      MH_UPDATE_LOCK: file('update.lock'),
      MH_GUARD_STATE_DIR: file('state'),
      MH_GUARD_LOG: file('guard.log'),
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('counts a running container without healthcheck (the socket proxy) as fine – no restart, no message', async () => {
    await checks(CHECKS_UNTIL_RESTART * 2);
    expect(calls()).toEqual([]);
    expect(events()).toEqual([]);
    expect(read('state/panel-failures').trim()).toBe('0');
  });

  it('restarts exactly the sick container and names it and the reason', async () => {
    setState('moinmorni-motor', 'running|unhealthy');
    fs.writeFileSync(path.join(root, 'reason', 'moinmorni-motor'), 'curl: (7) Failed to connect\n');
    afterRestart('moinmorni-motor', 'running|healthy');
    await checks(CHECKS_UNTIL_RESTART - 1);
    expect(calls()).toEqual([]);
    await check();
    expect(calls()).toEqual(['restart moinmorni-motor']);
    const [event] = events();
    expect(event).toMatchObject({ key: 'panel', status: 'fixed' });
    expect(event?.what).toContain('moinmorni-motor: krank – curl: (7) Failed to connect');
    expect(event?.what).not.toContain('socket-proxy');
    expect(read('guard.log')).toContain('moinmorni-motor: krank');
  });

  it('brings a missing container back with compose', async () => {
    fs.rmSync(path.join(root, 'c', 'moinmorni-socket-proxy'));
    await checks(CHECKS_UNTIL_RESTART);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain('compose');
    expect(events()[0]).toMatchObject({ status: 'fixed' });
    expect(events()[0]?.what).toContain('moinmorni-socket-proxy: fehlt');
  });

  it('does not claim "fixed" when the restart did not help – it asks for the logs instead', async () => {
    setState('moinmorni', 'exited|');
    afterRestart('moinmorni', 'exited|');
    await checks(CHECKS_UNTIL_RESTART);
    const [event] = events();
    expect(event).toMatchObject({ key: 'panel', status: 'action', command: 'docker logs --tail 80 moinmorni' });
    expect(event?.what).toContain('moinmorni: aus (exited)');
  });

  it('says so when the same container keeps getting sick (three restarts in an hour)', async () => {
    afterRestart('moinmorni', 'running|healthy');
    const sickAgain = async () => {
      setState('moinmorni', 'running|unhealthy');
      await checks(CHECKS_UNTIL_RESTART);
    };
    await sickAgain();
    await sickAgain();
    await sickAgain();
    const statuses = events().map((event) => `${event.key} ${event.status}`);
    expect(statuses).toEqual(['panel fixed', 'panel fixed', 'panel:wiederholt action']);
    expect(events()[2]?.command).toBe('docker logs --tail 80 moinmorni');
  });

  it('leaves everything alone during an update', async () => {
    setState('moinmorni', 'exited|');
    fs.writeFileSync(file('update.lock'), '');
    await checks(CHECKS_UNTIL_RESTART * 2);
    expect(calls()).toEqual([]);
    expect(events()).toEqual([]);
  });
});
