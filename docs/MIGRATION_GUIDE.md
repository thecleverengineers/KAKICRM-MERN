# Safe migration guide

The importer was deliberately built as a copy operation. It does not connect to, modify, or delete anything in the legacy MySQL system.

## Pre-flight checklist

1. Keep the original ZIP and SQL dump unchanged.
2. Make one final MySQL dump and a file-system backup immediately before cut-over.
3. Ensure the legacy PHP directory supplied with `--assets` includes `uploads`, `storage`, and `public/uploads`.
4. Start with `--dry-run`; it parses every insert statement and reports counts without writing to MongoDB.
5. Run the live import only when the dry-run totals are expected.

## Command

```bash
npm run migrate:legacy -- \
  --sql /absolute/path/localhost.sql \
  --assets /absolute/path/kakicrm.store

npm run verify:legacy -- \
  --sql /absolute/path/localhost.sql
```

Optional flags:

- `--dry-run`: parse and validate only.
- `--database kaki_crm_modern`: choose a MongoDB database name when `MONGODB_URI` has no database name.
- `--skip-assets`: import SQL data only.

## Validation

The importer creates one `migration_runs` record containing source checksum, counts per table, copied file roots, and any parsing failures. It also tags every imported MongoDB record with the source checksum. Run `npm run verify:legacy` after the live import; it compares the source-matched migration run with the actual tagged MongoDB records and fails if even one row is missing. The data archive screen in the application exposes every migrated table for reconciliation.

## Rollback

Rollback is simply routing traffic back to the PHP/MySQL system. Because no legacy source is changed, no reverse conversion is required. Do not delete the MongoDB database until the new application has passed user acceptance testing and the agreed retention period.
