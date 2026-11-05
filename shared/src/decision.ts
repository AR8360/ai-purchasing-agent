import { z } from 'zod';
import type { Trigger } from './trigger.js';

/** Lifecycle of one purchasing decision (see docs: state machine). */
export const DECISION_STATES = [
  'RECEIVED',
  'INVESTIGATING',
  'DECIDED',
  'NEEDS_APPROVAL',
  'EXECUTING',
  'VALIDATING',
  'RECONCILING',
  'VALIDATED',
  'ESCALATED',
  'NO_ACTION',
] as const;
export type DecisionState = (typeof DECISION_STATES)[number];
export const TERMINAL_STATES: readonly DecisionState[] = ['VALIDATED', 'ESCALATED', 'NO_ACTION'];
export const isTerminal = (s: DecisionState) => TERMINAL_STATES.includes(s);

export const DecisionKindSchema = z.enum(['ACCEPT', 'MODIFY', 'REJECT', 'INVESTIGATE', 'ESCALATE']);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/** How a decision is carried out. STANDARD = Scenario 1; the rest are Scenario 2 responses. */
export const StrategySchema = z.enum(['STANDARD', 'ACCEPT_PARTIAL', 'SPLIT', 'RESOURCE']);
export type Strategy = z.infer<typeof StrategySchema>;

export const ActionSchema = z.object({
  type: z.enum(['CREATE_PO', 'AMEND_PO']),
  poId: z.string().optional().describe('Required for AMEND_PO'),
  sku: z.string(),
  node: z.string(),
  supplierId: z.string(),
  qty: z.number().int().positive(),
  expectedInDays: z.number().optional().describe('Delivery timing for CREATE_PO, copied from the engine result'),
  reason: z.string(),
});
export type Action = z.infer<typeof ActionSchema>;

/** The final answer the LLM submits through the `submit_decision` tool. */
export const SubmitDecisionSchema = z.object({
  decision: DecisionKindSchema,
  strategy: StrategySchema.optional(),
  quantity: z.number().int().nonnegative().optional(),
  supplierId: z.string().optional(),
  actions: z.array(ActionSchema).describe('Empty for REJECT, INVESTIGATE and ESCALATE'),
  reasoning: z.array(z.string()).min(1).describe('Short factual bullets, each tied to a tool result'),
  constraintsHit: z.array(z.string()),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  missingInformation: z.array(z.string()).optional().describe('Required for INVESTIGATE'),
});
export type SubmittedDecision = z.infer<typeof SubmitDecisionSchema>;

// ---------------------------------------------------------------------------
// Trace records stored on the decision document
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  turn: number;
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  error?: string;
  ms: number;
  at: string;
}

export interface Transition {
  from: DecisionState | null;
  to: DecisionState;
  at: string;
  reason: string;
  expected?: unknown;
  observed?: unknown;
}

export type ActionStatus = 'PENDING' | 'DONE' | 'FAILED' | 'REVERTED';

export interface ActionRecord {
  index: number;
  action: Action;
  attempt: number;
  status: ActionStatus;
  idempotencyKey: string;
  poId?: string;
  /** Snapshot of the PO before an AMEND, used to revert. */
  before?: { qty: number; pendingQty: number | null };
  error?: { code: string; status?: number; message: string; details?: unknown };
  at: string;
}

export interface FieldDiff {
  field: string;
  expected: unknown;
  observed: unknown;
}

export interface ValidationRecord {
  kind: 'PO' | 'OUTCOME';
  actionIndex: number | null;
  ok: boolean;
  diffs: FieldDiff[];
  checks?: { name: string; ok: boolean; detail: string }[];
  at: string;
}

export type ReconcileMove = 'RETRY' | 'ADJUST' | 'COMPENSATE' | 'ESCALATE';

export interface ReconciliationRecord {
  move: ReconcileMove;
  failure: string;
  detail: string;
  /** Index of the action that failed (-1 for whole-decision failures). */
  actionIndex: number;
  at: string;
}

export interface EscalationOption {
  label: string;
  detail: string;
}

export interface Escalation {
  summary: string;
  options: EscalationOption[];
}

/** Deterministic decision computed by the engine; the LLM's submission must match it. */
export interface EngineDecision {
  decision: DecisionKind;
  strategy: Strategy;
  quantity?: number;
  supplierId?: string;
  actions: Action[];
  constraintsHit: string[];
  rule: string;
  summary: string;
  escalation?: Escalation;
  missingInformation?: string[];
  details?: Record<string, unknown>;
  /** Labelled evidence the model must base its reasoning on (numbers are grounded against these). */
  facts?: string[];
}

export interface DecisionDoc {
  decisionId: string;
  trigger: Trigger;
  faults: string[];
  state: DecisionState;
  toolCalls: ToolCallRecord[];
  computed: Record<string, unknown>;
  engine: EngineDecision | null;
  decision: SubmittedDecision | null;
  rejectedSubmissions: { turn: number; problems: string[] }[];
  actions: ActionRecord[];
  validations: ValidationRecord[];
  reconciliations: ReconciliationRecord[];
  transitions: Transition[];
  approval: { required: boolean; reasons: string[]; by?: string; at?: string; outcome?: 'APPROVED' | 'REJECTED' };
  escalation: Escalation | null;
  explanation: string | null;
  llm: { provider: string; model: string; turns: number; cacheHits: number };
  error: string | null;
  /** The SKU/node's purchase orders as this decision left them (snapshot at completion). */
  finalPurchaseOrders?: import('./domain.js').PurchaseOrder[];
  createdAt: string;
  updatedAt: string;
}

/** Faults the mock systems can inject (via the x-fault header). */
export const FAULTS = ['reject_moq', 'budget_exceeded', 'timeout', 'not_found', 'mismatch_qty'] as const;
export type Fault = (typeof FAULTS)[number];
