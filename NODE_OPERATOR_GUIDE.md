# BNKR Node Operator Guide

This guide lets an external operator run a fully validating **The Banneker Coin (BNKR)** node and join the published peer mesh.

## Current network status

As of commit `a874d4a`, the three hosted nodes are converged and mutually connected:

| Field | Value |
|---|---|
| Brand | **The Banneker Coin (BNKR)** |
| Network ID | `BNKR-MAINNET-V1` |
| V2 activation height | `5000` (not yet reached; Era 1 rules still apply below it) |
| Mainnet checkpoints | `731` and `2500` |
| Canonical chain | `https://banneker-coin.onrender.com` |
| Published seeds | `https://banneker-coin.onrender.com`, `https://the-black-coin.onrender.com`, `https://banneker-coin-node-b.onrender.com` |

Those three nodes are one hosted cluster. **BNKR is not yet decentralized in the operational sense**: independent operators with separate hosts, databases, and keys are what make that claim true. By running your own node you help change that.

Never modify consensus constants, genesis, checkpoints, `MAX_REORG_DEPTH`, or V2 activation height. Never set `ALLOW_LOCAL_PEERS=true` on a public node.

---

## Option A — Docker (recommended)

### 1. Set your external HTTPS origin

Create a `.env` file next to `docker-compose.yml`:

```env
PUBLIC_URL=https://bnkr.example.com
BNKR_BIND=0.0.0.0
BNKR_PORT=4174
```

`PUBLIC_URL` must be the exact external HTTPS origin peers will use to reach you: no path, no trailing slash, no `localhost`, no private IP. If it is empty, the node still starts and learns peers transitively, but it cannot create the reverse registration edge on other nodes.

### 2. Start the node

```bash
docker compose up -d --build
```

The stack:

- preconfigures all three live seed URLs in `SEED_PEERS`,
- stores SQLite state in the persistent `bnkr-data` volume at `/data/bnkr.db`,
- exposes the node on host port `4174` by default,
- uses `ALLOW_LOCAL_PEERS=false` and `NODE_ENV=production`.

Stop with `docker compose down`. `docker compose down -v` deletes the chain data; do not use it unless you intend to resync from genesis.

### 3. Follow logs

```bash
docker compose logs -f bnkr-node
```

Look for `Registered with peer`, `Discovered peer`, and successful peer sync messages.

---

## Option B — Three-line Node.js quick start

On a host with Node.js 22+:

```bash
git clone https://github.com/thehandsomedevil-blkc/banneker-coin.git && cd banneker-coin
npm install && npm run build
PUBLIC_URL=https://bnkr.example.com SEED_PEERS=https://banneker-coin.onrender.com,https://the-black-coin.onrender.com,https://banneker-coin-node-b.onrender.com DB_PATH=$PWD/bnkr.db npm start
```

Windows PowerShell:

```powershell
git clone https://github.com/thehandsomedevil-blkc/banneker-coin.git; cd banneker-coin
npm.cmd install; npm.cmd run build
$env:PUBLIC_URL="https://bnkr.example.com"; $env:SEED_PEERS="https://banneker-coin.onrender.com,https://the-black-coin.onrender.com,https://banneker-coin-node-b.onrender.com"; $env:DB_PATH="$PWD\bnkr.db"; npm.cmd start
```

Use a path on persistent storage for `DB_PATH`. The repository `.db` files are local artifacts and are ignored by Git; never overwrite them.

---

## Port forwarding and HTTPS reverse proxy

The node listens on `0.0.0.0:4174` inside the container by default. Prefer terminating TLS at a reverse proxy and exposing only `443` publicly.

If the proxy runs on the same host, bind Docker to loopback:

```env
BNKR_BIND=127.0.0.1
BNKR_PORT=4174
```

### Caddy

```caddyfile
bnkr.example.com {
  reverse_proxy 127.0.0.1:4174
}
```

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name bnkr.example.com;

  ssl_certificate     /etc/letsencrypt/live/bnkr.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bnkr.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4174;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

