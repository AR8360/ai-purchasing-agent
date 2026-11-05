import { listen } from '../app.js';
import { connectDb, disconnectDb } from '../db.js';
import type { CacheMode } from '../agent/llmCache.js';
import { runEval } from './runner.js';

/**
 * npm run eval            replay recorded LLM responses (offline, deterministic)
 * npm run eval:record     record missing responses with the real model
 * npm run eval:live       call the model for every turn and overwrite fixtures
 * Add "-- --case <name|variant>" to run a single case.
 */
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = (arg('mode') ?? 'replay') as CacheMode;
const only = arg('case');

await connectDb();
const { server } = await listen(0);
let exitCode = 0;
try {
  console.log(`Evaluation (mode=${mode}${only ? `, case=${only}` : ''})`);
  const report = await runEval({ mode, only, log: (s) => console.log(s) });
  console.log(`\n${report.passed}/${report.total} passed`);
  if (report.passed !== report.total) exitCode = 1;
} catch (e) {
  console.error((e as Error).message);
  exitCode = 1;
} finally {
  server.close();
  await disconnectDb();
}
process.exit(exitCode);
