# `localhost(1).sql` migration validation

## Source snapshot

| Item | Verified value |
| --- | --- |
| SQL file | `localhost(1).sql` |
| SHA-256 | `7b26a3afe3d03fb2939d685dd2dabd4d90cf18cd15419cb16c39bd71ffd4e170` |
| Schema tables declared | 84 |
| MongoDB collection mappings | 84 |
| Populated source tables | 56 |
| SQL `INSERT` statements | 65 |
| Rows parsed by the production importer | 4,572 |
| Unmapped schema tables | 0 |
| Unmapped populated tables | 0 |
| Parser failures | 0 |
| Skipped populated tables | 0 |

The 28 remaining tables are present in the schema but contain no rows in this snapshot. Their MongoDB collections are still available, so later imports can populate them without a code change.

## Safe production import

Use the updated project on the MongoDB 8 / Node.js 24 server. The importer is idempotent: it upserts by original source ID (or a deterministic composite key where no ID exists), preserves every source column in `raw`, does not delete MongoDB records, and never writes to the SQL file or MySQL server.

```bash
cd /www/kaki

# Pause only the Node.js service so the target database is not changed during import.
pm2 stop kaki-crm

# Import every SQL row. Quote the filename if it still contains parentheses.
npm run migrate:legacy -- \
  --sql '/root/kaki-migration/localhost(1).sql' \
  --skip-assets \
  --batch-size 500

# This must report 4,572 expected rows and 4,572 tagged MongoDB rows.
npm run verify:legacy -- \
  --sql '/root/kaki-migration/localhost(1).sql'

pm2 restart kaki-crm --update-env
pm2 save
```

Open the completed application through the production HTTPS domain:

```text
https://www.kakicrm.store/
```

## Files and attachments

This SQL dump preserves all database records, including original paths for documents and uploads. It does not contain the binary file contents themselves. If the original PHP application's upload/storage directory is available, run a second idempotent import with its path instead of `--skip-assets`:

```bash
npm run migrate:legacy -- \
  --sql '/root/kaki-migration/localhost(1).sql' \
  --assets /root/kaki-migration/kakicrm.store \
  --batch-size 500
```

Run the verification command again after that import. Keep the original MySQL system, SQL dump, and upload directories unchanged until user acceptance testing is complete.
