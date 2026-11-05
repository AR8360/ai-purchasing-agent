import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

export type CacheMode = 'off' | 'record' | 'replay' | 'live';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/purchasing',
  simNow: process.env.SIM_NOW ?? '2026-11-01T00:00:00.000Z',
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'gemini',
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.MODEL ?? '',
    minIntervalMs: Number(process.env.LLM_MIN_INTERVAL_MS ?? 4000),
    thinkingLevel: process.env.LLM_THINKING_LEVEL ?? 'LOW',
    cacheMode: (process.env.LLM_CACHE ?? 'off') as CacheMode,
    requestTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120_000),
  },
  paths: {
    scenarios: path.join(REPO_ROOT, 'eval', 'scenarios'),
    fixtures: path.join(REPO_ROOT, 'eval', 'fixtures'),
    results: path.join(REPO_ROOT, 'eval', 'results'),
  },
  /** Base URL the tools use to reach the mock external systems. Set at listen time. */
  baseUrl: `http://127.0.0.1:${Number(process.env.PORT ?? 4000)}`,
};

export function setBaseUrl(url: string) {
  config.baseUrl = url;
}
