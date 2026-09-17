import mongoose from 'mongoose';
import { env } from '../config/env.js';

mongoose.set('strictQuery', true);

export async function connectDatabase(uri = env.MONGODB_URI): Promise<void> {
  if (mongoose.connection.readyState === 1) return;

  await mongoose.connect(uri, {
    autoIndex: env.NODE_ENV !== 'production',
    serverSelectionTimeoutMS: 10_000
  });
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
