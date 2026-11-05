import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb(uri = config.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
