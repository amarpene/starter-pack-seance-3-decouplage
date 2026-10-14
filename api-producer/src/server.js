import Fastify from 'fastify';
import { Queue } from 'bullmq';

const fastify = Fastify({ logger: true });

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

const gpsQueue = new Queue('gps-pings', {
  connection: {
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
  },
});

let pendingPositions = [];
let flushScheduled = false;

const flushPositionBatch = async () => {
  flushScheduled = false;
  const batch = pendingPositions;
  pendingPositions = [];

  try {
    const jobs = await gpsQueue.addBulk(
      batch.map(({ data }) => ({
        name: 'position',
        data,
        opts: {
          jobId: `ping-${encodeURIComponent(data.pingId)}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86400, count: 10000 },
          removeOnFail: { age: 604800 },
        },
      }))
    );
    batch.forEach((entry, index) => entry.resolve(jobs[index]));
  } catch (err) {
    batch.forEach((entry) => entry.reject(err));
  }

  if (pendingPositions.length > 0 && !flushScheduled) {
    flushScheduled = true;
    setImmediate(flushPositionBatch);
  }
};

const enqueuePosition = (data) =>
  new Promise((resolve, reject) => {
    pendingPositions.push({ data, resolve, reject });
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flushPositionBatch);
    }
  });

const pingSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['driverId', 'latitude', 'longitude', 'timestamp'],
    properties: {
      pingId: { type: 'string', minLength: 1, maxLength: 128 },
      driverId: { type: 'string', minLength: 1 },
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      timestamp: { type: 'integer' },
    },
  },
};

fastify.addHook('onClose', async () => {
  await gpsQueue.close();
});

fastify.post('/api/positions', { schema: pingSchema }, async (request, reply) => {
  const ingestionStartedAt = performance.now();
  const ping = request.body;
  const pingId = ping.pingId || `ping_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  try {
    await enqueuePosition({
      ...ping,
      pingId,
      receivedAt: new Date().toISOString(),
    });

    reply.header('Server-Timing', `ingest;dur=${(performance.now() - ingestionStartedAt).toFixed(2)}`);
    return reply.code(202).send({ accepted: true, pingId });
  } catch (err) {
    request.log.error({ err, pingId }, 'Failed to enqueue GPS position');
    return reply.code(503).send({ message: 'GPS ingestion queue is unavailable' });
  }
});

fastify.get('/metrics', async (request, reply) => {
  const counts = await gpsQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return { queue: 'gps-pings', ...counts };
});

fastify.get('/health', async () => {
  return { status: 'OK', uptime: process.uptime() };
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    fastify.close().catch((err) => {
      fastify.log.error(err, 'Failed to close API gracefully');
      process.exitCode = 1;
    });
  });
}

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`API Ingestion démarrée sur le port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
