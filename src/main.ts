import { loadConfig, assertOrdinaryUser, checkWorkspace } from './config.js';
import { Store } from './store.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  assertOrdinaryUser();
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error('Usage: node dist/main.js <config.json>');
  const config = await loadConfig(path);
  await checkWorkspace(config);
  const store = new Store(config.stateDir);
  try {
    const { app } = createApp(config, store);
    const server = app.listen(config.listenPort, '127.0.0.1', () => {
      console.log(`milanoreal-mcp listening on 127.0.0.1:${config.listenPort} (persistent VPS tools)`);
    });
    const timer = setInterval(() => {
      try { store.cleanup(Math.floor(Date.now() / 1000)); }
      catch { console.error('State cleanup failed; will retry on the next interval'); }
    }, 60_000);
    timer.unref();
    server.on('error', () => { console.error('HTTP listener failed'); clearInterval(timer); store.close(); process.exitCode = 1; });
    const stop = () => {
      clearInterval(timer);
      server.close(() => { store.close(); });
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { store.close(); throw error; }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
