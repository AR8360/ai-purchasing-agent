import { config } from './config.js';
import { connectDb } from './db.js';
import { listen } from './app.js';

await connectDb();
const { url } = await listen(config.port);
console.log(`AI purchasing agent API on ${url}  (model=${config.llm.model || 'unset'}, llmCache=${config.llm.cacheMode})`);
