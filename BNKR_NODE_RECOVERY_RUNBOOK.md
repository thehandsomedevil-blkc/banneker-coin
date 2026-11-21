# BNKR Multi-Node Verification & Recovery Runbook

Current state as of commit `a874d4a`: the three hosted BNKR services are converged
on the canonical chain and form a full mutual mesh. `https://banneker-coin.onrender.com`
remains the source of truth. These services are project-hosted; BNKR is **not yet
decentralized in the operator sense** until independent operators run their own
nodes. See [`NODE_OPERATOR_GUIDE.md`](NODE_OPERATOR_GUIDE.md).

## Current mesh

| Service | Height / status | Peers | Role |
|---|---|---|---|
| `https://banneker-coin.onrender.com` | 2858, checkpoints `APPLICABLE` | node-b, the-black-coin | Canonical source of truth |
| `https://the-black-coin.onrender.com` | 2858, checkpoints `APPLICABLE` | node-b, banneker-coin | Published seed; legacy hostname for the same rebranded BNKR project, but a distinct peer endpoint |
| `https://banneker-coin-node-b.onrender.com` | 2858, checkpoints `APPLICABLE` | banneker-coin, the-black-coin | Published seed |

The network ID is `BNKR-MAINNET-V1`, V2 activation is block `5000`, and the
mainnet checkpoints are `731` and `2500`. All three nodes report the same tip:
`0000351797b77d294d0aa23852f7235691d028981093b67e5eed0aeb32e14968`.

## Safety rules

1. Never edit or overwrite an existing production `.db` file.
2. Never change genesis, `BNKR-MAINNET-V1`, checkpoints `731`/`2500`, or V2 height `5000`.
3. Never lower `MAX_REORG_DEPTH = 100`.
4. Keep `ALLOW_LOCAL_PEERS=false` on public nodes.
5. Never put Turso tokens, wallet phrases, or private keys in code or chat.
6. Live verification is read-only GETs only. Render/Turso dashboard and env changes are applied by the operator, not by an assistant.

## Verify the live mesh — read-only

```bash
for NODE in \
  https://banneker-coin.onrender.com \
  https://the-black-coin.onrender.com \
  https://banneker-coin-node-b.onrender.com
do
  echo "=== $NODE ==="
  curl -fsS "$NODE/api/node"
  curl -fsS "$NODE/health"
  curl -fsS "$NODE/api/peers"
  curl -fsS "$NODE/api/state"
done
```

Expected on every node:

- HTTP `200` on `/api/node`, `/health`, `/api/peers`, and `/api/state`;
- `sourceCommit` is `a874d4a...` or newer;
- `networkId: "BNKR-MAINNET-V1"` and `v2ActivationHeight: 5000`;
- identical `height`, `latestBlock.hash`, `checkpointState`, and `accountsValid`;
- `height: 2858` at the current checkpoint, `checkpointState: "APPLICABLE"`;
- checkpoints `731` and `2500` both `APPLICABLE` with the canonical hashes below;
- `accountsValid: true` and `healthy: true`;
- exactly two peer entries, each with `lastError: null`;
- no node lists its own public URL as a peer.

Canonical checkpoint hashes:

```text
731  000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8
2500 000004f48c5efffd42058140ba6532eeff322a33871a030ce4aefb54bdc38dd7
```

## How peer healing works

- `PUBLIC_URL` is the exact external HTTPS origin peers use to reach a node. It is
  recommended because registration is what creates the reverse edge on another node.
- Peer discovery is pull-only: a node can still learn peers from peers it already
  has even when it cannot advertise a public URL. It does not need `PUBLIC_URL`
  to add learned peers locally.
- Registration is retried on a cooldown, so a failed startup POST self-heals without
  restarting the booted node.
- Transitive discovery asks known peers for their peer tables, screens candidates,
  verifies `/api/node` identity, and adds compatible origins locally.
- `/api/node` exposes a per-process `instanceId`. A node skips candidates with its
  own ID and prunes stored self-peer entries. This is why an external hostname does
  not become a self peer when `PUBLIC_URL` is missing.

With three nodes, expect exactly two peers per node. More operators should increase
that count; missing or asymmetric edges usually indicate a bad `PUBLIC_URL`, an
empty `SEED_PEERS`, blocked outbound HTTPS, or a node that has not completed its
retry/discovery pass yet.

## Recovery procedure if a node diverges

Use this only when verification shows a node on the wrong chain or with a deep
reorg error. Do not mutate a live database.

1. Create a fresh empty database for that service in the Turso dashboard. Keep the
   URL and token private.
2. In the Render dashboard, set that service's environment:

   | Key | Value |
   |---|---|
   | `PUBLIC_URL` | Exact external HTTPS origin for that service, no trailing slash |
   | `SEED_PEERS` | The other two live BNKR seed URLs, excluding the node's own URL |
   | `TURSO_DATABASE_URL` | The new empty database URL |
   | `TURSO_AUTH_TOKEN` | The new database token |
   | `ALLOW_LOCAL_PEERS` | `false` |
   | `NODE_ENV` | `production` |

   Example for `the-black-coin`:

   ```text
   PUBLIC_URL=https://the-black-coin.onrender.com
   SEED_PEERS=https://banneker-coin.onrender.com,https://banneker-coin-node-b.onrender.com
   ```

   Example for `banneker-coin-node-b`:

   ```text
   PUBLIC_URL=https://banneker-coin-node-b.onrender.com
   SEED_PEERS=https://banneker-coin.onrender.com,https://the-black-coin.onrender.com
   ```

3. Let the operator redeploy or restart through the dashboard. Render injects
   `PORT`; do not hard-code it.
4. A zero-block node seeds only compiled deterministic genesis, registers with its
   seeds, and pulls the canonical chain through the paged sync endpoint.
5. Re-run the read-only verification above.

If the error is
`Peer chain reorganization exceeds the 100-block safety limit`, the node was not
started from an empty DB or followed a divergent chain. Recreate it from a fresh
empty DB; do **not** lower `MAX_REORG_DEPTH`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `PUBLIC_URL is missing or not a public HTTPS origin` | Missing/internal advertised URL | Set the exact external HTTPS origin |
| `peers: 0` or one-way edge | Seeds unreachable, outbound HTTPS blocked, or registration not retried yet | Check `SEED_PEERS`, DNS, firewall, `/health`, and wait for the retry pass |
| A node lists itself as a peer | Stale self entry from before `instanceId` pruning | Redeploy commit `a874d4a` or newer; discovery prunes it |
| `reorganization exceeds the 100-block safety limit` | Non-empty DB followed a divergent chain | Start from a fresh empty DB; never lower the guard |
| `REMOTE_STORAGE_UNAVAILABLE` | Wrong Turso URL/token or network failure | Verify credentials; never silently fall back to local SQLite |
| `NOT_YET_APPLICABLE` checkpoints | Height is still below 731 | Wait for sync; compare tip hash with canonical |
| `accountsValid: false` or `healthy: false` | Local chain failed validation | Stop mining, resync from a fresh DB, verify tip and checkpoint hashes |

## Properties preserved

- SHA-256 Proof-of-Work and canonical difficulty rules
- Fixed 21,000,000 BNKR supply and halving schedule
- Deterministic compiled genesis and `BNKR-MAINNET-V1`
- Checkpoints `731` and `2500`
- V2 activation height `5000`
- `MAX_REORG_DEPTH = 100`
- Fail-closed remote storage
- SSRF-screened, identity-verified peer transport
- Encrypted wallet vault
- Full security-header set
- Peer fault banning
- Build provenance reporting
