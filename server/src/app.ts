import express from 'express';
import type { AddressInfo } from 'node:net';
import { setBaseUrl } from './config.js';
import { registerShortfallHandler } from './events/shortfall.js';
import { mockRouter } from './mock/routes.js';
import { api } from './routes/index.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/mock', mockRouter); // the "external systems"
  app.use('/', api); // the agent's own API
  registerShortfallHandler();
  return app;
}

/** Starts the HTTP server and points the agent's tools at it. */
export function listen(port: number) {
  const app = createApp();
  return new Promise<{ server: import('node:http').Server; url: string }>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      setBaseUrl(url);
      resolve({ server, url });
    });
  });
}
