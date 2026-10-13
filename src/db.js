import mysql from 'mysql2/promise';

const { createPool } = mysql;

export function createDatabase(config) {
<<<<<<< HEAD
  const pool = createPool({
    host: config.databaseHost,
    port: config.databasePort,
    user: config.databaseUser,
    password: config.databasePassword,
    database: config.databaseName,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 100,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    timezone: 'Z',
=======
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
>>>>>>> e7eef70 (database to neon)
  });
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'", (error) => {
      if (error) {
        console.error('Could not set the MySQL session timezone to UTC.', {
          code: error.code ?? 'UNKNOWN',
        });
        connection.destroy();
      }
    });
  });
  return pool;
}
