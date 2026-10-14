import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const processingDelayMs = parseInt(process.env.PROCESSING_DELAY_MS || '50', 10);
const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
const maxJobsPerSecond = parseInt(process.env.WORKER_MAX_PER_SECOND || '100', 10);
const dedupTtlSeconds = parseInt(process.env.DEDUP_TTL_SECONDS || '86400', 10);
const processingLockTtlSeconds = Math.max(30, Math.ceil(processingDelayMs / 1000) + 10);

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

const claimProcessingLock = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('INCR', KEYS[3])
    return 0
  end
  if redis.call('EXISTS', KEYS[2]) == 1 then
    return -1
  end
  redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2], 'NX')
  return 1
`;

const markProcessedAndReleaseLock = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
  end
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
  redis.call('INCR', KEYS[3])
  redis.call('DEL', KEYS[1])
  return 1
`;

const releaseProcessingLock = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

const worker = new Worker(
  'gps-pings',
  async (job) => {
    const { pingId, driverId, latitude, longitude, timestamp, receivedAt } = job.data;
    const keySuffix = encodeURIComponent(pingId);
    const processedKey = `gps:processed:${keySuffix}`;
    const lockKey = `gps:processing:${keySuffix}`;
    const duplicateCountKey = 'gps:duplicate:count';
    const processedCountKey = 'gps:processed:count';
    const lockToken = randomUUID();
    const claim = await redisClient.eval(
      claimProcessingLock,
      3,
      processedKey,
      lockKey,
      duplicateCountKey,
      lockToken,
      processingLockTtlSeconds
    );

    if (claim === 0) {
      console.log(`[Worker] DOUBLON DÉTECTÉ pour pingId: ${pingId}. Message ignoré.`);
      return { status: 'DUPLICATE', pingId };
    }
    if (claim !== 1) {
      throw new Error(`Processing lock is already held for pingId: ${pingId}`);
    }

    try {
      await sleep(processingDelayMs);

      const committed = await redisClient.eval(
        markProcessedAndReleaseLock,
        3,
        lockKey,
        processedKey,
        processedCountKey,
        lockToken,
        dedupTtlSeconds
      );
      if (committed !== 1) {
        throw new Error(`Processing lock expired before completion for pingId: ${pingId}`);
      }

      console.log(
        `[Worker] Traité pingId=${pingId} driverId=${driverId} ` +
        `latitude=${latitude} longitude=${longitude} timestamp=${timestamp} receivedAt=${receivedAt}`
      );
      return { status: 'PROCESSED', pingId };
    } catch (err) {
      await redisClient.eval(releaseProcessingLock, 1, lockKey, lockToken);
      throw err;
    }
  },
  {
    connection: {
      host: redisHost,
      port: redisPort,
    },
    concurrency,
    limiter: { max: maxJobsPerSecond, duration: 1000 },
    lockDuration: (processingLockTtlSeconds + 5) * 1000,
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
