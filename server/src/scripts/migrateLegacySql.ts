import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { LEGACY_COLLECTIONS, getLegacyModel, makeCompositeKey, type LegacyCollection } from '../db/legacy.js';
import { connectDatabase, disconnectDatabase } from '../db/mongoose.js';
import { copyLegacyAssets, ensureUploadRoot } from '../services/storage.js';

interface Arguments {
  sql: string;
  assets?: string;
  dryRun: boolean;
  skipAssets: boolean;
  database?: string;
  batchSize: number;
}

interface TableDefinition {
  columns: string[];
  types: Map<string, string>;
}

interface ParsedInsert {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

interface MigrationSummary {
  source: string;
  checksum: string;
  dryRun: boolean;
  startedAt: string;
  completedAt?: string;
  tableCounts: Record<string, number>;
  skippedTables: string[];
  failures: string[];
  assets?: { copiedRoots: string[]; skippedRoots: string[] };
}

const runSchema = new mongoose.Schema({
  source: String,
  checksum: String,
  dryRun: Boolean,
  startedAt: Date,
  completedAt: Date,
  tableCounts: mongoose.Schema.Types.Mixed,
  skippedTables: [String],
  failures: [String],
  assets: mongoose.Schema.Types.Mixed
}, { collection: 'migration_runs', minimize: false, versionKey: false });

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const sqlPath = path.resolve(args.sql);
  await stat(sqlPath);
  const source = await readFile(sqlPath, 'utf8');
  const summary: MigrationSummary = {
    source: sqlPath,
    checksum: crypto.createHash('sha256').update(source).digest('hex'),
    dryRun: args.dryRun,
    startedAt: new Date().toISOString(),
    tableCounts: {},
    skippedTables: [],
    failures: []
  };
  const importedAt = new Date();
  const definitions = parseTableDefinitions(source);

  try {
    if (!args.dryRun) {
      await connectDatabase(args.database ? withDatabase(env.MONGODB_URI, args.database) : undefined);
      await ensureUploadRoot();
    }

    for (const insert of parseInserts(source, definitions)) {
      if (!isLegacyCollection(insert.table)) {
        if (!summary.skippedTables.includes(insert.table)) summary.skippedTables.push(insert.table);
        continue;
      }
      summary.tableCounts[insert.table] = (summary.tableCounts[insert.table] ?? 0) + insert.rows.length;
      if (!args.dryRun && insert.rows.length) {
        await upsertBatch(insert.table, insert.rows, args.batchSize, summary.checksum, importedAt);
      }
    }

    if (!args.dryRun && args.assets && !args.skipAssets) {
      summary.assets = await copyLegacyAssets(path.resolve(args.assets));
    }
  } catch (error) {
    summary.failures.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    summary.completedAt = new Date().toISOString();
    if (!args.dryRun && mongoose.connection.readyState === 1) {
      const MigrationRun = mongoose.models.MigrationRun ?? mongoose.model('MigrationRun', runSchema);
      await MigrationRun.create(summary);
      await disconnectDatabase();
    }
    printSummary(summary);
  }
}

function parseArguments(values: string[]): Arguments {
  const args: Partial<Arguments> = { dryRun: false, skipAssets: false, batchSize: 500 };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--skip-assets') args.skipAssets = true;
    else if (value === '--sql') args.sql = values[++index];
    else if (value === '--assets') args.assets = values[++index];
    else if (value === '--database') args.database = values[++index];
    else if (value === '--batch-size') args.batchSize = Number(values[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.sql) throw new Error('Usage: npm run migrate:legacy -- --sql /path/to/localhost.sql [--assets /path/to/kakicrm.store] [--dry-run]');
  if (!Number.isSafeInteger(args.batchSize) || args.batchSize! < 1 || args.batchSize! > 2_000) throw new Error('--batch-size must be an integer from 1 to 2000.');
  return args as Arguments;
}

function parseTableDefinitions(source: string): Map<string, TableDefinition> {
  const definitions = new Map<string, TableDefinition>();
  const expression = /CREATE TABLE `([^`]+)` \(([\s\S]*?)\) ENGINE=/g;
  for (const match of source.matchAll(expression)) {
    const table = match[1];
    const body = match[2];
    const types = new Map<string, string>();
    const columns: string[] = [];
    for (const line of body.split('\n')) {
      const column = line.match(/^\s*`([^`]+)`\s+([^\s,]+)/);
      if (column) {
        columns.push(column[1]);
        types.set(column[1], column[2].toLowerCase());
      }
    }
    definitions.set(table, { columns, types });
  }
  return definitions;
}

function* parseInserts(source: string, definitions: Map<string, TableDefinition>): Generator<ParsedInsert> {
  const opener = /INSERT INTO `([^`]+)` \(([^)]*)\) VALUES\s*/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    const table = match[1];
    const columns = [...match[2].matchAll(/`([^`]+)`/g)].map((column) => column[1]);
    const end = findStatementEnd(source, opener.lastIndex);
    const valuesSource = source.slice(opener.lastIndex, end);
    opener.lastIndex = end + 1;
    const definition = definitions.get(table);
    const rows = parseRows(valuesSource, columns, definition?.types ?? new Map());
    yield { table, columns, rows };
  }
}

