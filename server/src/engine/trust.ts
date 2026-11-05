/** Data trust checks: if any fail, the agent must INVESTIGATE rather than act. Pure. */

export interface TrustIssue {
  code: 'STALE_FORECAST' | 'MISSING_FORECAST' | 'INVALID_INVENTORY' | 'MISSING_INVENTORY' | 'PO_MISSING_DATE' | 'MISSING_TERMS';
  message: string;
}

export interface TrustInput {
  forecastAgeHours: number | null;
  onHand: number | null | undefined;
  openPos: { poId: string; expectedDate?: string | null }[];
  hasTerms: boolean;
  maxForecastAgeHours?: number;
}

export const MAX_FORECAST_AGE_HOURS = 48;

export function checkDataTrust(t: TrustInput): TrustIssue[] {
  const issues: TrustIssue[] = [];
  const maxAge = t.maxForecastAgeHours ?? MAX_FORECAST_AGE_HOURS;
  if (t.forecastAgeHours == null) {
    issues.push({ code: 'MISSING_FORECAST', message: 'No demand forecast for this SKU and node' });
  } else if (t.forecastAgeHours > maxAge) {
    issues.push({
      code: 'STALE_FORECAST',
      message: `Forecast is ${t.forecastAgeHours}h old (limit ${maxAge}h); a fresh forecast is needed before ordering`,
    });
  }
  if (t.onHand == null) {
    issues.push({ code: 'MISSING_INVENTORY', message: 'No inventory record for this SKU and node' });
  } else if (!Number.isFinite(t.onHand) || t.onHand < 0) {
    issues.push({ code: 'INVALID_INVENTORY', message: `On-hand quantity ${t.onHand} is not valid` });
  }
  for (const po of t.openPos) {
    if (!po.expectedDate) issues.push({ code: 'PO_MISSING_DATE', message: `Open ${po.poId} has no expected date` });
  }
  if (!t.hasTerms) issues.push({ code: 'MISSING_TERMS', message: 'Supplier terms missing for this SKU' });
  return issues;
}
