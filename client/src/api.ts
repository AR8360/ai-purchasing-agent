import type { DecisionDoc, DecisionState, PurchaseOrder, Trigger } from '@purchasing/shared';

export interface DecisionSummary {
  decisionId: string;
  trigger: Trigger;
  state: DecisionState;
  faults: string[];
  decision?: { decision?: string; strategy?: string; quantity?: number };
  approval?: { required?: boolean };
  createdAt: string;
}

export type DecisionDetail = DecisionDoc & { purchaseOrders: PurchaseOrder[] };

export interface Variant {
  name: string;
  description: string;
  trigger: Trigger;
  faults: string[];
}

export interface EvalResult {
  name: string;
  variant: string;
  description?: string;
  pass: boolean;
  failures: string[];
  decisionId: string | null;
  finalState: string | null;
  decision: string | null;
  quantity: number | null;
  llmTurns: number;
  cacheHits: number;
  ms: number;
}

export interface EvalReport {
  mode: string;
  model: string;
  startedAt: string;
  passed: number;
  total: number;
  results: EvalResult[];
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(json?.message ?? `HTTP ${r.status}`);
  return json as T;
}

export const api = {
  health: () => req<{ ok: boolean; simNow: string; model: string; llmCache: string }>('GET', '/health'),
  decisions: () => req<DecisionSummary[]>('GET', '/decisions'),
  decision: (id: string) => req<DecisionDetail>('GET', `/decisions/${id}`),
  approve: (id: string) => req<{ decisionId: string }>('POST', `/decisions/${id}/approve`, { by: 'buyer' }),
  reject: (id: string) => req<{ decisionId: string }>('POST', `/decisions/${id}/reject`, { by: 'buyer' }),
  variants: () => req<Variant[]>('GET', '/simulate/variants'),
  runVariant: (variant: string, faults?: string[]) =>
    req<{ decisionId: string }>('POST', '/simulate/run-variant', { variant, ...(faults ? { faults } : {}) }),
  evalResults: () => req<EvalReport | null>('GET', '/eval/results'),
  runEval: () => req<EvalReport>('POST', '/eval/run', { mode: 'replay' }),
};
