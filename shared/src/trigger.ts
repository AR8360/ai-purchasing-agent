import { z } from 'zod';

/** Scenario 1: the replenishment system recommends a purchase. */
export const RecommendationTriggerSchema = z.object({
  type: z.literal('RECOMMENDATION'),
  sku: z.string(),
  node: z.string(),
  supplierId: z.string(),
  qty: z.number().int().positive(),
  source: z.string().default('replenishment-system'),
});

/** Scenario 2: a supplier confirms less than an open PO asked for. */
export const ShortfallTriggerSchema = z.object({
  type: z.literal('SUPPLIER_SHORTFALL'),
  poId: z.string(),
  confirmedQty: z.number().int().nonnegative(),
  message: z.string().optional(),
  // Filled in by the supplier webhook from the PO, so the agent can gather evidence in one turn.
  sku: z.string().optional(),
  node: z.string().optional(),
  supplierId: z.string().optional(),
  orderedQty: z.number().int().optional(),
});

export const TriggerSchema = z.discriminatedUnion('type', [RecommendationTriggerSchema, ShortfallTriggerSchema]);

export type RecommendationTrigger = z.infer<typeof RecommendationTriggerSchema>;
export type ShortfallTrigger = z.infer<typeof ShortfallTriggerSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
