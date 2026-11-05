import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Content } from '@google/genai';
import { responseFromGeminiContent, type LLMClient, type LLMRequest, type LLMResponse } from './llm.js';

/**
 * Record/replay wrapper around any LLMClient.
 *   replay  fixtures only; a miss is an error (deterministic, offline, no quota)
 *   record  use a fixture when present, otherwise call the model and save the response
 *   live    always call the model and overwrite the fixture
 * The key hashes everything that influences the response, so a prompt or tool change
 * produces a miss instead of a silently stale answer.
 */
export type CacheMode = 'replay' | 'record' | 'live';

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export class FixtureMissError extends Error {}

/** Which model the recorded fixtures belong to; replay uses it whatever MODEL says. */
export function readFixtureManifest(dir: string): { provider: string; model: string } | null {
  const f = path.join(dir, '_manifest.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export function writeFixtureManifest(dir: string, meta: { provider: string; model: string }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(meta, null, 2));
}

export class CachingLLM implements LLMClient {
  readonly provider: string;
  readonly model: string;
  hits = 0;
  misses = 0;

  constructor(
    private inner: LLMClient | null,
    private mode: CacheMode,
    private dir: string,
    meta: { provider: string; model: string },
  ) {
    this.provider = meta.provider;
    this.model = meta.model;
    fs.mkdirSync(dir, { recursive: true });
  }

  keyFor(req: LLMRequest) {
    const payload = JSON.stringify(stable({ provider: this.provider, model: this.model, ...req }));
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const key = this.keyFor(req);
    const file = path.join(this.dir, `${key}.json`);
    if (this.mode !== 'live' && fs.existsSync(file)) {
      const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.hits++;
      return { ...responseFromGeminiContent(fx.content as Content, fx.usage), cached: true };
    }
    if (this.mode === 'replay' || !this.inner) {
      this.misses++;
      // Keep the unmatched request so it can be diffed against the recorded ones.
      const missDir = path.join(this.dir, '..', 'results', 'misses');
      fs.mkdirSync(missDir, { recursive: true });
      fs.writeFileSync(path.join(missDir, `${key}.json`), JSON.stringify(stable(req), null, 2));
      throw new FixtureMissError(`No recorded LLM response for request ${key} (run "npm run eval:record" to record it)`);
    }
    const res = await this.inner.generate(req);
    this.misses++;
    if (res.message.role === 'model') {
      fs.writeFileSync(
        file,
        JSON.stringify(
          { key, provider: this.provider, model: this.model, turn: req.messages.length, content: res.message.content, usage: res.usage, request: stable(req) },
          null,
          2,
        ),
      );
    }
    return res;
  }
}
