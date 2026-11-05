/** Domain records as returned by the (mock) external systems. Dates are ISO strings. */

export interface Sku {
  sku: string;
  name: string;
  category: string;
  zone: string;
  packSize: number;
}

export interface Inventory {
  sku: string;
  node: string;
  onHand: number;
  reserved: number;
  updatedAt: string;
}

export interface Forecast {
  sku: string;
  node: string;
  dailyMean: number;
  dailyStdDev: number;
  horizonDays: number;
  generatedAt: string;
}

export type PoStatus = 'CREATED' | 'CONFIRMED' | 'SHIPPED' | 'RECEIVED' | 'CANCELLED';

export interface PoHistoryEntry {
  at: string;
  event: string;
  from?: unknown;
  to?: unknown;
  reason?: string;
}

export interface PurchaseOrder {
  poId: string;
  sku: string;
  node: string;
  supplierId: string;
  qty: number;
  /** Soft amendment, applied on commit once the decision validates. */
  pendingQty: number | null;
  /** Quantity the supplier confirmed (set by a shortfall event). */
  confirmedQty: number | null;
  unitCost: number;
  totalCost: number;
  status: PoStatus;
  expectedDate: string;
  idempotencyKey?: string;
  decisionId?: string;
  history: PoHistoryEntry[];
  createdAt: string;
}

export interface SupplierReliability {
  onTimeRate: number;
  fillRate: number;
  avgLeadDelta: number;
}

export interface Supplier {
  supplierId: string;
  name: string;
  reliability: SupplierReliability;
}

export interface SupplierTerms {
  supplierId: string;
  sku: string;
  leadTimeDays: number;
  moq: number;
  packSize: number;
  unitCost: number;
  /** Earliest days until the supplier could ship an additional batch. */
  backfillLeadDays: number;
}

export interface Budget {
  node: string;
  category: string;
  period: string;
  total: number;
  reserved: number;
  spent: number;
}

export interface Storage {
  node: string;
  zone: string;
  capacityUnits: number;
  usedUnits: number;
  /** Space already booked for other inbound deliveries (other SKUs). */
  reservedInboundUnits: number;
}
