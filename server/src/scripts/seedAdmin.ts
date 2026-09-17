import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../db/mongoose.js';
import { getLegacyModel, toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { createLegacyRecord, updateLegacyRecord } from '../services/legacyRepository.js';

async function main(): Promise<void> {
  const email = String(process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD ?? '');
  const name = String(process.env.ADMIN_NAME ?? 'System Administrator').trim();
  if (!email || !password || password.length < 12) {
    throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters before running this command.');
  }

  await connectDatabase();
  const existing = await getLegacyModel('users').findOne({ 'raw.email': new RegExp(`^${escapeRegex(email)}$`, 'i'), archivedAt: { $exists: false } }).lean<LegacyRecord | null>();
  const hash = await bcrypt.hash(password, 12);
  const record = existing
    ? await updateLegacyRecord('users', existing.legacyId!, { name, email, password_hash: hash, role: 'admin', status: 'active' })
    : await createLegacyRecord('users', { name, email, password_hash: hash, role: 'admin', status: 'active', created_at: new Date().toISOString() });

  console.log(`Administrator ready: ${toPublicRecord(record!).legacyId}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => disconnectDatabase());
