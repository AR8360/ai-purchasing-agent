import { describe, expect, it } from 'vitest';
import { computeNeed, projectedStockAt, simulateStockout } from './calculator.js';
import { resolveConstraints, roundDownToPack, roundUpToPack, storageFreeAt } from './constraints.js';
import { checkDataTrust } from './trust.js';
import { requiresApproval } from './policy.js';
import { decideRecommendation } from './recommendation.js';
import { assessShortfall, type ShortfallInput, type TermsLite } from './shortfall.js';
import { rankSuppliers, weightsFor } from './supplierScore.js';
import { ALLOWED, IllegalTransitionError, transition } from './stateMachine.js';
import { validatePo } from './validator.js';
import { adjustForMoq, classify, failureKindFromHttp } from './reconciler.js';
import { checkSubmission } from './guard.js';
import type { DecisionState, Transition } from '@purchasing/shared';

// ----- Scenario 1 world (mirrors seed/data/base.json) ------------------------------
const S1 = {
  onHand: 150,
  dailyMean: 60,
  dailyStdDev: 10,
  leadTimeDays: 7,
  openPos: [{ poId: 'PO-1041', qty: 400, inDays: 2 }],
  moq: 200,
  packSize: 50,
  unitCost: 240,
  budgetRemaining: 100_000,
  storage: { capacityUnits: 650, usedUnits: 150, reservedInboundUnits: 240 },
};

function s1Decision(overrides: Partial<typeof S1> & { rec: number; forecastAgeHours?: number }) {
  const w = { ...S1, ...overrides };
  const need = computeNeed({ ...w, openPos: w.openPos });
  const stockAtDelivery = projectedStockAt(w.leadTimeDays, w.onHand, w.dailyMean, w.openPos);
  const storageFree = storageFreeAt({ ...w.storage, ourOnHand: w.onHand, ourProjectedStock: stockAtDelivery });
  const constraints = resolveConstraints({
    trueNeed: need.trueNeed,
    moq: w.moq,
    packSize: w.packSize,
    unitCost: w.unitCost,
    budgetRemaining: w.budgetRemaining,
    storageFreeAtDelivery: storageFree,
  });
  const trustIssues = checkDataTrust({
    forecastAgeHours: overrides.forecastAgeHours ?? 6,
    onHand: w.onHand,
    openPos: [{ poId: 'PO-1041', expectedDate: '2026-11-03T00:00:00.000Z' }],
    hasTerms: true,
  });
  const engine = decideRecommendation({
    sku: 'BUTTER-500',
    node: 'BLR-01',
    supplierId: 'DAIRYCO',
    recommendedQty: w.rec,
    moq: w.moq,
    packSize: w.packSize,
    unitCost: w.unitCost,
    need,
    constraints,
    trustIssues,
  });
  return { need, constraints, engine, storageFree };
}

describe('calculator', () => {
  it('reproduces the Scenario 1 case B need', () => {
    const need = computeNeed(S1);
    expect(need.horizon).toBe(14);
    expect(need.demandOverHorizon).toBe(840);
    expect(need.safetyStock).toBe(44);
    expect(need.coverageNeeded).toBe(884);
    expect(need.incomingInWindow).toBe(400);
    expect(need.projectedPosition).toBe(550);
    expect(need.trueNeed).toBe(334);
  });

  it('ignores open POs that land after the horizon', () => {
    const need = computeNeed({ ...S1, openPos: [{ poId: 'LATE', qty: 999, inDays: 30 }] });
    expect(need.incomingInWindow).toBe(0);
    expect(need.incomingIgnored).toHaveLength(1);
  });

  it('simulates stockout with arrivals', () => {
    expect(simulateStockout(150, 60, [])).toBe(2.5);
    expect(simulateStockout(150, 60, [{ poId: 'X', qty: 400, inDays: 2 }])).toBe(9.17);
    expect(simulateStockout(420, 60, [{ poId: 'X', qty: 250, inDays: 6 }])).toBe(11.17);
  });

  it('projects stock without going negative', () => {
    expect(projectedStockAt(7, 150, 60, S1.openPos)).toBe(130);
    expect(projectedStockAt(10, 100, 60, [])).toBe(0);
  });
});

