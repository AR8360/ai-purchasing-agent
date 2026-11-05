import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { REPO_ROOT, setBaseUrl } from './config.js';
import { registerShortfallHandler } from './events/shortfall.js';
import { mockRouter } from './mock/routes.js';
import { api } from './routes/index.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // In a deployment the built UI is served from the same origin (it calls the API with relative paths).
  const ui = path.join(REPO_ROOT, 'client', 'dist');
  if (fs.existsSync(path.join(ui, 'index.html'))) app.use(express.static(ui));
  app.use('/mock', mockRouter); // the "external systems"
  app.use('/', api); // the agent's own API
  registerShortfallHandler();
  return app;
}

/** Starts the HTTP server and points the agent's tools at it. */
export function listen(port: number) {
  const app = createApp();
  return new Promise<{ server: import('node:http').Server; url: string }>((resolve) => {
    // Local default: loopback only. A host such as Render sets HOST=0.0.0.0.
    const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      setBaseUrl(url);
      resolve({ server, url });
    });
  });
}
