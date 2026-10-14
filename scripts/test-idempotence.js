#!/usr/bin/env node

/**
 * Script d'épreuve 3 : Démonstration de l'Idempotent Consumer
 * Envoie 2 fois exactement le même ping avec le même pingId à 1 seconde d'intervalle.
 */

const TARGET_URL = process.env.API_URL || 'http://localhost:3000/api/positions';
const API_BASE_URL = new URL(TARGET_URL).origin;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getMetrics() {
  const response = await fetch(`${API_BASE_URL}/metrics`);
  if (!response.ok) {
    throw new Error(`Metrics endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

async function run() {
  const baseline = await getMetrics();
  if (baseline.waiting !== 0 || baseline.active !== 0 || baseline.delayed !== 0) {
    throw new Error('Drain the queue before running the isolated idempotence test');
  }

  const duplicatePingId = `ping_idempotent_test_${Date.now()}`;
  const payload = {
    pingId: duplicatePingId,
    driverId: 'DRV-42-TEST',
    latitude: 48.8584,
    longitude: 2.2945,
    timestamp: Date.now(),
  };

  console.log(` [Épreuve 3] Test de résistance aux doublons (Idempotence)`);
  console.log(` Envoi du 1er ping avec ID : ${duplicatePingId}...`);

  const res1 = await fetch(TARGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data1 = await res1.json();
  console.log(` Réponse 1er ping : Status ${res1.status}`, data1);
  if (res1.status !== 202 || data1.pingId !== duplicatePingId) {
    throw new Error(`Expected first request to be accepted with pingId ${duplicatePingId}`);
  }

  console.log(` Attente de 1 seconde...`);
  await sleep(1000);

  console.log(` Envoi du 2nd ping IDENTIQUE (même pingId)...`);
  const res2 = await fetch(TARGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data2 = await res2.json();
  console.log(` Réponse 2nd ping : Status ${res2.status}`, data2);
  if (res2.status !== 202 || data2.pingId !== duplicatePingId) {
    throw new Error(`Expected duplicate request to be accepted with pingId ${duplicatePingId}`);
  }

  let metrics;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await sleep(100);
    metrics = await getMetrics();
    if (metrics.completed >= baseline.completed + 2) {
      break;
    }
  }

  if (
    metrics.completed !== baseline.completed + 2 ||
    metrics.processed !== baseline.processed + 1 ||
    metrics.duplicates !== baseline.duplicates + 1 ||
    metrics.waiting !== 0 ||
    metrics.active !== 0
  ) {
    throw new Error(
      `Expected 2 completed jobs (one processed, one duplicate); metrics: ${JSON.stringify(metrics)}`
    );
  }

  console.log('IDEMPOTENCE VALIDÉE : 2 jobs acquittés, 1 position traitée, 1 doublon ignoré côté worker.');
}

run().catch((err) => {
  console.error('[Idempotence test failed]', err);
  process.exitCode = 1;
});