describe('constraints', () => {
  it('rounds to packs', () => {
    expect(roundUpToPack(334, 50)).toBe(350);
    expect(roundDownToPack(416.67, 50)).toBe(400);
    expect(roundUpToPack(0, 50)).toBe(0);
  });

  it('computes storage free on the delivery day', () => {
    expect(storageFreeAt({ ...S1.storage, ourOnHand: 150, ourProjectedStock: 130 })).toBe(280);
  });

  it('case B: storage is the binding constraint', () => {
    const { constraints } = s1Decision({ rec: 800 });
    expect(constraints).toMatchObject({
      requestedQty: 350,
      maxByBudget: 400,
      maxByStorage: 250,
      feasibleQty: 250,
      bindingConstraint: 'STORAGE',
      constraintsHit: ['STORAGE'],
      noFeasibleQty: false,
    });
  });
});

describe('Scenario 1 decisions', () => {
  it('A: ACCEPT a recommendation that matches the computed need', () => {
    const { engine } = s1Decision({ rec: 350, storage: { capacityUnits: 650, usedUnits: 150, reservedInboundUnits: 0 } });
    expect(engine.decision).toBe('ACCEPT');
    expect(engine.quantity).toBe(350);
    expect(engine.constraintsHit).toEqual([]);
  });

  it('B: MODIFY 800 → 250 (open PO counted, storage binds)', () => {
    const { engine } = s1Decision({ rec: 800 });
    expect(engine.decision).toBe('MODIFY');
    expect(engine.quantity).toBe(250);
    expect(engine.actions).toEqual([expect.objectContaining({ type: 'CREATE_PO', supplierId: 'DAIRYCO', qty: 250 })]);
    expect(engine.details?.coverageGap).toBe(84);
  });

  it('C: ESCALATE when MOQ is above every allowed quantity', () => {
    const { engine, constraints } = s1Decision({ rec: 800, moq: 300 });
    expect(constraints.noFeasibleQty).toBe(true);
    expect(engine.decision).toBe('ESCALATE');
    expect(engine.actions).toEqual([]);
    expect(engine.escalation?.options.length).toBeGreaterThanOrEqual(2);
  });

  it('D: INVESTIGATE on a stale forecast', () => {
    const { engine } = s1Decision({ rec: 800, forecastAgeHours: 72 });
    expect(engine.decision).toBe('INVESTIGATE');
    expect(engine.missingInformation?.[0]).toMatch(/72h old/);
  });

  it('REJECT when stock already covers demand', () => {
    const { engine } = s1Decision({ rec: 300, onHand: 900, storage: { capacityUnits: 2000, usedUnits: 900, reservedInboundUnits: 0 } });
    expect(engine.decision).toBe('REJECT');
    expect(engine.actions).toEqual([]);
  });
});

describe('policy', () => {
  const base = { unitCostBySupplier: { DAIRYCO: 240, FRESHFARMS: 252 }, strategy: 'STANDARD' as const };
  const create = (qty: number, supplierId = 'DAIRYCO') => ({ type: 'CREATE_PO' as const, sku: 'S', node: 'N', supplierId, qty, reason: '' });

  it('buying less than recommended is automatic', () => {
    expect(requiresApproval({ ...base, decision: 'MODIFY', actions: [create(250)], recommendedQty: 800 }).required).toBe(false);
  });
  it('buying 75% more than recommended needs approval (case E)', () => {
    const r = requiresApproval({ ...base, decision: 'MODIFY', actions: [create(350)], recommendedQty: 200 });
    expect(r.required).toBe(true);
    expect(r.reasons[0]).toMatch(/75% above/);
  });
  it('large POs need approval', () => {
    expect(requiresApproval({ ...base, decision: 'ACCEPT', actions: [create(450)], recommendedQty: 450 }).required).toBe(true);
  });
  it('a small ADJUST after failure is automatic, a big one is not', () => {
    const c = { ...base, decision: 'MODIFY' as const, strategy: 'RESOURCE' as const, actions: [create(300, 'FRESHFARMS')] };
    expect(requiresApproval({ ...c, afterFailure: { move: 'ADJUST', growth: 0.2 } }).required).toBe(false);
    expect(requiresApproval({ ...c, afterFailure: { move: 'ADJUST', growth: 0.6 } }).required).toBe(true);
  });
  it('never gates decisions that move no money', () => {
    expect(requiresApproval({ ...base, decision: 'ESCALATE', actions: [] }).required).toBe(false);
  });
});

