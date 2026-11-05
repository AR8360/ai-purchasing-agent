import mongoose from 'mongoose';
import { config } from '../config.js';
import { connectDb, disconnectDb } from '../db.js';

const masked = config.mongoUri.replace(/\/\/([^:/]+):[^@]*@/, '//$1:****@');
console.log(`Connecting to ${masked}`);
try {
  await connectDb();
  const r = await mongoose.connection.db!.command({ ping: 1 });
  console.log('DB PING OK', r);
} catch (e) {
  console.error('DB PING FAILED:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
