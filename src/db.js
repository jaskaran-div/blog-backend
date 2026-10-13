import mysql from 'mysql2/promise';

const { createPool } = mysql;

export function createDatabase(config) {
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
