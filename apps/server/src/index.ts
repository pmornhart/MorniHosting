import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env, pkg.version);
  const built = await buildApp({ config });
  await built.start();
  await built.app.listen({ host: config.host, port: config.port });
  built.app.log.info(
    { version: config.version, driver: built.ctx.docker.kind, dataDir: config.dataDir },
    'MorniHosting läuft',
  );

  const shutdown = async (signal: string): Promise<void> => {
    built.app.log.info({ signal }, 'MorniHosting wird beendet; Minecraft-Server laufen weiter');
    try {
      await built.stop();
    } finally {
      process.exit(0);
    }
  };
  // Crash protection for the panel itself: a forgotten promise somewhere (a webhook, a download) is logged
  // instead of taking the whole panel down. Real programming errors still end it; Docker starts it again.
  process.on('unhandledRejection', (reason) => {
    built.app.log.error({ err: reason }, 'unhandled promise rejection (panel keeps running)');
  });
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

try {
  await main();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`\n${err.message}\n\n`);
  } else {
    process.stderr.write(
      `MorniHosting konnte nicht starten: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
  process.exit(1);
}
