import { defineConfig } from '@playwright/test';
import net from 'node:net';

// Pick a free port once in the main process; workers inherit it through the environment.
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const port = Number(process.env.E2E_PORT) || await freePort();
process.env.E2E_PORT = String(port);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: 'node e2e/mock-server.js',
    url: `http://127.0.0.1:${port}/`,
    env: { PORT: String(port), MOCK_TEST: '1', MOCK_SEED: '1' },
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
