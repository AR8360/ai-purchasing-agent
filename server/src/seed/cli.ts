import { connectDb, disconnectDb } from '../db.js';
import { listVariants, seed } from './seed.js';

const variant = process.argv[2] ?? 's1-b';

if (variant === '--list') {
  for (const v of listVariants()) console.log(`${v.name.padEnd(6)} ${v.description}`);
  process.exit(0);
}

await connectDb();
try {
  const r = await seed(variant);
  console.log(`Seeded "${r.variant}" at simulated now=${r.now}`);
  console.log(r.counts);
} finally {
  await disconnectDb();
}
