import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { LEGACY_COLLECTIONS, getLegacyModel, type LegacyCollection } from '../db/legacy.js';
import { connectDatabase, disconnectDatabase } from '../db/mongoose.js';

interface Arguments {
  sql: string;
  database?: string;
}

interface StoredMigrationRun {
  source?: string;
  checksum?: string;
  completedAt?: Date | string;
  tableCounts?: unknown;
  skippedTables?: unknown;
  failures?: unknown;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const sqlPath = path.resolve(args.sql);
  await stat(sqlPath);
  const source = await readFile(sqlPath, 'utf8');
  const checksum = crypto.createHash('sha256').update(source).digest('hex');

  await connectDatabase(args.database ? withDatabase(env.MONGODB_URI, args.database) : undefined);
  try {
    const run = await mongoose.connection.collection('migration_runs').findOne(
      { checksum, dryRun: false },
      { sort: { completedAt: -1 } }
    ) as StoredMigrationRun | null;

    if (!run) {
      throw new Error('No completed live migration run matches this SQL file checksum. Run npm run migrate:legacy first.');
    }

    const expectedCounts = parseCounts(run.tableCounts);
    const unknownTables = Object.keys(expectedCounts).filter((table) => !isLegacyCollection(table));
    const failures = asStringArray(run.failures);
    const skippedTables = asStringArray(run.skippedTables);
    const validationErrors: string[] = [];

    if (unknownTables.length) validationErrors.push(`Migration run includes unknown collections: ${unknownTables.join(', ')}.`);
    if (failures.length) validationErrors.push(`Migration run recorded failures: ${failures.join('; ')}.`);
    if (skippedTables.length) validationErrors.push(`Migration run skipped tables: ${skippedTables.join(', ')}.`);

    const entries = Object.entries(expectedCounts).sort(([left], [right]) => left.localeCompare(right));
    let expectedTotal = 0;
    let importedTotal = 0;
    for (const [collection, expected] of entries) {
      if (!isLegacyCollection(collection)) continue;
      expectedTotal += expected;
      const imported = await getLegacyModel(collection).countDocuments({
        legacySourceChecksum: checksum,
        archivedAt: { $exists: false }
      });
      importedTotal += imported;
      if (imported !== expected) validationErrors.push(`${collection}: expected ${expected}, found ${imported}.`);
    }

    console.log('\nLegacy migration verification');
    console.log(`Source: ${sqlPath}`);
    console.log(`Checksum: ${checksum}`);
    console.log(`Migration completed: ${run.completedAt ? new Date(run.completedAt).toISOString() : 'unknown'}`);
    console.log(`Populated collections: ${entries.length}`);
    console.log(`Expected rows: ${expectedTotal}`);
    console.log(`MongoDB rows tagged with this source: ${importedTotal}`);

    if (validationErrors.length) {
      for (const error of validationErrors) console.error(`Verification failure: ${error}`);
      throw new Error(`Migration verification failed with ${validationErrors.length} issue(s).`);
    }

    console.log('Verification passed: every imported SQL row is present in MongoDB.');
  } finally {
    await disconnectDatabase();
  }
}

function parseArguments(values: string[]): Arguments {
  const args: Partial<Arguments> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--sql') args.sql = values[++index];
    else if (value === '--database') args.database = values[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.sql) throw new Error('Usage: npm run verify:legacy -- --sql /path/to/localhost.sql [--database kaki_crm_modern]');
  return args as Arguments;
}

function parseCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The matching migration run has no usable table-count summary.');
  }

  const counts: Record<string, number> = {};
  for (const [table, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`The matching migration run contains an invalid count for ${table}.`);
    }
    counts[table] = count;
  }
  return counts;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isLegacyCollection(value: string): value is LegacyCollection {
  return (LEGACY_COLLECTIONS as readonly string[]).includes(value);
}

function withDatabase(uri: string, database: string): string {
  const [base, query = ''] = uri.split('?');
  const slashIndex = base.lastIndexOf('/');
  const authorityEndsAt = base.indexOf('://') + 3;
  const prefix = slashIndex < authorityEndsAt ? `${base}/` : `${base.slice(0, slashIndex + 1)}`;
  return `${prefix}${encodeURIComponent(database)}${query ? `?${query}` : ''}`;
}

void main().catch((error: unknown) => {
  console.error(`Migration verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
