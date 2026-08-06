#!/usr/bin/env node
/**
 * create-auth-users.mjs — deterministic Auth identity provisioning (plan §6.2).
 *
 * Default mode uses the Supabase Admin API with strong random unusable
 * passwords; users later set real passwords via the recovery flow (Brevo
 * SMTP stays configured). Idempotent: keyed by legacy_identity_map +
 * validated email, never by caller-chosen UUIDs.
 *
 * Modes:
 *   --dry-run            print planned actions only (no API/DB writes)
 *   --local-stub         LOCAL TESTS ONLY: insert stub auth.users rows into a
 *                        disposable DB (harness schema) instead of Admin API
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node create-auth-users.mjs <exportdir> <out: identity-map.json> [--dry-run]
 *   PGDATABASE=coins_staging \
 *     node create-auth-users.mjs <exportdir> <out> --local-stub
 *
 * Never logs emails, passwords, or keys.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const localStub = args.includes('--local-stub');
const [exportdir, outFile] = args.filter((a) => !a.startsWith('--'));
if (!exportdir || !outFile) {
  console.error('usage: create-auth-users.mjs <exportdir> <out.json> [--dry-run|--local-stub]');
  process.exit(2);
}

const users = readFileSync(join(exportdir, 'users.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Load any previous map for idempotent reruns.
const existing = existsSync(outFile)
  ? JSON.parse(readFileSync(outFile, 'utf8'))
  : {};

if (dryRun) {
  const pending = users.filter((u) => !existing[String(u.legacy_user_id)]);
  console.log(`dry-run: ${users.length} legacy users, ${Object.keys(existing).length} already mapped, ${pending.length} to create`);
  process.exit(0);
}

const map = { ...existing };

if (localStub) {
  // Disposable-DB mode: direct stub insert, deterministic random UUIDs.
  const pg = (await import('pg')).default;
  const client = new pg.Client({
    host: process.env.PGHOST || '/var/run/postgresql',
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
  });
  await client.connect();
  try {
    for (const u of users) {
      const key = String(u.legacy_user_id);
      if (map[key]) continue;
      const id = randomUUID();
      await client.query(
        `INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [id, `legacy-${u.legacy_user_id}@staging.invalid`],
      );
      map[key] = id;
    }
  } finally {
    await client.end();
  }
  writeFileSync(outFile, JSON.stringify(map, null, 2));
  console.log(`local-stub: mapped ${Object.keys(map).length} identities`);
  process.exit(0);
}

// --- Real Admin API mode (staging/prod only; service key never logged) ---
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run/--local-stub)');
  process.exit(2);
}

let created = 0; let skipped = 0; let failed = 0;
for (const u of users) {
  const key = String(u.legacy_user_id);
  if (map[key]) { skipped += 1; continue; }
  const password = randomBytes(32).toString('base64url'); // unusable; reset flow later
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: u.email,
      password,
      email_confirm: true, // no mail until recovery is explicitly sent
      user_metadata: { product: 'coins', legacy_user_id: u.legacy_user_id, username: u.username },
    }),
  });
  if (!res.ok) {
    failed += 1;
    console.error(`create failed for legacy user ${u.legacy_user_id}: HTTP ${res.status}`);
    continue;
  }
  const body = await res.json();
  map[key] = body.id; // persist the RETURNED uuid (never caller-chosen)
  created += 1;
  // checkpoint after every create so a rerun is resumable
  writeFileSync(outFile, JSON.stringify(map, null, 2));
}
writeFileSync(outFile, JSON.stringify(map, null, 2));
console.log(`admin: created=${created} skipped=${skipped} failed=${failed}`);
process.exit(failed ? 1 : 0);
