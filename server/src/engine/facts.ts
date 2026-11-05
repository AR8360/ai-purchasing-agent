import type { NeedResult } from './calculator.js';
import type { ConstraintResult } from './constraints.js';
import type { ShortfallAssessment, ShortfallInput } from './shortfall.js';
import type { TrustIssue } from './trust.js';

/**
 * Evidence facts: short, correctly labelled statements built from the same numbers
 * the engine used. The model writes its reasoning from these, and the guard rejects
 * reasoning that cites a number not found here. Pure.
 */

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pct = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

export interface RecommendationFactsInput {
  sku: string;
  node: string;
  supplierId: string;
  recommendedQty: number;
  onHand: number;
  dailyMean: number;
  dailyStdDev: number;
  leadTimeDays: number;
  moq: number;
  packSize: number;
  unitCost: number;
  budgetRemaining: number;
  budget?: { total: number; reserved: number; spent: number };
  deliveryDay: number;
  storageFreeAtDelivery: number;
  storage?: { capacityUnits: number; usedUnits: number; reservedInboundUnits: number };
  stockAtDelivery?: number;
  need: NeedResult;
  constraints: ConstraintResult;
  trustIssues: TrustIssue[];
}

export function recommendationFacts(i: RecommendationFactsInput): string[] {
  const n = i.need;
  const c = i.constraints;
  const f: string[] = [
    `Recommendation under review: ${i.recommendedQty} units of ${i.sku} at ${i.node} from ${i.supplierId}.`,
  ];
  for (const t of i.trustIssues) f.push(`Data problem: ${t.message}.`);
  f.push(
    `On hand ${i.onHand} units; forecast demand ${i.dailyMean} units/day (standard deviation ${i.dailyStdDev}).`,
    `Planning horizon ${n.horizon} days (lead time ${i.leadTimeDays} + review ${n.reviewPeriodDays}): coverage needed ${n.coverageNeeded} = ${n.demandOverHorizon} demand + ${n.safetyStock} safety stock.`,
  );
  for (const p of n.incomingCounted) f.push(`Open ${p.poId} brings ${p.qty} units in ${p.inDays} days (counted as incoming).`);
  for (const p of n.incomingIgnored) f.push(`Open ${p.poId} (${p.qty} units) lands after the horizon (not counted).`);
  f.push(`Projected position ${n.projectedPosition} (on hand + incoming), so the true need is ${n.trueNeed} units.`);
  if (n.trueNeed > 0) {
    f.push(
      `${i.supplierId} terms: MOQ ${i.moq}, pack ${i.packSize}, ${inr(i.unitCost)}/unit, so the orderable quantity is ${c.requestedQty}.`,
      `Budget remaining ${inr(i.budgetRemaining)}${i.budget ? ` (total ${inr(i.budget.total)}, already reserved ${inr(i.budget.reserved)}, spent ${inr(i.budget.spent)})` : ''} allows at most ${c.maxByBudget} units.`,
      `Storage on delivery day ${i.deliveryDay} has ${i.storageFreeAtDelivery} units free${i.storage ? ` (capacity ${i.storage.capacityUnits}, ${i.storage.reservedInboundUnits} booked for other deliveries${i.stockAtDelivery !== undefined ? `, our projected stock ${i.stockAtDelivery}` : ''})` : ''}, allowing at most ${c.maxByStorage} units in whole packs.`,
      c.noFeasibleQty
        ? `No quantity works: the largest allowed (${c.feasibleQty}) is below the MOQ ${i.moq}.`
        : `Feasible order: ${c.feasibleQty} units${c.bindingConstraint !== 'NONE' ? `, limited by ${c.bindingConstraint.toLowerCase()}` : ''}.`,
    );
    if (!c.noFeasibleQty && c.feasibleQty < n.trueNeed) {
      f.push(`${n.trueNeed - c.feasibleQty} units of need stay uncovered and should be re-reviewed after incoming stock lands.`);
    }
  }
  return f;
}

export function shortfallFacts(i: ShortfallInput, a: ShortfallAssessment): string[] {
  const released = a.shortfallQty * i.po.unitCost;
  const f: string[] = [
    `${i.po.poId}: ${i.po.qty} units ordered from ${i.po.supplierId} at ${inr(i.po.unitCost)}/unit, due in ${i.po.inDays} days; the supplier confirms only ${i.po.confirmedQty}, so ${a.shortfallQty} units are short.`,
    `${i.sku} at ${i.node}: ${i.onHand} units on hand, demand ${i.dailyMean} units/day.`,
    `With only ${i.po.confirmedQty} arriving, the need over ${a.need.horizon} days is ${a.need.trueNeed} units and stock runs out on day ${a.stockoutDay}.`,
    `Budget: ${inr(i.budgetRemaining)} remaining now; amending ${i.po.poId} to ${i.po.confirmedQty} releases ${inr(released)}, so ${inr(a.budgetAfterAmend)} is available for a replacement order.`,
  ];
  for (const c of a.candidates) {
    const who = c.kind === 'BACKFILL' ? `${c.supplierId} backfill` : `${c.name ?? c.supplierId}`;
    const timing = c.beforeStockout ? `before the day-${a.stockoutDay} stockout` : `after the day-${a.stockoutDay} stockout`;
    const money = c.budgetOk ? `fits the ${inr(a.budgetAfterAmend)} available` : `exceeds the ${inr(a.budgetAfterAmend)} available`;
    f.push(
      `${who}: ${c.qty} units (MOQ ${c.moq}) at ${inr(c.unitCost)}/unit = ${inr(c.totalCost)} (${pct(c.costDelta)} vs ${i.po.supplierId}), arrives day ${c.arrivalDays} (${timing}), on-time ${Math.round(c.onTimeRate * 100)}%, ${money}${c.storageOk ? '' : ', does not fit storage'}${c.score !== undefined ? `, score ${c.score}` : ''}.`,
    );
  }
  return f;
}
