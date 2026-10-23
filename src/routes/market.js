import { Router } from 'express';

export function createMarketRouter({ marketSnapshotService, logger = console }) {
  const router = Router();

  // Read-only: serves the stored PostgreSQL snapshot and never calls external market APIs.
  router.get('/snapshot', async (_request, response) => {
    try {
      const snapshot = await marketSnapshotService.getLatestSnapshot();
      response.set('Cache-Control', 'public, max-age=60');
      response.json(snapshot);
    } catch (error) {
      logger.error('Market snapshot read failed.', { code: error?.code ?? 'UNKNOWN' });
      response.set('Cache-Control', 'no-store');
      response.status(503).json({
        status: 'unavailable',
        realtime: false,
        message: 'Market snapshot is temporarily unavailable.',
        instruments: [],
      });
    }
  });

  return router;
}
