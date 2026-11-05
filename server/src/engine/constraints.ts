/**
 * Constraint resolution: turns a raw need into a quantity that can actually be ordered.
 * Pure function. Order: MOQ and pack rounding first, then the budget and storage caps.
 */

export type ConstraintName = 'MOQ' | 'PACK' | 'BUDGET' | 'STORAGE';

export interface ConstraintInput {
  trueNeed: number;
  moq: number;
  packSize: number;
  unitCost: number;
  budgetRemaining: number;
  /** Free units in the storage zone on the delivery day, before this order lands. */
  storageFreeAtDelivery: number;
}

export interface ConstraintViolation {
  constraint: ConstraintName;
  limit: number;
  requested: number;
  detail: string;
}

export interface ConstraintResult {
  requestedQty: number;
  maxByBudget: number;
  maxByStorage: number;
  feasibleQty: number;
  bindingConstraint: 'NONE' | 'BUDGET' | 'STORAGE';
  constraintsHit: ConstraintName[];
  violations: ConstraintViolation[];
  noFeasibleQty: boolean;
}

export const roundUpToPack = (qty: number, pack: number) => (qty <= 0 ? 0 : Math.ceil(qty / pack) * pack);
export const roundDownToPack = (qty: number, pack: number) => (qty <= 0 ? 0 : Math.floor(qty / pack) * pack);

export function resolveConstraints(c: ConstraintInput): ConstraintResult {
  const constraintsHit: ConstraintName[] = [];
  const violations: ConstraintViolation[] = [];

  // 1. Nothing needed: nothing to order.
  if (c.trueNeed <= 0) {
    return {
      requestedQty: 0,
      maxByBudget: roundDownToPack(c.budgetRemaining / c.unitCost, c.packSize),
      maxByStorage: roundDownToPack(c.storageFreeAtDelivery, c.packSize),
      feasibleQty: 0,
      bindingConstraint: 'NONE',
      constraintsHit,
      violations,
      noFeasibleQty: false,
    };
  }

  // 2. Supplier rules: at least the MOQ, in whole packs.
  if (c.moq > c.trueNeed) constraintsHit.push('MOQ');
  const requestedQty = roundUpToPack(Math.max(c.trueNeed, c.moq), c.packSize);

  // 3. Business caps.
  const maxByBudget = roundDownToPack(c.budgetRemaining / c.unitCost, c.packSize);
  const maxByStorage = roundDownToPack(c.storageFreeAtDelivery, c.packSize);
  const feasibleQty = Math.max(0, Math.min(requestedQty, maxByBudget, maxByStorage));

  let bindingConstraint: ConstraintResult['bindingConstraint'] = 'NONE';
  if (feasibleQty < requestedQty) bindingConstraint = maxByStorage <= maxByBudget ? 'STORAGE' : 'BUDGET';

  if (maxByBudget < requestedQty) {
    constraintsHit.push('BUDGET');
    violations.push({
      constraint: 'BUDGET',
      limit: maxByBudget,
      requested: requestedQty,
      detail: `Remaining budget ${c.budgetRemaining} buys at most ${maxByBudget} units at ${c.unitCost}`,
    });
  }
  if (maxByStorage < requestedQty) {
    constraintsHit.push('STORAGE');
    violations.push({
      constraint: 'STORAGE',
      limit: maxByStorage,
      requested: requestedQty,
      detail: `Storage has room for ${maxByStorage} units on the delivery day`,
    });
  }

  // 4. A cap below the MOQ means no quantity satisfies every rule.
  const noFeasibleQty = feasibleQty < c.moq;
  if (noFeasibleQty) {
    violations.push({
      constraint: 'MOQ',
      limit: c.moq,
      requested: feasibleQty,
      detail: `Largest allowed quantity ${feasibleQty} is below the supplier MOQ ${c.moq}`,
    });
    if (!constraintsHit.includes('MOQ')) constraintsHit.push('MOQ');
  }

  return { requestedQty, maxByBudget, maxByStorage, feasibleQty, bindingConstraint, constraintsHit, violations, noFeasibleQty };
}

/** Free storage for one SKU on a given day: capacity minus other SKUs and other bookings minus our projected stock. */
export function storageFreeAt(args: {
  capacityUnits: number;
  usedUnits: number;
  reservedInboundUnits: number;
  ourOnHand: number;
  ourProjectedStock: number;
}): number {
  const otherSkus = Math.max(0, args.usedUnits - args.ourOnHand);
  return Math.max(0, args.capacityUnits - otherSkus - args.reservedInboundUnits - args.ourProjectedStock);
}