// ----- Scenario 2 world (mirrors seed variants s2-*) --------------------------------
const terms = (o: Partial<Record<string, Partial<TermsLite>>> = {}): TermsLite[] => [
  { supplierId: 'DAIRYCO', leadTimeDays: 7, moq: 200, packSize: 50, unitCost: 240, backfillLeadDays: 14, onTimeRate: 0.85, avgLeadDelta: 0, ...o.DAIRYCO },
  { supplierId: 'FRESHFARMS', leadTimeDays: 3, moq: 200, packSize: 50, unitCost: 252, backfillLeadDays: 3, onTimeRate: 0.95, avgLeadDelta: 0, ...o.FRESHFARMS },
  { supplierId: 'BUTTERHOUSE', leadTimeDays: 2, moq: 500, packSize: 50, unitCost: 300, backfillLeadDays: 2, onTimeRate: 0.7, avgLeadDelta: 0, ...o.BUTTERHOUSE },
];
const s2 = (o: Partial<ShortfallInput> = {}): ShortfallInput => ({
  sku: 'BUTTER-500',
  node: 'BLR-01',
  category: 'dairy',
  po: { poId: 'PO-2001', supplierId: 'DAIRYCO', qty: 500, confirmedQty: 250, unitCost: 240, inDays: 6 },
  onHand: 420,
  dailyMean: 60,
  dailyStdDev: 10,
  otherOpenPos: [],
  terms: terms(),
  budgetRemaining: 30_000,
  storage: { capacityUnits: 1200, usedUnits: 420, reservedInboundUnits: 0 },
  ...o,
});

describe('Scenario 2 decisions', () => {
  it('A: ACCEPT_PARTIAL when the shortfall does not matter', () => {
    const r = assessShortfall(s2({ onHand: 700, storage: { capacityUnits: 1200, usedUnits: 700, reservedInboundUnits: 0 } }));
    expect(r.engine).toMatchObject({ decision: 'ACCEPT', strategy: 'ACCEPT_PARTIAL' });
    expect(r.engine.actions).toEqual([expect.objectContaining({ type: 'AMEND_PO', poId: 'PO-2001', qty: 250 })]);
  });

  it('B: SPLIT when the same supplier can backfill before stockout', () => {
    const r = assessShortfall(s2({ terms: terms({ DAIRYCO: { backfillLeadDays: 9 } }) }));
    expect(r.stockoutDay).toBe(11.17);
    expect(r.engine).toMatchObject({ decision: 'MODIFY', strategy: 'SPLIT' });
    expect(r.engine.actions.map((a) => [a.type, a.supplierId, a.qty])).toEqual([
      ['AMEND_PO', 'DAIRYCO', 250],
      ['CREATE_PO', 'DAIRYCO', 250],
    ]);
  });

  it('C: RESOURCE to FreshFarms when backfill is too late', () => {
    const r = assessShortfall(s2());
    expect(r.budgetAfterAmend).toBe(90_000);
    expect(r.engine).toMatchObject({ decision: 'MODIFY', strategy: 'RESOURCE', supplierId: 'FRESHFARMS', quantity: 250 });
    expect(r.engine.actions[1]).toMatchObject({ type: 'CREATE_PO', supplierId: 'FRESHFARMS', qty: 250, expectedInDays: 3 });
  });

  it('D: ESCALATE with priced options when alternates are too expensive', () => {
    const r = assessShortfall(s2({ terms: terms({ FRESHFARMS: { unitCost: 336 } }) }));
    expect(r.engine.decision).toBe('ESCALATE');
    expect(r.engine.actions).toEqual([]);
    expect(r.engine.escalation?.options.some((o) => /FRESHFARMS|FreshFarms/i.test(o.label))).toBe(true);
  });

  it('ranks FreshFarms above ButterHouse for dairy', () => {
    const ranked = rankSuppliers(
      [
        { supplierId: 'FRESHFARMS', costDelta: 0.05, arrivalDays: 3, onTimeRate: 0.95, qty: 250, neededQty: 250 },
        { supplierId: 'BUTTERHOUSE', costDelta: 0.25, arrivalDays: 2, onTimeRate: 0.7, qty: 500, neededQty: 250 },
      ],
      11.17,
      weightsFor('dairy'),
    );
    expect(ranked[0]!.candidate.supplierId).toBe('FRESHFARMS');
  });
});

