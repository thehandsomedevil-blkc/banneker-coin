# The Banneker Coin (BNKR)
### An Open Peer-to-Peer Monetary Protocol - Built From the Ground Up

> "The root problem with conventional currency is all the trust that's required to make it work."  
> - Satoshi Nakamoto, 2009

---

## Honoring Benjamin Banneker

**The Banneker Coin (BNKR)** honors Benjamin Banneker, the self-taught African American mathematician, astronomer, and clockmaker from Baltimore County, Maryland. His legacy of mathematical rigor, careful observation, and precise timekeeping inspires this open monetary protocol.

**Rooted in African American heritage, open to all.** BNKR is an invitation for anyone, anywhere to run a node, verify the ledger, and participate in a peer-to-peer network without permission.

---

## Why BNKR Exists

Nobody is coming to hand us ownership. Every traditional bank, payment app, and middleman sits between you and your own value - freezing accounts, taking cuts, and deciding who gets access.

BNKR strips all of that out as a sovereign, peer-to-peer digital cash network with:

- **No central mint** - nobody can print extra coins out of thin air.
- **No gatekeepers or KYC** - generate your own cryptographic keys locally in seconds.
- **No middlemen** - send value directly from wallet to wallet, verified by pure math and Proof-of-Work.
- **Open ledger** - every block, hash, and transfer is verifiable by anyone running a node.

---

## Protocol Rules (Locked in Code)

| Parameter | Specification |
| :--- | :--- |
| **Ticker** | `BNKR` |
| **Maximum Supply** | `21,000,000 BNKR` (Hard Cap) |
| **Initial Block Reward** | `50 BNKR` |
| **Halving Schedule** | Every `210,000` blocks (height-only; unchanged at V2) |
| **Consensus** | SHA-256 Proof-of-Work (Auto-adjusting difficulty) |
| **V2 Target Block Time** | `60` seconds (Era 1 remains frozen at `15` seconds) |
| **V2 Activation Height** | `2026` |
| **Mainnet Checkpoint 1** | Height `731` — `000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8` |
| **Signatures** | Ed25519 Client-Side Local Signing |
| **Official Seed Node** | `https://banneker-coin.onrender.com` |

---

## Run an Independent BNKR Node

No one grants a node its authority. A node earns it by checking every block, every signature, and the checkpoint that anchors the Era 1 chain. If the chain disagrees with the compiled rules, your node should refuse it — not ask you to trust it.

### 1. Get the Code

```bash
git clone https://github.com/thehandsomedevil-blkc/banneker-coin.git
cd banneker-coin
npm install
```

### 2. Connect to the Peer Network and Start

Quick-start form (replace `https://onrender.com` with the published seed URL for your deployment):

```bash
BANNEKER_PEERS=https://onrender.com npm start
```

Current published BNKR seed used by this repository:

```bash
BANNEKER_PEERS=https://banneker-coin.onrender.com npm start
```

Windows equivalents for the published seed:

```cmd
set BANNEKER_PEERS=https://banneker-coin.onrender.com && npm start
```

```powershell
$env:BANNEKER_PEERS="https://banneker-coin.onrender.com"; npm start
```

### 3. Verify From Your Own Node — Trust Nothing

Health must report `ok: true`, `accountsValid: true`, and a checkpoint digest. While your node is still below height 731, `checkpointState` is `NOT_YET_APPLICABLE`; once it has synced past the checkpoint it must be `APPLICABLE`.

```bash
curl -fsS http://127.0.0.1:4174/health \
  | jq '{ok, height, checkpointState, accountsValid, checkpointSetDigest}'
```

Confirm the compiled activation parameters ahead of V2 Activation Height `2026`:

```bash
curl -fsS http://127.0.0.1:4174/api/node \
  | jq '{v2ActivationHeight, coinbaseMaturity, targetBlockSeconds, halvingInterval, checkpointState}'
```

Verify Mainnet Checkpoint 1 directly from the synced blocks:

```bash
curl -fsS 'http://127.0.0.1:4174/api/peer/blocks?from=731&to=731&page=0' \
  | jq -r '.blocks[0].hash'
```

Expected output:

```text
000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8
```

### 4. Open Your Node Dashboard

Visit `http://localhost:4174` in your browser to:
- **Generate an Anonymous Wallet** (back up your private key JSON - your keys never leave your device).
- **Start Proof-of-Work Mining** directly from your browser worker.
- **Broadcast Peer-to-Peer Transfers** across the network.

---

## Verify Everything - Trust Nothing

- **Live Explorer & Seed Node:** [https://banneker-coin.onrender.com](https://banneker-coin.onrender.com)
- **Run Consensus & Security Tests:**
  ```bash
  npm test
  ```

---

> "Where I'm from, nothing is given - you learn early that if you don't own the foundation, you're just renting the floor. True freedom isn't asking for a seat at someone else's table; it's writing the rules of your own ledger in math nobody can break."  
> **- Handsome Devil (Baltimore)**

---

## License

The Banneker Coin (BNKR) is open-source software released under the [MIT License](LICENSE).

Copyright (c) 2026 Handsome Devil. Permission is granted to use, copy, modify, merge, publish, distribute, sublicense, and sell copies of this software, provided the copyright notice and permission notice are included in all copies or substantial portions. The software is provided "as is", without warranty of any kind.
