import { FAULTS } from '@purchasing/shared';
import { onShortfall } from '../mock/routes.js';
import { startDecision } from '../agent/orchestrator.js';

/**
 * Subscribes the agent to supplier shortfall events (the supplier portal's webhook).
 * Every event starts a Scenario 2 decision.
 */
export function registerShortfallHandler() {
  onShortfall(async (evt) => {
    const faults = evt.faults.filter((f) => (FAULTS as readonly string[]).includes(f));
    const { decisionId } = await startDecision(
      {
        type: 'SUPPLIER_SHORTFALL',
        poId: evt.poId,
        confirmedQty: evt.confirmedQty,
        message: evt.message,
        sku: evt.sku,
        node: evt.node,
        supplierId: evt.supplierId,
        orderedQty: evt.orderedQty,
      },
      faults,
    );
    return { decisionId };
  });
}
