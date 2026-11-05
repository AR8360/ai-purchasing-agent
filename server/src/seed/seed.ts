import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Trigger } from '@purchasing/shared';
import { addDays, addHours, clock } from '../clock.js';
import {
  ALL_MODELS,
  BudgetModel,
  DecisionModel,
  ForecastModel,
  InventoryModel,
  PurchaseOrderModel,
  SkuModel,
  StorageModel,
  SupplierModel,
  SupplierTermsModel,
} from '../models/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, 'data');

type World = Record<string, any[]>;

export interface VariantInfo {
  name: string;
  description: string;
  trigger: Trigger;
  faults: string[];
}

const COLLECTIONS = ['skus', 'suppliers', 'supplierTerms', 'inventory', 'forecasts', 'purchaseOrders', 'budgets', 'storage'];

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listVariants(): VariantInfo[] {
  const dir = path.join(DATA_DIR, 'variants');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const v = readJson(path.join(dir, f));
      return { name: f.replace(/\.json$/, ''), description: v.description, trigger: v.trigger, faults: v.faults ?? [] };
    });
}

export function getVariant(name: string): VariantInfo {
  const v = listVariants().find((x) => x.name === name);
  if (!v) throw new Error(`Unknown seed variant "${name}". Known: ${listVariants().map((x) => x.name).join(', ')}`);
  return v;
}

/** Base world with the variant's collections replaced wholesale. */
export function buildWorld(variant?: string): World {
  const base = readJson(path.join(DATA_DIR, 'base.json'));
  const world: World = {};
  for (const c of COLLECTIONS) world[c] = base[c] ?? [];
  if (variant && variant !== 'base') {
    const v = readJson(path.join(DATA_DIR, 'variants', `${variant}.json`));
    for (const [c, docs] of Object.entries(v.replace ?? {})) world[c] = docs as any[];
  }
  return world;
}

/** Resets the simulation clock and replaces every collection with the chosen world. */
export async function seed(variant = 's1-b', opts: { clearDecisions?: boolean } = {}) {
  if (variant !== 'base') getVariant(variant);
  clock.reset();
  const now = clock.now();
  const w = buildWorld(variant);

  // Decision history is kept across re-seeds (it is the inbox) unless asked otherwise.
  await Promise.all(
    ALL_MODELS.filter((m) => opts.clearDecisions || m !== DecisionModel).map((m) => (m as any).deleteMany({})),
  );

  await SkuModel.insertMany(w.skus);
  await SupplierModel.insertMany(w.suppliers);
  await SupplierTermsModel.insertMany(w.supplierTerms);
  await InventoryModel.insertMany(
    w.inventory.map(({ updatedHoursAgo = 0, ...r }) => ({ ...r, updatedAt: addHours(-updatedHoursAgo, now).toISOString() })),
  );
  await ForecastModel.insertMany(
    w.forecasts.map(({ generatedHoursAgo = 0, ...r }) => ({ ...r, generatedAt: addHours(-generatedHoursAgo, now).toISOString() })),
  );
  await PurchaseOrderModel.insertMany(
    w.purchaseOrders.map(({ expectedInDays, createdDaysAgo = 2, ...r }) => ({
      ...r,
      totalCost: r.qty * r.unitCost,
      pendingQty: null,
      confirmedQty: null,
      expectedDate: addDays(expectedInDays, now).toISOString(),
      createdAt: addDays(-createdDaysAgo, now).toISOString(),
      history: [{ at: addDays(-createdDaysAgo, now).toISOString(), event: 'CREATED', to: r.qty, reason: 'seed' }],
    })),
  );
  await BudgetModel.insertMany(w.budgets);
  await StorageModel.insertMany(w.storage);
  // Make sure unique indexes (idempotency key) exist before any write.
  await Promise.all(ALL_MODELS.map((m) => (m as any).syncIndexes()));

  return {
    variant,
    now: now.toISOString(),
    counts: Object.fromEntries(COLLECTIONS.map((c) => [c, w[c].length])),
  };
}
