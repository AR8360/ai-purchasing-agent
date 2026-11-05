import type { DecisionState } from '@purchasing/shared';
import type { PoView } from './data.js';
import { mockCall } from './http.js';
import type { ToolContext } from './registry.js';

/**
 * Write tools. They are NOT offered to the LLM, and each one refuses to run outside
 * the state where it is legitimate: orders are placed only while EXECUTING, committed
 * only while VALIDATING, and undone only while RECONCILING.
 */
export class WriteNotAllowedError extends Error {}

function assertState(ctx: ToolContext, op: string, allowed: DecisionState[]) {
  if (!allowed.includes(ctx.decision.state)) {
    throw new WriteNotAllowedError(`${op} is not allowed in state ${ctx.decision.state} (allowed: ${allowed.join(', ')})`);
  }
}

export function createPurchaseOrder(
  ctx: ToolContext,
  a: { sku: string; node: string; supplierId: string; qty: number; expectedInDays?: number; idempotencyKey: string },
) {
  assertState(ctx, 'create_purchase_order', ['EXECUTING']);
  return mockCall<PoView & { idempotentReplay?: boolean }>(ctx, 'POST', '/po', { ...a, decisionId: ctx.decisionId });
}

export function amendPurchaseOrder(ctx: ToolContext, poId: string, qty: number, reason: string) {
  assertState(ctx, 'amend_purchase_order', ['EXECUTING']);
  return mockCall<PoView>(ctx, 'PATCH', `/po/${encodeURIComponent(poId)}`, { qty, reason, decisionId: ctx.decisionId });
}

export function commitAmendment(ctx: ToolContext, poId: string, reason: string) {
  assertState(ctx, 'commit_amendment', ['VALIDATING']);
  return mockCall<PoView>(ctx, 'POST', `/po/${encodeURIComponent(poId)}/commit`, { reason });
}

export function revertAmendment(ctx: ToolContext, poId: string, reason: string) {
  assertState(ctx, 'revert_amendment', ['RECONCILING']);
  return mockCall<PoView>(ctx, 'POST', `/po/${encodeURIComponent(poId)}/revert`, { reason });
}

export function cancelPurchaseOrder(ctx: ToolContext, poId: string, reason: string) {
  assertState(ctx, 'cancel_purchase_order', ['RECONCILING']);
  return mockCall<PoView>(ctx, 'POST', `/po/${encodeURIComponent(poId)}/cancel`, { reason });
}
