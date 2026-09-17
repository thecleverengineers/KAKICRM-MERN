import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../db/mongoose.js';
import { getLegacyModel, type LegacyRecord } from '../db/legacy.js';

/**
 * Non-mutating production diagnostic for migrated accounts. It does not print
 * a password or hash: it only reports whether the supplied password matches
 * the exact bcrypt value currently stored in the configured MongoDB database.
 */
async function main(): Promise<void> {
  const email = String(process.env.AUTH_CHECK_EMAIL ?? '').trim().toLowerCase();
  const password = String(process.env.AUTH_CHECK_PASSWORD ?? '');
  if (!email || !password) {
    throw new Error('Set AUTH_CHECK_EMAIL and AUTH_CHECK_PASSWORD before running this check.');
  }

  await connectDatabase();
  const user = await getLegacyModel('users')
    .findOne({ 'raw.email': new RegExp(`^${escapeRegex(email)}$`, 'i'), archivedAt: { $exists: false } })
    .lean<LegacyRecord | null>();
  const raw = user?.raw ?? {};
  const passwordField = typeof raw.password_hash === 'string'
    ? 'password_hash'
    : typeof raw.password === 'string'
      ? 'password'
      : null;
  const storedHash = passwordField ? String(raw[passwordField]).trim() : '';
  const normalizedHash = storedHash.replace(/^\$2y\$/, '$2b$');
  const matches = normalizedHash
    ? await bcrypt.compare(password, normalizedHash).catch(() => false)
    : false;

  const compiledAuthPath = fileURLToPath(new URL('../routes/auth.js', import.meta.url));
  const compiledAuth = existsSync(compiledAuthPath) ? readFileSync(compiledAuthPath, 'utf8') : '';
  const database = mongoose.connection.db?.databaseName ?? 'unknown';

  console.log(JSON.stringify({
    configuredDatabase: database,
    compiledLoginHasLegacyHashFix: compiledAuth.includes('verifyLegacyPassword'),
    userFound: Boolean(user),
    userId: user?.legacyId ?? null,
    accountStatus: user ? String(raw.status ?? 'active') : null,
    passwordField,
    hashPrefix: storedHash ? storedHash.slice(0, 4) : null,
    suppliedPasswordMatchesStoredHash: matches
  }, null, 2));
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
