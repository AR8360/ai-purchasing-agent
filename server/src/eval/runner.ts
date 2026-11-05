import fs from 'node:fs';
import path from 'node:path';
import type { DecisionDoc, PurchaseOrder, Trigger } from '@purchasing/shared';
import { createLLM } from '../agent/llm.js';
import { CachingLLM, readFixtureManifest, writeFixtureManifest, type CacheMode } from '../agent/llmCache.js';
import { approveDecision, startDecision, useLlm, waitFor } from '../agent/orchestrator.js';
import { config } from '../config.js';
import { resetFaults } from '../mock/fault.js';
import { PurchaseOrderModel } from '../models/index.js';
import { getVariant, seed } from '../seed/seed.js';

/**
 * Evaluation: each case = seed world + trigger + optional faults + expectations.
 * Assertions map to the assignment's questions: right decision, right information,
 * constraints respected, right action, validated, and recovery when an action fails.
 */

export interface EvalExpect {
  decision?: string | null;
  strategy?: string;
  quantity?: number;
  finalState?: string;
  toolsCalledIncludes?: string[];
  constraintsHit?: string[];
  actions?: string[];
  validated?: boolean;
  reconciliationMoves?: string[];
  approvalRequired?: boolean;
  posCreatedByDecision?: number;
  pos?: Record<string, Partial<PurchaseOrder> | null>;
}

export interface EvalCase {
  name: string;
  variant: string;
  description?: string;
  question?: string;
  trigger?: Trigger;
  faults?: string[];
  approve?: boolean;
  expect: EvalExpect;
}

export interface CaseResult {
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
  mode: CacheMode;
  model: string;
  startedAt: string;
  passed: number;
  total: number;
  results: CaseResult[];
}

export function listCases(): EvalCase[] {
  if (!fs.existsSync(config.paths.scenarios)) return [];
  return fs
    .readdirSync(config.paths.scenarios)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(config.paths.scenarios, f), 'utf8')) as EvalCase);
}