describe('state machine', () => {
  const doc = (state: DecisionState) => ({ state, transitions: [] as Transition[] });
  it('allows the happy path and logs every move', () => {
    const d = doc('RECEIVED');
    for (const s of ['INVESTIGATING', 'DECIDED', 'EXECUTING', 'VALIDATING', 'VALIDATED'] as DecisionState[]) {
      transition(d, s, { at: 't', reason: 'x' });
    }
    expect(d.state).toBe('VALIDATED');
    expect(d.transitions.map((t) => t.to)).toEqual(['INVESTIGATING', 'DECIDED', 'EXECUTING', 'VALIDATING', 'VALIDATED']);
  });
  it('rejects illegal moves', () => {
    expect(() => transition(doc('INVESTIGATING'), 'EXECUTING', { at: 't', reason: 'x' })).toThrow(IllegalTransitionError);
    expect(() => transition(doc('VALIDATED'), 'EXECUTING', { at: 't', reason: 'x' })).toThrow(IllegalTransitionError);
  });
  it('lets reconciliation route to approval or escalation', () => {
    expect(ALLOWED.RECONCILING).toEqual(expect.arrayContaining(['EXECUTING', 'NEEDS_APPROVAL', 'ESCALATED']));
  });
});

describe('validator', () => {
  const po = { poId: 'PO-1042', supplierId: 'DAIRYCO', qty: 250, pendingQty: null, unitCost: 240, totalCost: 60000, status: 'CREATED' };
  it('passes a matching read-back', () => {
    expect(validatePo({ supplierId: 'DAIRYCO', qty: 250, statusIn: ['CREATED'] }, po).ok).toBe(true);
  });
  it('reports field diffs', () => {
    const r = validatePo({ supplierId: 'DAIRYCO', qty: 250 }, { ...po, qty: 300 });
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual([{ field: 'qty', expected: 250, observed: 300 }]);
  });
  it('reports a missing record', () => {
    expect(validatePo({ supplierId: 'DAIRYCO', qty: 250 }, null).ok).toBe(false);
  });
});

describe('reconciler', () => {
  it('maps HTTP failures to kinds', () => {
    expect(failureKindFromHttp(422, 'MOQ_NOT_MET')).toBe('MOQ_REJECTED');
    expect(failureKindFromHttp(409, 'BUDGET_EXCEEDED')).toBe('BUDGET_EXCEEDED');
    expect(failureKindFromHttp(504, 'GATEWAY_TIMEOUT')).toBe('TRANSIENT');
    expect(failureKindFromHttp(404, 'NOT_FOUND')).toBe('NOT_FOUND');
  });
  it('retries transient failures up to the cap, then escalates', () => {
    expect(classify({ kind: 'TRANSIENT', retries: 0, adjusts: 0, completedActions: 0 })).toBe('RETRY');
    expect(classify({ kind: 'TRANSIENT', retries: 3, adjusts: 0, completedActions: 0 })).toBe('ESCALATE');
  });
  it('adjusts once on MOQ rejection, then compensates if earlier steps succeeded', () => {
    expect(classify({ kind: 'MOQ_REJECTED', retries: 0, adjusts: 0, completedActions: 1 })).toBe('ADJUST');
    expect(classify({ kind: 'MOQ_REJECTED', retries: 0, adjusts: 1, completedActions: 1 })).toBe('COMPENSATE');
  });
  it('compensates a budget failure after a completed amend', () => {
    expect(classify({ kind: 'BUDGET_EXCEEDED', retries: 0, adjusts: 1, completedActions: 1 })).toBe('COMPENSATE');
    expect(classify({ kind: 'BUDGET_EXCEEDED', retries: 0, adjusts: 0, completedActions: 0 })).toBe('ESCALATE');
  });
  it('adjusts quantity up to the new MOQ in whole packs', () => {
    expect(adjustForMoq(250, 300, 50)).toBe(300);
    expect(adjustForMoq(250, 260, 50)).toBe(300);
  });
});

