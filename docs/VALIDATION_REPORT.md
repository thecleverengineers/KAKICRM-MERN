# Validation report

Validation was performed against the supplied `localhost.sql` dump and PHP archive on 10 August 2026.

| Check | Result |
| --- | --- |
| TypeScript static check (`npm run check`) | Passed |
| Production client and server build (`npm run build`) | Passed |
| Production dependency audit (`npm audit --omit=dev --audit-level=high`) | Passed; no vulnerabilities reported |
| SQL migration dry run | Passed |
| Parsed source rows | 4,572 across all populated KAKI CRM tables |
| Uploaded-file directories identified | `uploads`, `storage`, `public/uploads`, `public/logo` |

No live database import was performed during validation because no MongoDB deployment endpoint was provided. The live command is deliberately separate and must be run against a controlled MongoDB environment after the dry-run counts are approved.

```bash
npm run migrate:legacy -- \
  --sql /absolute/path/localhost.sql \
  --assets /absolute/path/kakicrm.store
```

The importer is idempotent and will upsert the same source rows on subsequent runs.
