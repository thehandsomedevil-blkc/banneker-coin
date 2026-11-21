# BNKR Multi-Node Recovery Runbook

Goal: converge all three live services onto the canonical chain served by
`https://banneker-coin.onrender.com`, while preserving every fail-closed and
Satoshi-style consensus property.

## Situation

| Service | Current chain | Role |
|---|---:|---|
| `https://banneker-coin.onrender.com` | height 2858, checkpoints `APPLICABLE` | **Canonical source of truth** |
| `https://the-black-coin.onrender.com` | divergent height 106 | Must be reset and resynced |
| `https://banneker-coin-node-b.onrender.com` | divergent height 106 | Must be reset and resynced |

The two divergent nodes cannot adopt the canonical chain because their local
106-block history diverges from the canonical chain by more than
`MAX_REORG_DEPTH = 100`. The sync error is:

```text
Peer chain reorganization exceeds the 100-block safety limit.
```

That guard is intentional. Do **not** lower it.

`the-black-coin` also returned HTTP 400 on `POST /api/peers` because it had no
public `PUBLIC_URL`, so it advertised the internal default
`http://0.0.0.0:$PORT`. The receiving node correctly rejected that as
self-peering. The code now skips outbound registration when no valid public
HTTPS origin is configured, instead of emitting an internal identity.

## Safety rules

1. Never edit or overwrite an existing production `.db` file.
2. Never set `ALLOW_LOCAL_PEERS=true` on a public node.
3. Never change genesis, network ID, checkpoints `731`/`2500`, or V2 height `5000`.
4. Never lower `MAX_REORG_DEPTH`.
5. Never put Turso tokens, wallet phrases, or private keys in code or chat.

## Step 1 — Create two brand-new empty Turso databases

Create one fresh database for each divergent node. They must contain **0 blocks**.

```bash
turso db create bnkr-black-coin
turso db show bnkr-black-coin --url
turso db tokens create bnkr-black-coin

turso db create bnkr-node-b
turso db show bnkr-node-b --url
turso db tokens create bnkr-node-b
```

Keep the returned URL and token private. Use them only in the Render dashboard
environment variables.

## Step 2 — Set Render environment variables

### Canonical: `banneker-coin`

Keep the existing Turso database that contains the 2858-block chain.

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://banneker-coin.onrender.com` |
| `SEED_PEERS` | `https://the-black-coin.onrender.com,https://banneker-coin-node-b.onrender.com` |
| `TURSO_DATABASE_URL` | existing canonical DB URL — do not change |
| `TURSO_AUTH_TOKEN` | existing canonical token — do not change |
| `ALLOW_LOCAL_PEERS` | `false` |
| `NODE_ENV` | `production` |

`SEED_PEERS` on the canonical node is optional but recommended once the other
two services are ready.

### Fresh node: `the-black-coin`

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://the-black-coin.onrender.com` |
| `SEED_PEERS` | `https://banneker-coin.onrender.com` |
| `TURSO_DATABASE_URL` | the new empty `bnkr-black-coin` URL |
| `TURSO_AUTH_TOKEN` | the new `bnkr-black-coin` token |
| `ALLOW_LOCAL_PEERS` | `false` |
| `NODE_ENV` | `production` |

### Fresh node: `banneker-coin-node-b`

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://banneker-coin-node-b.onrender.com` |
| `SEED_PEERS` | `https://banneker-coin.onrender.com` |
| `TURSO_DATABASE_URL` | the new empty `bnkr-node-b` URL |
| `TURSO_AUTH_TOKEN` | the new `bnkr-node-b` token |
| `ALLOW_LOCAL_PEERS` | `false` |
| `NODE_ENV` | `production` |

`PORT` is injected by Render; do not hard-code it.

## Step 3 — Redeploy

1. Save the env vars in Render.
2. Trigger a manual deploy for each of the three services, or wait for auto-deploy.
3. The two fresh nodes will:
   - create the schema,
   - detect 0 blocks,
   - seed **only** the compiled deterministic genesis because `SEED_PEERS` is set,
   - register themselves with the canonical peer,
   - pull the full canonical chain through the paged sync endpoint.

Allow several minutes for 2858 blocks to sync.

## Step 4 — Verify

Run read-only checks:

```bash
curl -s https://banneker-coin.onrender.com/api/node
curl -s https://banneker-coin.onrender.com/health
curl -s https://banneker-coin.onrender.com/api/peers
curl -s https://banneker-coin.onrender.com/api/state

curl -s https://the-black-coin.onrender.com/api/node
curl -s https://the-black-coin.onrender.com/health
curl -s https://the-black-coin.onrender.com/api/peers
curl -s https://the-black-coin.onrender.com/api/state

curl -s https://banneker-coin-node-b.onrender.com/api/node
curl -s https://banneker-coin-node-b.onrender.com/health
curl -s https://banneker-coin-node-b.onrender.com/api/peers
curl -s https://banneker-coin-node-b.onrender.com/api/state
```

Expected on all three:

- same `sourceCommit`, `76c7825...` or newer
- `height >= 2858` and identical across all nodes
- identical `latestBlock.hash`
- `peers >= 1`
- each node lists the other two URLs in `/api/peers`
- `lastError: null` for every peer
- checkpoints `731` and `2500` with state `APPLICABLE`
- `checkpointState: APPLICABLE`
- `accountsValid: true`
- `healthy: true`

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `reorganization exceeds the 100-block safety limit` | The node was not started from an empty DB | Recreate that node's Turso DB; do not lower the guard |
| HTTP 400 `A node cannot peer with itself` | `PUBLIC_URL` missing/internal | Set the exact external HTTPS URL |
| Peer never appears in `/api/peers` | Registration skipped or failed | Check `PUBLIC_URL`, `SEED_PEERS`, and `/health` |
| `REMOTE_STORAGE_UNAVAILABLE` | Wrong Turso URL/token or network failure | Verify the new DB URL/token; never fall back to local SQLite |
| `NOT_YET_APPLICABLE` checkpoints | Height is still below 731 | Wait for sync to finish; verify tip hash |

## Properties preserved

- Proof of work and canonical difficulty rules
- Fixed 21,000,000 BNKR supply and halving schedule
- Deterministic compiled genesis and network ID
- Checkpoints `731` and `2500`
- V2 activation height `5000`
- Fail-closed remote storage
- SSRF-protected, screened, pinned peer transport
- Encrypted wallet vault
- Full security-header set
- Peer fault banning
- Build provenance reporting
