import mongoose, { Schema } from 'mongoose';
import type {
  Budget,
  DecisionDoc,
  Forecast,
  Inventory,
  PurchaseOrder,
  Sku,
  Storage,
  Supplier,
  SupplierTerms,
} from '@purchasing/shared';

const opts = { versionKey: false as const };

const SkuSchema = new Schema<Sku>(
  {
    sku: { type: String, required: true, unique: true },
    name: String,
    category: { type: String, required: true },
    zone: { type: String, required: true },
    packSize: { type: Number, required: true },
  },
  opts,
);

const InventorySchema = new Schema<Inventory>(
  {
    sku: { type: String, required: true },
    node: { type: String, required: true },
    onHand: { type: Number, required: true },
    reserved: { type: Number, default: 0 },
    updatedAt: { type: String, required: true },
  },
  opts,
);
InventorySchema.index({ sku: 1, node: 1 }, { unique: true });

const ForecastSchema = new Schema<Forecast>(
  {
    sku: { type: String, required: true },
    node: { type: String, required: true },
    dailyMean: { type: Number, required: true },
    dailyStdDev: { type: Number, required: true },
    horizonDays: { type: Number, default: 28 },
    generatedAt: { type: String, required: true },
  },
  opts,
);
ForecastSchema.index({ sku: 1, node: 1 }, { unique: true });

const PurchaseOrderSchema = new Schema<PurchaseOrder>(
  {
    poId: { type: String, required: true, unique: true },
    sku: { type: String, required: true },
    node: { type: String, required: true },
    supplierId: { type: String, required: true },
    qty: { type: Number, required: true },
    pendingQty: { type: Number, default: null },
    confirmedQty: { type: Number, default: null },
    unitCost: { type: Number, required: true },
    totalCost: { type: Number, required: true },
    status: { type: String, required: true },
    expectedDate: { type: String, required: true },
    // Unique only when present: a retried create with the same key returns the original PO.
    idempotencyKey: { type: String, unique: true, sparse: true },
    decisionId: String,
    history: { type: [Schema.Types.Mixed], default: [] } as any,
    createdAt: { type: String, required: true },
  },
  opts,
);

const SupplierSchema = new Schema<Supplier>(
  {
    supplierId: { type: String, required: true, unique: true },
    name: String,
    reliability: {
      onTimeRate: Number,
      fillRate: Number,
      avgLeadDelta: Number,
    },
  },
  opts,
);

const SupplierTermsSchema = new Schema<SupplierTerms>(
  {
    supplierId: { type: String, required: true },
    sku: { type: String, required: true },
    leadTimeDays: Number,
    moq: Number,
    packSize: Number,
    unitCost: Number,
    backfillLeadDays: Number,
  },
  opts,
);
SupplierTermsSchema.index({ supplierId: 1, sku: 1 }, { unique: true });

const BudgetSchema = new Schema<Budget>(
  {
    node: String,
    category: String,
    period: String,
    total: Number,
    reserved: Number,
    spent: Number,
  },
  opts,
);
BudgetSchema.index({ node: 1, category: 1 }, { unique: true });

const StorageSchema = new Schema<Storage>(
  {
    node: String,
    zone: String,
    capacityUnits: Number,
    usedUnits: Number,
    reservedInboundUnits: Number,
  },
  opts,
);
StorageSchema.index({ node: 1, zone: 1 }, { unique: true });

const PoEventSchema = new Schema(
  {
    poId: String,
    type: String,
    payload: Schema.Types.Mixed,
    receivedAt: String,
    decisionId: String,
  },
  opts,
);

/** The full decision trace is one document: it is the audit log, the UI and the eval evidence. */
const DecisionSchema = new Schema<DecisionDoc>(
  {
    decisionId: { type: String, required: true, unique: true },
    state: { type: String, required: true, index: true },
    createdAt: { type: String, index: true },
  },
  { ...opts, strict: false, minimize: false },
);

export const SkuModel = mongoose.model('Sku', SkuSchema, 'skus');
export const InventoryModel = mongoose.model('Inventory', InventorySchema, 'inventory');
export const ForecastModel = mongoose.model('Forecast', ForecastSchema, 'forecasts');
export const PurchaseOrderModel = mongoose.model('PurchaseOrder', PurchaseOrderSchema, 'purchaseOrders');
export const SupplierModel = mongoose.model('Supplier', SupplierSchema, 'suppliers');
export const SupplierTermsModel = mongoose.model('SupplierTerms', SupplierTermsSchema, 'supplierTerms');
export const BudgetModel = mongoose.model('Budget', BudgetSchema, 'budgets');
export const StorageModel = mongoose.model('Storage', StorageSchema, 'storage');
export const PoEventModel = mongoose.model('PoEvent', PoEventSchema, 'poEvents');
export const DecisionModel = mongoose.model('Decision', DecisionSchema, 'decisions');

export const ALL_MODELS = [
  SkuModel,
  InventoryModel,
  ForecastModel,
  PurchaseOrderModel,
  SupplierModel,
  SupplierTermsModel,
  BudgetModel,
  StorageModel,
  PoEventModel,
  DecisionModel,
] as const;
