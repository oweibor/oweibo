---
name: migration-safety
description: Write DB migrations that don't break the running application — additive first, narrowing later.
tags: [database, migrations, scope:starter]
applies_to: [general-coding]
---

# migration-safety

A migration is "safe" when the application can run uninterrupted against
both the old schema and the new schema simultaneously. That property
lets you roll out and roll back without downtime.

Rules of thumb:

1. **Add before subtract.** Add the new column / table / index first.
   Don't drop the old one until every running version of the app has
   stopped depending on it.
2. **Default everywhere.** A new NOT NULL column needs a default — or
   else inserts from the old app version will fail.
3. **Narrow with NOT VALID then VALIDATE.** Adding a CHECK constraint
   to a populated table? Use `ADD CONSTRAINT ... NOT VALID` then a
   separate `VALIDATE CONSTRAINT`. The validate pass takes a weaker
   lock.
4. **Index concurrently.** `CREATE INDEX CONCURRENTLY` avoids the
   write lock; pair with `IF NOT EXISTS` for safe re-runs.
5. **Backfill is its own migration.** Schema first, backfill second.
   The backfill should be idempotent and chunked.

Roll forward, not back, whenever possible. Reverting a schema change
is usually riskier than rolling forward to a fix.