If your proxy chain is not trusted, set `TRUST_PROXY_HOPS` to the exact number of trusted hops. Do not blindly trust arbitrary `X-Forwarded-For` values from the internet.

---

## Health and peer verification

Run these against your own node:

```bash
curl -fsS https://bnkr.example.com/health | jq '{ok, height, sourceCommit, storage, peers}'
curl -fsS https://bnkr.example.com/api/node | jq '{name, ticker, networkId, v2ActivationHeight, checkpointState, accountsValid, peers, sourceCommit}'
curl -fsS https://bnkr.example.com/api/peers | jq '.peers[] | {url, lastError}'
curl -fsS https://bnkr.example.com/api/state | jq '{height, checkpointState, accountsValid, healthy, tip: .latestBlock.hash}'
```

Expected:

- `ok: true`, `healthy: true`, `accountsValid: true`;
- `networkId: "BNKR-MAINNET-V1"`;
- `v2ActivationHeight: 5000`;
- `checkpointState: "APPLICABLE"` once past height `731`;
- height and tip hash matching the canonical node;
- peer entries for the published seed nodes, each with `lastError: null`;
- no entry for your own `PUBLIC_URL`.

Checkpoint hashes to verify directly:

```bash
curl -fsS 'https://bnkr.example.com/api/peer/blocks?from=731&to=731&page=0' | jq -r '.blocks[0].hash'
# 000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8

curl -fsS 'https://bnkr.example.com/api/peer/blocks?from=2500&to=2500&page=0' | jq -r '.blocks[0].hash'
# 000004f48c5efffd42058140ba6532eeff322a33871a030ce4aefb54bdc38dd7
```

If a peer is missing, confirm `PUBLIC_URL`, `SEED_PEERS`, outbound HTTPS, and `/health`. The node retries registration and also learns peers transitively from peers it already has.

---

## CLI mining

The CLI miner talks only to the node origin you give it. It never opens a wallet or a database.

### 1. Generate a miner key

```bash
node -e "const nacl=require('nacl'); const k=nacl.sign.keyPair(); console.log('PUBLIC='+Buffer.from(k.publicKey).toString('base64')); console.log('SECRET='+Buffer.from(k.secretKey).toString('base64'))"
```

Save `SECRET` offline. Only the `PUBLIC` value is passed to the miner; it is the address that receives the coinbase reward.

### 2. Mine one block

```bash
npm run mine -- --miner <PUBLIC_KEY_BASE64> --origin http://127.0.0.1:4174 --blocks 1
```

For continuous mining:

```bash
npm run mine -- --miner <PUBLIC_KEY_BASE64> --origin http://127.0.0.1:4174 --blocks 0
```

Press `Ctrl+C` to stop. The miner uses the same canonical preimage as the browser worker and respects Era 1 / V2 template shapes, so it cannot submit a block for the wrong network era.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `reorganization exceeds the 100-block safety limit` | Node was not started from an empty DB, or followed a divergent chain | Start from a fresh `DB_PATH`; never lower `MAX_REORG_DEPTH` |
| `PUBLIC_URL is not a public HTTPS origin` | Missing or internal advertised URL | Set your exact external HTTPS origin |
| `peers: 0` | Seeds unreachable or outbound HTTPS blocked | Check `SEED_PEERS`, DNS, firewall, and `/health` |
| `accountsValid: false` or `healthy: false` | Local chain failed validation | Stop mining, resync from a fresh DB, compare tip hash with canonical |
| `REMOTE_STORAGE_UNAVAILABLE` | Bad Turso URL/token | Fix the credentials; do not silently fall back to local SQLite in production |

---

## Safety checklist

- Keep `.db` files on a persistent volume; back them up while the node is stopped or with SQLite-aware tooling.
- Never commit `.env`, `.db`, or Turso tokens.
- Keep `ALLOW_LOCAL_PEERS=false` on any public node.
- Do not change genesis, `BNKR-MAINNET-V1`, checkpoints `731`/`2500`, or V2 height `5000`.
- Run `npm run build` and `npm test` before upgrading an operator node.
