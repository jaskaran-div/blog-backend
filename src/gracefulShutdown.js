export function createGracefulShutdown({
  server,
  scheduledJob,
  pool,
  waitForNewsletterProcessing,
  logger = console,
}) {
  let shutdownPromise;
  return function shutdown(signal) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      logger.info(`Received ${signal}; closing newsletter service.`);
      scheduledJob.stop();
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } catch {
        logger.error('Could not close the HTTP server cleanly.');
        process.exitCode = 1;
      }
      try {
        await waitForNewsletterProcessing();
      } catch {
        logger.error('Could not finish scheduled newsletter processing.');
        process.exitCode = 1;
      }
      try {
        await pool.end();
      } catch {
        logger.error('Could not close the database pool cleanly.');
        process.exitCode = 1;
      }
    })();
    return shutdownPromise;
  };
}
