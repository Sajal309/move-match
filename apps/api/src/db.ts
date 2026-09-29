import { readFileSync } from 'node:fs';
import pg from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.js';

const databaseCaFile = process.env.DATABASE_SSL_CA_FILE?.trim();
const databaseCa = databaseCaFile ? readFileSync(databaseCaFile, 'utf8') : undefined;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 16,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 8_000,
  application_name: 'move-match-api',
  ssl: process.env.DATABASE_SSL === 'require'
    ? { rejectUnauthorized: true, ...(databaseCa ? { ca: databaseCa } : {}) }
    : undefined,
});

export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  retryStrategy: (attempt: number) => Math.min(attempt * 500, 5_000),
});

export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>, isolation: 'READ COMMITTED' | 'SERIALIZABLE' = 'READ COMMITTED') {
  const client = await pool.connect();
  try {
    await client.query(`begin isolation level ${isolation}`);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
