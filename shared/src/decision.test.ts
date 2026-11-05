import { describe, expect, it } from 'vitest';
import { SubmitDecisionSchema, TriggerSchema, toToolJsonSchema } from './index.js';

describe('shared contracts', () => {
  it('converts the submit_decision schema to a tool-safe JSON schema', () => {
    const js = toToolJsonSchema(SubmitDecisionSchema) as any;
    expect(js.type).toBe('object');
    expect(js.properties.decision.enum).toEqual(['ACCEPT', 'MODIFY', 'REJECT', 'INVESTIGATE', 'ESCALATE']);
    expect(js.required).toEqual(expect.arrayContaining(['decision', 'actions', 'reasoning']));
    const text = JSON.stringify(js);
    expect(text).not.toContain('$schema');
    expect(text).not.toContain('$ref');
  });

  it('parses both trigger types', () => {
    expect(TriggerSchema.parse({ type: 'RECOMMENDATION', sku: 'A', node: 'N', supplierId: 'S', qty: 5 }).type).toBe(
      'RECOMMENDATION',
    );
    expect(TriggerSchema.parse({ type: 'SUPPLIER_SHORTFALL', poId: 'PO-1', confirmedQty: 2 }).type).toBe(
      'SUPPLIER_SHORTFALL',
    );
  });

  it('rejects a decision without reasoning', () => {
    const r = SubmitDecisionSchema.safeParse({ decision: 'ACCEPT', actions: [], reasoning: [], constraintsHit: [], confidence: 'HIGH' });
    expect(r.success).toBe(false);
  });
});
