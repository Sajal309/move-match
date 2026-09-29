import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsPath = resolve(here, '../../../supabase/migrations');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('create schema if not exists app_meta');
    await client.query(`create table if not exists app_meta.schema_migrations (
      version text primary key, applied_at timestamptz not null default now()
    )`);
    const files = (await readdir(migrationsPath)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of files) {
      const exists = await client.query('select 1 from app_meta.schema_migrations where version = $1', [filename]);
      if (exists.rowCount) continue;
      const sql = await readFile(join(migrationsPath, filename), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into app_meta.schema_migrations(version) values ($1)', [filename]);
        await client.query('commit');
        process.stdout.write(`Applied ${filename}\n`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
