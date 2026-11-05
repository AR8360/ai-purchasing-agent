import crypto from 'node:crypto';
import type { DecisionDoc, Trigger } from '@purchasing/shared';
import { clock } from '../clock.js';
import { DecisionModel } from '../models/index.js';
import type { LLMClient } from './llm.js';

export function newDecision(trigger: Trigger, faults: string[], llm: Pick<LLMClient, 'provider' | 'model'>): DecisionDoc {
  const at = clock.wallIso();
  return {
    decisionId: `DEC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    trigger,
    faults,
    state: 'RECEIVED',
    toolCalls: [],
    computed: {},
    engine: null,
    decision: null,
    rejectedSubmissions: [],
    actions: [],
    validations: [],
    reconciliations: [],
    transitions: [{ from: null, to: 'RECEIVED', at, reason: `${trigger.type} received` }],
    approval: { required: false, reasons: [] },
    escalation: null,
    explanation: null,
    llm: { provider: llm.provider, model: llm.model, turns: 0, cacheHits: 0 },
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Every step is written before the next one runs: if the process dies, the trace shows where. */
export async function persist(d: DecisionDoc) {
  d.updatedAt = clock.wallIso();
  await DecisionModel.replaceOne({ decisionId: d.decisionId }, JSON.parse(JSON.stringify(d)), { upsert: true });
}

export async function loadDecision(decisionId: string): Promise<DecisionDoc | null> {
  const doc = await DecisionModel.findOne({ decisionId }, { _id: 0 }).lean();
  return (doc as unknown as DecisionDoc) ?? null;
}
