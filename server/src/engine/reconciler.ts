import type { ReconcileMove } from '@purchasing/shared';
import { roundUpToPack } from './constraints.js';

/**
 * Feedback-loop policy: when an action's outcome differs from what was expected,
 * choose exactly one of four moves. Pure.
 *
 *   RETRY       transient failure or not-yet-visible write; same request, same idempotency key
 *   ADJUST      the system told us what would work (e.g. new MOQ) or produced a different but
 *               acceptable result; change the action and try once more
 *   COMPENSATE  a later step failed after earlier steps succeeded; undo them to a clean state
 *   ESCALATE    nothing safe left to try; hand a clean state and options to a human
 */

export type FailureKind =
  | 'TRANSIENT' // timeout, 5xx
  | 'NOT_FOUND' // write accepted but read-back cannot see it yet
  | 'MOQ_REJECTED'
  | 'QTY_MISMATCH' // read-back shows a different quantity
  | 'BUDGET_EXCEEDED'
  | 'OUTCOME_FAILED'
  | 'OTHER';

export interface FailureContext {
  kind: FailureKind;
  /** How many times this action has already been retried / adjusted. */
  retries: number;
  adjusts: number;
  /** Whether earlier actions of this decision already succeeded (and would need undoing). */
  completedActions: number;
}

export const MAX_RETRIES = 3;
export const MAX_ADJUSTS = 1;

export function classify(f: FailureContext): ReconcileMove {
  switch (f.kind) {
    case 'TRANSIENT':
    case 'NOT_FOUND':
      if (f.retries < MAX_RETRIES) return 'RETRY';
      break;
    case 'MOQ_REJECTED':
    case 'QTY_MISMATCH':
      if (f.adjusts < MAX_ADJUSTS) return 'ADJUST';
      break;
    default:
      break;
  }
  return f.completedActions > 0 ? 'COMPENSATE' : 'ESCALATE';
}

/** HTTP status / error code from a mock system → failure kind. */
export function failureKindFromHttp(status: number | undefined, code: string | undefined): FailureKind {
  if (code === 'MOQ_NOT_MET') return 'MOQ_REJECTED';
  if (code === 'BUDGET_EXCEEDED') return 'BUDGET_EXCEEDED';
  if (status === 404) return 'NOT_FOUND';
  if (status === undefined || status >= 500) return 'TRANSIENT';
  return 'OTHER';
}

/** ADJUST for an MOQ rejection: smallest valid quantity ≥ what we wanted. */
export function adjustForMoq(qty: number, moq: number, packSize: number) {
  return roundUpToPack(Math.max(qty, moq), packSize);
}

/** Exponential backoff for RETRY, in ms. */
export const backoffMs = (retries: number) => Math.min(4000, 250 * 2 ** retries);
