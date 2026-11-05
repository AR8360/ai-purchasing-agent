import type { Budget, Forecast, Inventory, PurchaseOrder, Sku, Storage, SupplierReliability, SupplierTerms } from '@purchasing/shared';
import type { OpenPo } from '../engine/calculator.js';
import { projectedStockAt } from '../engine/calculator.js';
import { storageFreeAt } from '../engine/constraints.js';
import { HttpError, mockCall, qs, type CallContext } from './http.js';

/** Typed accessors for the mock external systems. */

export type InventoryView = Inventory & { available: number; category: string; zone: string; packSize: number };
export type ForecastView = Forecast & { ageHours: number };
export type PoView = PurchaseOrder & { effectiveQty: number; expectedInDays: number };
export type TermsView = SupplierTerms & { name?: string; reliability?: SupplierReliability };
export type BudgetView = Budget & { remaining: number };
export type StorageView = Storage & { freeUnits: number };

export const getSku = (c: CallContext, sku: string) => mockCall<Sku>(c, 'GET', `/skus/${encodeURIComponent(sku)}`);
export const getInventory = (c: CallContext, sku: string, node: string) => mockCall<InventoryView>(c, 'GET', `/inventory${qs({ sku, node })}`);
export const getForecast = (c: CallContext, sku: string, node: string) => mockCall<ForecastView>(c, 'GET', `/forecast${qs({ sku, node })}`);
export const getOpenPos = (c: CallContext, sku: string, node: string) =>
  mockCall<PoView[]>(c, 'GET', `/po${qs({ sku, node, status: 'open' })}`);
export const getPo = (c: CallContext, poId: string) => mockCall<PoView>(c, 'GET', `/po/${encodeURIComponent(poId)}`);
export const getTerms = (c: CallContext, supplierId: string, sku: string) =>
  mockCall<TermsView>(c, 'GET', `/suppliers/terms${qs({ supplierId, sku })}`);
export const getAlternates = (c: CallContext, sku: string, exclude?: string) =>
  mockCall<TermsView[]>(c, 'GET', `/suppliers/alternates${qs({ sku, exclude })}`);
export const getBackfill = (c: CallContext, supplierId: string, sku: string) =>
  mockCall<{ earliestInDays: number; earliestDate: string }>(c, 'GET', `/suppliers/${encodeURIComponent(supplierId)}/backfill${qs({ sku })}`);
export const getBudget = (c: CallContext, node: string, category: string) => mockCall<BudgetView>(c, 'GET', `/budget${qs({ node, category })}`);
export const getStorage = (c: CallContext, node: string, zone: string) => mockCall<StorageView>(c, 'GET', `/storage${qs({ node, zone })}`);

/** 404 → null, anything else rethrows. */
export async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

export const toOpenPo = (p: PoView): OpenPo => ({ poId: p.poId, qty: p.effectiveQty, inDays: p.expectedInDays });

/**
 * Fresh capacity check for one order line, used when re-planning after a failure:
 * remaining budget and free storage on the delivery day (excluding the order itself).
 */
export async function capacityForOrder(
  c: CallContext,
  a: { sku: string; node: string; supplierId: string; deliveryInDays?: number; excludePoId?: string },
) {
  const sku = await getSku(c, a.sku);
  const [inv, fc, pos, terms, budget, storage] = await Promise.all([
    getInventory(c, a.sku, a.node),
    getForecast(c, a.sku, a.node),
    getOpenPos(c, a.sku, a.node),
    getTerms(c, a.supplierId, a.sku),
    getBudget(c, a.node, sku.category),
    getStorage(c, a.node, sku.zone),
  ]);
  const openPos = pos.filter((p) => p.poId !== a.excludePoId).map(toOpenPo);
  // Default delivery day: the supplier's effective lead time.
  const deliveryInDays = a.deliveryInDays ?? terms.leadTimeDays + (terms.reliability?.avgLeadDelta ?? 0);
  const stock = projectedStockAt(deliveryInDays, inv.onHand, fc.dailyMean, openPos);
  const storageFree = storageFreeAt({ ...storage, ourOnHand: inv.onHand, ourProjectedStock: stock });
  return { budgetRemaining: budget.remaining, storageFree, deliveryInDays, unitCost: terms.unitCost, packSize: terms.packSize, moq: terms.moq };
}
