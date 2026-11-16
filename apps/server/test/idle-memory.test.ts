/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerDetail, ServerSummary } from '@mornihosting/shared';
import { buildContainerSpec } from '../src/servers/spec.js';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

const paper = {
  name: 'Modus',
  edition: 'java',
  software: 'paper',
  version: '26.1.2',
  memoryMb: 1536,
  port: 25565,
  eula: true,
  startNow: false,
};

/** Aikar's flags as the itzg image sets them below 12 GB – without -XX:+AlwaysPreTouch. */
const AIKAR_WITHOUT_PRETOUCH = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs',
  '-Daikars.new.flags=true',
];
const GIVE_BACK = [
  '-XX:G1PeriodicGCInterval=60000',
  '-XX:TrimNativeHeapInterval=60000',
  '-XX:MinHeapFreeRatio=10',
  '-XX:MaxHeapFreeRatio=30',
];

describe('release idle memory: always online, little RAM and CPU time without players', () => {
  let t: TestApp;
  let s: Session;
  beforeEach(async () => {
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const create = async (payload: object): Promise<ServerSummary> =>
    (
      await t.app.inject({ method: 'POST', url: '/api/servers', headers: authHeaders(s), payload })
    ).json<ServerSummary>();
  const patch = async (id: string, payload: object): Promise<ServerSummary> =>
    (
      await t.app.inject({ method: 'PATCH', url: `/api/servers/${id}`, headers: authHeaders(s), payload })
    ).json<ServerSummary>();
  const env = (id: string): Record<string, string> =>
    buildContainerSpec(t.ctx.config, t.servers.rowWithSecrets(id), 'Europe/Berlin').env;
  const flags = (id: string): string[] => (env(id)['JVM_XX_OPTS'] ?? '').split(' ').filter(Boolean);
  const propsFile = (id: string): string => path.join(t.dataDir, 'servers', id, 'server.properties');
  const pauseOf = (id: string): string | undefined =>
    fs
      .readFileSync(propsFile(id), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('pause-when-empty-seconds='))
      ?.split('=')[1];
  const setPause = (id: string, value: string): void => {
    const lines = fs.readFileSync(propsFile(id), 'utf8').split('\n');
    fs.writeFileSync(
      propsFile(id),
      lines
        .map((l) => (l.startsWith('pause-when-empty-seconds=') ? `pause-when-empty-seconds=${value}` : l))
        .join('\n'),
    );
  };
  const action = (id: string, what: 'start' | 'stop') =>
    t.app.inject({ method: 'POST', url: `/api/servers/${id}/actions/${what}`, headers: authHeaders(s) });
  const stateOf = async (id: string): Promise<string> =>
    (await t.app.inject({ url: `/api/servers/${id}`, headers: authHeaders(s) })).json<ServerDetail>().live
      .state;
  const startAndWait = async (id: string): Promise<void> => {
    await action(id, 'start');
    await waitFor(async () => (await stateOf(id)) === 'running');
  };
  const stopAndWait = async (id: string): Promise<void> => {
    await action(id, 'stop');
    await waitFor(async () => (await stateOf(id)) === 'stopped');
  };

  test('off by default: as before – Aikar flags with pre-touch and a 1 GB start heap', async () => {
    const server = await create(paper);
    expect(server.releaseIdleMemory).toBe(false);
    expect(env(server.id)).toMatchObject({
      INIT_MEMORY: '1024M',
      MAX_MEMORY: '1536M',
      USE_AIKAR_FLAGS: 'true',
    });
    expect(env(server.id)['JVM_XX_OPTS']).toBeUndefined();
  });

  test('on: small start heap, the same Aikar flags without pre-touch, unused memory goes back', async () => {
    const server = await create({ ...paper, releaseIdleMemory: true });
    expect(server.releaseIdleMemory).toBe(true);
    expect(env(server.id)).toMatchObject({
      INIT_MEMORY: '256M',
      MAX_MEMORY: '1536M',
      USE_AIKAR_FLAGS: 'false',
    });
    expect(flags(server.id)).toEqual([...AIKAR_WITHOUT_PRETOUCH, ...GIVE_BACK]);
    expect(flags(server.id)).not.toContain('-XX:+AlwaysPreTouch');

    // From 12 GB on, itzg takes Aikar's variant for big heaps – so do we.
    const big = await create({
      ...paper,
      name: 'Groß',
      port: 25566,
      memoryMb: 16384,
      releaseIdleMemory: true,
    });
    expect(flags(big.id)).toEqual(
      expect.arrayContaining([
        '-XX:G1NewSizePercent=40',
        '-XX:G1MaxNewSizePercent=50',
        '-XX:G1HeapRegionSize=16M',
        '-XX:G1ReservePercent=15',
        '-XX:InitiatingHeapOccupancyPercent=20',
      ]),
    );
  });

  test('Java 8 knows neither periodic collection nor native trimming (the JVM would not start): only the rest', async () => {
    const old = await create({ ...paper, version: '1.12.2', releaseIdleMemory: true });
    expect(flags(old.id)).not.toContain('-XX:G1PeriodicGCInterval=60000');
    expect(flags(old.id)).not.toContain('-XX:TrimNativeHeapInterval=60000');
    expect(flags(old.id)).toEqual(
      expect.arrayContaining(['-XX:MinHeapFreeRatio=10', '-XX:MaxHeapFreeRatio=30']),
    );
    // A newer Java chosen by hand gets it again.
    await patch(old.id, { javaTag: 'java17' });
    expect(flags(old.id)).toContain('-XX:G1PeriodicGCInterval=60000');
  });

  test('Velocity: starts small instead of start = maximum, with G1 that gives memory back', async () => {
    const proxy = await create({
      ...paper,
      name: 'Proxy',
      software: 'velocity',
      version: '3.4.0',
      memoryMb: 1024,
      port: 25577,
    });
    expect(env(proxy.id)['MEMORY']).toBe('1024M');
    await patch(proxy.id, { releaseIdleMemory: true });
    expect(env(proxy.id)).toMatchObject({ INIT_MEMORY: '256M', MAX_MEMORY: '1024M' });
    expect(env(proxy.id)['MEMORY']).toBeUndefined();
    expect(flags(proxy.id)).toEqual(['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', ...GIVE_BACK]);
    expect(env(proxy.id)['UID']).toBeUndefined();
  });

  test('switch with PATCH; Bedrock and other games never get it', async () => {
    const server = await create(paper);
    expect((await patch(server.id, { releaseIdleMemory: true })).releaseIdleMemory).toBe(true);
    expect((await patch(server.id, { releaseIdleMemory: false })).releaseIdleMemory).toBe(false);
    const bedrock = await create({
      ...paper,
      edition: 'bedrock',
      software: 'bedrock',
      version: 'latest',
      port: 19132,
      releaseIdleMemory: true,
    });
    expect(bedrock.releaseIdleMemory).toBe(false);
    expect((await patch(bedrock.id, { releaseIdleMemory: true })).releaseIdleMemory).toBe(false);
  });

  test('the world pauses without players: written before the start, an own delay stays, off takes it back', async () => {
    const server = await create({ ...paper, releaseIdleMemory: true });
    await startAndWait(server.id);
    expect(pauseOf(server.id)).toBe('60');
    await stopAndWait(server.id);

    // Someone set their own delay: it stays.
    setPause(server.id, '300');
    await startAndWait(server.id);
    expect(pauseOf(server.id)).toBe('300');
    await stopAndWait(server.id);

    // Off: our own minute goes again (Paper's default: never pause); an own delay would stay.
    setPause(server.id, '60');
    await patch(server.id, { releaseIdleMemory: false });
    expect(pauseOf(server.id)).toBe('-1');
    await startAndWait(server.id);
    expect(pauseOf(server.id)).toBe('-1');
  });

  test('versions before 1.21.2 have no pause – nothing is written', async () => {
    const old = await create({ ...paper, version: '1.20.4', releaseIdleMemory: true });
    await startAndWait(old.id);
    expect(pauseOf(old.id)).toBeUndefined();
  });
});
