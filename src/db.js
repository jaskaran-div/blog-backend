import pg from 'pg';

export function createDatabase(config) {
  const { Pool } = pg;
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}
