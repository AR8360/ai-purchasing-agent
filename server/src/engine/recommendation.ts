import type { EngineDecision, EscalationOption } from '@purchasing/shared';
import type { NeedResult } from './calculator.js';
import type { ConstraintResult } from './constraints.js';
import type { TrustIssue } from './trust.js';

/** Scenario 1 decision rule: review a replenishment recommendation. Pure. */

export const ACCEPT_TOLERANCE = 0.1;

export interface RecommendationInput {
  sku: string;
  node: string;
  supplierId: string;
  recommendedQty: number;
  moq: number;
  packSize: number;
  unitCost: number;
  need: NeedResult;
  constraints: ConstraintResult;
  trustIssues: TrustIssue[];
}

export function decideRecommendation(i: RecommendationInput): EngineDecision {
  const { need, constraints: c, recommendedQty: rec } = i;

  if (i.trustIssues.length > 0) {
    return {
      decision: 'INVESTIGATE',
      strategy: 'STANDARD',
      actions: [],
      constraintsHit: [],
      rule: 'DATA_TRUST',
      summary: `Not acting on untrusted data: ${i.trustIssues.map((t) => t.message).join('; ')}`,
      missingInformation: i.trustIssues.map((t) => t.message),
    };
  }

  if (need.trueNeed <= 0) {
    return {
      decision: 'REJECT',
      strategy: 'STANDARD',
      quantity: 0,
      actions: [],
      constraintsHit: [],
      rule: 'NO_NEED',
      summary: `Stock ${need.projectedPosition} (on hand + incoming) already covers the ${need.coverageNeeded} needed over ${need.horizon} days`,
    };
  }

  if (c.noFeasibleQty) {
    const options: EscalationOption[] = [
      {
        label: `Order the MOQ (${i.moq}) anyway`,
        detail: `Exceeds the ${c.bindingConstraint.toLowerCase()} limit of ${c.feasibleQty} by ${i.moq - c.feasibleQty} units; needs an override`,
      },
      { label: 'Source from a supplier with a lower MOQ', detail: `Need is ${need.trueNeed} units; ${i.supplierId} MOQ is ${i.moq}` },
    ];
    if (need.incomingCounted.length > 0) {
      options.push({
        label: 'Defer and re-review after incoming stock lands',
        detail: `${need.incomingCounted.map((p) => `${p.poId} (${p.qty}) in ${p.inDays}d`).join(', ')} will change the storage picture`,
      });
    }
    return {
      decision: 'ESCALATE',
      strategy: 'STANDARD',
      actions: [],
      constraintsHit: c.constraintsHit,
      rule: 'NO_FEASIBLE_QTY',
      summary: `Need ${need.trueNeed} units, but the largest allowed quantity (${c.feasibleQty}, bound by ${c.bindingConstraint}) is below ${i.supplierId}'s MOQ of ${i.moq}`,
      escalation: {
        summary: `No order quantity satisfies MOQ ${i.moq} and the ${c.bindingConstraint.toLowerCase()} limit ${c.feasibleQty}.`,
        options,
      },
    };
  }

  const recIsValid =
    rec % i.packSize === 0 && rec >= i.moq && rec <= Math.min(c.maxByBudget, c.maxByStorage);
  const closeEnough = Math.abs(c.feasibleQty - rec) / rec <= ACCEPT_TOLERANCE;
  const accept = recIsValid && closeEnough;
  const qty = accept ? rec : c.feasibleQty;

  const why: string[] = [];
  if (need.incomingCounted.length) {
    why.push(`counts incoming ${need.incomingCounted.map((p) => `${p.poId} (${p.qty})`).join(', ')}`);
  }
  if (c.bindingConstraint !== 'NONE') why.push(`${c.bindingConstraint.toLowerCase()} caps the order at ${c.feasibleQty}`);
  if (c.constraintsHit.includes('MOQ')) why.push(`raised to MOQ ${i.moq}`);

  return {
    decision: accept ? 'ACCEPT' : 'MODIFY',
    strategy: 'STANDARD',
    quantity: qty,
    supplierId: i.supplierId,
    actions: [
      {
        type: 'CREATE_PO',
        sku: i.sku,
        node: i.node,
        supplierId: i.supplierId,
        qty,
        reason: accept ? `Recommendation of ${rec} confirmed` : `Recommendation ${rec} changed to ${qty}`,
      },
    ],
    constraintsHit: c.constraintsHit,
    rule: accept ? 'WITHIN_TOLERANCE' : 'RECOMPUTED_QTY',
    summary: accept
      ? `Recommendation of ${rec} is within ${ACCEPT_TOLERANCE * 100}% of the computed feasible quantity ${c.feasibleQty}`
      : `Computed need ${need.trueNeed} (${why.join('; ') || 'recomputed'}) → order ${qty} instead of ${rec}`,
    details: {
      coverageGap: Math.max(0, need.trueNeed - qty),
    },
  };
}
