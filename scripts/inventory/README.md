# Inventory scripts (READ-ONLY)

All scripts in this directory are strictly read-only. They must never write,
delete, or modify any data, and they must never print secret values. Outputs
go to stdout (or a caller-chosen file) and are safe to attach to migration
reports after review.

## Scripts

- `inventory-source-db.sh` — inventories the legacy Coins PostgreSQL database
  (schemas, tables, row counts, constraints, indexes, sequences, extensions,
  timestamp bounds, null/integrity anomaly counts). Connects with a read-only
  transaction. No PII values are selected — only counts, aggregates, and
  structural metadata.
- `inventory-supabase.sh` — inventories the shared self-hosted Supabase
  PostgreSQL (existing schemas, extensions, publications, roles, and whether
  the `coins` schema name is free). Additive-change safety check before any
  migration is applied there.

## Usage

```bash
# Legacy source DB (uses PG* env or COINS_SOURCE_DATABASE_URL)
PGDATABASE=coins PGUSER=jd ./scripts/inventory/inventory-source-db.sh

# Supabase instance (use a read-capable connection; never the service key in shell history)
SUPABASE_DB_URL='postgresql://...@.../postgres' ./scripts/inventory/inventory-supabase.sh
```

Outputs are plain text + SQL result grids. Review before sharing.
