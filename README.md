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
le critère strict est de recevoir les 100 réponses `202` en moins de 10 ms
chacune. Le script échoue explicitement si une requête manque le seuil.
Sur Docker Desktop Windows, le dernier essai a accepté les 100 requêtes, mais
0/100 réponses aller-retour sont restées sous 10 ms (p95 : 282 ms) ; le p95
mesuré par l'API était de 35,53 ms. Le critère de latence n'est donc pas validé
sur cet environnement, même si l'acceptation asynchrone fonctionne. Il faut
rejouer la mesure sur l'environnement cible avant de revendiquer ce SLA.

---

### Épreuve 2 — Le Chaos Test (Panne du Worker)

Arrêtez le worker sans arrêter Redis ni l'API, puis injectez un lot de positions :

```bash
docker compose stop gps-worker
node scripts/test-chaos.js
```

Le test vérifie 50 réponses `202` et l'augmentation de `waiting` pendant que
le worker est arrêté. Redémarrez le worker :

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

Les deux requêtes créent deux jobs ; le worker doit en traiter un et ignorer
l'autre. Le worker vérifie un marqueur Redis conservé pendant 24 heures par
défaut. Avant le traitement, un script Lua Redis prend un verrou atomiquement ;
un doublon déjà traité est acquitté sans réexécuter le traitement, tandis
qu'un verrou actif provoque une nouvelle tentative BullMQ. Les métriques
`processed` et `duplicates` permettent de vérifier ces résultats.

---

### Épreuve 4 — Observabilité & Backlog Live 

`GET /metrics` expose les compteurs `waiting`, `active`, `delayed`, `failed`
et `completed` de la file `gps-pings`. Le worker traite au plus 5 jobs
simultanément et est limité à 100 démarrages de traitement par seconde par
défaut ; les valeurs peuvent être ajustées via `WORKER_CONCURRENCY` et
`WORKER_MAX_PER_SECOND`.
