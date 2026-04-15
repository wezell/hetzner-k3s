#!/usr/bin/env npx tsx
/**
 * migrate.ts — Run pending SQL migrations against the control-plane database.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx src/db/migrate.ts
 *
 * Migrations are plain SQL files in src/db/migrations/ named NNN_description.sql.
 * Applied migrations are tracked in a schema_migrations table.
 */

import postgres from 'postgres';
import fs from 'fs';
import path from 'path';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });

  try {
    // Ensure migration tracking table exists
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Discover migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Load already-applied versions
    const applied = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const appliedSet = new Set(applied.map((r) => r.version));

    let ranCount = 0;
    for (const file of files) {
      const version = file.replace('.sql', '');
      if (appliedSet.has(version)) {
        console.log(`  [skip] ${version}`);
        continue;
      }

      const sqlText = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      console.log(`  [run]  ${version}`);

      // Execute migration in a transaction
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlText);
        await tx`
          INSERT INTO schema_migrations (version) VALUES (${version})
        `;
      });

      console.log(`  [done] ${version}`);
      ranCount++;
    }

    if (ranCount === 0) {
      console.log('All migrations already applied — database is up to date.');
    } else {
      console.log(`Applied ${ranCount} migration(s).`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