export function readLatestResults(): EvalReport | null {
  const f = path.join(config.paths.results, 'latest.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

async function fireTrigger(trigger: Trigger, faults: string[]): Promise<string> {
  if (trigger.type === 'RECOMMENDATION') return (await startDecision(trigger, faults)).decisionId;
  // Scenario 2 enters through the supplier webhook, as in production.
  const r = await fetch(`${config.baseUrl}/mock/events/shortfall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poId: trigger.poId, confirmedQty: trigger.confirmedQty, message: trigger.message, faults }),
  });
  const json = (await r.json()) as any;
  if (!r.ok || !json.decisionId) throw new Error(`Shortfall event failed: ${json.message ?? r.status}`);
  return json.decisionId;
}

export function assertCase(e: EvalExpect, d: DecisionDoc | null, pos: PurchaseOrder[], approvalSeen: boolean): string[] {
  const f: string[] = [];
  if (!d) return ['decision document not found'];
  const eq = (label: string, expected: unknown, actual: unknown) => {
    if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(actual)) {
      f.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  eq('decision', e.decision, d.decision?.decision ?? null);
  eq('strategy', e.strategy, d.decision?.strategy);
  eq('quantity', e.quantity, d.decision?.quantity);
  eq('finalState', e.finalState, d.state);

  if (e.toolsCalledIncludes) {
    const submitTurn = d.toolCalls.findIndex((t) => t.name === 'submit_decision' && (t.output as any)?.accepted);
    const before = new Set(d.toolCalls.slice(0, submitTurn < 0 ? undefined : submitTurn).filter((t) => t.ok).map((t) => t.name));
    const missing = e.toolsCalledIncludes.filter((t) => !before.has(t));
    if (missing.length) f.push(`information: tools not called before deciding: ${missing.join(', ')}`);
  }
  if (e.constraintsHit) {
    const hit = d.engine?.constraintsHit ?? [];
    const missing = e.constraintsHit.filter((c) => !hit.includes(c));
    if (missing.length) f.push(`constraints: expected ${missing.join(', ')} in ${JSON.stringify(hit)}`);
  }
  eq('actions', e.actions, (d.actions.length ? d.actions.map((a) => a.action) : d.engine?.actions ?? []).map((a) => a.type));
  if (e.validated !== undefined) {
    const last = [...d.validations].reverse().find((v) => v.kind === 'OUTCOME');
    const ok = d.state === 'VALIDATED' && !!last?.ok;
    if (ok !== e.validated) f.push(`validated: expected ${e.validated}, got ${ok}`);
  }
  eq('reconciliationMoves', e.reconciliationMoves, d.reconciliations.map((r) => r.move));
  if (e.approvalRequired !== undefined && e.approvalRequired !== (approvalSeen || d.approval.required)) {
    f.push(`approvalRequired: expected ${e.approvalRequired}, got ${approvalSeen || d.approval.required}`);
  }
  if (e.posCreatedByDecision !== undefined) {
    eq('posCreatedByDecision', e.posCreatedByDecision, pos.filter((p) => p.decisionId === d.decisionId).length);
  }
  for (const [poId, exp] of Object.entries(e.pos ?? {})) {
    const po = pos.find((p) => p.poId === poId);
    if (exp === null) {
      if (po) f.push(`${poId}: expected not to exist, found ${po.qty} from ${po.supplierId}`);
      continue;
    }
    if (!po) {
      f.push(`${poId}: expected to exist`);
      continue;
    }
    for (const [k, v] of Object.entries(exp)) eq(`${poId}.${k}`, v, (po as any)[k]);
  }
  return f;
}

export async function runEval(opts: { mode: CacheMode; only?: string; log?: (s: string) => void }): Promise<EvalReport> {
  const log = opts.log ?? (() => undefined);
  const recorded = readFixtureManifest(config.paths.fixtures);
  const meta = opts.mode === 'replay' && recorded ? recorded : { provider: config.llm.provider, model: config.llm.model };
  if (opts.mode !== 'replay') writeFixtureManifest(config.paths.fixtures, meta);
  const llm = new CachingLLM(opts.mode === 'replay' ? null : createLLM(), opts.mode, config.paths.fixtures, meta);
  const restore = useLlm(llm);
  const cases = listCases().filter((c) => !opts.only || c.name === opts.only || c.variant === opts.only);
  const results: CaseResult[] = [];
  try {
    for (const c of cases) {
      const started = Date.now();
      const v = getVariant(c.variant);
      let d: DecisionDoc | null = null;
      let approvalSeen = false;
      const failures: string[] = [];
      try {
        resetFaults();
        await seed(c.variant);
        const id = await fireTrigger(c.trigger ?? v.trigger, c.faults ?? v.faults);
        d = await waitFor(id);
        if (c.approve && d?.state === 'NEEDS_APPROVAL') {
          approvalSeen = true;
          d = await (await approveDecision(id, 'eval')).done;
        }
        const pos = (await PurchaseOrderModel.find({}, { _id: 0 }).lean()) as unknown as PurchaseOrder[];
        failures.push(...assertCase(c.expect, d, pos, approvalSeen));
        if (d?.error) failures.push(`error: ${d.error}`);
      } catch (e) {
        failures.push(`run failed: ${(e as Error).message}`);
      }
      const r: CaseResult = {
        name: c.name,
        variant: c.variant,
        description: c.description,
        pass: failures.length === 0,
        failures,
        decisionId: d?.decisionId ?? null,
        finalState: d?.state ?? null,
        decision: d?.decision?.decision ?? null,
        quantity: d?.decision?.quantity ?? null,
        llmTurns: d?.llm.turns ?? 0,
        cacheHits: d?.llm.cacheHits ?? 0,
        ms: Date.now() - started,
      };
      results.push(r);
      log(`${r.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(28)} ${String(r.finalState).padEnd(14)} ${String(r.decision ?? '-').padEnd(11)} ${String(r.quantity ?? '-').padEnd(5)} turns=${r.llmTurns} cached=${r.cacheHits} ${r.ms}ms${r.pass ? '' : `\n      ${failures.join('\n      ')}`}`);
    }
  } finally {
    restore();
  }
  const report: EvalReport = {
    mode: opts.mode,
    model: meta.model,
    startedAt: new Date().toISOString(),
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  };
  if (!opts.only) {
    fs.mkdirSync(config.paths.results, { recursive: true });
    fs.writeFileSync(path.join(config.paths.results, 'latest.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
