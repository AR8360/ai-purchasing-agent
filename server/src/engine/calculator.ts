/**
 * Replenishment need calculation. Pure: no I/O, no clock, no LLM.
 *
 * Order of operations (never circular):
 *   1. horizon = effective lead time + review period
 *   2. incoming = open POs (effective qty) that land within the horizon
 *   3. projected position = on hand + incoming
 *   4. true need = coverage needed - projected position (floored at 0)
 *   5. stockout day is simulated separately, day by day with arrivals, for risk only.
 */

export const DAY_MS = 86_400_000;

export interface OpenPo {
  poId: string;
  qty: number;
  /** Days from now until the PO is expected to land. */
  inDays: number;
}

export interface NeedInput {
  onHand: number;
  dailyMean: number;
  dailyStdDev: number;
  leadTimeDays: number;
  avgLeadDelta?: number;
  reviewPeriodDays?: number;
  /** Service-level z-score; 1.65 ≈ 95%. */
  z?: number;
  openPos: OpenPo[];
}

export interface NeedResult {
  reviewPeriodDays: number;
  effectiveLeadTime: number;
  horizon: number;
  demandOverHorizon: number;
  safetyStock: number;
  coverageNeeded: number;
  incomingInWindow: number;
  incomingCounted: OpenPo[];
  incomingIgnored: OpenPo[];
  projectedPosition: number;
  trueNeed: number;
  daysOfCoverOnHand: number;
  /** Days until stock runs out given current stock and incoming POs (null = never within simulation). */
  daysToStockout: number | null;
}

export const DEFAULT_REVIEW_PERIOD_DAYS = 7;
export const DEFAULT_Z = 1.65;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function safetyStockFor(z: number, dailyStdDev: number, effectiveLeadTime: number) {
  return Math.round(z * dailyStdDev * Math.sqrt(Math.max(effectiveLeadTime, 0)));
}

export function computeNeed(input: NeedInput): NeedResult {
  const reviewPeriodDays = input.reviewPeriodDays ?? DEFAULT_REVIEW_PERIOD_DAYS;
  const z = input.z ?? DEFAULT_Z;
  const effectiveLeadTime = input.leadTimeDays + (input.avgLeadDelta ?? 0);
  const horizon = effectiveLeadTime + reviewPeriodDays;

  const demandOverHorizon = Math.round(input.dailyMean * horizon);
  const safetyStock = safetyStockFor(z, input.dailyStdDev, effectiveLeadTime);
  const coverageNeeded = demandOverHorizon + safetyStock;

  const incomingCounted = input.openPos.filter((p) => p.inDays <= horizon);
  const incomingIgnored = input.openPos.filter((p) => p.inDays > horizon);
  const incomingInWindow = incomingCounted.reduce((s, p) => s + p.qty, 0);

  const projectedPosition = input.onHand + incomingInWindow;
  const trueNeed = Math.max(0, coverageNeeded - projectedPosition);

  return {
    reviewPeriodDays,
    effectiveLeadTime,
    horizon,
    demandOverHorizon,
    safetyStock,
    coverageNeeded,
    incomingInWindow,
    incomingCounted,
    incomingIgnored,
    projectedPosition,
    trueNeed,
    daysOfCoverOnHand: input.dailyMean > 0 ? round2(input.onHand / input.dailyMean) : Infinity,
    daysToStockout: simulateStockout(input.onHand, input.dailyMean, input.openPos),
  };
}

/** Continuous depletion with step arrivals; returns the first day stock hits zero. */
export function simulateStockout(onHand: number, dailyMean: number, openPos: OpenPo[]): number | null {
  if (dailyMean <= 0) return null;
  const arrivals = [...openPos].filter((p) => p.qty > 0).sort((a, b) => a.inDays - b.inDays);
  let stock = onHand;
  let t = 0;
  for (const a of arrivals) {
    const at = Math.max(a.inDays, t);
    if (stock - dailyMean * (at - t) < 0) return round2(t + stock / dailyMean);
    stock -= dailyMean * (at - t);
    t = at;
    stock += a.qty;
  }
  return round2(t + stock / dailyMean);
}

/** Projected stock of this SKU at a future day (before anything ordered now arrives). */
export function projectedStockAt(day: number, onHand: number, dailyMean: number, openPos: OpenPo[]): number {
  // Stock cannot go negative: a stockout means lost sales, not negative inventory.
  const arrivals = [...openPos].filter((p) => p.inDays <= day).sort((a, b) => a.inDays - b.inDays);
  let stock = onHand;
  let t = 0;
  for (const a of arrivals) {
    stock = Math.max(0, stock - dailyMean * (a.inDays - t)) + a.qty;
    t = a.inDays;
  }
  stock = Math.max(0, stock - dailyMean * (day - t));
  return Math.round(stock);
}
