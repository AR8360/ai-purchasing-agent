import { connectDb, disconnectDb } from '../db.js';
import { DecisionModel } from '../models/index.js';

/** Print a compact view of a decision trace: npm run show -w @purchasing/server -- [decisionId] */
await connectDb();
try {
  const id = process.argv[2];
  const d: any = id
    ? await DecisionModel.findOne({ decisionId: id }, { _id: 0 }).lean()
    : await DecisionModel.findOne({}, { _id: 0 }).sort({ createdAt: -1 }).lean();
  if (!d) {
    console.log('No decision found');
  } else {
    console.log(`${d.decisionId}  ${d.trigger.type}  state=${d.state}  turns=${d.llm.turns} cached=${d.llm.cacheHits}`);
    console.log(`engine: ${d.engine?.decision} ${d.engine?.strategy} qty=${d.engine?.quantity} rule=${d.engine?.rule}`);
    console.log(`submitted: ${d.decision?.decision} qty=${d.decision?.quantity}`);
    console.log('tools:', d.toolCalls.map((t: any) => `${t.turn}:${t.name}${t.ok ? '' : '(ERR ' + t.error + ')'}`).join(' '));
    for (const r of d.rejectedSubmissions) console.log(`guard rejected (turn ${r.turn}): ${r.problems.join(' | ')}`);
    console.log('transitions:', d.transitions.map((t: any) => t.to).join(' → '));
    for (const a of d.actions) console.log(`action ${a.index}: ${a.action.type} ${a.poId ?? ''} ${a.action.supplierId} ${a.action.qty} ${a.status} ${a.error?.message ?? ''}`);
    for (const r of d.reconciliations) console.log(`reconcile: ${r.move} after ${r.failure}: ${r.detail}`);
    if (d.error) console.log('ERROR:', d.error);
    if (d.explanation) console.log('\n' + d.explanation);
  }
} finally {
  await disconnectDb();
}
