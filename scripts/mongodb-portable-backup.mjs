#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import mongoose from 'mongoose';
import { EJSON } from 'bson';

const [command, target] = process.argv.slice(2);
const uri = process.env.MONGODB_URI;
if (!uri || !['backup', 'restore'].includes(command) || !target) {
  console.error('Usage: MONGODB_URI=... mongodb-portable-backup.mjs backup|restore DIRECTORY');
  process.exit(2);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000, maxPoolSize: 4 });
const db = mongoose.connection.db;
if (!db) throw new Error('MongoDB connection did not expose a database.');

try {
  if (command === 'backup') await backup(db, path.resolve(target));
  else await restore(db, path.resolve(target));
} finally {
  await mongoose.disconnect();
}

async function backup(db, directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name).sort();
  const manifest = { format: 1, database: db.databaseName, createdAt: new Date().toISOString(), collections: [] };

  for (const name of collections) {
    const encoded = Buffer.from(name).toString('base64url');
    const collection = db.collection(name);
    const dataFile = `${encoded}.ndjson`;
    const indexFile = `${encoded}.indexes.json`;
    const writer = createWriteStream(path.join(directory, dataFile), { mode: 0o600 });
    let count = 0;
    for await (const document of collection.find({}, { noCursorTimeout: true }).batchSize(500)) {
      if (!writer.write(`${EJSON.stringify(document, { relaxed: false })}\n`)) await new Promise((resolve) => writer.once('drain', resolve));
      count += 1;
    }
    await new Promise((resolve, reject) => { writer.end(resolve); writer.once('error', reject); });
    const indexes = await collection.indexes().catch(() => []);
    await writeFile(path.join(directory, indexFile), EJSON.stringify(indexes, { relaxed: false, indent: 2 }), { mode: 0o600 });
    manifest.collections.push({ name, dataFile, indexFile, documents: count });
    console.log(`Backed up ${name}: ${count} documents`);
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

async function restore(db, directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.collections)) throw new Error('Unsupported MongoDB portable backup format.');
  const expectedFiles = new Set(await readdir(directory));
  for (const item of manifest.collections) {
    if (typeof item.name !== 'string' || typeof item.dataFile !== 'string' || !expectedFiles.has(item.dataFile)) throw new Error('Backup manifest contains an invalid collection entry.');
  }

  // Drop only after every manifest entry has passed structural validation.
  const current = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const item of current) await db.collection(item.name).drop().catch((error) => { if (error?.codeName !== 'NamespaceNotFound') throw error; });

  for (const item of manifest.collections) {
    const collection = db.collection(item.name);
    const input = readline.createInterface({ input: createReadStream(path.join(directory, item.dataFile)), crlfDelay: Infinity });
    let batch = [];
    let count = 0;
    for await (const line of input) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length >= 500) { await collection.insertMany(batch, { ordered: true }); count += batch.length; batch = []; }
    }
    if (batch.length) { await collection.insertMany(batch, { ordered: true }); count += batch.length; }
    if (item.indexFile && expectedFiles.has(item.indexFile)) {
      const indexes = EJSON.parse(await readFile(path.join(directory, item.indexFile), 'utf8'), { relaxed: false });
      for (const index of indexes) {
        if (index.name === '_id_') continue;
        const { key, name, v: _v, ns: _ns, background: _background, ...options } = index;
        await collection.createIndex(key, { ...options, name });
      }
    }
    console.log(`Restored ${item.name}: ${count} documents`);
  }
}
