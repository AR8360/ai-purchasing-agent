import { config } from '../config.js';

export class HttpError extends Error {
  constructor(
    public status: number | undefined,
    public body: any,
    message: string,
  ) {
    super(message);
  }
  get code(): string | undefined {
    return this.body?.code;
  }
}

export interface CallContext {
  decisionId: string;
  faults: string[];
}

/**
 * The agent reaches every external system over HTTP. Fault-injection headers are
 * forwarded so a test can make a specific call fail exactly once per decision.
 */
export async function mockCall<T = any>(ctx: CallContext, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ctx.faults.length) {
    headers['x-fault'] = ctx.faults.join(',');
    headers['x-fault-key'] = ctx.decisionId;
  }
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/mock${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new HttpError(undefined, null, `Network error calling ${method} ${path}: ${(e as Error).message}`);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new HttpError(res.status, json, json?.message ?? `HTTP ${res.status} from ${method} ${path}`);
  return json as T;
}

export const qs = (o: Record<string, string | number | undefined>) =>
  '?' +
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
