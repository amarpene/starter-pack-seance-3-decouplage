#!/usr/bin/env node

/**
 * Script Node.js autonome d'injection de 100 pings GPS simultanés (sans dépendance externe).
 * Usage : node scripts/inject-load-node.js
 */

const TARGET_URL = process.env.API_URL || 'http://localhost:3000/api/positions';
const TOTAL_PINGS = Number.parseInt(process.env.TOTAL_PINGS || '100', 10);
const LATENCY_LIMIT_MS = 10;

if (!Number.isInteger(TOTAL_PINGS) || TOTAL_PINGS <= 0) {
  throw new Error('TOTAL_PINGS must be a positive integer');
}

async function sendPing(index) {
  const payload = {
    driverId: `DRV-${Math.floor(Math.random() * 1500) + 1}`,
    latitude: +(48.8566 + (Math.random() - 0.5) * 0.1).toFixed(6),
    longitude: +(2.3522 + (Math.random() - 0.5) * 0.1).toFixed(6),
    timestamp: Date.now(),
  };

  const start = performance.now();
  try {
    const res = await fetch(TARGET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const duration = performance.now() - start;
    const data = await res.json();
    const serverTiming = res.headers.get('server-timing');
    const serverDuration = serverTiming?.match(/dur=([\d.]+)/)?.[1];
    return {
      success: res.status === 202,
      status: res.status,
      duration,
      serverDuration: serverDuration === undefined ? null : Number(serverDuration),
      data,
    };
  } catch (err) {
    const duration = performance.now() - start;
    return { success: false, error: err.message, duration };
  }
}

async function run() {
  console.log(` [Épreuve 1] Démarrage de l'injection en rafale de ${TOTAL_PINGS} requêtes vers ${TARGET_URL}...`);
  const globalStart = performance.now();

  const promises = Array.from({ length: TOTAL_PINGS }, (_, i) => sendPing(i + 1));
  const results = await Promise.all(promises);

  const totalTime = performance.now() - globalStart;
  const successes = results.filter((r) => r.success);
  const durations = results.map((r) => r.duration).sort((a, b) => a - b);
  const serverDurations = results
    .map((r) => r.serverDuration)
    .filter((duration) => duration !== null)
    .sort((a, b) => a - b);

  const p50 = durations[Math.floor(durations.length * 0.5)].toFixed(1);
  const p95 = durations[Math.floor(durations.length * 0.95)].toFixed(1);
  const p99 = durations[Math.floor(durations.length * 0.99)].toFixed(1);
  const underLimitCount = results.filter((result) => result.success && result.duration < LATENCY_LIMIT_MS).length;
  const serverP95 = serverDurations.length === TOTAL_PINGS
    ? serverDurations[Math.floor(serverDurations.length * 0.95)]
    : Number.POSITIVE_INFINITY;
  const serverUnderLimitCount = results.filter(
    (result) => result.success && result.serverDuration !== null && result.serverDuration < LATENCY_LIMIT_MS
  ).length;

  console.log('\n --- RÉSULTATS DU CRASH TEST (PIC DE CHARGE) ---');
  console.log(`Total requêtes envoyées : ${TOTAL_PINGS}`);
  console.log(`Succès (202 Accepted)  : ${successes.length}/${TOTAL_PINGS} (${((successes.length / TOTAL_PINGS) * 100).toFixed(0)}%)`);
  console.log(`Durée totale d'envoi    : ${totalTime.toFixed(1)} ms`);
  console.log(`Latence aller-retour p50: ${p50} ms`);
  console.log(`Latence aller-retour p95: ${p95} ms`);
  console.log(`Latence aller-retour p99: ${p99} ms`);
  console.log(`Réponses sous ${LATENCY_LIMIT_MS} ms : ${underLimitCount}/${TOTAL_PINGS}`);
  console.log(`Ingestions serveur sous ${LATENCY_LIMIT_MS} ms : ${serverUnderLimitCount}/${TOTAL_PINGS}`);
  console.log(`Ingestion serveur p95   : ${Number.isFinite(serverP95) ? serverP95.toFixed(2) : 'indisponible'} ms`);

  if (successes.length === TOTAL_PINGS && underLimitCount === TOTAL_PINGS) {
    console.log(`\n ÉPREUVE 1 VALIDÉE : ${TOTAL_PINGS}/${TOTAL_PINGS} pings répondent 202 en moins de ${LATENCY_LIMIT_MS} ms.`);
  } else {
    console.log(`\n ÉPREUVE 1 ÉCHOUÉE : il faut ${TOTAL_PINGS}/${TOTAL_PINGS} réponses 202 en moins de ${LATENCY_LIMIT_MS} ms.`);
    process.exitCode = 1;
  }
}

run();
