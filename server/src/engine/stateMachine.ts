import type { DecisionState, Transition } from '@purchasing/shared';

/** Allowed transitions. Anything else is a bug and throws. */
export const ALLOWED: Record<DecisionState, DecisionState[]> = {
  RECEIVED: ['INVESTIGATING'],
  INVESTIGATING: ['DECIDED', 'ESCALATED'],
  DECIDED: ['NO_ACTION', 'NEEDS_APPROVAL', 'EXECUTING', 'ESCALATED'],
  NEEDS_APPROVAL: ['EXECUTING', 'NO_ACTION'],
  EXECUTING: ['VALIDATING', 'RECONCILING'],
  VALIDATING: ['VALIDATED', 'RECONCILING'],
  RECONCILING: ['EXECUTING', 'DECIDED', 'NEEDS_APPROVAL', 'ESCALATED'],
  VALIDATED: [],
  ESCALATED: [],
  NO_ACTION: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public from: DecisionState,
    public to: DecisionState,
  ) {
    super(`Illegal state transition ${from} → ${to}`);
  }
}

export function canTransition(from: DecisionState, to: DecisionState) {
  return ALLOWED[from].includes(to);
}

/** Mutates the decision: validates the move and appends it to the transition log. */
export function transition(
  d: { state: DecisionState; transitions: Transition[] },
  to: DecisionState,
  meta: { at: string; reason: string; expected?: unknown; observed?: unknown },
) {
  if (!canTransition(d.state, to)) throw new IllegalTransitionError(d.state, to);
  d.transitions.push({ from: d.state, to, ...meta });
  d.state = to;
}
