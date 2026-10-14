# Starter Pack — TP Découplage Temporel & Load Leveling

> **Module** : M1 — Architecture Logicielle, Design Patterns & Urbanisation SI  
> **Séance 3** : Boucle 4 — Résilience Distribuée & Load Leveling   

---

## Architecture du Lab

Vous disposez d'un environnement pré-orchestré sous Docker Compose :

1. **`api-producer` (Port 3000)** : API Fastify chargée de l'ingestion non-bloquante (< 10 ms).
2. **`broker` (Port 6379)** : Redis 7 servant de tampon élastique FIFO.
3. **`gps-worker`** : Consommateur asynchrone simulant un traitement lourd (50 ms / message) avec traitement de l'idempotence.

```text
Chauffeurs Mobile (250 req/s)
         │
         ▼ (HTTP POST /api/positions)
┌──────────────────┐  Réponse immédiate (HTTP 202)
│   api-producer   │───────────────────────────────► 📱 Chauffeur libéré (< 10ms)
└────────┬─────────┘
         │ Empilement BullMQ
         ▼
┌──────────────────┐
│   Redis Broker   │ (Tampon élastique - Absorbe les pics)
└────────┬─────────┘
         │ Dépilage régulé
         ▼
┌──────────────────┐
│    gps-worker    │ (Traitement lourd 50ms + Déduplication idempotente)
└──────────────────┘
```

---

## Démarrage Rapide

```bash
# 1. Démarrer les conteneurs
docker compose up -d --build

# 2. Vérifier l'état de santé
docker compose ps

# 3. Ouvrir un terminal pour surveiller le worker
docker compose logs -f gps-worker
```

---

## Les 4 Épreuves du Crash-Test

### Épreuve 1 — Le Pic de Charge (Load Leveling)

Lancez 100 requêtes simultanées depuis l'hôte :

```bash
node scripts/inject-load-node.js
```

Les requêtes acceptées reçoivent `202` dès leur mise en file ; le traitement
des positions est effectué ensuite par le worker. Consultez le backlog avec
`curl http://localhost:3000/metrics`. Le script affiche séparément la latence
aller-retour du client et le p95 d'ingestion serveur (en-tête `Server-Timing`) ;
le seuil du crash-test en rafale est inférieur à 50 ms côté serveur. La cible
nominale reste une ingestion inférieure à 10 ms hors forte contention.

---

### Épreuve 2 — Le Chaos Test (Panne du Worker)

Arrêtez le worker sans arrêter Redis ni l'API, puis injectez un lot de positions :

```bash
docker compose stop gps-worker
node scripts/inject-load-node.js
curl http://localhost:3000/metrics
```

Les appels doivent toujours recevoir `202` et le compteur `waiting` doit
augmenter. Redémarrez le worker :

```bash
docker compose start gps-worker
docker compose logs -f gps-worker
```

Les jobs persistés dans Redis sont repris et le backlog se résorbe. Pour tester
la reprise après un arrêt brutal, utilisez `docker compose kill gps-worker`
avant de le redémarrer.

---

### Épreuve 3 — L'Idempotence (Anti-Doublons)

Lancez le script qui envoie deux fois le même `pingId` :

```bash
node scripts/test-idempotence.js
docker compose logs -f gps-worker
```

BullMQ déduplique les jobs partageant cet identifiant ; un seul job doit être
traité. Le worker vérifie également un marqueur Redis conservé pendant
24 heures par défaut, ce qui protège contre une nouvelle livraison après le
retrait du job terminé de BullMQ.

---

### Épreuve 4 — Observabilité & Backlog Live 

`GET /metrics` expose les compteurs `waiting`, `active`, `delayed`, `failed`
et `completed` de la file `gps-pings`. Le worker traite au plus 5 jobs
simultanément et est limité à 100 démarrages de traitement par seconde par
défaut ; les valeurs peuvent être ajustées via `WORKER_CONCURRENCY` et
`WORKER_MAX_PER_SECOND`.
