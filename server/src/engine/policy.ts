import type { Action, DecisionKind, Strategy } from '@purchasing/shared';

/**
 * Human-approval policy, kept as data. Each rule is evaluated against the
 * proposed decision; any rule that fires routes the decision to NEEDS_APPROVAL.
 */
export const POLICY_LIMITS = {
  /** Auto-execute only POs up to this value (₹). */
  maxAutoPoValue: 100_000,
  /** Ordering MORE than recommended by over this fraction needs a human. Buying less is auto. */
  maxUpwardDeviation: 0.2,
  /** Switching to an alternate supplier is auto only up to this cost premium. */
  maxSupplierCostPremium: 0.1,
  /** After a failure, an ADJUST may re-execute automatically if it grows the order by at most this fraction. */
  maxAutoAdjustGrowth: 0.2,
} as const;

export interface PolicyContext {
  decision: DecisionKind;
  strategy: Strategy;
  actions: Action[];
  /** Scenario 1 only: the quantity the replenishment system recommended. */
  recommendedQty?: number;
  /** Supplier on the original PO / recommendation. */
  originalSupplierId?: string;
  unitCostBySupplier: Record<string, number>;
  originalUnitCost?: number;
  /** True when the decision is being re-executed after a failed attempt. */
  afterFailure?: { move: 'ADJUST' | 'OTHER'; growth: number };
}

export interface PolicyRule {
  id: string;
  description: string;
  fires: (c: PolicyContext) => string | null;
}

export const POLICY_RULES: PolicyRule[] = [
  {
    id: 'PO_VALUE',
    description: `Any new PO above ₹${POLICY_LIMITS.maxAutoPoValue.toLocaleString('en-IN')} needs approval`,
    fires: (c) => {
      const big = c.actions.find(
        (a) => a.type === 'CREATE_PO' && a.qty * (c.unitCostBySupplier[a.supplierId] ?? 0) > POLICY_LIMITS.maxAutoPoValue,
      );
      return big ? `PO value ₹${big.qty * (c.unitCostBySupplier[big.supplierId] ?? 0)} exceeds the auto limit` : null;
    },
  },
  {
    id: 'UPWARD_DEVIATION',
    description: `Ordering more than ${POLICY_LIMITS.maxUpwardDeviation * 100}% above the recommendation needs approval`,
    fires: (c) => {
      if (c.decision !== 'MODIFY' || c.strategy !== 'STANDARD' || !c.recommendedQty) return null;
      const qty = c.actions.find((a) => a.type === 'CREATE_PO')?.qty ?? 0;
      const up = (qty - c.recommendedQty) / c.recommendedQty;
      return up > POLICY_LIMITS.maxUpwardDeviation
        ? `Quantity ${qty} is ${Math.round(up * 100)}% above the recommended ${c.recommendedQty}`
        : null;
    },
  },
  {
    id: 'SUPPLIER_SWITCH_PREMIUM',
    description: `Switching supplier at more than ${POLICY_LIMITS.maxSupplierCostPremium * 100}% cost premium needs approval`,
    fires: (c) => {
      if (!c.originalSupplierId || !c.originalUnitCost) return null;
      const sw = c.actions.find((a) => a.type === 'CREATE_PO' && a.supplierId !== c.originalSupplierId);
      if (!sw) return null;
      const premium = ((c.unitCostBySupplier[sw.supplierId] ?? 0) - c.originalUnitCost) / c.originalUnitCost;
      return premium > POLICY_LIMITS.maxSupplierCostPremium
        ? `Switching to ${sw.supplierId} costs ${Math.round(premium * 100)}% more`
        : null;
    },
  },
  {
    id: 'AFTER_FAILURE',
    description: `Re-executing after a failure needs approval unless it is an ADJUST growing the order by ≤${POLICY_LIMITS.maxAutoAdjustGrowth * 100}%`,
    fires: (c) => {
      if (!c.afterFailure) return null;
      if (c.afterFailure.move === 'ADJUST' && c.afterFailure.growth <= POLICY_LIMITS.maxAutoAdjustGrowth) return null;
      return `Re-execution after a failure (${c.afterFailure.move}, +${Math.round(c.afterFailure.growth * 100)}%)`;
    },
  },
];

export function requiresApproval(c: PolicyContext): { required: boolean; reasons: string[] } {
  // No money moves for these: never gate them.
  if (c.decision === 'REJECT' || c.decision === 'INVESTIGATE' || c.decision === 'ESCALATE' || c.actions.length === 0) {
    return { required: false, reasons: [] };
  }
  const reasons = POLICY_RULES.map((r) => r.fires(c)).filter((x): x is string => !!x);
  return { required: reasons.length > 0, reasons };
}
