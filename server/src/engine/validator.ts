import type { FieldDiff } from '@purchasing/shared';

/** Read-back validation: compare what we expected a write to produce with what the system holds. Pure. */

export interface ExpectedPo {
  poId?: string;
  supplierId: string;
  qty: number;
  pendingQty?: number | null;
  unitCost?: number;
  totalCost?: number;
  statusIn?: string[];
}

export interface ObservedPo {
  poId: string;
  supplierId: string;
  qty: number;
  pendingQty: number | null;
  unitCost: number;
  totalCost: number;
  status: string;
}

export function validatePo(expected: ExpectedPo, observed: ObservedPo | null): { ok: boolean; diffs: FieldDiff[] } {
  if (!observed) return { ok: false, diffs: [{ field: 'exists', expected: true, observed: false }] };
  const diffs: FieldDiff[] = [];
  const cmp = (field: string, e: unknown, o: unknown) => {
    if (e !== undefined && e !== o) diffs.push({ field, expected: e, observed: o });
  };
  cmp('poId', expected.poId, observed.poId);
  cmp('supplierId', expected.supplierId, observed.supplierId);
  cmp('qty', expected.qty, observed.qty);
  if (expected.pendingQty !== undefined) cmp('pendingQty', expected.pendingQty, observed.pendingQty);
  cmp('unitCost', expected.unitCost, observed.unitCost);
  cmp('totalCost', expected.totalCost, observed.totalCost);
  if (expected.statusIn && !expected.statusIn.includes(observed.status)) {
    diffs.push({ field: 'status', expected: expected.statusIn.join('|'), observed: observed.status });
  }
  return { ok: diffs.length === 0, diffs };
}

export interface OutcomeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Whole-picture check after every action validated individually. */
export function validateOutcome(checks: OutcomeCheck[]) {
  return { ok: checks.every((c) => c.ok), checks };
}
