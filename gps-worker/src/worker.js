import { Worker } from 'bullmq';
import Redis from 'ioredis';

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const processingDelayMs = parseInt(process.env.PROCESSING_DELAY_MS || '50', 10);
const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
const maxJobsPerSecond = parseInt(process.env.WORKER_MAX_PER_SECOND || '100', 10);
const dedupTtlSeconds = parseInt(process.env.DEDUP_TTL_SECONDS || '86400', 10);

for (const [name, value] of Object.entries({
  PROCESSING_DELAY_MS: processingDelayMs,
  WORKER_CONCURRENCY: concurrency,
  WORKER_MAX_PER_SECOND: maxJobsPerSecond,
  DEDUP_TTL_SECONDS: dedupTtlSeconds,
})) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

const redisClient = new Redis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: null,
});

console.log(`[Worker] Initialisation du consommateur asynchrone (${redisHost}:${redisPort})...`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const worker = new Worker(
  'gps-pings',
  async (job) => {
    const { pingId, driverId, latitude, longitude, timestamp, receivedAt } = job.data;
    const processedKey = `gps:processed:${encodeURIComponent(pingId)}`;

    if (await redisClient.exists(processedKey)) {
      console.log(`[Worker] DOUBLON DÉTECTÉ pour pingId: ${pingId}. Message ignoré.`);
      return { status: 'DUPLICATE', pingId };
    }

    await sleep(processingDelayMs);

    const markedProcessed = await redisClient.set(processedKey, '1', 'EX', dedupTtlSeconds, 'NX');
    if (markedProcessed === null) {
      console.log(`[Worker] DOUBLON DÉTECTÉ pour pingId: ${pingId}. Message ignoré.`);
      return { status: 'DUPLICATE', pingId };
    }

    console.log(
      `[Worker] Traité pingId=${pingId} driverId=${driverId} ` +
      `latitude=${latitude} longitude=${longitude} timestamp=${timestamp} receivedAt=${receivedAt}`
    );
    return { status: 'PROCESSED', pingId };
  },
  {
    connection: {
      host: redisHost,
      port: redisPort,
    },
    concurrency,
    limiter: { max: maxJobsPerSecond, duration: 1000 },
  }
);

worker.on('failed', (job, err) => {
  console.error(` [Worker] Échec sur le Job #${job?.id}: ${err.message}`);
});

worker.on('error', (err) => {
  console.error('[Worker] Erreur BullMQ:', err);
});

const shutdown = async () => {
  console.log('[Worker] Arrêt gracieux (Graceful Shutdown)...');
  await worker.close();
  await redisClient.quit();
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown().catch((err) => {
      console.error('[Worker] Échec de l’arrêt gracieux:', err);
      process.exitCode = 1;
    });
  });
}