describe('decision guard', () => {
  const { engine } = s1Decision({ rec: 800 });
  const good = {
    decision: 'MODIFY' as const,
    quantity: 250,
    actions: [{ type: 'CREATE_PO' as const, sku: 'BUTTER-500', node: 'BLR-01', supplierId: 'DAIRYCO', qty: 250, reason: 'r' }],
    reasoning: ['x'],
    constraintsHit: ['STORAGE'],
    confidence: 'HIGH' as const,
  };
  it('accepts a submission that matches the engine', () => {
    expect(checkSubmission(good, engine)).toEqual([]);
  });
  it('rejects a submission that rubber-stamps the recommendation', () => {
    const bad = { ...good, decision: 'ACCEPT' as const, quantity: 800, actions: [{ ...good.actions[0]!, qty: 800 }] };
    const problems = checkSubmission(bad, engine);
    expect(problems.join(' ')).toMatch(/engine result is MODIFY/);
    expect(problems.join(' ')).toMatch(/computed 250/);
  });
});

describe('evidence facts and reasoning grounding', () => {
  it('Scenario 2 facts label the budget available after the amendment', async () => {
    const { shortfallFacts } = await import('./facts.js');
    const input = s2();
    const facts = shortfallFacts(input, assessShortfall(input));
    const budget = facts.find((f) => f.startsWith('Budget:'))!;
    expect(budget).toContain('₹30,000 remaining now');
    expect(budget).toContain('releases ₹60,000');
    expect(budget).toContain('₹90,000 is available for a replacement order');
    expect(facts.some((f) => f.includes('FreshFarms') || f.includes('FRESHFARMS'))).toBe(true);
  });

  it('Scenario 1 facts include the storage breakdown', async () => {
    const { recommendationFacts } = await import('./facts.js');
    const { need, constraints, storageFree } = s1Decision({ rec: 800 });
    const facts = recommendationFacts({
      sku: 'BUTTER-500', node: 'BLR-01', supplierId: 'DAIRYCO', recommendedQty: 800, onHand: 150, dailyMean: 60, dailyStdDev: 10,
      leadTimeDays: 7, moq: 200, packSize: 50, unitCost: 240, budgetRemaining: 100_000, deliveryDay: 7, storageFreeAtDelivery: storageFree,
      storage: S1.storage, stockAtDelivery: 130, need, constraints, trustIssues: [],
    });
    expect(facts.join(' ')).toContain('280 units free');
    expect(facts.join(' ')).toContain('240 booked for other deliveries');
    expect(facts.join(' ')).toContain('true need is 334');
  });

  it('rejects reasoning with numbers that are not in the facts', async () => {
    const { ungroundedNumbers } = await import('./guard.js');
    const evidence = 'Budget: ₹30,000 remaining now; ₹90,000 is available. PO-2001 short 250.';
    expect(ungroundedNumbers(['FreshFarms fits the ₹90,000 available', 'PO-2001 is short 250 units'], evidence)).toEqual([]);
    expect(ungroundedNumbers(['FreshFarms fits within ₹45,000'], evidence)).toEqual([45000]);
    expect(ungroundedNumbers(['arrives in 3 days'], evidence)).toEqual([]);
  });

  it('the guard rejects an ungrounded submission', () => {
    const { engine } = s1Decision({ rec: 800 });
    engine.facts = ['true need is 334', 'Feasible order: 250 units'];
    const sub = {
      decision: 'MODIFY' as const,
      quantity: 250,
      actions: [{ type: 'CREATE_PO' as const, sku: 'BUTTER-500', node: 'BLR-01', supplierId: 'DAIRYCO', qty: 250, reason: 'r' }],
      reasoning: ['Need is 334', 'Storage allows 999'],
      constraintsHit: ['STORAGE'],
      confidence: 'HIGH' as const,
    };
    expect(checkSubmission(sub, engine).join(' ')).toMatch(/not in engineDecision.facts: 999/);
  });
});
