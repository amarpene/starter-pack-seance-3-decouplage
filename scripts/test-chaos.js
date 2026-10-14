#!/usr/bin/env node

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const TOTAL_PINGS = 50;

async function run() {
  const before = await fetch(`${API_BASE_URL}/metrics`);
  if (!before.ok) {
    throw new Error(`Metrics endpoint returned HTTP ${before.status}`);
  }
  const beforeCounts = await before.json();

  const results = await Promise.all(
    Array.from({ length: TOTAL_PINGS }, async (_, index) => {
      const response = await fetch(`${API_BASE_URL}/api/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pingId: `chaos_${Date.now()}_${index}`,
          driverId: `DRV-CHAOS-${index}`,
          latitude: 48.8566,
          longitude: 2.3522,
          timestamp: Date.now(),
        }),
      });
      return { status: response.status, body: await response.json() };
    })
  );

  const accepted = results.filter((result) => result.status === 202);
  if (accepted.length !== TOTAL_PINGS) {
    throw new Error(`Expected ${TOTAL_PINGS} HTTP 202 responses, got ${accepted.length}/${TOTAL_PINGS}`);
  }

  const after = await fetch(`${API_BASE_URL}/metrics`);
  if (!after.ok) {
    throw new Error(`Metrics endpoint returned HTTP ${after.status}`);
  }
  const afterCounts = await after.json();
  const queuedDelta = afterCounts.waiting - beforeCounts.waiting;
  if (queuedDelta < TOTAL_PINGS) {
    throw new Error(`Expected at least ${TOTAL_PINGS} additional waiting jobs, got ${queuedDelta}`);
  }

  console.log(`CHAOS TEST: ${accepted.length}/${TOTAL_PINGS} responses were HTTP 202.`);
  console.log(`Waiting jobs increased by ${queuedDelta} (${beforeCounts.waiting} -> ${afterCounts.waiting}).`);
  console.log('Redis retained the jobs while the worker was stopped.');
}

run().catch((err) => {
  console.error('[Chaos test failed]', err);
  process.exitCode = 1;
});
