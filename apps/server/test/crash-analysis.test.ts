import { describe, expect, it } from 'vitest';
import { analyseCrash, type CrashContext } from '../src/servers/crash.js';

const base: Omit<CrashContext, 'lines'> = { oomKilled: false, exitCode: 1, memoryMb: 4096, javaTag: null };
const ESSENTIALS = {
  'com.earth2me.essentials': { name: 'Essentials', file: 'plugins/EssentialsX-2.21.0.jar' },
};

describe('crash helper', () => {
  it('names the plugin whose code threw, and the root error', () => {
    const crash = analyseCrash({
      ...base,
      packages: ESSENTIALS,
      lines: [
        '[10:00:00 INFO]: Done (3.2s)!',
        '[10:05:00 ERROR]: Encountered an unexpected exception',
        'java.lang.RuntimeException: tick failed',
        '\tat net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:1)',
        '\tat com.earth2me.essentials.Essentials.onTick(Essentials.java:42)',
        'Caused by: java.lang.NullPointerException: Cannot invoke "User.getName()"',
      ],
    });
    expect(crash.ruleId).toBe('plugin-error');
    expect(crash.params).toMatchObject({
      plugin: 'Essentials',
      file: 'plugins/EssentialsX-2.21.0.jar',
      error: 'java.lang.NullPointerException: Cannot invoke "User.getName()"',
    });
    expect(crash.excerpt[0]).toContain('ERROR');
  });

  it('spots a plugin built for another version', () => {
    const crash = analyseCrash({
      ...base,
      packages: ESSENTIALS,
      lines: [
        "java.lang.NoSuchMethodError: 'void org.bukkit.Server.x()'",
        '\tat com.earth2me.essentials.Essentials.onEnable(Essentials.java:42)',
      ],
    });
    expect(crash).toMatchObject({ ruleId: 'plugin-incompatible', params: { plugin: 'Essentials' } });
  });

  it('tells a full machine from a full server', () => {
    expect(analyseCrash({ ...base, exitCode: 137, lines: ['[10:00:00 INFO]: Done'] }).ruleId).toBe(
      'host-out-of-memory',
    );
    expect(analyseCrash({ ...base, oomKilled: true, exitCode: 137, lines: [] }).ruleId).toBe('out-of-memory');
    expect(analyseCrash({ ...base, lines: ['java.io.IOException: No space left on device'] }).ruleId).toBe(
      'disk-full',
    );
  });

  it('recognises a frozen server and a broken config', () => {
    expect(
      analyseCrash({ ...base, lines: ['[10:00:00 ERROR]: The server has stopped responding!'] }).ruleId,
    ).toBe('watchdog');
    expect(
      analyseCrash({
        ...base,
        lines: ['org.bukkit.configuration.InvalidConfigurationException: while scanning a simple key'],
      }).ruleId,
    ).toBe('config-broken');
  });

  it('still names the error when nothing else is known', () => {
    const crash = analyseCrash({ ...base, lines: ['java.lang.IllegalStateException: boom'] });
    expect(crash).toMatchObject({
      ruleId: 'unknown-error',
      params: { error: 'java.lang.IllegalStateException: boom' },
    });
  });
});