function findStatementEnd(source: string, start: number): number {
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === "'") {
        if (source[index + 1] === "'") index += 1;
        else quoted = false;
      }
    } else if (char === "'") {
      quoted = true;
    } else if (char === ';') {
      return index;
    }
  }
  throw new Error('Unterminated INSERT statement in SQL dump.');
}

function parseRows(valuesSource: string, columns: string[], types: Map<string, string>): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  let index = 0;
  while (index < valuesSource.length) {
    index = skipWhitespaceAndSeparators(valuesSource, index);
    if (index >= valuesSource.length) break;
    if (valuesSource[index] !== '(') throw new Error(`Expected '(' while parsing INSERT values near offset ${index}.`);
    index += 1;
    const values: unknown[] = [];
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const parsed = parseValue(valuesSource, index, types.get(columns[columnIndex]) ?? '');
      values.push(parsed.value);
      index = skipSpaces(valuesSource, parsed.index);
      const delimiter = valuesSource[index];
      if (columnIndex < columns.length - 1) {
        if (delimiter !== ',') throw new Error(`Expected ',' for column ${columns[columnIndex]}.`);
        index += 1;
      } else {
        if (delimiter !== ')') throw new Error(`Expected ')' after column ${columns[columnIndex]}.`);
        index += 1;
      }
    }
    rows.push(Object.fromEntries(columns.map((column, columnIndex) => [column, values[columnIndex]])));
  }
  return rows;
}

function parseValue(source: string, start: number, type: string): { value: unknown; index: number } {
  let index = skipSpaces(source, start);
  if (source[index] === "'") {
    const parsed = parseQuoted(source, index + 1);
    return { value: parsed.value, index: parsed.index };
  }
  const tokenStart = index;
  while (index < source.length && source[index] !== ',' && source[index] !== ')') index += 1;
  const token = source.slice(tokenStart, index).trim();
  if (token.toUpperCase() === 'NULL') return { value: null, index };
  if (/^b'[01]'$/i.test(token)) return { value: token.slice(2, -1) === '1' ? 1 : 0, index };
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(token)) return { value: parseNumeric(token, type), index };
  return { value: token, index };
}

function parseQuoted(source: string, start: number): { value: string; index: number } {
  let value = '';
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      const escapes: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', '\\': '\\', "'": "'", '"': '"' };
      value += escapes[next] ?? next;
      index += 2;
      continue;
    }
    if (char === "'") {
      if (source[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      return { value, index: index + 1 };
    }
    value += char;
    index += 1;
  }
  throw new Error('Unterminated quoted value in SQL dump.');
}

function parseNumeric(token: string, type: string): number | string {
  if (/^(tinyint|smallint|mediumint|int|bigint)/.test(type) && Number.isSafeInteger(Number(token))) return Number(token);
  return token;
}

function skipWhitespaceAndSeparators(source: string, index: number): number {
  while (index < source.length && (source[index] === ',' || /\s/.test(source[index]))) index += 1;
  return index;
}

function skipSpaces(source: string, index: number): number {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

async function upsertBatch(
  collection: LegacyCollection,
  rows: Record<string, unknown>[],
  batchSize: number,
  sourceChecksum: string,
  importedAt: Date
): Promise<void> {
  const model = getLegacyModel(collection);
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await model.bulkWrite(batch.map((raw) => {
      const id = numericId(raw.id);
      const key = makeCompositeKey(collection, raw);
      return {
        updateOne: {
          filter: id ? { legacyId: id } : { legacyCompositeKey: key },
          update: {
            $set: id
              ? { legacyId: id, raw, legacySourceChecksum: sourceChecksum, legacyImportedAt: importedAt }
              : { legacyCompositeKey: key, raw, legacySourceChecksum: sourceChecksum, legacyImportedAt: importedAt },
            $unset: { archivedAt: 1 }
          },
          upsert: true
        }
      };
    }) as mongoose.AnyBulkWriteOperation<import('../db/legacy.js').LegacyRecord>[], { ordered: false });
  }
}

function numericId(value: unknown): number | null {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
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

function printSummary(summary: MigrationSummary): void {
  const entries = Object.entries(summary.tableCounts).sort(([left], [right]) => left.localeCompare(right));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  console.log(`\nMigration ${summary.dryRun ? 'dry-run ' : ''}summary`);
  console.log(`Source: ${summary.source}`);
  console.log(`Rows parsed: ${total}`);
  for (const [table, count] of entries) console.log(`  ${table}: ${count}`);
  if (summary.skippedTables.length) console.log(`Skipped non-app tables: ${summary.skippedTables.join(', ')}`);
  if (summary.assets) console.log(`Asset roots copied: ${summary.assets.copiedRoots.join(', ') || 'none'}`);
  if (summary.failures.length) console.log(`Failures: ${summary.failures.join('; ')}`);
}

void main().catch((error: unknown) => {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
