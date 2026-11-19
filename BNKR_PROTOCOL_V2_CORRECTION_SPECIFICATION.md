# BNKR — Protocol V2 Correction Specification

## Independent Review Remediation — Design Only

**Project:** Banneker Koin (BNKR)
**Repository:** `https://github.com/thehandsomedevil-blkc/banneker-coin`
**Remediation input:** `BNKR_PROTOCOL_V2_INDEPENDENT_REVIEW.md` (5 blockers, 29 corrections C-01…C-29, 26 missing tests M-01…M-26)
**Specification under correction:** `BNKR_NETWORK_IDENTITY_PROTOCOL_V2_SPECIFICATION.md` (1,626 lines)
**Evidence inputs:** `BNKR_NETWORK_IDENTITY_PROTOCOL_AUDIT_2026-11-17.md`, `BNKR_PHASE1_REVIEW_AND_P0_PLAN_2026-11-17.md`, `SECURITY_AUDIT_PART_C_2026-11-17.md`, `BNKR_TURSO_PRODUCTION_DATABASE_AUDIT_2026-11-17.md`

> **STATUS: DESIGN ONLY. NOTHING IMPLEMENTED, MODIFIED, DEPLOYED, COMMITTED, OR EXECUTED.**
> This document corrects a *specification*. It does not correct a *network*. V2 is not implemented, not active, and not on testnet. BNKR is not network-bound, not isolated from BLKC, and not decentralized. No source file, database, genesis value, network identifier, checkpoint, activation height, or production configuration was changed. All three databases were SHA-256 verified before and after writing; see §22.6.
>
> **Baseline correction of record:** the `accountsValid` capability exists **only as an uncommitted working-tree change**. It is absent from commit `908c642` and therefore cannot exist in any deployed build produced from that commit. The original V2 specification's "verified baseline" partly describes the working tree, not production. §11 separates five baselines explicitly, and every capability claim below is labelled with the baseline it comes from.
>
> **Current-state note (2026-11-19).** The design-only review below remains the historical record. The current compiled configuration is `V2_ACTIVATION_HEIGHT = 5000` with Mainnet Checkpoints at heights `731` and `2500`; startup recovery uses a binary search over the rollback point instead of the old linear replay. §21.2, §21.3, and §21.9 are authoritative for current values. No mainnet database was modified.

### Label conventions

| Tag | Meaning |
|---|---|
| **[Verified]** | Confirmed against source, stored data, `HEAD`, or the working tree during this review. Line numbers are the working tree (`server/ledger.js`, 1,163 lines) unless `HEAD:` is stated. The working tree is uncommitted and may differ from `HEAD` (`908c642`, 875-line `ledger.js`). |
| **[Proposed]** | Normative requirement of this correction. Not implemented. |
| **[Unverified]** | Cannot be established read-only from this repository (production, Turso, Render, DNS). |
| **[Owner decision]** | Cannot be resolved by engineering evidence alone; recorded in §21. |
| **[Fiction]** | Fictional test input. Not a real key, block, hash, balance, or chain. |

### Document control

| Item | Value |
|---|---|
| Correction of | V2 specification §4, §5, §6, §7, §8, §9, §10, §13, §14, §15, §16, §17, §19, §20 |
| Original specification edited? | **No.** It remains the historical record. |
| Independent review edited? | **No.** |
| Source edited? | **No.** |
| Databases edited? | **No.** |
| Block/transaction submitted? | **No.** |
| Peer contacted or synchronized? | **No.** |
| Commits / pushes / branch changes? | **None.** |
| Q-1 selected? | **Yes — height 5000** (owner initially selected 2026 on 2026-11-18; compiled schedule postponed to 5000 on 2026-11-19; §21.2, §21.9). |
| Q-2 selected? | **Yes — Mainnet Checkpoints at heights 731 and 2500** (731 selected 2026-11-18; 2500 derived from the live chain and appended 2026-11-19; §21.3, §21.9). |
| V2 activated on mainnet? | **No.** The compiled activation height is 5000. The live Era 1 chain passed 2026 before the correction and had not reached 5000 on 2026-11-19. |
| Decentralization claimed? | **No.** |

---

## 1. Executive summary

### 1.1 The finding in one paragraph

The original V2 design has the right objective — bind network identity into the block hash, anchor history with checkpoints, and fail closed — and it states that objective with unusual discipline. But it is not yet a specification. It names two serialization functions it never defines (`canonical_array`, `canonical_reward`), validates a block object instead of the header projection the system actually hashes, verifies checkpoints by reading the very database field an attacker would rewrite, permits a later binary to replace checkpoint history, and asserts a production capability (`accountsValid`) that is not deployed. Those five defects are document defects, not implementation defects, and every one of them is resolvable on paper. This document resolves them.

### 1.2 What this document changes, and what it deliberately does not

**Changes (normative):**

1. One closed, versioned, network-bound **ASCII** serialization algorithm, with a single transaction projection and no undefined helper functions.
2. A **four-layer block model** that separates consensus header fields, derived fields, persistence metadata, and application metadata.
3. A checkpoint verification algorithm that **recomputes** every hash from stored block bytes and verifies ancestry, PoW, work, era, and network before work comparison.
4. An **append-only checkpoint continuity policy** with derivation-not-decree, publication-before-use, manifest digests, conflicting-release refusal, and operator rejection.
5. A **fail-closed, five-baseline** production model and a safe-refusal policy for unknown protocol versions.
6. A corrected **62-test matrix**, 26 missing adversarial tests, and 15 monetary-policy tests, with corrected threat mappings.
7. An honest **independent-node architecture** that states what does not exist yet.

**Does not change:**

- Genesis (`49f9e886…ebaa`), `NETWORK_ID` (`BNKR-MAINNET-V1`), `PROTOCOL_UPGRADE_HEIGHT` (136), `MAX_SUPPLY`, `INITIAL_REWARD`, `HALVING_INTERVAL`, `TARGET_BLOCK_SECONDS`, `ADJUSTMENT_INTERVAL`, `MAX_DIFFICULTY`, `MEDIAN_TIME_WINDOW`, `MAX_REORG_DEPTH`, reward rules, fee schedule, account model, or any stored block.
- The original V2 document or the independent review.
- Any production environment variable or deployment.
- Q-1 or Q-2 in the original design-only correction. They are now selected by owner decision in §21.9: Q-1 was originally `2026` and is now compiled as `5000`, and Q-2 now includes Mainnet Checkpoint 2 at height `2500`. The earlier "unresolved" text is retained as history, not as current status.

### 1.3 Blocker resolution summary

| Blocker | Finding | Resolution in this document | Status |
|---|---|---|---|
| **B-1** | `canonical_array` / `canonical_reward` undefined; §4.4 and §5.3 contradict each other and the vectors (R-01, C-01) | §3–§5: one authoritative algorithm; closed 11-field header; closed 7-field transaction projection; 12 worked vectors including transaction-bearing blocks | **RESOLVED AS SPECIFICATION** |
| **B-2** | Predicate 12 rejects every stored block and is vacuous because `headerOf` is a whitelist (R-02, C-02) | §6: four-layer model; validation applies to the projection for hashing and to the object for admission; `hash`/`chainWork` explicitly permitted; V1 persisted blocks never re-judged by V2 predicates | **RESOLVED AS SPECIFICATION** |
| **B-3** | Checkpoint verification trusts stored `block.hash` instead of recomputing (R-03, C-03) | §8: recompute from canonical JSON, verify height, header, hash, PoW, predecessor, full local ancestry, era, network, work; stored hash is never a trust input | **RESOLVED AS SPECIFICATION** |
| **B-4** | No checkpoint continuity across releases; a later binary can ratify a conflicting fork (R-04, C-05) | §9: append-only set, monotonic ancestry, derivation script, publication-before-use, manifest digest, conflict refusal, N-of-M attestation proposal, operator rejection | **RESOLVED AS SPECIFICATION; governance parameters are [Owner decision]** |
| **B-5** | Deployed build lacks `accountsValid`; baseline conflates deployed, `HEAD`, working tree, Phase 1, and V2 (R-05, C-19) | §11–§12: five-baseline evidence table; no capability called deployed without production evidence; fail-closed production design; build identity required | **RESOLVED AS SPECIFICATION; production facts remain [Unverified]** |

### 1.4 Readiness verdict

| Question | Verdict |
|---|---|
| Is the *specification* now complete enough for an independent implementer to build the serializer? | **Yes, conditionally.** §4 is total and testable; §5 supplies complete vectors. |
| Is the *specification* now complete enough to implement checkpoint validation? | **Yes, conditionally.** §8 is an algorithm; §9 supplies the governance rules. |
| Is the *specification* complete enough to implement monetary validation? | **Yes.** §15 specifies the existing rules and the tests; no economic rule is changed. |
| Is the *network* ready for implementation or testnet? | **No.** No second node, no second implementation, no measured miner diversity, no derived checkpoint, no deployment evidence. |
| Can BNKR survive founder disappearance today? | **No.** Nothing in the code calls the founder at runtime, but there is no distributable full node, no seed/discovery, no derivation script, and no second operator. |
| Is BNKR decentralized? | **No.** One hosted API, one database provider, one implementation, zero peers, founder-selected checkpoints. This document does not change that. |

**One-sentence verdict:** the corrections make V2 *implementable as a specification*; they do not make BNKR *independent as a network*, and no testnet should be scheduled until a second operator validates today's code and a second implementation reproduces the vectors.

### 1.5 Non-claims

This document does **not** claim that:

- V2 has been implemented, tested, deployed, or activated.
- Any checkpoint value is correct or final.
- Any activation height is safe.
- Any test has passed. Tests are specified, not executed.
- BNKR is decentralized, independent of BLKC today, or safe against a well-funded attacker.
- Cryptography can eliminate the need for human coordination at a contentious upgrade.

---

## 2. Original findings disposition matrix

Every finding from the independent review is dispositioned. Nothing is silently dropped. Disposition vocabulary:

| Disposition | Meaning |
|---|---|
| **Corrected** | Resolved normatively in this document; section cited. |
| **Alternative** | A different design is adopted and the trade-off is stated. |
| **Unresolved** | Cannot be resolved by this document; evidence or action still missing. |
| **Owner** | Requires the project owner to decide; options and consequences recorded in §21. |
| **Operational** | Depends on production facts that are not observable read-only. |

### 2.1 The five blockers (R-01…R-05 / C-01…C-05)

| Finding | Correction | Disposition | Where |
|---|---|---|---|
| **R-01** `canonical_array` / `canonical_reward` undefined; §4.4 vs §5.3 diverge; no transaction-bearing vector | **C-01** | **Corrected** — one algorithm, one transaction projection, 12 vectors including 1-tx and 2-tx blocks | §3, §4, §5 |
| **R-02** Predicate 12 rejects every stored block; vacuous against `headerOf` whitelist | **C-02** | **Corrected** — four-layer model; projection hashed, object admitted; `hash`/`chainWork` allowed; V1 persisted blocks exempt from V2 predicates | §6 |
| **R-03** Checkpoint verification trusts stored `block.hash` | **C-03** | **Corrected** — recompute, ancestry walk, PoW, work, era, network, then reject before work comparison | §8 |
| **R-04** No checkpoint continuity across releases | **C-05** | **Corrected** — append-only, monotonic ancestry, derivation, publication, manifest digest, conflict refusal | §9 |
| **R-05** Deployed build lacks `accountsValid`; baseline conflates five states | **C-19** | **Corrected as specification** — five baselines; no deployed claim without evidence; fail-closed production design | §11, §12 |

### 2.2 All 29 corrections

| ID | Required change (review) | Disposition | Resolution |
|---|---|---|---|
| C-01 | Define preimage; remove `canonical_array`/`canonical_reward`; add ≥1-tx vector | **Corrected** | §3.2, §4.4, §5 |
| C-02 | Predicate on 11-field projection; permit `hash`/`chainWork`; require all keys present | **Corrected** | §6.2–§6.5 |
| C-03 | Recompute checkpoint hash; stored hash never trusted | **Corrected** | §8.3 |
| C-04 | Replace "one hash authenticates ancestry" with exact procedure and cost | **Corrected** | §8.4 |
| C-05 | Monotonic checkpoint set; add never remove/alter; descend from all prior | **Corrected** | §9.2 |
| C-06 | Published, reproducible derivation script; any operator can compute | **Corrected** | §9.3, §13.4 |
| C-07 | Publication-before-use; checkpoint references a publicly visible block | **Corrected** | §9.4 |
| C-08 | Serializer throws on missing/`undefined`; `Number.isSafeInteger(version)` | **Corrected** | §4.7, §4.8 |
| C-09 | Make checkpoint cadence normative; tie to `MAX_REORG_DEPTH`; state unprotected range | **Corrected as rule; parameter [Owner decision]** | §9.5, Q-19 |
| C-10 | Three checkpoint states: not-yet-applicable / applicable / violated | **Corrected** | §8.5 |
| C-11 | Add calculation method, miner/operator/independence gates, cancel/delay procedure | **Corrected as procedure; values [Owner decision]** | §13.2, §13.3 |
| C-12 | Compare on highest common checkpoint; prefer superset peer; reject only mismatch | **Corrected** | §14.6 |
| C-13 | Define `protocolVersion` as maximum validated block version; `2` at activation | **Corrected** | §14.7 |
| C-14 | Define `MAX_CHAIN_BLOCKS`; cap against real size; stream/paginate before parse | **Corrected** | §14.8 |
| C-15 | Specify v1-compatibility mode and drop point; remove contradiction | **Corrected** | §14.9 |
| C-16 | Add `fromHeight`/paged headers+blocks; no unbounded full-chain GET | **Corrected** | §14.8 |
| C-17 | Fully specify signed challenge or remove TE-58 | **Corrected** | §14.10 |
| C-18 | Add state/supply commitment or state full-replay-only verification | **Alternative (documented)** — no state root in V2; full replay; deferred to Era 3 | §7.6, §15.2 |
| C-19 | Require Phase-1 hardening, build identifier, `accountsValid`, `/health`; record open risk | **Corrected as specification; deployment [Unverified]** | §11, §12 |
| C-20 | Document real issuance timeline; resolve Q-15 before monetary claims | **Corrected as documentation; intent [Owner decision]** | §15.6, Q-15 |
| C-21 | Add sync-only recovery below `CP-TIP-AT-RELEASE` | **Corrected** | §12.7 |
| C-22 | Split TE-62; old-binary truncation is expected behaviour | **Corrected** | §10.6, §16.10 |
| C-23 | "Deep reorgs never legitimate" only below newest checkpoint; analyse partition | **Corrected** | §14.5, §9.6 |
| C-24 | Remove `'blackcoin.db'` default and legacy env aliases | **Corrected** | §12.2 |
| C-25 | Build-time check against duplicate serializers/identifiers | **Corrected** | §7.4 |
| C-26 | Replace all 17 T-n→TE-n mappings with correct references | **Corrected** | §17 |
| C-27 | Fix `networkState` / `expectedDifficulty` window interaction | **Corrected, with a factual correction to the review** — the claimed throw is not reproducible; the real defects are an implicit window contract, an unenforced `minDifficulty` floor at non-adjustment heights above 136, and a wrong genesis branch | §14.11 |
| C-28 | Correct `validateChain` / `validateChainInternal` and other citations | **Corrected** | §7.5 |
| C-29 | Start replacement at highest verified checkpoint, re-apply suffix only | **Corrected** | §14.3 |

### 2.3 All 26 missing adversarial tests

| ID | Target | Disposition | Test placement |
|---|---|---|---|
| M-01 | Forged stored `hash` at checkpoint | **Added** | §16.11, TE-63 |
| M-02 | Reverse-ordered source keys | **Added** | §16.1.1, TE-64 |
| M-03 | Rolling-upgrade checkpoint sets | **Added** | §16.7, TE-65 |
| M-04 | Extra property on transaction | **Added** | §16.1.1, TE-66 |
| M-05 | `version: 2.0`, `null`, `true` | **Added** | §16.1.1, TE-67 |
| M-06 | Raw `validateChain` on foreign chain | **Added** | §16.3, TE-68 |
| M-07 | Chain shorter than `CP-PRE` | **Added** | §16.6, TE-69 |
| M-08 | DNS/redirect SSRF variants | **Added** | §16.7, TE-70 |
| M-09 | 200 MB peer chain body | **Added** | §16.7, TE-71 |
| M-10 | Reward = subsidy + 1; wrong recipient; fee as subsidy | **Added** | §16.12, MT-01/02/03 |
| M-11 | Two blocks claiming remaining supply | **Added** | §16.12, MT-09 and MT-14 |
| M-12 | `protocol_state` mismatch; checkpoint removed | **Added** | §16.6, TE-72 |
| M-13 | Zero-checkpoint build on mainnet | **Added** | §16.6, TE-73 |
| M-14 | MTP across era boundary | **Added** | §16.4, TE-74 |
| M-15 | v1 binary opens v2 DB | **Added as expected-behaviour harness** | §16.10, TE-62b |
| M-16 | Reorg 100/101/150 above checkpoint | **Added** | §16.4, TE-75 |
| M-17 | Duplicate JSON keys | **Added** | §16.1.1, TE-76 |
| M-18 | Homoglyph/trailing space/ZWJ network ID | **Added** | §16.1.1, TE-77 |
| M-19 | Pre-activation tip below `H` | **Added** | §16.6, TE-78 |
| M-20 | `chainWork` number/leading zeros/missing | **Added** | §16.2, TE-79 |
| M-21 | `transactions` null/string/10,001 | **Added** | §16.1.1, TE-80 |
| M-22 | `amount` + `amountUnits` agree/disagree | **Added** | §16.1.1, TE-81 |
| M-23 | `protocol_state` v2 but v1 tip | **Added** | §16.6, TE-82 |
| M-24 | Stale browser v1 serializer submits | **Added** | §16.5, TE-83 |
| M-25 | Stale backup below release checkpoint | **Added** | §16.6, TE-84 |
| M-26 | Sync-only recovery then assert S2–S5 | **Added** | §16.6, TE-85 |

All 26 are specified as **tests to be written and executed later**. None has been executed. No row claims a pass.

### 2.4 TE-18, TE-62, the mapping, and monetary tests

| Item | Original defect | Disposition | Corrected form |
|---|---|---|---|
| **TE-18** | Asserted `validateChain(BLKC) === valid:true`, which would let `/api/validate` report a foreign chain as valid while `replaceChain` refuses it | **Corrected** | `validateChain` includes identity. BLKC chain ⇒ `valid:false`, reason at `CP-PRE`; a separate audit-only `replayChain` may report per-block economic validity without identity. §16.3 |
| **TE-62** | Unsatisfiable: a v1 binary truncates a v2 DB via the repair loop; it does not refuse | **Corrected / split** | TE-62a: new binary + future-version DB ⇒ safe refusal, no repair. TE-62b: v1 binary + v2 DB ⇒ documented truncation harness, expected behaviour, never described as safe. §10.6 |
| **Threat→test mapping** | Every T-n mapped to TE-n by number; all 17 semantically wrong | **Corrected** | §17 gives the full corrected matrix; each test maps to a threat or invariant. |
| **Monetary-policy tests** | No reward, supply, fee, or inflation test existed | **Corrected** | §15.9, §16.12: MT-01…MT-15 plus reorg/supply tests. |
| **Activation/checkpoint decisions** | Q-1/Q-2 unresolved in the design-only correction | **Resolved by owner on 2026-11-18; current compiled schedule corrected 2026-11-19** | §21.2, §21.3, and §21.9 record activation `5000` and checkpoints at `731` and `2500`; the original evidence requirements remain an open independence gap, not a code gap. |

### 2.5 Owner decisions

| ID | Question | Disposition |
|---|---|---|
| Q-1 | `PROTOCOL_V2_HEIGHT` | **Resolved** — 5000 (owner initially selected 2026 on 2026-11-18; compiled schedule corrected 2026-11-19; §21.2, §21.9) |
| Q-2 | Which heights become checkpoints | **Resolved** — Mainnet Checkpoints at heights 731 and 2500 (731 selected 2026-11-18; 2500 derived from the live chain and appended 2026-11-19; §21.3, §21.9) |
| Q-3 | Merkle root in a future era | **Owner** — recommend no for V2; state root is separate (Q-18) |
| Q-4 | Peer authentication mandatory? | **Owner** — recommend mandatory for write endpoints (§14.10) |
| Q-5 | Transaction version / strict schema | **Owner** — V2 block-level strictness is mandatory regardless; tx-level version deferred |
| Q-6 | Public testnet and `networkId` | **Owner** — `BNKR-TESTNET-V1` proposed; must be compiled, not configured |
| Q-7 | Who operates the second node? | **Unresolved and blocking** — no second operator exists |
| Q-8 | Checkpoint publication channel | **Owner** — four channels plus derivation script (§9.4) |
| Q-9 | `MAX_REORG_DEPTH` policy | **Owner** — must be decided with cadence (Q-19); "retain 100" is unsafe by default |
| Q-10 | Should `/api/peer/*` remain public? | **Owner** — recommend authenticated and rate-limited |
| Q-11 | Rollback policy at `H` | **Owner** — recommend halt mining, read-only, sync-only recovery (§12.7) |
| Q-12 | "New network" vs "separated continuation" | **Owner** — recommend "separated continuation"; keep §20.1 claims policy |
| Q-13 | Checkpoint cadence and its tie to `MAX_REORG_DEPTH` | **Owner** — folded into Q-19 |
| Q-14 | Release/monotonicity policy and who may publish | **Corrected as rule; signer set open** (§9, Q-20) |
| Q-15 | Height-only halving or ~4-year target | **Resolved** — height-only, 210,000 blocks, 21M cap; no wall-clock halving (§21.9) |
| Q-16 | N-of-M checkpoint attestation required? | **Owner** — proposal in §9.7; Q-21 |
| Q-17 | Third-party serializer owner and due date | **Unresolved** — Q-22 |

New decisions introduced by this correction: **Q-18** state commitment, **Q-19** checkpoint cadence / reorg depth, **Q-20** release signing and reproducible-build trust root, **Q-21** checkpoint attestation scheme, **Q-22** third-party serializer owner, **Q-23** activation cancellation authority, **Q-24** V2 transaction canonicality strictness. All are in §21.

### 2.6 What remains unresolved

| Item | Why it cannot be closed here |
|---|---|
| Independent Q-2 derivation | The compiled anchor was derived once, read-only; a second party and publication channel remain |
| Q-7, Q-17, Q-22 | Require real people and organizations outside this repository |
| Q-19 | Cadence/reorg-depth policy remains a governance decision; Q-15 is resolved in §21.9 |
| U-1, U-2 | Production build and Turso backend are not observable read-only |
| Deployment evidence | No dashboard, CLI, token, or production access in this review |
| Second implementation | No non-JavaScript serializer exists |
| Miner/operator diversity | `peers: 0` at the last verified baseline |
| State commitment (R-20 / C-18) | Deliberately deferred; full replay remains the only balance-verification method |

---

## 3. Corrected V2 header schema

### 3.1 Design invariant

V2 adds **exactly two** fields to the historical header: `version` and `networkId`. Everything else is inherited in the same order, with the same names, and with the same meaning. The total is **11 consensus header fields**. [Proposed]

This is deliberate. Every additional field is another thing two implementations can disagree about. `height`, `timestamp`, `prevHash`, `difficulty`, `nonce`, `miner`, `transactions`, `reward`, and `message` are already committed by `headerOf:36-48`; changing their names or order would gratuitously invalidate history and tooling for zero security gain. [Verified]

### 3.2 Normative field table

Serialization order is normative. A V2 preimage emits these keys in exactly this sequence.

| # | Field | JSON type | Domain | Null? | Consensus role |
|---|---|---|---|---|---|
| 1 | `version` | integer | exactly `2`; `Number.isSafeInteger` | no | selects the serializer and commits the era |
| 2 | `networkId` | string | ASCII `^[A-Z0-9-]{1,64}$`; byte-equal to the compiled constant | no | binds the block to one network |
| 3 | `height` | integer | safe integer `≥ 1`; `= parent.height + 1` | no | era predicate and replay index |
| 4 | `timestamp` | integer | safe integer; Unix milliseconds; `> medianTimePast`; `≤ now + 120000` | no | MTP rule |
| 5 | `prevHash` | string | lowercase hex, exactly 64 chars | no | ancestry |
| 6 | `difficulty` | integer | safe integer `1..6`; equals `expectedDifficulty(history, height)` | no | PoW target |
| 7 | `nonce` | integer | safe integer `≥ 0` | no | PoW search |
| 8 | `miner` | string | canonical base64 of exactly 32 bytes (Ed25519 public key) | no | reward recipient binding |
| 9 | `transactions` | array | ≤ 10,000 elements; each exactly the 7-field V2 transaction projection (§4.4) | no | value transfer |
| 10 | `reward` | object | exactly `{recipient, amount}` in that key order (§4.5) | no | issuance |
| 11 | `message` | null | literal `null` | yes, always | historical/genesis compatibility |

**Genesis is not a V2 block.** Genesis remains `height 0`, `difficulty 0`, `miner null`, `reward null`, `transactions []`, and a non-null `message`, serialized by the V1 serializer exactly as at `genesisBlock:270-283`. V2 rules apply at heights `≥ H`, where `H ≥ 1`. [Verified for genesis; Proposed for V2]

### 3.3 Type definitions

| Name | Definition | Rejection condition |
|---|---|---|
| `safeInt` | `typeof n === "number" && Number.isSafeInteger(n)` | any string, float, `NaN`, `Infinity`, `-0` used as a distinct value, or unsafe integer |
| `canonicalDecimal` | `^(0\|[1-9][0-9]*)(\.[0-9]{0,7}[1-9])?$` | leading zeros, trailing zeros in the fraction, bare `1.`, exponent, `+`, `-`, more than 8 decimals |
| `b64key` | string; standard base64; decodes to exactly 32 bytes; re-encodes identically | wrong length, URL-safe alphabet without padding, non-canonical padding, whitespace |
| `b64sig` | string; standard base64; decodes to exactly 64 bytes; re-encodes identically | wrong length or non-canonical form |
| `hex64` | `^[0-9a-f]{64}$` | uppercase, short, long, `0x` prefix, non-hex |
| `networkId` | ASCII `^[A-Z0-9-]{1,64}$` and byte-equal to `LOCAL_NETWORK_ID` | empty, `null`, Unicode homoglyph, trailing space, zero-width joiner, case variant |
| `ascii` | every code unit `0x20..0x7E` | any non-ASCII character |

`canonicalDecimal` is stricter than the original specification's `/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/`. The stricter form removes the `"1.50"` versus `"1.5"` ambiguity: both represent the same atomic amount, but only `"1.5"` is canonical. V2 rejects the non-canonical form rather than silently normalizing it, because silent normalization makes the hash depend on which layer normalized first. [Proposed; see Q-24]

### 3.4 Era distinction

| Property | Era 1 (heights `0 … H−1`) | Era 2 (heights `≥ H`) |
|---|---|---|
| Serializer | `headerOf` 9 fields, byte-for-byte frozen (`:36-48`) | 11-field V2 serializer (§4) |
| Fields | `height, timestamp, prevHash, difficulty, nonce, miner, transactions, reward, message` | `version, networkId` + the same nine, in the same relative order |
| `version` | absent or numeric `1`; never emitted | exactly numeric `2`; required |
| `networkId` | absent; may be present in storage but never hashed | required, ASCII, byte-equal to local constant |
| Transaction form | historical raw form, including legacy fee-less transactions below 136 | closed 7-field projection only |
| Genesis | V1 serializer, `message` non-null | not applicable |

**Era 1 stored bytes must never be re-serialized through the V2 path.** The audit proved that adding `version`/`networkId` unconditionally changes 0 of 859 BNKR hashes only if the serializer ignores them; the moment the serializer includes them, every historical hash changes. The branch is therefore consensus-critical. [Verified: audit §4.3]

### 3.5 Deliberately excluded fields

| Field | Why excluded |
|---|---|
| `chainId`, `magic`, `protocolId` | Redundant with `networkId`; each adds a disagreement surface |
| `merkleRoot` | Changes the commitment mechanism and transaction ordering rules at the same time; belongs in a separate era (Q-3) |
| `stateRoot` / `supplyCommitment` | Not available without a state transition commitment; deferred (C-18, Q-18) |
| `hash` | Derived from the preimage; committing it is circular |
| `chainWork` | Derived cumulative value; not a header field |
| `receivedAt`, `peer`, `validatedAt` | Application metadata; must never influence consensus |
| `signature` on the header | Not part of BNKR's consensus model; peer authentication is separate (§14.10) |

### 3.6 Header object versus block object

The **header** is the 11-field projection. The **block** is the persisted object, which may also carry derived and metadata fields. Only the header is hashed. §6 defines the four layers and the exact validation boundary. This distinction is the resolution of R-02.

### 3.7 Size bounds

| Bound | Proposed value | Reason |
|---|---|---|
| `MAX_TX_PER_BLOCK` | 10,000 | matches original §4.2 and `verifyBlockTransactions` count bound |
| `MAX_BLOCK_PREIMAGE_BYTES` | 8 MiB | hard bound before hashing; 10,000 × ~500 B plus overhead stays below it |
| `MAX_NETWORK_ID_BYTES` | 64 | prevents pathological identifiers |
| `MAX_MESSAGE_BYTES` | 0 for V2 | `message` is `null` |
| `MAX_HEADER_JSON_DEPTH` | 3 | header → array → transaction; reward → two scalars |

A block whose serialized preimage exceeds 8 MiB is rejected before hashing. This is an admission bound, not a consensus economic rule.

**Conflict with the deployed parser.** `PROTECTION_STATUS.maxJsonBodyBytes` is `64 KiB` (`security.js:11`) and `express.json` applies it to **all** of `/api` (`index.js:162`). A V2 block between 64 KiB and 8 MiB is therefore admissible by consensus and unsubmittable through the current HTTP surface. The V2 block route needs its own parser with the 8 MiB bound (TE-92); the global limit must not be raised for every endpoint as a shortcut, because an 8 MiB bound on `/api/state` or `/api/tx` is a denial-of-service multiplier. Two parsers, two bounds, one shared validator.

---

## 4. Complete canonical serialization specification

### 4.1 The one authoritative definition

For a V2 header `h`, the preimage is:

```text
P(h) = "{"                                                            // U+007B
     + "\"version\":2"                                                // literal
     + ",\"networkId\":"   + Q(h.networkId)
     + ",\"height\":"      + I(h.height)
     + ",\"timestamp\":"   + I(h.timestamp)
     + ",\"prevHash\":"    + Q(h.prevHash)
     + ",\"difficulty\":"  + I(h.difficulty)
     + ",\"nonce\":"       + I(h.nonce)
     + ",\"miner\":"       + Q(h.miner)
     + ",\"transactions\":"+ A(h.transactions)
     + ",\"reward\":"      + R(h.reward)
     + ",\"message\":null"
     + "}"                                                            // U+007D
```

No whitespace. No trailing newline. No BOM. No length prefix. No domain tag. No alternative key order. The byte sequence is exactly `UTF8(P(h))`, and because every character in `P(h)` is ASCII (§4.10), that byte sequence is identical to the ASCII code units. [Proposed]

### 4.2 Encoding rules

| Property | Rule |
|---|---|
| Character encoding | UTF-8, no BOM, no normalization |
| Alphabet | every V2 string is ASCII; non-ASCII is rejected, never escaped |
| String quoting | double quotes around the exact bytes; no escaping is ever required under the V2 domains (§4.10) |
| Integer encoding | shortest decimal, no `+`, no leading zeros, `0` for zero, no exponent, no decimal point; all are `safeInt` |
| Float | forbidden everywhere, including `version`, amounts, fees, timestamps, nonces |
| Null | literal `null`; only `message`, and V2 requires it |
| Boolean | forbidden |
| Array | `[` + elements in their existing order, comma-separated, no spaces + `]`; empty is `[]` |
| Object | exactly two objects exist in a V2 header: the header itself and `reward`; both have fixed keys in fixed order |
| Duplicate keys | structurally impossible in the canonical writer; any parser that sees duplicate JSON keys must reject the input before validation (M-17) |
| Key normalization | none: no case folding, no trimming, no Unicode normalization |
| Trailing data | forbidden after the closing `}` |
| Canonicality | two implementations given the same semantic header must emit the same bytes, not merely equivalent JSON |

### 4.3 Header field order

The order is **1 `version`, 2 `networkId`, 3 `height`, 4 `timestamp`, 5 `prevHash`, 6 `difficulty`, 7 `nonce`, 8 `miner`, 9 `transactions`, 10 `reward`, 11 `message`**. It is not alphabetical, not insertion-order-dependent at the caller, and not configurable.

An implementation must construct the text explicitly. Relying on a general-purpose map serializer is permitted **only** if the serializer is configured to emit this exact order and to reject missing keys. `JSON.stringify` on an object literal in this order is one correct implementation in JavaScript; it is not the definition. The definition is the byte string in §4.1. [Proposed]

### 4.4 Transaction projection `T7`

V2 commits a **closed 7-field projection** for every transaction, in this order:

| # | Field | Type | Rule |
|---|---|---|---|
| 1 | `sender` | string | canonical base64, 32 bytes |
| 2 | `recipient` | string | canonical base64, 32 bytes; must differ from `sender` |
| 3 | `amount` | string | canonical decimal; atomic units `≥ 1,000,000` (0.01 BNKR) |
| 4 | `fee` | string | canonical decimal; atomic units `≥ 100,000` (0.001 BNKR) |
| 5 | `nonce` | integer | safe integer `≥ 1` |
| 6 | `timestamp` | integer | safe integer `> 0`, `≤ now + 120000` |
| 7 | `signature` | string | canonical base64, 64 bytes; verifies under `sender` |

Serialization of one transaction:

```text
T7(t) = "{" + "\"sender\":"    + Q(t.sender)
            + ",\"recipient\":"+ Q(t.recipient)
            + ",\"amount\":"   + Q(t.amount)
            + ",\"fee\":"      + Q(t.fee)
            + ",\"nonce\":"    + I(t.nonce)
            + ",\"timestamp\":"+ I(t.timestamp)
            + ",\"signature\":"+ Q(t.signature)
            + "}"
```

`A(txs) = "[" + join(",", txs.map(T7)) + "]"`.

**No other transaction field is permitted inside a V2 block.** In particular:

- `amountUnits` and `feeUnits` are **input aliases**, not V2 block fields. `verifyTransaction` accepts them at the API boundary only when they agree with the decimal field; the canonical block form contains `amount` and `fee` only.
- `legacy` transactions (no `fee`) are an Era 1 historical form. They are invalid at heights `≥ H` because `PROTOCOL_UPGRADE_HEIGHT = 136` is below any plausible `H`, and `verifyTransaction` already rejects fee-less transactions above 136 (`resolveTransactionAmounts:114-132`, `verifyBlockTransactions:305-338`). [Verified]
- Additional properties are rejected, not ignored. This directly closes M-04.
- A transaction object whose `amount` or `fee` is not canonical is rejected even if its signature verifies, because the projection would otherwise have to normalize it silently. The block builder must canonicalize **before** mining; the validator must require the raw object to equal its canonical projection.

This is a **stricter V2 admission rule**, not a change to the V1 transaction consensus rules. It is recorded as Q-24 because it changes what a V2 miner may put in a block. [Proposed]

### 4.5 Reward projection `R2`

```text
R2(r) = "{" + "\"recipient\":" + Q(r.recipient)
            + ",\"amount\":"   + Q(r.amount)
            + "}"
```

- Exactly two keys, in this order, no extras.
- `recipient` is canonical base64 of 32 bytes.
- `amount` is canonical decimal, including `"0"` if zero.
- `recipient` **must equal** `miner` for a non-genesis block; the serializer does not enforce this, the validator does (`validateBlock:367-369`).
- `amount` **must equal** `formatUnits(subsidy + fees)` for the block's replay state; the serializer does not enforce this, the validator does. [Verified for the rule; Proposed for V2 projection]

### 4.6 Message

`message` is the literal `null` for every V2 block. It is still present in the preimage because removing it would create a second structural difference between eras and because the historical validator requires it at `validateBlock:363`. A non-null V2 `message` is rejected before hashing. [Proposed]

### 4.7 Totality: never rely on `JSON.stringify` omission

The historical hazard is real: `JSON.stringify({a: undefined})` is `{}`, and `headerOf` with `networkId: undefined` produces a shorter preimage (R-11). The V2 serializer must be **total**:

```text
function serializeV2Header(h):
    requirePlainObject(h)
    requireExactKeys(h, [version, networkId, height, timestamp, prevHash,
                         difficulty, nonce, miner, transactions, reward, message],
                     allowDerived = false)
    require(h.version is safeInt and h.version == 2)
    require(h.networkId is string and matches ^[A-Z0-9-]{1,64}$)
    require(h.height is safeInt and h.height >= 1)
    require(h.timestamp is safeInt)
    require(h.prevHash matches ^[0-9a-f]{64}$)
    require(h.difficulty is safeInt and 1 <= h.difficulty <= 6)
    require(h.nonce is safeInt and h.nonce >= 0)
    require(isCanonicalB64(h.miner, 32))
    require(isArray(h.transactions) and length <= 10000)
    for t in h.transactions: requireExactKeys(t, T7_KEYS); require(T7types(t))
    requireExactKeys(h.reward, ["recipient","amount"])
    require(isCanonicalB64(h.reward.recipient, 32))
    require(isCanonicalDecimal(h.reward.amount))
    require(h.message === null)
    s = buildText(h)                      // §4.1, exact order
    require(length(UTF8(s)) <= 8*1024*1024)
    return s
```

Every failure is a typed rejection. There is **no** coercion, no default value, no “treat missing as null”, and no dependence on property enumeration order. `undefined` is never serialized; it is a rejection. [Proposed]

### 4.8 Version selection

```text
function headerOf(block):
    if block.version is undefined:
        return v1Projection(block)                  // Era 1 only; caller enforces height
    if block.version is safeInt and block.version == 1:
        return v1Projection(block)                  // permitted, never emitted
    if block.version is safeInt and block.version == 2:
        return v2Projection(block)                  // must satisfy §3.2 and §4.7
    throw UnsupportedVersion(block.version)
```

`block.version === 2` is tested with `Number.isSafeInteger`, so `2.0` is accepted **only** because JavaScript represents it as the safe integer `2`; `"2"`, `null`, `true`, `2.5`, and `NaN` are rejected. A JSON parser that distinguishes `2.0` from `2` must normalize numeric tokens to IEEE-754 values before this test, and must reject non-integer tokens for an integer field. [Proposed; closes M-05]

### 4.9 Hash and proof-of-work interpretation

```text
preimage = UTF8(P(h))                                  // exact bytes
digest   = SHA-256(preimage)                           // 32 bytes
hash     = lowercaseHex(digest)                        // 64 ASCII chars
validPoW = hash[0 .. difficulty-1] == "0" * difficulty // hex nibbles
work     = 16 ^ difficulty                             // expected hashes
```

- PoW is defined on the **lowercase hex text**, not on a byte comparison. `difficulty` is a count of leading hexadecimal zero characters, which is `4 × difficulty` leading zero bits. Difficulty `0` is genesis-only and has no PoW.
- `hash` is never part of the preimage. `chainWork` is never part of the preimage.
- The digest is not truncated, encoded, reversed, or byte-swapped. There is no `0x` prefix.
- The expected number of hashes for a valid block at difficulty `d` is `16^d`; this is an expectation, not a guarantee (see §15.8).
- `MAX_DIFFICULTY = 6`; `workForDifficulty:147-152` throws outside `1..6`. [Verified]

### 4.10 Preimage boundaries and the no-escaping theorem

**Boundaries:** the preimage begins with the single byte `0x7B` (`{`) and ends with the single byte `0x7D` (`}`). It contains no leading or trailing whitespace, no NUL, no BOM, no length prefix, and no separator other than the commas and colons shown. The SHA-256 input is exactly those bytes and nothing else.

**Theorem (V2 requires no JSON escaping).** Every string value in a V2 header is drawn from one of four ASCII alphabets:

1. `networkId`: `A–Z`, `0–9`, `-`
2. `prevHash`: `0–9`, `a–f`
3. `miner`, `sender`, `recipient`, `signature`: base64 `A–Z`, `a–z`, `0–9`, `+`, `/`, `=`
4. `amount`, `fee`, `reward.amount`: `0–9`, `.`

None of these contains `"` (0x22), `\` (0x5C), or a control character (0x00–0x1F). RFC 8259 requires escaping only those characters. Therefore **no V2 string field can require an escape sequence**, and two conforming implementations cannot diverge on escaping, Unicode normalization, surrogate pairs, or `\u` casing. This was checked programmatically over a representative two-transaction header: 15 string fields, 0 requiring escaping. [Verified against the correction vectors]

This theorem is why V2 restricts `networkId` to `[A-Z0-9-]` and amounts to canonical decimals. It converts a cross-language escaping problem into a byte-copy problem.

### 4.11 Executable-style pseudocode

```text
function buildV2Block(fields):
    h = {
      version: 2,
      networkId: LOCAL_NETWORK_ID,
      height: fields.height,
      timestamp: fields.timestamp,
      prevHash: fields.prevHash,
      difficulty: fields.difficulty,
      nonce: fields.nonce,
      miner: fields.miner,
      transactions: fields.transactions.map(canonicalT7),
      reward: { recipient: fields.rewardRecipient, amount: canonicalDecimal(fields.rewardAmount) },
      message: null
    }
    preimage = serializeV2Header(h)          // throws on any violation
    h.hash = lowercaseHex(SHA256(UTF8(preimage)))
    h.chainWork = fields.parentChainWork + workForDifficulty(h.difficulty)
    return h

function validateV2Header(h, expected):
    preimage = serializeV2Header(h)          // total; rejects missing/extra/undefined
    require(h.version == 2)
    require(h.networkId == LOCAL_NETWORK_ID) // byte equality, not case-insensitive
    require(h.height == expected.height)
    require(h.prevHash == expected.prevHash)
    require(h.difficulty == expected.difficulty)
    require(h.timestamp > expected.medianTimePast)
    require(h.timestamp <= now + 120000)
    require(h.reward.recipient == h.miner)
    require(h.reward.amount == formatUnits(expected.subsidy + expected.fees))
    digest = lowercaseHex(SHA256(UTF8(preimage)))
    require(h.hash is undefined or h.hash == digest)
    require(hasLeadingHexZeros(digest, h.difficulty))
    return digest
```

The validator recomputes the hash; it never trusts a supplied `hash`. If a supplied `hash` is present and differs, that is an explicit rejection, not a silent correction. [Proposed]

### 4.12 Serialization invariants

| ID | Invariant | Test |
|---|---|---|
| S-1 | Changing only `networkId` changes the digest | TE-01, V-02/V-06/V-07 |
| S-2 | Identical fields and identical `networkId` produce identical bytes and digest | TE-02 |
| S-3 | Reordering source-object keys does not change the output | TE-64 |
| S-4 | Reordering the transaction array changes the digest | TE-64 / V-03 vs V-08 |
| S-5 | Adding a transaction field changes the digest or is rejected | TE-66 |
| S-6 | Any missing or `undefined` required field is rejected, never omitted | TE-67 |
| S-7 | A V1 block hashes byte-identically under the V1 path | TE-15, TE-16 |
| S-8 | `hash` and `chainWork` never enter the preimage | TE-79 |
| S-9 | Non-canonical decimals are rejected | TE-81 |
| S-10 | Non-ASCII or non-canonical network IDs are rejected | TE-77 |
| S-11 | The serializer is pure: no clock, no environment, no I/O | code review + TE-40 |
| S-12 | The preimage has no bytes outside the ones specified | vector byte-length assertions |

---

## 5. Complete reference vectors

### 5.1 Fiction declaration and reproducibility

Every value in this section is **[Fiction]**. None is a real key, address, block, transaction, balance, or chain. None was submitted anywhere. The vectors exist only to make the serializer falsifiable.

Reproduction rules:

```text
PREV_A = SHA-256("bnkr-correction-vector-parent-a")
       = 60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1

PREV_B = SHA-256("bnkr-correction-vector-parent-b")
       = 903356c4e7106fc6bd2665e9b80ce4eb8480d4842c806f7c4391e51347d35c5d
```

The base64 keys/signatures are the ASCII labels shown below, written into fixed-length buffers and zero-padded, then base64-encoded. They are syntactically valid encodings but correspond to no real private key.

| Symbol | Value | Bytes |
|---|---|---|
| `MINER` | `Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=` | 32 |
| `SENDER_A` | `Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=` | 32 |
| `RECIP_A` | `Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=` | 32 |
| `RECIP_B` | `Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAyAAA=` | 32 |
| `SIG_1` | `Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==` | 64 |
| `SIG_2` | `Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==` | 64 |

Shared fixed values unless a vector overrides them: `height = 1200`, `timestamp = 1795000000000`, `prevHash = PREV_A`, `difficulty = 5`, `nonce = 424242`, `miner = MINER`, `message = null`, `version = 2`, `networkId = "BNKR-MAINNET-V1"`.

The original V2 specification's §4.7 used a different fictional parent (`b8b8d003…`). Those values remain valid for their own inputs; the vectors below use `PREV_A` so that every byte is reproducible from this document alone. V-01 therefore does **not** equal the original §4.7 digest, and that is expected.

### 5.2 Vector index

| ID | Scenario | Preimage bytes | SHA-256 |
|---|---|---|---|
| V-01 | Empty transaction array; reward 50 | 363 | `5807a168c2bf3f494b64fda9f522348950041325a66387f53dc60b6c4b47ba23` |
| V-02 | One transaction; reward 50 | 647 | `2f760c32ae85c56e5d5c22d5c22790260e6c35d470240af9ca4c5eb434f56999` |
| V-03 | Two transactions; reward 50.002 | 937 | `830208e022beca06a105ba5dd67b3ecc8b1656c1983f67b6f75c32b164c38e2d` |
| V-04 | Zero reward; encodable, conditionally valid | 362 | `91068d45d8038a437ba2342fa87df8184f1de30e27b53c81d089130f82088474` |
| V-05 | Maximum safe integers for timestamp and nonce | 376 | `562a17a275769d1f62d53db6addc42f9eec5ac4f89ad9d9cd863c1ca2a9b83c8` |
| V-06 | Same as V-02, `networkId = BLKC-MAINNET-V1` | 647 | `0a0c650021e223d0efaa917a1be0884959848a3127c5e74a18ad6950c9a97f94` |
| V-07 | Same as V-02, `networkId = BNKR-TESTNET-V1` | 647 | `804ac44933ce85994f890496964f7cb7a28ac87d8a9e61163f12d49fe1196a07` |
| V-08 | Two transactions swapped | 937 | `60bba283f1c977a21938829390b3d24aecd2b4e835e4a774f62400505bcc036e` |
| V-09 | V1 serializer over the V-02 body | 605 | `f7cdfe74c1666590daecd1dd931a54f56f759ddac3fcb8c5067230a14cb7c395` |
| V-10 | One-unit reward `0.00000001` | 655 | `fd9115ee7e03022da7eac4852cecb2b4be0a84806494f376c12818e8289695b4` |
| V-11 | Non-null message; encoding probe only | 671 | `85891ffc60b08b75971026ec16a634eeac3f03e5cb74721f914b18af96a2866a` |
| V-12 | V-02 with a different `prevHash` | 647 | `c9df92e3293e54920523fdea9665d39728c0548baa6d9567b5940900e5ac8557` |

All 12 digests are distinct. V-02, V-06, V-07, and V-09 have the same body and differ only in network/era binding; their four distinct digests are the core separation evidence.

V2 supports exactly **one** transaction type: the canonical transfer `T7`. Legacy fee-less transactions exist only in Era 1 and are invalid at any plausible activation height (`PROTOCOL_UPGRADE_HEIGHT = 136`). Historical hash preservation for those transactions is covered by TE-15/TE-16, not by a V2 vector. [Verified for the legacy window; Proposed for the V2 restriction]

### 5.3 V-01 — empty block

**Input [Fiction]:** `{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}`

**Preimage (363 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}
```

**SHA-256:** `5807a168c2bf3f494b64fda9f522348950041325a66387f53dc60b6c4b47ba23`

### 5.4 V-02 — one transaction

**Transaction [Fiction]:** `{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}`

**Preimage (647 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}
```

**SHA-256:** `2f760c32ae85c56e5d5c22d5c22790260e6c35d470240af9ca4c5eb434f56999`

### 5.5 V-03 — two transactions, nonzero reward

**Inputs [Fiction]:** V-02 transaction plus `{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAyAAA=","amount":"0.25","fee":"0.001","nonce":2,"timestamp":1794999999500,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}`; reward `50.002` = 50 subsidy + 0.002 fees.

**Preimage (937 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAyAAA=","amount":"0.25","fee":"0.001","nonce":2,"timestamp":1794999999500,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50.002"},"message":null}
```

**SHA-256:** `830208e022beca06a105ba5dd67b3ecc8b1656c1983f67b6f75c32b164c38e2d`

### 5.6 V-04 — zero reward

**Input [Fiction]:** V-01 with `reward.amount = "0"`.

**Preimage (362 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"0"},"message":null}
```

**SHA-256:** `91068d45d8038a437ba2342fa87df8184f1de30e27b53c81d089130f82088474`

**Consensus interpretation:** zero is **encodable** and is valid only when `subsidy + fees = 0`. `rewardForHeight` clamps the subsidy to `MAX_SUPPLY - supply` (`:247-251`), so at supply exhaustion an empty block legitimately has reward `"0"`. A zero reward before supply exhaustion is rejected by `validateBlock:365-370`, not by the serializer. This distinction matters: the serializer answers “can this be hashed?”, the validator answers “is this issuance legal?” [Verified rule; fiction values]

### 5.7 V-05 — maximum supported integers

**Input [Fiction]:** V-01 with `timestamp = 9007199254740991` and `nonce = 9007199254740991` (`Number.MAX_SAFE_INTEGER`).

**Preimage (376 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":9007199254740991,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":9007199254740991,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}
```

**SHA-256:** `562a17a275769d1f62d53db6addc42f9eec5ac4f89ad9d9cd863c1ca2a9b83c8`

**Boundary note:** `9007199254740991` is the largest exactly representable integer. `9007199254740992` is not a safe integer and must be rejected. A timestamp of `MAX_SAFE_INTEGER` is serializable but fails the consensus rule `timestamp ≤ now + 120000`; the vector tests encoding, not validity.

### 5.8 V-06 — same body, BLKC network ID

**Input [Fiction]:** exact V-02 body with `networkId = "BLKC-MAINNET-V1"`.

**Preimage (647 bytes):**

```text
{"version":2,"networkId":"BLKC-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}
```

**SHA-256:** `0a0c650021e223d0efaa917a1be0884959848a3127c5e74a18ad6950c9a97f94`

### 5.9 V-07 — same body, testnet network ID

**Input [Fiction]:** exact V-02 body with `networkId = "BNKR-TESTNET-V1"`.

**Preimage (647 bytes):**

```text
{"version":2,"networkId":"BNKR-TESTNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}
```

**SHA-256:** `804ac44933ce85994f890496964f7cb7a28ac87d8a9e61163f12d49fe1196a07`

### 5.10 V-08 — transaction order matters

**Input [Fiction]:** V-03 with the two transactions in reverse order (nonce 2 first, nonce 1 second). Reward remains `50.002`.

**Preimage (937 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAyAAA=","amount":"0.25","fee":"0.001","nonce":2,"timestamp":1794999999500,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50.002"},"message":null}
```

**SHA-256:** `60bba283f1c977a21938829390b3d24aecd2b4e835e4a774f62400505bcc036e`

V-03 and V-08 have identical contents as a multiset and different digests. A block producer that reorders the mempool must re-mine; a validator must never sort transactions before hashing.

### 5.11 V-09 — the V1 serializer is a different era

**Input [Fiction]:** the V-02 body serialized by the **Era 1** 9-field serializer, with both `version` and `networkId` excluded.

**Preimage (605 bytes):**

```text
{"height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}
```

**SHA-256:** `f7cdfe74c1666590daecd1dd931a54f56f759ddac3fcb8c5067230a14cb7c395`

V-02 and V-09 commit the same semantic block under two different era rules and produce different digests. This is the property that makes a V1 block invalid at `height ≥ H` and prevents a V1 binary from validating a V2 block by accident.

### 5.12 V-10 — one atomic unit of reward

**Input [Fiction]:** V-02 with `reward.amount = "0.00000001"` (one atomic unit, `10^-8` BNKR).

**Preimage (655 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"0.00000001"},"message":null}
```

**SHA-256:** `fd9115ee7e03022da7eac4852cecb2b4be0a84806494f376c12818e8289695b4`

This vector catches float contamination. `0.00000001` is exactly representable in decimal text but is not the same as the JSON number `0.00000001` printed by every language; only the string is normative.

### 5.13 V-11 — non-null message (encoding probe, consensus-invalid)

**Input [Fiction]:** V-02 with `message = "fictional non-null message"`.

**Preimage (671 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"60238fecf275e70db6ce6e18ccba1afa302152d3763576d89832835b18dfb5e1","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":"fictional non-null message"}
```

**SHA-256:** `85891ffc60b08b75971026ec16a634eeac3f03e5cb74721f914b18af96a2866a`

**Important:** this preimage is **not** produced by a conforming V2 serializer. `serializeV2Header` rejects `message !== null` before hashing. The digest is included only to prove that a non-null message cannot collide with the null form and that a third-party implementation which accidentally accepts it will be detected by a different digest. Treat V-11 as a negative-vector reference, not an accepted block.

### 5.14 V-12 — different parent

**Input [Fiction]:** V-02 with `prevHash = PREV_B`.

**Preimage (647 bytes):**

```text
{"version":2,"networkId":"BNKR-MAINNET-V1","height":1200,"timestamp":1795000000000,"prevHash":"903356c4e7106fc6bd2665e9b80ce4eb8480d4842c806f7c4391e51347d35c5d","difficulty":5,"nonce":424242,"miner":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","transactions":[{"sender":"Qk5LUi1WMi1GSUNUSU9OQUwtU0VOREVSLUtFWS0wMQA=","recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtUkVDSVBJRU5ULTAxAAA=","amount":"1.5","fee":"0.001","nonce":1,"timestamp":1794999999000,"signature":"Qk5LUi1WMi1GSUNUSU9OQUwtU0lHLTAwMDAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}],"reward":{"recipient":"Qk5LUi1WMi1GSUNUSU9OQUwtTUlORVItS0VZLTAwMDE=","amount":"50"},"message":null}
```

**SHA-256:** `c9df92e3293e54920523fdea9665d39728c0548baa6d9567b5940900e5ac8557`

### 5.15 Negative vectors

These must be **rejected before hashing**, with a stable error code. The expected result is a typed error, not a digest.

| ID | Input mutation | Expected rejection |
|---|---|---|
| N-01 | Remove `networkId` | `MISSING_FIELD` |
| N-02 | Add `chainId` | `EXTRA_HEADER_FIELD` |
| N-03 | `version = "2"` | `INVALID_VERSION_TYPE` |
| N-04 | `version = 3` | `UNSUPPORTED_VERSION` |
| N-05 | `version = null` / `true` / `2.5` | `INVALID_VERSION_TYPE` |
| N-06 | `networkId = ""` | `INVALID_NETWORK_ID` |
| N-07 | `networkId` with Cyrillic `В` | `INVALID_NETWORK_ID` (non-ASCII) |
| N-08 | `networkId` with trailing space or ZWJ | `INVALID_NETWORK_ID` |
| N-09 | `networkId` case variant | `NETWORK_ID_MISMATCH` |
| N-10 | `height = 0` | `INVALID_HEIGHT` |
| N-11 | `timestamp` as string | `INVALID_INTEGER` |
| N-12 | `nonce = -1` | `INVALID_NONCE` |
| N-13 | `difficulty = 7` | `INVALID_DIFFICULTY` |
| N-14 | `miner` decodes to 31 bytes | `INVALID_KEY` |
| N-15 | `transactions = null` | `INVALID_TRANSACTIONS` |
| N-16 | 10,001 transactions | `TOO_MANY_TRANSACTIONS` |
| N-17 | transaction has extra `amountUnits` | `EXTRA_TRANSACTION_FIELD` |
| N-18 | `amount = "1.50"` | `NON_CANONICAL_DECIMAL` |
| N-19 | `amount = "1e-8"` | `NON_CANONICAL_DECIMAL` |
| N-20 | `reward.amount = 50.0` (JSON number) | `INVALID_REWARD_TYPE` |
| N-21 | `reward` has extra `fee` | `EXTRA_REWARD_FIELD` |
| N-22 | `message = ""` | `NON_NULL_MESSAGE` |
| N-23 | duplicate `"height"` key in input JSON | `DUPLICATE_KEY` (parser-level) |
| N-24 | trailing data after `}` | `TRAILING_DATA` |
| N-25 | preimage > 8 MiB | `PREIMAGE_TOO_LARGE` |

### 5.16 How the vectors are used

A conforming implementation must ship a vector runner that asserts, for every positive vector:

1. the exact preimage byte length,
2. the exact preimage bytes (not a normalized or re-serialized form),
3. the exact lowercase SHA-256 digest,
4. determinism across two runs and two source-key orders,
5. rejection of every negative vector with the documented code.

A vector runner that only compares digests is insufficient: two implementations can produce the same digest from different bytes only by a SHA-256 collision, but a vector that compares bytes catches key-order and escaping drift immediately. [Proposed]

The vectors are **not** a test that the current code passes. The current `headerOf` has no `version`/`networkId` branch and will fail V-01…V-12 by construction until Phase 1 is implemented. [Verified: `headerOf:36-48`]

### 5.17 Cross-language obligations

| Obligation | Reason |
|---|---|
| Emit `P(h)` explicitly, not via a generic map serializer | Map ordering and escaping differ across languages |
| Treat all V2 numbers as 64-bit-safe integers, not floats | `timestamp` and `nonce` use the full safe-integer range |
| Reject non-integer numeric tokens for integer fields | `2.0` versus `2` must not create two interpretations |
| Reject duplicate JSON keys at parse time | Last-key-wins is a parser behavior, not a JSON guarantee (M-17) |
| Never Unicode-normalize | `networkId` is ASCII; normalization is a bug surface |
| Never escape base64 `/` or `+` | JSON does not require it; escaping would change bytes |
| Hash the UTF-8 bytes, not a UTF-16 string | The definition is bytes |
| Recompute the hash instead of trusting a supplied field | The central rule of §8 |

---

## 6. Corrected schema validation

### 6.1 Four layers, one hash boundary

The original specification applied predicate 12 (“no additional own enumerable properties”) to the **block**, while `headerOf` hashes a **whitelist projection**. Every stored block carries at least `hash` and `chainWork` (`applyBlock:731-734`), so the predicate rejected 100% of valid stored blocks. It was also vacuous for hashing, because `headerOf` never reads those fields. [Verified: `headerOf:36-48`, `applyBlock:731-734`, audit §4.3]

The correction is a four-layer model:

| Layer | Fields | Hashed? | Who may write | Validation |
|---|---|---|---|---|
| **L1 — consensus header** | `version`, `networkId`, `height`, `timestamp`, `prevHash`, `difficulty`, `nonce`, `miner`, `transactions`, `reward`, `message` (Era 2); the nine historical fields (Era 1) | **Yes** | Block producer, constrained by consensus | Full type/domain/era/identity predicates |
| **L2 — derived block fields** | `hash`, `chainWork` | **No** | Any node, deterministically recomputed | Must equal recomputation; supplied values are never trust inputs |
| **L3 — persisted database metadata** | `blocks.height`, `blocks.timestamp`, `blocks.hash`, `blocks.miner`, `blocks.tx_count`, `blocks.json`, `blocks.chain_work`, rowid; `protocol_state.*` | **No** | Storage layer / operator | Cross-checked against L1/L2; mismatch is fatal or repaired only above the highest checkpoint |
| **L4 — application metadata** | `receivedAt`, `peer`, `source`, UI flags, analytics | **No** | Any layer | Must never be read by consensus; unknown L4 fields are ignored on persisted history and rejected on received V2 blocks |

The rule is: **hash L1 only; admit or reject the block object; cross-check L3 against L1/L2; never let L4 influence consensus.**

### 6.2 Why `headerOf` already provides field selection

`headerOf(block)` constructs a new object with exactly nine named properties (`:36-48`). It does not spread the input, does not copy unknown keys, and does not iterate `Object.keys(block)`. Therefore:

- Adding `networkId: "BLKC-MAINNET-V1"` to a historical block changes **0** hashes, because the field is not read. The audit confirmed 0/859 BNKR, 0/297 BLKC, and 0/377 node-B hashes changed. [Verified]
- Adding `hash` and `chainWork` cannot change a hash for the same reason.
- A malicious `__proto__` or `constructor` property cannot enter the preimage through `headerOf`.
- The projection is already a closed schema **for hashing**.

That is precisely why the original predicate 12 was both destructive and unnecessary. The hash boundary was already safe; the admission boundary was the broken part.

### 6.3 What additional validation is actually for

Additional validation must exist, but its purpose is **not** to protect the hash. Its purposes are:

1. **Cross-implementation agreement.** A second implementation must reject the same blocks, not merely hash them the same way. If one node accepts a block with `amountUnits` and another rejects it, they can diverge on validity even with an identical hash.
2. **Era enforcement.** The serializer answers “how do I hash this?”; the validator answers “is this version legal at this height?” (`§4.9` of the original is correct on this point).
3. **Identity enforcement.** A V2 block carrying the wrong `networkId` may hash fine; it must be rejected before work is considered.
4. **Malleability closure.** The header commits the transaction array. If a transaction object can carry an extra field that one implementation hashes and another strips, the same “transaction” has two hashes. A closed projection removes the ambiguity.
5. **Operational diagnosis.** Typed errors distinguish corruption from an unsupported protocol version (§10.7).

Additional validation must **not**:

- reject a persisted historical block for carrying `hash`, `chainWork`, or legacy storage metadata;
- re-hash a V1 block through the V2 serializer;
- treat a missing optional L4 field as corruption;
- “repair” a block by deleting fields and re-hashing it.

### 6.4 Validation pseudocode by context

#### 6.4.1 Newly constructed block (local miner/server)

```text
function constructBlock(template, nonce):
    require(template.height >= 1)
    require(template.height >= H ? template.version == 2 : template.version is undefined or 1)
    txs = template.transactions.map(t => canonicalT7(t))       // throws on extras/non-canonical
    reward = { recipient: template.miner, amount: canonicalDecimal(template.rewardAmount) }
    h = { version: eraVersion(template.height), networkId: eraNetworkId(template.height),
          height, timestamp, prevHash, difficulty, nonce, miner, transactions: txs,
          reward, message: null }
    preimage = (h.version == 2) ? serializeV2Header(h) : serializeV1Header(h)
    h.hash = sha256Hex(preimage)
    h.chainWork = parentChainWork + workForDifficulty(h.difficulty)
    return h
```

The builder canonicalizes **before** hashing. It never hashes a raw client object.

#### 6.4.2 Received block (API or peer)

```text
function validateReceivedBlock(block, context):
    requirePlainObject(block)
    requireNoDuplicateKeys(block)                             // parser-level, before this function
    version = block.version
    if context.height >= H:
        require(version is safeInt and version == 2)
        requireExactHeaderKeys(block, V2_KEYS, allowDerived = ["hash","chainWork"])
    else:
        require(version is undefined or version == 1)
        requireHistoricalProjection(block)                    // ignore L3/L4 extras
    requireCanonicalTransactions(block.transactions, era = context.height >= H)
    requireCanonicalReward(block.reward)
    require(block.message === null)
    computed = recomputeHash(block)                           // from L1 only
    if block.hash !== undefined: require(block.hash === computed)
    if context.height >= H: require(block.chainWork is undefined or block.chainWork === expectedWork)
    require(hasProof(computed, block.difficulty))
    // then economics (§15), checkpoints (§8), work comparison (§14)
```

A received V2 block with an unknown top-level field other than `hash` and `chainWork` is rejected with `EXTRA_HEADER_FIELD`. A received Era 1 block with extra storage metadata is **not** rejected on that ground; the V1 projection ignores it. This asymmetry is intentional: history is frozen, new blocks are closed.

#### 6.4.3 Persisted historical block (Era 1)

```text
function validatePersistedV1(row):
    block = JSON.parse(row.json)
    require(block.height === row.height)
    require(serializeV1Header(block) produces the historical bytes)
    require(sha256Hex(serializeV1Header(block)) === row.hash)
    require(row.chain_work === cumulativeWorkThrough(row.height))
    // Do NOT apply V2 predicates. Do NOT reject extras.
    // Do NOT rewrite the row to remove fields.
```

The stored `json` is the historical record. `headerOf` projects the nine consensus fields; `JSON.parse` preserves the stored key order for those nine, and `headerOf` emits them in the fixed V1 order. Extra fields in `json` are ignored for hashing. [Verified: `getBlocks:515-518`, `validateChainInternal:379-425`]

#### 6.4.4 Persisted V2 block

```text
function validatePersistedV2(row):
    block = JSON.parse(row.json)
    require(block.height === row.height)
    require(block.version is safeInt and block.version == 2)
    require(block.networkId == LOCAL_NETWORK_ID)
    requireExactHeaderKeys(block, V2_KEYS, allowDerived = true)
    requireCanonicalTransactions(block.transactions)
    requireCanonicalReward(block.reward)
    computed = sha256Hex(serializeV2Header(block))
    require(computed === row.hash)
    require(computed === block.hash)                 // if stored
    require(row.chain_work === cumulativeWorkThrough(row.height))
    require(hasProof(computed, block.difficulty))
```

A persisted V2 row whose `json` carries an L4 field must fail closed at startup, because a V2 header is closed. The operator may export the row, inspect it, and re-sync from a peer; the node must not silently delete the field and continue.

### 6.5 Field-admission matrix

| Field / situation | Era 1 persisted | Era 1 received | V2 received | V2 persisted |
|---|---|---|---|---|
| 9 historical consensus fields | required | required | required | required |
| `version` absent | allowed | allowed | rejected | rejected |
| `version: 1` | allowed, not emitted | allowed below `H` | rejected | rejected |
| `version: 2` | ignored for hashing; **not** a V1 block | rejected below `H` | required | required |
| `networkId` | ignored (never hashed) | ignored for hashing; may be stored | required, byte-equal | required, byte-equal |
| `hash` | allowed | allowed if equal to recomputation | allowed if equal | required/equal |
| `chainWork` | allowed | allowed if equal | allowed if equal | required/equal |
| `tx_count`, `receivedAt`, `peer` | ignored | ignored | rejected | rejected |
| `__proto__`, `constructor`, `prototype` | ignored | ignored | rejected | rejected |
| unknown field | ignored | ignored | **rejected** | **rejected** |

### 6.6 `hash` and `chainWork` are derived, not trusted

- A supplied `hash` is compared to the recomputation. If it differs, the block is rejected. A node never “accepts the supplied hash because the field is present”.
- A supplied `chainWork` must equal the cumulative sum from genesis (or from the highest verified checkpoint plus the suffix, after ancestry verification). A number `0` is not the string `"0"`; the canonical form is a decimal string (`validateBlock:359`, `validateChainInternal:397`). M-20 covers this.
- Persisted `blocks.hash` is an index/cross-check, not a consensus authority. §8 requires recomputation before a checkpoint comparison.
- A database writer who changes `blocks.hash` without changing `blocks.json` is detected by recomputation.
- A database writer who changes both `blocks.json` and `blocks.hash` still cannot match a compiled checkpoint unless they break SHA-256 or re-mine a block whose hash equals the constant.

### 6.7 Parser-level requirements

| Requirement | Reason |
|---|---|
| Reject duplicate JSON keys | `{"height":1,"height":2}` has no portable meaning; last-key-wins is implementation-defined (M-17) |
| Reject trailing data after the top-level object | Prevents smuggling a second object |
| Reject `NaN`, `Infinity`, `-Infinity` | Not valid JSON; must not become numbers |
| Reject numbers outside the safe-integer range for integer fields | Avoids precision loss |
| Reject non-canonical base64 | Two encodings of the same key would produce two identities |
| Reject non-ASCII in V2 strings | The no-escaping theorem depends on it |
| Do not use a prototype-polluting merge | `__proto__` must be an ordinary rejected key |

### 6.8 Error taxonomy

| Code | Meaning | Fatal at startup? |
|---|---|---|
| `MISSING_FIELD` | required consensus field absent | yes for V2 rows |
| `EXTRA_HEADER_FIELD` | unknown field on a received/persisted V2 block | yes for V2 rows |
| `INVALID_VERSION_TYPE` / `UNSUPPORTED_VERSION` | wrong type or unknown era | yes if persisted |
| `NETWORK_ID_MISMATCH` | V2 block bound to another network | yes |
| `NON_CANONICAL_DECIMAL` / `INVALID_REWARD_TYPE` | monetary field malformed | yes |
| `HASH_MISMATCH` | recomputation differs from stored/supplied hash | **corruption** — may be repairable only above the highest checkpoint |
| `POW_INVALID` | hash lacks leading zeros | corruption |
| `CHAINWORK_MISMATCH` | cumulative work wrong | corruption |
| `UNSUPPORTED_PROTOCOL_VERSION` | a version the binary does not implement | **not corruption** — safe refusal (§10) |

---

## 7. Historical hash preservation requirements

### 7.1 The absolute rules

| Rule | Statement |
|---|---|
| **H-1** | Every existing BNKR block retains its original hash. |
| **H-2** | Every preserved BLKC block retains its original hash. |
| **H-3** | Every node-B block retains its original hash. |
| **H-4** | The V1 serialized output is byte-identical before and after any V2 change. |
| **H-5** | Genesis is unchanged: `49f9e88619178347aaf806ba33c00ab973d1d62e45db982a851e86728880ebaa`. |
| **H-6** | No historical block is “repaired”, re-serialized, or migrated to the V2 form. |
| **H-7** | A change that alters any stored hash is a chain-destroying change and must be rejected at review, not patched at runtime. |

### 7.2 The frozen V1 projection

The V1 path is not a style choice; it is a historical artifact. It must remain exactly:

```text
V1(b) = { height, timestamp, prevHash, difficulty, nonce, miner, transactions, reward, message }
hash  = lowercaseHex(SHA256(UTF8(JSON.stringify(V1(b)))))
```

with these properties:

- Nine keys in that order, no `version`, no `networkId`.
- `transactions` is the **raw stored array**, not the V2 `T7` projection. Historical transactions may carry extra fields or legacy fee-less forms; normalizing them would change hashes.
- `reward` is the raw stored object, including any historical key order.
- `message` is raw, including the genesis em-dash.
- String escaping is whatever `JSON.stringify` produced historically. V2's no-escaping theorem does **not** apply to Era 1; Era 1 conformance is defined by the stored bytes and the historical serializer, not by a new canonicalization.
- `JSON.parse` followed by `headerOf` must preserve the nine field values and the fixed output order. The audit's 0-mismatch result over 859 + 297 + 377 blocks is the evidence. [Verified]

### 7.3 Audit evidence

| Chain | Blocks | Recomputed hash mismatches | Source |
|---|---|---|---|
| BNKR (`bannekercoin.db`) | 859 (height 858) | **0** | audit §4.3 |
| BLKC (`blackcoin.db`) | 297 (height 296) | **0** | audit §4.3 |
| Node-B (`node-b.db`) | 377 (height 376) | **0** | audit §4.3 |

The audit also proved the inverse: injecting `networkId` and `version` into stored objects changed **0** hashes under the current `headerOf`. That is both the proof that the current serializer ignores the fields and the warning that a naive “add the fields to `headerOf`” change would be catastrophic. [Verified]

### 7.4 Build-time duplicate-serializer check (C-25)

The repository currently contains duplicated consensus logic:

| Location | Duplicate | Risk |
|---|---|---|
| `src/miner.worker.js:13-45`, `47-60` | header construction, PoW loop | a browser bundle can hash a different preimage from the server |
| `src/App.jsx:31` | `NETWORK_ID` | client and server can disagree on identity |
| `src/App.jsx:200-212` | `signingMessage` | transaction domain separation can drift |
| `server/ledger.js:36-52` | canonical serializer | must become the single source or import from `shared/` |

**Requirement:** a build-time check fails if any of the following appears outside `shared/`:

- a second `headerOf`, `hashBlock`, `canonicalJson`, `serializeV2Header`, or `workForDifficulty`;
- a string literal equal to `NETWORK_ID` or `GENESIS_HASH`;
- a second transaction-message construction;
- a second `CHECKPOINTS` table.

The check must be mechanical (AST or grep with an allowlist), not a code-review convention. A stale browser bundle is a real failure mode: M-24 covers a v1 serializer submitting after activation. [Proposed]

### 7.5 Citation corrections (C-28)

The original specification contained imprecise references. Corrected references, working-tree line numbers:

| Symbol | Correct location | Note |
|---|---|---|
| `headerOf` | `ledger.js:36-48` | nine-field projection |
| `hashBlock` | `ledger.js:50-52` | `sha256(JSON.stringify(headerOf(block)))` |
| `genesisBlock` | `ledger.js:270-283` | difficulty 0, chainWork `"0"` |
| `hasProof` | `ledger.js:285-287` | leading hex zeros |
| `validMiner` | `ledger.js:289-291` | 32-byte key check |
| `expectedDifficulty` | `ledger.js:253-268` | `find(height-10)` requires full history |
| `validateBlock` | `ledger.js:346-377` | per-block rules |
| `validateChainInternal` | `ledger.js:379-425` | returns balances/nonces too |
| `validateChain` | `ledger.js:427-430` | **strips** balances/nonces |
| `createLedger` | `ledger.js:432-437` | default `'blackcoin.db'` |
| `validateStoredChain` | `ledger.js:520-530` | adds `accountsValid` in working tree only |
| startup repair | `ledger.js:569-616` | silent truncation engine |
| `applyBlock` | `ledger.js:671-741` | stores `JSON.stringify(block)` and supplied `hash` |
| `acceptTransaction` | `ledger.js:743-748` | delegates to `acceptTransactionLocked` |
| `acceptBlockLocked` | `ledger.js:920-938` | validates then applies |
| `replaceChainLocked` | `ledger.js:944-1029` | full-chain reapply |
| `networkState` | `ledger.js:1113-1139` | 10-block window for difficulty |
| `/api/node` | `index.js:279-292` | lacks identity fields |
| `/api/validate` | `index.js:319-321` | returns `validateStoredChain()` |
| `/api/peers` POST | `index.js:343-359` | trust on `name`/`ticker` |
| `/api/peer/chain` | `index.js:361-364` | unbounded full-chain response |
| `/api/peer/tx` / `block` | `index.js:372-384` | unauthenticated |
| `maxJsonBodyBytes` | `security.js` | `64 * 1024` |

The distinction between `validateChain` and `validateChainInternal` matters: tests that need balances must call the internal function; tests that call the public function cannot see them. The original specification conflated the two in §2.1/§19.1. [Verified]

### 7.6 State commitment: the documented alternative (C-18 / R-20)

**Decision:** V2 does **not** add a Merkle root or a state root. Balances and supply are verifiable only by full replay.

Consequences, stated plainly:

| Consequence | Effect |
|---|---|
| A checkpoint authenticates **history**, not **balances** | An attacker who compromises a peer's state must still forge a valid block chain, but a node cannot prove a balance to a light client from a checkpoint alone |
| Independent verification is O(chain) | At 859 blocks this is trivial; at millions it is not |
| Light clients are impossible | A wallet must trust an API or replay headers plus state proofs |
| Startup cost grows linearly | Acceptable for the current chain; must be revisited before scale |
| A state root would require a defined state transition | That is a separate era with its own audit; bundling it into V2 would double consensus surface |

This is an honest limitation, not a defect hidden by a checkpoint. The original §8.1 sentence “one hash authenticates ~860 blocks” was true of the **history**, and false if read as “one hash authenticates the local database”. §8.4 replaces it with an explicit ancestry procedure. [Proposed]

### 7.7 Genesis is shared with BLKC — say it explicitly

Genesis is byte-identical across BNKR, BLKC, and node-B, and hashes to `49f9e886…ebaa`. It contains no `networkId`, because the field does not exist in the V1 schema. Therefore:

- Genesis is **not** a network check. The current check recomputes the same nine fields from code and passes for both networks (`validateChainInternal:382-386`). [Verified]
- Any BNKR chain and any BLKC-derived chain are indistinguishable below `H` except by the **checkpoint**.
- `CP-PRE` is the only practical defence against a same-genesis substitution. `CP-GENESIS` alone cannot distinguish the two.
- The claim “BNKR blocks cannot be replayed on BLKC” is false before `H` and true only for V2 blocks after `H`. §20.1 of the original is correct and must be preserved verbatim.

This is the single most important fact a new operator must understand. A specification that says “genesis binds the network” is wrong for BNKR.

### 7.8 Historical release gate

A release is not eligible for any V2 work unless all of the following pass on an isolated copy:

1. Recompute all 859 BNKR hashes with the V1 serializer: 0 mismatches.
2. Recompute all 297 BLKC hashes: 0 mismatches.
3. Recompute all 377 node-B hashes: 0 mismatches.
4. Genesis hash equals `49f9e886…ebaa`.
5. Total BNKR chain work equals `249342768`; BLKC equals `141732656`.
6. A V1 block at `H−1` and a V2 block at `H` both hash correctly under their own era.
7. No stored row is modified by the test.

If any of these fail, stop. Do not proceed to checkpoint work.

---

## 8. Checkpoint verification algorithm

### 8.1 The checkpoint tuple

A consensus checkpoint is a compiled constant with exactly these fields:

```text
Checkpoint = {
  networkId:       "BNKR-MAINNET-V1" | "BNKR-TESTNET-V1",
  protocolVersion: 1 | 2,             // era of the checkpointed block
  height:          safeInt >= 1,
  blockHash:       hex64,
  chainWork:       decimal string,    // cumulative from genesis, inclusive
  genesisHash:     hex64,             // must equal the network genesis
  manifestDigest:  hex64              // SHA-256 of the canonical manifest body
}
```

`manifestDigest` is not hashed into the block; it binds the **published description** to the compiled tuple. `blockHash` is the only value that must equal a recomputed block hash. [Proposed]

### 8.2 What a checkpoint can and cannot prove

| Claim | Proved by a checkpoint? | Why |
|---|---|---|
| The block at `height` has a specific header, transactions, and reward | **Yes**, if the hash is recomputed and matches | SHA-256 preimage resistance |
| Every ancestor’s `prevHash` is correctly linked | **Yes**, if the local ancestry is walked | each block commits its parent hash |
| The local database’s copy of every ancestor is unaltered | **Only with a full ancestry walk** | a hash commits `prevHash`, not the bytes of the ancestor; a tampered ancestor with a re-linked suffix changes the checkpoint hash, but a tampered ancestor below a *verified* checkpoint requires walking down to detect |
| The checkpoint constant itself is authentic | **No** | authenticity comes from release integrity and diverse republication (§9) |
| Balances and supply are correct | **No** | no state commitment (§7.6) |
| The chain has more work than another chain | **Not by itself** | work is compared only after identity and checkpoint checks (§14) |
| The checkpoint is current | **No** | a checkpoint is a historical anchor, not a tip |

The original §8.4 Q3 asserted `block.hash === checkpoint.hash` using the **stored** `block.hash`. That is forgeable by anyone who can write the database: `applyBlock:731-734` stores the client-supplied hash, and the fast path skipped `validateBlock:371` recomputation. [Verified] The corrected algorithm never reads a stored hash as a trust input.

### 8.3 The verification algorithm (normative)

Inputs: `cp` (a compiled checkpoint), `store` (the local block store), `H` (activation height), `LOCAL_NETWORK_ID`, `GENESIS_HASH`.

```text
function verifyCheckpoint(cp, store):
    // 1. Context
    require(cp.networkId == LOCAL_NETWORK_ID)                  -> NETWORK_ID_MISMATCH
    require(cp.genesisHash == GENESIS_HASH)                    -> GENESIS_MISMATCH
    require(cp.height >= 1)                                    -> INVALID_CHECKPOINT
    require(cp.protocolVersion == eraOf(cp.height, H))         -> ERA_MISMATCH
    require(isHex64(cp.blockHash))                             -> INVALID_CHECKPOINT
    require(isCanonicalDecimal(cp.chainWork))                  -> INVALID_CHECKPOINT

    // 2. Load by height, never by hash
    block = store.getByHeight(cp.height)                       -> CHECKPOINT_BLOCK_MISSING
    require(block.height == cp.height)                         -> HEIGHT_MISMATCH

    // 3. Reconstruct the canonical header under the correct era
    if cp.protocolVersion == 1:
        require(block.version is undefined or block.version == 1) -> ERA_MISMATCH
        header = v1Projection(block)                           // 9 fields, frozen
    else if cp.protocolVersion == 2:
        require(block.version is safeInt and block.version == 2)  -> ERA_MISMATCH
        require(block.networkId == LOCAL_NETWORK_ID)              -> NETWORK_ID_MISMATCH
        header = v2Projection(block)                           // 11 fields, §4
    else:
        return UNSUPPORTED_PROTOCOL_VERSION                    // never repair

    // 4. Recompute the hash from the reconstructed header
    computed = sha256Hex(utf8(serialize(header, era = cp.protocolVersion)))

    // 5. Authenticate identity
    require(computed == cp.blockHash)                          -> CHECKPOINT_HASH_MISMATCH

    // 6. Verify proof of work on the recomputed hash
    require(hasLeadingHexZeros(computed, block.difficulty))    -> POW_INVALID

    // 7. Verify the predecessor relationship
    if cp.height == 0:
        require(block.prevHash == ZERO_HASH)                   -> PREV_HASH_INVALID
    else:
        parent = store.getByHeight(cp.height - 1)               -> CHECKPOINT_ANCESTRY_MISSING
        parentHash = recomputeBlockHash(parent)                 // recursively verified below
        require(block.prevHash == parentHash)                   -> PREV_HASH_INVALID

    // 8. Verify cumulative work at this height
    work = cumulativeWork(store, 0, cp.height)                  // §8.4
    require(work.toString() == cp.chainWork)                    -> CHAINWORK_MISMATCH

    // 9. Verify full local ancestry down to genesis
    require(verifyAncestry(store, cp.height))                   -> CHECKPOINT_ANCESTRY_INVALID

    // 10. Only now may the caller consult work for chain selection
    return VERIFIED
```

Every failure is **fatal** for startup or candidate-chain admission. The function must not return “valid with a warning”, must not fall back to the stored `block.hash`, and must not skip step 8 because the hash matched. [Proposed]

### 8.4 Ancestry verification and its cost

```text
function verifyAncestry(store, top):
    require(top >= 1)
    for i from top down to 1:
        b = store.getByHeight(i)                                -> ANCESTRY_MISSING
        h_i = recomputeBlockHash(b)                             // era-aware
        require(hasLeadingHexZeros(h_i, b.difficulty))          -> POW_INVALID
        parent = store.getByHeight(i - 1)                       -> ANCESTRY_MISSING
        h_parent = recomputeBlockHash(parent)
        require(b.prevHash == h_parent)                         -> ANCESTRY_LINK_BROKEN
        require(b.chainWork == cumulativeWorkThrough(i))        -> CHAINWORK_MISMATCH
    require(recomputeBlockHash(store.getByHeight(0)) == GENESIS_HASH) -> GENESIS_MISMATCH
    return true
```

**Cost:** one SHA-256 per block over roughly the serialized header size. At the verified baseline, 859 BNKR blocks at ~600–900 bytes each is well under 1 MB of hashing and completes in milliseconds on any node. It is not a performance problem at the current scale. It becomes one only if the chain grows by orders of magnitude; that is a reason to add a state/commitment design later (Q-18), not a reason to skip ancestry now.

**What the walk proves:** the local bytes form a continuous chain from genesis to the checkpoint, every `prevHash` matches the recomputed parent, every block satisfies PoW, and every cumulative work value is correct. **What it does not prove:** that the checkpoint constant is the “right” history, or that balances are correct. Those are governance (§9) and replay (§15) questions.

**Incremental caching:** a node may cache `verified_through = A` in local storage to avoid re-walking on every request, but on **startup** it must re-verify from the highest checkpoint down to genesis unless it can authenticate the cache independently. A database writer can alter the cache. Because the current chain is small, the simplest correct design is: re-walk on every startup; use the cache only within a single process lifetime. [Proposed]

### 8.5 Three checkpoint states

The original specification used “(when height permits)” once and left the semantics undefined. Replace it with a total state function:

```text
function checkpointState(cp, tipHeight):
    if tipHeight < cp.height: return NOT_YET_APPLICABLE
    block = store.getByHeight(cp.height)
    if block is missing:      return VIOLATED        // tip claims to be past it
    if verifyCheckpoint(cp, store) != VERIFIED: return VIOLATED
    return APPLICABLE
```

| State | Meaning | Node behavior |
|---|---|---|
| `NOT_YET_APPLICABLE` | The local tip is below the checkpoint height | Serve normally; do **not** claim the checkpoint is verified; expose `checkpointState` in `/api/node` and `/health` |
| `APPLICABLE` | The block exists and verifies | Normal operation; the checkpoint is enforced on every candidate chain |
| `VIOLATED` | The tip is at or above the height but the block is missing or wrong | **Fatal.** Refuse to serve, refuse to peer, preserve the database, require operator action |
| `UNSUPPORTED_PROTOCOL_VERSION` | The block’s era is unknown to this binary | **Fatal, not corruption** (§10) |

This also defines the pre-activation window (M-19): before `H` is mined, `CP-ACT` is `NOT_YET_APPLICABLE`, and the node must say so rather than pretending it is enforced.

### 8.6 Checkpoint identity versus checkpoint authenticity

| Property | Mechanism | Failure mode |
|---|---|---|
| **Identity** | The tuple’s `networkId`, `genesisHash`, `height`, `protocolVersion` | A tuple for the wrong network is rejected at step 1 |
| **Integrity** | Recomputed `blockHash` and `chainWork` | A tampered block or DB row is rejected at steps 4–8 |
| **Ancestry** | `prevHash` walk to genesis | A missing/altered ancestor is rejected at step 9 |
| **Authenticity** | Review, reproducible build, multiple publication channels, attestations | A compromised release can still ship a malicious constant; crypto does not prevent this |
| **Freshness** | Cadence and manifest publication date | An old checkpoint says nothing about recent history |

A checkpoint is not a signature. A compiled constant is authentic because independent parties can see and reproduce the same bytes, not because a server or a key said so.

### 8.7 Database-tampering cases that must fail

| Tampering | Detection |
|---|---|
| Change `blocks.hash` only | Recomputation differs; `CHECKPOINT_HASH_MISMATCH` |
| Change `blocks.chain_work` only | Sum differs; `CHAINWORK_MISMATCH` |
| Change `blocks.json` header field, keep old hash | Recomputation differs |
| Change `blocks.json` and `blocks.hash` consistently | Recomputed hash no longer equals the compiled checkpoint |
| Replace the whole row with a different valid block at the same height | Hash differs from the constant |
| Delete the checkpoint block | `CHECKPOINT_BLOCK_MISSING` / `VIOLATED` |
| Delete an ancestor, keep the suffix | `ANCESTRY_MISSING` |
| Rewrite `protocol_state` to claim a different network | S6 mismatch; compiled constants still win |
| Rewrite both DB and `protocol_state` | Checkpoint constants still reject a different history |
| Mine a new block at the checkpoint height with valid PoW | Its hash cannot equal the constant without a SHA-256 preimage attack |

M-01 and TE-63 are specified to exercise the first four.

### 8.8 Verification order relative to work

The checkpoint check runs **before** any comparison of cumulative work. A candidate chain with `10^30` work and a wrong checkpoint is rejected at step B6, and the work value is never read. This is Rule N-1 (§14.2). Instrumented tests (TE-24) must assert that the work accessor was not called.

### 8.9 What replaces original §8.4 Q3

The original text said:

> “locate the block at `checkpoint.height`, assert `block.hash === checkpoint.hash`, and assert recomputed cumulative work …”

Replace it with:

> “Load the block by height. Reconstruct its canonical header under the checkpoint’s era. Recompute its SHA-256 hash. Compare the recomputed hash — never a stored hash — to the compiled constant. Verify PoW, predecessor linkage, cumulative work, era, network, and full local ancestry to genesis. Reject before any work comparison. A stored `hash` field is never a trust input.”

That is the correction of record. [Proposed]

---

## 9. Checkpoint continuity and governance

### 9.1 Five things that are not the same thing

| Term | Definition | Authority | Failure mode |
|---|---|---|---|
| **Consensus checkpoint** | A tuple compiled into node software and enforced during validation | The binary the operator chose to run | A malicious binary can enforce a different history |
| **Checkpoint manifest** | A public, versioned description of checkpoint data (`docs/checkpoints/<network>.json`) | Published by maintainers; verified by anyone | A manifest can disagree with the binary or with another channel |
| **Digital signature** | Evidence that a designated key approved a manifest | The key holder | A signature proves approval, **not entitlement to change consensus** |
| **Peer-provided checkpoint** | A checkpoint value received over the network | The peer (untrusted) | Never adopted; compare-only |
| **Database-stored checkpoint** | A row in the local database | Anyone who can write the DB | Proves internal consistency, not authenticity |

A signature on a manifest is **not** a consensus change. A manifest is **not** a checkpoint. A peer’s claim is **not** evidence. A database row is **not** an anchor. Only the compiled constant is enforced. [Proposed]

### 9.2 Continuity rules (normative)

Let `S_r` be the checkpoint set compiled into release `r`, keyed by height, for one `networkId`.

| ID | Rule |
|---|---|
| **K-1** | **Append-only:** for any two releases `r` and `s` where `s` is a descendant of `r`, `S_r ⊆ S_s`. No checkpoint may be removed. |
| **K-2** | **Immutable values:** if `h ∈ S_r` and `h ∈ S_s`, every field of the tuple at `h` is byte-identical. No “correction” of a published checkpoint is valid. |
| **K-3** | **Monotonic height:** every new checkpoint height is greater than the maximum height in `S_r`. No retroactive insertion between existing anchors. |
| **K-4** | **Ancestry:** the block at a new checkpoint height must descend from the block at every prior checkpoint, verified by the §8.4 walk. A new checkpoint that does not extend the accepted chain is not a BNKR checkpoint. |
| **K-5** | **Network and genesis:** `networkId` and `genesisHash` never change. A release that changes either is a different network, not BNKR. |
| **K-6** | **Burial:** a checkpoint may be added only for a block that is already public and buried by at least `B` blocks (`B` proposed as 100; owner may set it). No checkpoint on the current tip. |
| **K-7** | **Derivation:** the value must be reproducible by a published script from a chain any operator can hold. A value that cannot be derived is a decree. |
| **K-8** | **Publication-before-use:** the manifest must be published before the binary that enforces it, for at least `P` days (`P` proposed as 14; owner may set it). |
| **K-9** | **Manifest chaining:** each manifest includes the SHA-256 of the previous manifest body. A manifest that does not chain to the prior published manifest is invalid. |
| **K-10** | **Binary binding:** each binary embeds the manifest digest and exposes it in `/api/node` and `/health`. A binary whose embedded digest does not match the published manifest is rejected by operators. |
| **K-11** | **Conflict is fatal:** two releases that assign different values to the same height are in conflict. A node must refuse to peer with the other set and must not choose by work. Resolution is social; no algorithm can decide which history is “real”. |
| **K-12** | **Recovery uses the same set:** database restore, re-sync, and disaster recovery never justify changing a checkpoint. A recovered node re-verifies the existing constants. |

These rules make silent ratification impossible **if operators check them**. They do not make it impossible in the sense of a cryptographic proof; a user who runs a malicious binary has delegated consensus to that binary.

### 9.3 Derivation, not decree

A checkpoint value is a **fact about a chain**, not a choice. The published derivation script must:

1. Take a chain source: a database export, a block file, or a peer chain plus the checkpoint it is being compared against.
2. Select the block by height.
3. Recompute the block hash under the correct era serializer.
4. Walk the ancestry to genesis and verify each linkage and PoW.
5. Sum cumulative work from height 1 to the checkpoint height.
6. Emit the tuple `{networkId, protocolVersion, height, blockHash, chainWork, genesisHash}` and a canonical manifest body.
7. Print the SHA-256 of the manifest body (`manifestDigest`).
8. Refuse to emit if any verification fails.

The script must be deterministic and dependency-light. It must not contact a privileged API, use a hardcoded “expected” hash as an input, or trust a stored `blocks.hash`. Two independent operators must run it on two independently obtained copies of the chain and publish byte-identical tuples. A mismatch is a stop signal. [Proposed; C-06]

**No checkpoint should be selected until this has happened.** A founder-computed hash is a proposal, not evidence.

### 9.4 Publication-before-use

| Stage | Requirement | Evidence |
|---|---|---|
| 1. Candidate | Block is public, buried by `B` blocks, and verifies | derivation output |
| 2. Independent reproduction | Two operators, two chain copies, identical tuple | signed statements or published logs |
| 3. Manifest | Canonical JSON committed to `docs/checkpoints/`, chained to the previous manifest | commit hash + `manifestDigest` |
| 4. Out-of-band publication | Website/social/release notes state the same tuple and digest | archived URL + timestamp |
| 5. Review window | At least `P` days between manifest publication and binary release | public timestamps |
| 6. Binary | Embeds the digest, exposes it, passes the conformance vectors | build artifact + `/api/node` |
| 7. Operator acceptance | Operators compare binary digest, manifest digest, and checkpoint tuple before upgrading | operator logs |

Any disagreement among channels is a **stop signal**, not a majority vote. The original §8.4 Q2 listed four channels; the correction adds derivability and a review window, because a channel without a derivation script is only an announcement. [Proposed; C-07]

### 9.5 Cadence and the unprotected range

Checkpoints at `H−1` and `H` protect the era boundary forever, but they say nothing about blocks mined after `H`. Everything above the newest checkpoint is protected only by cumulative work and `MAX_REORG_DEPTH`. On this chain that protection is weak:

- `MAX_DIFFICULTY = 6`; the modal difficulty has been 4 (`16^4 = 65,536` expected hashes per block).
- A 100-block rewrite at difficulty 4 is about `100 × 65,536 = 6,553,600` expected hashes.
- The independent review’s illustrative 5 MH/s assumption makes that roughly one second. That is an **assumption**, not a measured attack time, and it is not a universal cost. The arithmetic is in §15.8.
- `MAX_REORG_DEPTH = 100` (`:17`, enforced `:944-1029`) means a partition deeper than 100 blocks above the newest checkpoint cannot heal automatically.

Therefore:

1. Checkpoint cadence is a **security parameter**, not an optimization.
2. The specification must state: “history above the newest checkpoint is not economically protected at the current work profile.”
3. `MAX_REORG_DEPTH` and cadence must be decided together (Q-19). A small cap with sparse checkpoints converts a temporary partition into a permanent split (M-16).
4. A checkpoint must not be described as optional if it is the only practical protection against cheap historical rewriting under the current work profile.

**Proposed rule (parameter open):** add a checkpoint at least every `C` blocks and at every release, whichever comes first; require `B` confirmations before publishing; define a recovery path for partitions deeper than `MAX_REORG_DEPTH`. The values of `C`, `B`, and `MAX_REORG_DEPTH` are **not** chosen here. [Proposed; Q-19]

### 9.6 Conflicting releases and partitions

| Scenario | Required behavior |
|---|---|
| Release A has `{…,8000}`, release B has `{…,8000,9000}` | Both can be honest during a rolling upgrade. Compare on the **highest common** checkpoint; prefer the peer with the strict superset; do not reject merely because one has more anchors (§14.6). |
| Release A and B assign different hashes at height 8000 | **Conflict.** Refuse to peer, log both tuples, halt automatic resolution. Operators must compare manifests and attestations. There is no algorithmic winner. |
| A malicious release removes a checkpoint | Violates K-1. Any node that checks continuity rejects it. |
| A malicious release adds a checkpoint on an alternate history | Violates K-4. Reject unless it descends from all prior anchors. |
| A partition deeper than `MAX_REORG_DEPTH` | The cap prevents automatic healing. The node must report `PARTITION_TOO_DEEP`, not silently choose one side. Recovery requires operator action and possibly a new checkpoint on the legitimately heavier branch, published under §9.4. |
| Two operators publish different manifests for the same height | Stop. Re-derive from both chains. One of them is wrong or one chain is not BNKR. |

A network that cannot agree on which history is canonical has a social problem. The protocol’s job is to make the disagreement **visible and cheap to reject**, not to pretend it can be solved by arithmetic.

### 9.7 N-of-M attestation (proposal)

Signatures do not create authority, but a threshold of independent attestations makes unilateral checkpoint replacement visible and inconvenient.

**Proposal:**

- A manifest is valid for release only if it carries at least **3 valid signatures from 5 designated independent operators** (`3-of-5`), over the canonical manifest body.
- The founder may hold at most one key. A founder-only signature is insufficient.
- Keys are published, rotated with overlap, and revoked publicly.
- Signatures are verified by the release script and by operators; a binary that embeds an unsigned or under-threshold manifest fails its own release gate.
- The signature set does **not** change consensus by itself. Operators must still choose to run the binary. A threshold is evidence of review, not a consensus switch.

Alternative schemes (1-of-1 founder key, 2-of-3 foundation, token voting) are rejected as substitutes for independent operation. A token vote cannot make a false checkpoint true. The threshold is a governance aid. [Proposed; Q-21]

### 9.8 Malicious-release scenarios

| Scenario | Mitigation | Residual risk |
|---|---|---|
| Founder publishes a binary with a different checkpoint | K-1/K-2/K-4 + published manifest + independent attestations + operator diff | Operators who do not check will follow it |
| Repository owner force-pushes or deletes history | Mirrors, signed tags, commit hashes in release notes, independent builds | A compromised mirror set can hide the change |
| Release signing key is stolen | Threshold signatures, key rotation, revocation, out-of-band confirmation | Attacker can sign until revocation propagates |
| Binary is replaced on the download host | Reproducible builds, binary hash published in multiple channels, operator cross-check | Users who do not verify are exposed |
| Dependency compromise | Lockfiles, pinned hashes, minimal dependencies, reproducible builds | Supply-chain attacks remain possible |
| A malicious release removes the checkpoint check entirely | Code review, conformance vectors, operator diff, independent implementation | A user running the binary has delegated validation |
| Founder disappears | Published derivation script, manifests, independent operators, no runtime founder dependency | No second operator exists today; chain would validate but nobody could join |

### 9.9 Founder disappearance

What already works without the founder:

- The chain validates locally; no runtime call to the founder exists in `ledger.js` or `index.js`. [Verified]
- Rewards and supply are enforced by `validateBlock`, not by an admin endpoint. No admin endpoint exists. [Verified]
- A node with a complete database can keep validating new blocks if it can reach peers and receive blocks.

What does **not** work:

- No distributable full-node artifact or reproducible build is documented.
- No seed/discovery mechanism independent of the hosted API.
- No checkpoint derivation script is published.
- No second operator or second implementation exists.
- The hosted database token and release channel are single-party.
- The only web UI is tied to the hosted API.

**Verdict:** the code does not require the founder at runtime, but the **network** does require the founder operationally. That is a governance gap, not a consensus bug. The fix is a distributable node, published manifests, and at least one independent operator — not a new opcode.

### 9.10 Compromised repository or distribution channel

Recovery procedure for operators:

1. Stop the node. Do not delete the database.
2. Obtain the source from at least two independent mirrors at a commit whose hash is known out-of-band.
3. Rebuild from source; compare the binary hash to at least two independent builds.
4. Compare the embedded `manifestDigest` to the published manifest and to the out-of-band announcement.
5. Run the conformance vectors and the historical hash gate (§7.8) on a copy of the database.
6. Verify every checkpoint with §8.3.
7. Only then restart and peer.

If any step disagrees, the operator must not “pick the newest” binary. A compromised distribution channel is a stop condition. [Proposed]

### 9.11 Recovery from database corruption

| Corruption | Recovery |
|---|---|
| Bad tip above the highest checkpoint | Roll back only above the checkpoint; rebuild accounts from replay; log and serve only after S1–S8 pass |
| Corruption at or below the highest checkpoint | **Fatal.** Do not truncate below the anchor. Re-sync from peers; the checkpoint authenticates the replacement |
| Missing checkpoint block | Fatal at startup; re-sync |
| Altered `protocol_state` | S6 fatal; compiled constants win |
| Whole database lost | Bootstrap from genesis or from a peer; verify genesis, `CP-PRE`, `CP-ACT`, then replay the suffix |
| Backup below `CP-TIP-AT-RELEASE` | Sync-only mode until the tip reaches the release checkpoint (§12.7); do not serve misleading healthy status |

The old binary’s repair loop (`:569-616`) is the opposite of this policy: it slices the tip until something validates and then serves. §10 addresses why a new binary must never do that for an unknown version.

### 9.12 Independent operator rejection procedure

An operator who believes a checkpoint change is unauthorized must be able to reject it without forking the code:

1. Do **not** upgrade to the new binary.
2. Publish the manifest tuple and digest they consider canonical.
3. Continue running the prior binary, which enforces the prior set.
4. Refuse to peer with nodes whose checkpoint set conflicts (K-11).
5. State publicly which chain they are following and why.
6. If the conflict persists, treat it as a network partition, not a bug to be “fixed” by deleting the anchor.

This is a refusal to follow, not a defence by hashpower. On a chain where 100 blocks cost seconds, an operator cannot out-mine a founder; they can only refuse to validate the founder’s chain. The design must not pretend otherwise.

### 9.13 Trade-offs

| Mechanism | Strength | Weakness | Appropriate role |
|---|---|---|---|
| **Hardcoded checkpoint** | Cheap, deterministic, unforgeable without SHA-256 break | Inflexible; controlled by whoever builds the binary | **Required** for historical anchors |
| **Social consensus** | Legitimate; can resolve conflicts | Slow, ambiguous, capture-prone, invisible to software | **Unavoidable** around any contentious change |
| **Signed release / manifest** | Operational integrity; detects tampering | Key compromise, rotation, false sense of authority | **Evidence**, never the sole anchor |
| **Independent node software** | Strongest: multiple implementations can reject a bad release | Requires real operators and diversity; expensive | **The actual goal** |
| **Peer-provided checkpoint** | Convenient | Attacker is the peer | **Compare-only, never adopt** |
| **Database-stored checkpoint** | Useful for local consistency | Attacker with DB write access controls it | **Integrity aid only** |

### 9.14 What cryptography can and cannot do

| Can reduce cryptographically | Requires transparent coordination |
|---|---|
| Tampering with a historical block | Choosing which history is canonical |
| Forging a checkpoint hash | Deciding that a checkpoint is the right one |
| Replaying a block on another network after `H` | Deciding when `H` is safe |
| Creating supply outside the reward rule | Deciding whether the issuance schedule is the intended one |
| Altering stored metadata undetected | Preventing a compromised release from being run |
| Proving a block descends from genesis | Proving that an operator is independent |
| Binding a block to a network ID | Binding a human to a governance promise |

**Founder-independence requirement:** the founder must not possess an undisclosed private mechanism to replace checkpoint history. Today the founder controls release engineering, the Turso credential (which can edit `accounts` directly), the hosted deployment, and checkpoint selection. None of those is a consensus opcode, and none should be described as one. The mitigation is disclosure, multi-party release control, published derivations, and independent operators — not a claim that cryptography has removed the trust.

No DAO, token vote, or on-chain governance is proposed. Those would add surface without adding independent validation.

---

## 10. Old-node compatibility and safe refusal

### 10.1 What a V1 binary actually does with V2 data

This is verified behavior, not a hypothesis.

A V2 block at height `H` has a hash computed over 11 fields. A V1 binary computes `sha256(JSON.stringify(headerOf(block)))` over 9 fields (`ledger.js:36-52`). The two digests differ. Therefore:

1. `validateChainInternal` reaches the first V2 block and throws at `validateBlock:371` (`Block hash or proof of work is invalid.`).
2. `createLedger` catches the invalid chain in the startup path and enters the repair loop (`:569-616`).
3. The loop tries `storedBlocks.slice(0, end)` for `end` from the tip down to 1 until `validateChainInternal` returns valid.
4. At `end = H`, the chain `0 … H−1` is valid under V1. The loop selects it.
5. The transaction deletes `blocks WHERE height >= H` and clears `mempool`; accounts are rebuilt from the surviving prefix (`:594-610`).
6. The process logs `Rolled back N invalid tip block(s)` and **continues serving**.

The database is not preserved. The V2 blocks are deleted. The node appears healthy at height `H−1`. This is **silent truncation** in the operational sense: there is a log line, but the node serves a shorter chain and reports itself valid.

**Consequence:** TE-62 as originally written (“Refuses to start — never silently truncates”) is **unsatisfiable for a V1 binary**. A specification cannot retrofit behavior into a binary that does not read it. [Verified: `validateBlock:371`, repair loop `:569-616`]

### 10.2 Why this cannot be fixed in the old binary

- The old binary has no `version` field in its schema, no `UNSUPPORTED_PROTOCOL_VERSION` classification, and no checkpoint constants.
- The behavior is in the startup path of the released code; changing it requires a new binary.
- A database sentinel (a new table or row) is ignored by `getBlocks()` (`SELECT json FROM blocks`) and by `validateChainInternal`.
- Refusing to serve would require a code path that does not exist.

The only honest treatments are:

1. **Document it** as expected behavior for pre-V2 binaries.
2. **Withdraw** V1 binaries from distribution before activating V2.
3. **Require** operators to upgrade and verify before the activation height.
4. **Test it** in an isolated harness so nobody mistakes truncation for safety (TE-62b).

### 10.3 Required new-binary behavior

A binary that supports V2 (or any version `N`) must inspect persisted blocks **before** any repair decision:

```text
function classifyStartup(store, maxSupportedVersion):
    versions = scanRawJsonVersions(store)          // parse each row's json; do not validate yet
    if any v is not safeInt: return CORRUPTION
    if any v > maxSupportedVersion:
        return UNSUPPORTED_PROTOCOL_VERSION        // highest precedence
    if any v == maxSupportedVersion+1: ...         // same classification
    if any v < 1 or v not in supported set: return CORRUPTION
    if eraViolation(v, height): return ERA_VIOLATION
    if hash/pow/ancestry failure: return CORRUPTION
    return OK
```

**Precedence rule:** an unknown future version is classified **before** any hash or work conclusion. A v3 block will almost certainly fail a v2 hash check; that does not make it corrupt. It is unsupported. [Proposed]

On `UNSUPPORTED_PROTOCOL_VERSION` the node must:

1. Exit non-zero with a stable code (`10`).
2. Print `UPGRADE REQUIRED: database contains block version N; this binary supports up to M.`
3. Preserve the database byte-for-byte. No `DELETE`, no rollback, no account rebuild, no migration.
4. Not bind the HTTP port.
5. Not report healthy in any supervisor or `/health` response.
6. Optionally write a read-only diagnostic file (not in the DB) naming the first unsupported height.

### 10.4 Version compatibility matrix

| Binary | Database | Required result |
|---|---|---|
| V1 | V1 only | Normal V1 operation |
| V1 | V2 blocks present | **Truncates to `H−1`**; documented unsafe; must not be used with V2 data |
| V1 | V3 blocks present | Truncates; even less safe |
| V2 | V1, tip `< H` | Starts; checkpoints `NOT_YET_APPLICABLE`; does not serve as a V2 node above `H` until upgraded chain reaches `H` |
| V2 | V1→V2 boundary, consistent | Starts; verifies `CP-PRE`, `CP-ACT`; enforces era |
| V2 | V2 only | Normal |
| V2 | V3 blocks present | **Safe refusal**, exit 10, no repair |
| V2 | V2 block below `H`, or V1 block above `H` | `ERA_VIOLATION`; fatal, no repair |
| V2 | Unknown-version block + hash mismatch | Classify **unsupported first**; refuse; do not repair |
| V3 | V2 blocks present | Migration path defined by V3; must verify V2 checkpoints before extending |
| V3 | V2 + V3 | Normal for V3 |
| V3 | V4 present | Safe refusal |

### 10.5 Corruption versus unsupported version

| Signal | Classification | Allowed action |
|---|---|---|
| Numeric `version` greater than the binary’s maximum | `UNSUPPORTED_PROTOCOL_VERSION` | Refuse; preserve; exit 10 |
| Missing `version` above `H` | `ERA_VIOLATION` | Refuse; preserve; exit 11 |
| `version: 2` below `H` | `ERA_VIOLATION` | Refuse; preserve; exit 11 |
| Known version, hash mismatch | `CORRUPTION` | Repair only above the highest checkpoint; else exit 14 |
| Known version, bad PoW | `CORRUPTION` | Same |
| Known version, broken `prevHash` | `CORRUPTION` | Same |
| Known version, wrong chain work | `CORRUPTION` | Same |
| Missing block below a checkpoint | `CHECKPOINT_VIOLATION` | Refuse; re-sync; exit 11 |
| `protocol_state` mismatch | `IDENTITY_VIOLATION` | Refuse; exit 13 |
| Storage configured but unreachable | `STORAGE_ERROR` | Refuse; exit 13 |

**The rule:** an unsupported protocol version is **not** automatically a corrupt block. Treating it as corruption is how the current repair loop destroys data.

### 10.6 TE-62 split

| Test | Scenario | Expected |
|---|---|---|
| **TE-62a** | V2 binary starts on a database containing a numeric version greater than its maximum | Exit 10; `UPGRADE REQUIRED`; database row count and SHA-256 unchanged; port not bound; no repair log |
| **TE-62b** | Actual V1 binary starts on a V2 database in an isolated fixture | Expected-behavior harness: block count decreases to `H`, V2 blocks deleted, process still serves. This test **documents** truncation; it does not assert safety and is never a release gate for V1. |

TE-62b is the only honest way to test a binary that cannot be changed. It must be marked `EXPECTED-UNSAFE` in the test report.

### 10.7 Exit codes

| Code | Meaning |
|---|---|
| 0 | Normal |
| 10 | Unsupported protocol version |
| 11 | Checkpoint violation / era violation |
| 12 | Database rollback below release checkpoint |
| 13 | Storage or identity configuration failure |
| 14 | Corruption below the highest checkpoint |
| 15 | Build/manifest identity mismatch |
| 20 | Recovered from tip above checkpoint (warning; serving allowed) |

### 10.8 Operational mitigations

1. Announce the activation height and the upgrade deadline before distributing any V2 binary.
2. Withdraw V1 binaries from the download host; keep them only in an archive marked “DO NOT RUN AGAINST V2 DATA”.
3. Publish a preflight tool that scans a database copy for `version` values without modifying it.
4. Require operators to back up before upgrading and to verify the backup hash.
5. Monitor `/api/node` for `protocolVersion` and `checkpointState`; alert on `NOT_YET_APPLICABLE` near `H` and on any `VIOLATED`.
6. Do not describe a V1 binary as “safe” after `H`. It is not.

---

## 11. Production baseline correction

### 11.1 Five baselines, not one

| ID | Baseline | Evidence | What it is |
|---|---|---|---|
| **B0** | Deployed production | Live `/api/validate` observed during the audit: `{valid:true, height:858, chainWork:249342768, error:null}`, keys `[chainWork, error, height, protections, supply, valid]`; `accountsValid` **absent** | The software actually serving users. Commit unknown. Backend [Unverified]. |
| **B1** | Repository `HEAD` `908c642b110945264665a437fc691f59a3a94208` | `git show HEAD:server/ledger.js` is 875 lines; `validateStoredChain` at 438; no `accountsValid`, no `accountsMatchValidation`, no `sumBalances`; repair at 475 | The last committed code |
| **B2** | Working tree | 1,163-line `server/ledger.js`; `accountsValid` at 524; `accountsMatchValidation:558`; `sumBalances:547`; diff `+417/−129` in `ledger.js`, `+501` in `ledger.test.js` | Uncommitted Phase-1 work |
| **B3** | Phase 1 proposed | Fail-closed storage, S1–S8, `/health`, account validation; **not V2** | Design, not implemented |
| **B4** | V2 proposed | This document: serialization, checkpoints, version-aware validation, peer handshake | Design, not implemented |

B0, B1, and B2 are **three different programs**. A capability present in B2 must never be described as deployed. A capability present in B1 must never be described as running in B0.

### 11.2 Capability evidence table

| Capability | B0 deployed | B1 HEAD | B2 working tree | B3 Phase 1 | B4 V2 |
|---|---|---|---|---|---|
| `validateStoredChain` | present (response shape) | **yes** (`HEAD:438`) | yes (`:520`) | yes | yes |
| `accountsValid` in `/api/validate` | **no** (verified absent) | **no** | **yes** (`:524`) | required | required |
| `accountsMatchValidation` | unknown | **no** | **yes** (`:558`) | required | required |
| `sumBalances` supply guard | unknown | **no** | **yes** (`:547`) | required | required |
| Fail-closed storage | **no** (audit proved fail-open) | **no** | **no** | proposed | required |
| `protocol_state` | **no** | **no** | **no** | proposed | required |
| Checkpoint verification | **no** | **no** | **no** | proposed | required |
| V2 serializer / `networkId` in hash | **no** | **no** | **no** | no | proposed |
| `/health` | **no** (no route) | **no** | **no** | proposed | required |
| Build identifier in `/api/node` | **no** | **no** | **no** | proposed | required |
| Peer authentication | **no** | **no** | **no** | no | proposed |
| Paged chain sync | **no** | **no** | **no** | no | proposed |
| State root / light client | **no** | **no** | **no** | no | **deliberately absent** |

**Rule:** every row marked “deployed” requires a B0 observation, not an inference from source. Rows marked “unknown” are [Unverified], not “probably present”.

### 11.3 What the deployed baseline actually proves

- The deployed build validates a height-858 chain with work `249342768`.
- It returns `valid:true` for the BNKR database.
- It omits `accountsValid`, so the working-tree account reconciliation is **not** deployed.
- It is therefore **not** the reviewed tree and cannot be assumed to contain the Phase-1 hardening.

It does **not** prove:

- that the backend is Turso (U-2);
- that startup validation is fatal (the audit proved the fail-open path in code; production behavior is [Unverified]);
- that the deployed commit is `908c642` or any specific commit;
- that `/api/validate` is the only health signal;
- that the database integrity check runs at all in production.

### 11.4 Required build identity

A V2 node must expose, in `/api/node` and `/health`:

```json
{
  "buildId": "<git commit + build timestamp + builder>",
  "sourceCommit": "<40-char commit>",
  "protocolVersion": 2,
  "networkId": "BNKR-MAINNET-V1",
  "genesisHash": "49f9e886…ebaa",
  "checkpointSetDigest": "<sha256 of canonical checkpoint set>",
  "manifestDigest": "<sha256 of canonical manifest body>",
  "storage": "turso|local",
  "checkpointState": "NOT_YET_APPLICABLE|APPLICABLE|VIOLATED"
}
```

No secrets, tokens, hostnames with credentials, or query strings. A build that cannot report its identity is not eligible for testnet.

### 11.5 Separation of baselines in every claim

| Claim type | Required label |
|---|---|
| “The code does X” | B1 or B2 with line reference |
| “The deployed node does X” | B0 with an observed response or log |
| “Phase 1 will do X” | B3, proposed |
| “V2 will do X” | B4, proposed |
| “The audit proved X” | Evidence input with section |

A sentence that mixes two labels is a defect in the document. The original specification mixed B2 and B0 in §2.2 B-12 and §13.3 S7; that is corrected here.

---

## 12. Fail-closed storage specification

### 12.1 Current behavior (verified)

| Behavior | Source | Consequence |
|---|---|---|
| DB path defaults to `BANNEKER_DB \|\| BLACKCOIN_DB \|\| <cwd>/bannekercoin.db` | `index.js:19` | silent local file when no remote is configured |
| `TURSO_DATABASE_URL` missing or **empty** ⇒ `file:<path>` | `ledger.js:432-437` | no distinction between “not configured” and “configured wrongly” |
| A misspelled variable is never read | same | no error, no warning |
| `createLedger` creates schema and seeds genesis if empty | `ledger.js:~461-513` | a fresh empty database becomes a “valid” height-0 chain |
| `validateStoredChain` returns `{valid:true, height:0, supply:0, chainWork:"0"}` on a fresh file | `ledger.js:520-530` | fail-open reports health |
| Startup validation failure is logged, not fatal | `index.js:43-50` | a broken node keeps serving |
| An isolated run with no Turso configuration created a local DB and issued a height-1 mining template | audit §5 | proven fail-open, not theoretical |
| `createLedger(databasePath = 'blackcoin.db')` | `ledger.js:432` | a wrong-network-looking default |
| `BLACKCOIN_DB` / `BLACKCOIN_PEERS` aliases | `index.js:19`, `:52` | legacy branding can silently select the wrong store |

This is the live Critical defect the review identified as T-16. It is independent of V2 and should be fixed first. [Verified]

### 12.2 Required configuration (no implicit fallback)

| Variable | Required when | Meaning |
|---|---|---|
| `BNKR_STORAGE` | always | exactly `"turso"` or `"local"`; no default |
| `TURSO_DATABASE_URL` | `BNKR_STORAGE=turso` | remote endpoint; non-empty |
| `TURSO_AUTH_TOKEN` | `BNKR_STORAGE=turso` | credential; never logged |
| `BNKR_DB_PATH` | `BNKR_STORAGE=local` | local file path; non-empty |
| `NODE_ENV` | always | `production` tightens rules |
| `BNKR_EXPECTED_NETWORK_ID` | optional | if set, must equal the compiled constant |
| `BNKR_ALLOW_LOCAL_IN_PRODUCTION` | optional, dangerous | `"1"` permits local storage in production; must log a warning |
| `BNKR_RECOVERY_SYNC_ONLY` | optional | `"1"` enters sync-only recovery (§12.7) |

Rules:

1. `BNKR_STORAGE` missing, empty, or unknown ⇒ **fatal**, exit 13, before listen.
2. `BNKR_STORAGE=turso` with either Turso variable missing, empty, or whitespace ⇒ **fatal**. No local fallback, ever.
3. `BNKR_STORAGE=local` in `NODE_ENV=production` ⇒ fatal unless `BNKR_ALLOW_LOCAL_IN_PRODUCTION=1` **and** a warning is logged at startup and exposed in `/health`.
4. `BNKR_STORAGE=local` with a missing `BNKR_DB_PATH` ⇒ fatal.
5. Remove the `'blackcoin.db'` default argument and the `BLACKCOIN_DB`/`BLACKCOIN_PEERS` aliases (C-24).
6. Log the resolved backend as `storage=turso host=<host> db=<name>` or `storage=local path=<basename>`. Never log the token, the full URL with query parameters, or the database path in a public endpoint.
7. Environment variables may **assert** identity; they may never **define** `NETWORK_ID`, `GENESIS_HASH`, checkpoints, or `PROTOCOL_V2_HEIGHT` (§8.5 of the original is correct).

### 12.3 Production versus development

| Mode | Allowed storage | Allowed fail-open | Startup on empty DB | `/health` on failure |
|---|---|---|---|---|
| `NODE_ENV=production` | turso; local only with explicit override | **no** | **fatal** (S5) | 503, then exit |
| `NODE_ENV=test` | local temp file or in-memory fixture | no | allowed only with an explicit test fixture flag | 503 |
| `NODE_ENV=development` | local or turso, explicit `BNKR_STORAGE` | no | allowed | 503 |
| Unset `NODE_ENV` | treated as production for storage rules | **no** | **fatal** | 503, then exit |

The distinction is not cosmetic. A development convenience must never be reachable by an unset environment variable in production. “Unset” defaults to the strict mode.

### 12.4 Startup assertions (expanded)

Run before `app.listen`, in this order. All are fatal unless stated.

| # | Assertion | Failure code |
|---|---|---|
| S1 | Resolved storage matches the declared mode; the backend is reachable; schema is readable | 13 |
| S2 | Genesis block in storage recomputes to `GENESIS_HASH` | 14 |
| S3 | Block at `CP-PRE.height` recomputes to `CP-PRE.blockHash`, with correct work and ancestry | 11 |
| S4 | Block at `CP-ACT.height`, if tip permits, recomputes to `CP-ACT.blockHash` | 11 |
| S5 | `tip.height ≥ CP-TIP-AT-RELEASE.height` unless recovery mode is explicitly set | 12 |
| S6 | `protocol_state.network_id` equals the compiled constant (if the row exists) | 13 |
| S7 | `validateStoredChain()` returns `valid:true` **and** `accountsValid:true` | 14 |
| S8 | Every block respects its era (`v1 < H`, `v2 ≥ H`) | 11 |
| S9 | Build identity and `manifestDigest` match the compiled constants | 15 |
| S10 | Every compiled checkpoint verifies under §8.3, including ancestry | 11 |

S5 is what turns the live fail-open height-0 case into a hard failure: a fresh file is below any release checkpoint. S7 is impossible on B0 because `accountsValid` is absent; that is the point. A V2 node must not start on a build that cannot report it.

### 12.5 `protocol_state` as an assertion aid

```sql
CREATE TABLE IF NOT EXISTS protocol_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  network_id TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  min_reader_version INTEGER NOT NULL,
  max_reader_version INTEGER NOT NULL,
  activation_height INTEGER,
  checkpoint_height INTEGER,
  checkpoint_hash TEXT,
  checkpoint_manifest_digest TEXT,
  build_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- It is **descriptive and assertive**, never authoritative. Consensus constants live in code.
- `min_reader_version`/`max_reader_version` let a new binary detect that a row was written by a newer or older implementation.
- A mismatch is fatal (S6, S9), not a migration.
- A V1 binary ignores the table entirely; that is why it cannot be the sentinel that stops truncation.
- The row must not contain balances, supply, or checkpoint values used for validation.

### 12.6 Health and observability

```text
GET /health
200 {
  "ok": true,
  "buildId": "...",
  "protocolVersion": 2,
  "networkId": "BNKR-MAINNET-V1",
  "genesisHash": "49f9e886…",
  "height": 858,
  "checkpointState": "APPLICABLE",
  "storage": "turso",
  "accountsValid": true
}
503 { "ok": false, "reasonCode": "STORAGE_UNREACHABLE" | "CHECKPOINT_VIOLATION" | ... }
```

No stack traces, no tokens, no full URL, no internal paths in the public body. Detailed diagnostics go to logs with a correlation ID.

### 12.7 Sync-only recovery mode (C-21)

The original S5 forbade starting below `CP-TIP-AT-RELEASE`, which made the documented “restore and resync” path impossible. Corrected behavior:

| Condition | Behavior |
|---|---|
| `BNKR_RECOVERY_SYNC_ONLY=1` and storage is valid | Start in recovery: do **not** serve normal API; expose only `/health` and a minimal `/api/node` with `serving:false`, `checkpointState`, and sync progress |
| Sync reaches `CP-TIP-AT-RELEASE` and all checkpoints verify | Require a restart into normal mode; never flip automatically |
| Recovery flag set without a valid storage mode | Fatal (S1) |
| Recovery flag used on a healthy chain | Allowed but logged; still read-only |
| An operator tries to serve user traffic in recovery | Rejected by middleware |

Recovery mode is not a bypass of S2–S4/S6–S10. It only relaxes S5 until the chain catches up. It must be impossible to enable accidentally, and it must be visible in `/health`.

### 12.8 What production must never do

1. Select a local file because a remote variable is missing, empty, or misspelled.
2. Create a fresh database and report `valid:true`.
3. Bind the HTTP port before S1–S10 pass.
4. Log or expose the Turso token.
5. Serve a height-0 chain in production.
6. “Repair” a database across a checkpoint.
7. Report healthy while `accountsValid` is false or unknown.
8. Trust `protocol_state` over compiled constants.
9. Treat an unsupported version as corruption.
10. Continue after a build/manifest identity mismatch.

### 12.9 Scope note

This section specifies behavior; it does **not** change any production environment variable, Render service, Turso database, or deployment. The actual production configuration was not read or modified. U-1 and U-2 remain open.

---

## 13. Activation and checkpoint evidence requirements

### 13.1 Two different decisions

| Decision | Question | Not answerable until |
|---|---|---|
| **Activation height** `H` | When do the new rules become mandatory? | The readiness gates in §13.3 are met and the measured evidence in §13.2 exists |
| **Checkpoint set** | Which historical heights are anchored, and with what hashes? | The evidence in §13.4 exists for each checkpoint, independently reproduced |

They are related but not the same. A checkpoint at `H−1` can be derived before `H` is chosen, but it cannot be published as a release constant until `H` is stable. An activation height without a `CP-PRE` anchor is unsafe because the Era 1 prefix is shared with BLKC.

### 13.2 Q-1 evidence pack (historical; value now selected in §21.9)

The following must be measured and published before any `H` is proposed. None of these values is asserted here.

| Variable | Definition | Source | Why it matters |
|---|---|---|---|
| `tip_announce` | Chain tip at the moment `H` is announced | node `/api/node` | `H` must be above it by a margin |
| `T_obs` | Median inter-block interval over the last 2,016 blocks | timestamps from the local chain | the target 15 s is not the observed cadence |
| `T_p90` | 90th-percentile inter-block interval | same | a single slow period can eat the margin |
| `T_target` | `TARGET_BLOCK_SECONDS = 15` | `ledger.js:9` | for comparison only |
| `D_margin` | Wall-clock days of margin the owner wants | owner | e.g. 30/60/90 days; not selected |
| `M_blocks` | `ceil(D_margin × 86400 / T_obs)` | derived | the number of blocks that must exist before `H` |
| `M_min` | `2016` (original proposal) | original §7.3 | a floor, not a substitute for the formula |
| `hashrate_est` | `16^d / T_obs` at modal difficulty `d` | derived | expected hashes per second on the network |
| `miner_count` | Distinct miners in the last 1,000 blocks | block `miner` field | diversity |
| `operator_count` | Independent nodes that have validated the same chain | operator attestations | independence |
| `impl_count` | Independent serializer implementations | published vectors | cross-implementation |
| `peer_count` | Reachable peers from a fresh node | `/api/node`, peer test | bootstrap |
| `upgrade_signal` | Fraction of peers reporting V2 capability | `/api/node` handshake | rolling-upgrade readiness |
| `testnet_result` | Full TE + MT matrix on an isolated chain | test report | evidence, not a claim |

**Formula (for the record, not a selection):**

```text
H >= tip_announce + max(M_min, M_blocks)
M_blocks = ceil(D_margin * 86400 / T_obs)
```

`M_blocks` depends almost entirely on which cadence statistic is used, and §15.5 shows that the frequently quoted ~1,700 s figure is a mean contaminated by a 16-day genesis offset, not a block time. At a 30-day margin:

| `T_obs` used | Source | `M_blocks` for 30 days |
|---|---|---|
| 1,700 s | all-gap mean (contaminated) | 1,525 |
| 69.2 s | `p90` gap | 37,457 |
| 24.6 s | non-idle mean | 105,366 |
| 8.05 s | median gap | 322,147 |
| 15 s | `TARGET_BLOCK_SECONDS` | 172,800 |

`M_min = 2,016` therefore dominates **only** under the contaminated reading. Under any measured cadence, a 30-day margin requires tens to hundreds of thousands of blocks. The original "2,016 blocks ≈ 2 weeks" statement is wrong for both the target and the measured network; it is accidentally close only to the 1,700 s artifact. `T_obs` must be declared explicitly when `M_blocks` is computed. [Verified arithmetic; cadence measurement in §15.5]

**Readiness gates (all must pass):**

| Gate | Criterion | Current status |
|---|---|---|
| A-1 | At least two independent nodes run the current V1 code and agree on the tip | **Not met** (`peers: 0` at baseline) |
| A-2 | At least three distinct miners have produced blocks in the last 1,000 | **Unknown** |
| A-3 | A second, non-JavaScript serializer reproduces all V-01…V-12 vectors | **Not met** |
| A-4 | Every checkpoint in the release has two independent derivations | **Not met** |
| A-5 | Full test matrix passes on two machines with identical hashes | **Not met** |
| A-6 | Testnet `BNKR-TESTNET-V1` has run the matrix and a rolling upgrade | **Not met** |
| A-7 | Rollback/cancel procedure is published with a named decision-maker | **Not met** |
| A-8 | Wallet/miner builds using the shared serializer are available | **Not met** |
| A-9 | Fail-closed storage and `/health` are deployed and verified | **Not met** (B0 lacks both) |
| A-10 | Q-1, Q-2, Q-19, and Q-23 are answered in writing | **Open** |

**Cancellation/delay procedure:** before `H`, the named decision-maker (Q-23) must be able to publish a signed delay notice and a replacement binary with a later `H`. After `H`, a “delay” is a rollback and is a fork (§18.2 of the original is correct). The procedure must state who can call it, how it is authenticated, how operators verify it, and how a malicious delay is rejected. No such procedure exists today.

### 13.3 Q-1 verdict

**Historical verdict; superseded by §21.2 and §21.9.** The design-only review left `H` unselected because no second implementation or independent operator existed. On 2026-11-18 the owner selected height 2026. The live mainnet then remained in Era 1 past that height, so on 2026-11-19 the compiled schedule was postponed to `V2_ACTIVATION_HEIGHT = 5000`. The readiness concerns below remain valid as deployment and governance considerations, not as a reason to leave the parameter unset.

### 13.4 Q-2 evidence pack (historical; checkpoint now selected in §21.9)

For each proposed checkpoint, the following record must be published. A checkpoint without this record is a decree.

| Field | Requirement |
|---|---|
| `networkId` | `BNKR-MAINNET-V1` (or testnet) |
| `source` | Which database/export/peer chain it was derived from, with a SHA-256 of the source artifact |
| `height` | Exact height |
| `blockHash` | Recomputed under the correct era serializer, lowercase hex |
| `prevHash` | The block’s stored `prevHash`, plus the recomputed parent hash |
| `ancestry` | Result of the §8.4 walk from the checkpoint to genesis: every link verified, or the failing height |
| `pow` | Recomputed hash has `difficulty` leading hex zeros; difficulty value recorded |
| `chainWork` | Sum of `16^difficulty` from height 1 to the checkpoint, as a decimal string |
| `validateChain` | Result of a full replay through the checkpoint, including supply and account reconciliation |
| `dbIntegrity` | SHA-256 of the source database file or logical export; row count; no mutation during derivation |
| `reproduction` | A second operator’s independent derivation, same tuple, different source copy |
| `manifest` | Canonical manifest body and its SHA-256 |
| `publication` | Channel, URL/commit, timestamp, and the review window |
| `era` | `protocolVersion: 1` below `H`, `2` at/above `H` |
| `genesis` | `49f9e886…ebaa` |

**Why no checkpoint may be selected until this exists:**

1. A hash copied from a stored `blocks.hash` is not evidence; `applyBlock:731-734` stores the value the client supplied.
2. A hash computed by one person on one database is a proposal, not a consensus fact.
3. A checkpoint above the tip is `NOT_YET_APPLICABLE`; publishing it as “enforced” is false.
4. A checkpoint on an alternate history would ratify a fork (K-4).
5. A checkpoint whose ancestry was never walked could anchor a truncated or tampered prefix (R-12).
6. A checkpoint without a manifest digest cannot be tied to what was published.

### 13.5 Checkpoint set shape (structure only, no values)

```text
CP-GENESIS        height 0,     protocolVersion 1, hash = GENESIS_HASH
CP-PRE            height H-1,   protocolVersion 1
CP-ACT            height H,     protocolVersion 2
CP-TIP-AT-RELEASE height R,     protocolVersion 1 or 2, R >= H if activated
CP-<cadence>      height > R,   added by later releases under K-1..K-12
```

`CP-GENESIS` and `CP-PRE` are not redundant: genesis is shared with BLKC and cannot distinguish two same-genesis chains; `CP-PRE` can. This must be stated in the specification and in the operator documentation.

### 13.6 What would make a checkpoint invalid

| Condition | Verdict |
|---|---|
| Recomputed hash does not equal the constant | invalid |
| Ancestry walk fails | invalid |
| PoW invalid | invalid |
| `chainWork` mismatch | invalid |
| `networkId`/genesis mismatch | invalid |
| Height above the tip at publication | premature, not yet applicable |
| Different value at the same height in another release | conflict; halt |
| No published derivation | decree; not eligible for release |
| Only the founder reproduced it | insufficient for mainnet |

---

## 14. Chain replacement validation order

### 14.1 The algorithm (normative)

```text
function replaceChain(candidate):
    // A. Structure
    require(Array.isArray(candidate))                       -> NOT_AN_ARRAY
    require(1 <= candidate.length <= MAX_CHAIN_BLOCKS)      -> CHAIN_TOO_LONG
    require(serializedSize(candidate) <= MAX_CHAIN_BYTES)   -> CHAIN_TOO_LARGE
    require(heightsAreContiguousFromZero(candidate))        -> HEIGHT_GAP

    // B. Identity and era (no work read)
    require(candidate[0] recomputes to GENESIS_HASH)        -> GENESIS_MISMATCH
    require(candidate[0].chainWork == "0")                   -> GENESIS_WORK_NONZERO
    for each block:
        require(eraVersion(block.height, H) is legal)       -> ERA_VIOLATION
        if block.height >= H:
            require(block.version == 2)                      -> ERA_VIOLATION
            require(block.networkId == LOCAL_NETWORK_ID)     -> NETWORK_ID_MISMATCH
        requireNoUnknownHeaderFields(block)                 -> EXTRA_HEADER_FIELD
    for each compiled checkpoint cp:
        state = checkpointState(cp, candidateTipHeight)
        require(state != VIOLATED)                          -> CHECKPOINT_VIOLATION
        if state == APPLICABLE:
            require(verifyCheckpointAt(cp, candidate))      -> CHECKPOINT_VIOLATION

    // C. Consensus validity
    base = highestVerifiedCheckpointAtOrBelow(tip, candidate)
    replay from base (or 0 if full audit) through tip:
        MTP, difficulty, PoW, transactions, reward, supply
    require(chainWork monotonic and tip == sum)             -> CHAINWORK_MISMATCH
    require(no duplicate heights/hashes)                     -> DUPLICATE_BLOCK

    // D. Work and depth (first work read)
    require(newChainWork > oldChainWork)                     -> NOT_BETTER
    require(reorgDepth <= MAX_REORG_DEPTH)                   -> REORG_TOO_DEEP
    require(no checkpoint below the fork point)              -> CHECKPOINT_VIOLATION

    // E. Commit
    atomically:
        delete blocks/accounts/mempool above the base
        apply the candidate suffix from base
        requeue valid orphaned transactions
        update protocol_state assertion row
    // F. Post-commit
    verify accounts, supply, checkpoints, era, health
```

The order is the security property. **Rule N-1:** cumulative work is never consulted before steps A–B complete. A chain with `10^30` work and a wrong checkpoint or a foreign `networkId` is rejected before its work is read. [Proposed; original Rule N-1 is correct]

### 14.2 Why the order matters

| If work is read first | Consequence |
|---|---|
| A higher-work BLKC chain replaces BNKR | the original vulnerability, proven in the audit |
| A higher-work same-genesis fork replaces the prefix | checkpoint must reject it first |
| A malformed envelope is parsed before validation | memory exhaustion (R-17) |
| A bad checkpoint is compared after work | an attacker can force expensive validation before rejection |

### 14.3 Start at the highest verified checkpoint (C-29)

The current `replaceChainLocked` validates the entire candidate from height 0 (`:944-1029`) and re-applies every block on commit (`:1002-1012`). That is O(total chain) work per sync and a cheap availability attack. Corrected:

1. Choose `base` = the highest checkpoint `cp` such that `cp.height <= min(localTip, candidateTip)` and `cp` verifies.
2. Replay `base … candidateTip` only.
3. Verify that `candidate[base].prevHash` equals the recomputed hash of the local block at `base−1` (or the candidate block, if the base block itself is being replaced — it is not, because a checkpoint block may not be replaced).
4. Commit only the suffix above `base`.
5. If `full=true` (explicit audit), replay from 0 and compare; this is not the default.

The checkpoint block at `base` is immutable. A candidate that replaces it is rejected at B, not replayed.

### 14.4 Pre-activation and post-activation reorgs

| Period | Reorg below `H−1` | Reorg at `H` | Reorg above `H` |
|---|---|---|---|
| Before activation (tip `< H`) | Allowed under work + depth, because no `CP-PRE` is applicable yet; still bounded | not applicable | not applicable |
| At activation (tip `≥ H`) | **Rejected** by `CP-PRE` | **Rejected** by `CP-ACT` | Allowed above the highest checkpoint, under work + depth |
| After later checkpoints | **Rejected** by the oldest checkpoint above the fork | **Rejected** if the fork replaces any checkpoint | Allowed only above the newest checkpoint |

The phrase “deep reorgs are never legitimate” is true **below the newest checkpoint**, not universally. Above it, a reorg can be legitimate; `MAX_REORG_DEPTH` may still reject it, which is a liveness trade-off, not a security theorem. [Corrected from original §8.4 Q7]

### 14.5 Depth cap and partition recovery

`MAX_REORG_DEPTH = 100` (`:17`, enforced `:962-964`). Its operational meaning depends entirely on which cadence is used, and §15.5 shows the mean is not a cadence:

| Cadence basis | 100 blocks is |
|---|---|
| `p90` gap 69.2 s | 1.9 h |
| Non-idle mean 24.6 s | 41 min |
| Median gap 8.05 s | 13.4 min |
| Target 15 s | 25 min |
| All-gap mean 1,700 s | 47.2 h |

A cap of 100 blocks is therefore somewhere between 13 minutes and 47 hours of chain, depending on a statistic that is not a production rate. The constant cannot be justified without declaring the cadence it is meant to cover. This is why Q-19 ties the cap to a published cadence measurement rather than to a round number.

| Scenario | Result today | Required V2 behavior |
|---|---|---|
| Reorg of 50 above the newest checkpoint | accepted if work higher | accepted |
| Reorg of 100 | accepted at the boundary | accepted, with explicit boundary test |
| Reorg of 101 | rejected | rejected automatically, but reported as `REORG_TOO_DEEP`, not as corruption |
| Reorg of 150 after a legitimate partition | **permanent split** | require an operator-visible recovery procedure; do not silently choose |
| Reorg that crosses a checkpoint | rejected | rejected before work; fatal if local tip is the one that crossed |

A cap is necessary to bound cheap deep rewrites. It is not sufficient to recover a partition. The owner must choose the cap and cadence together (Q-19), and the spec must describe the recovery path rather than claiming deep reorgs never happen.

### 14.6 Peer checkpoint comparison (C-12)

The original §10.2/§10.3 required exact set equality and would partition honest nodes during a rolling upgrade. Corrected:

1. Exchange the full checkpoint set, not a single “checkpoint”.
2. Find the **highest common height**.
3. If a common height exists and the values match: acceptable peer. Prefer a peer whose set is a **strict superset** (it is ahead in anchors, not wrong).
4. If no common height exists: reject.
5. If any common height mismatches: reject and log both tuples. This is a conflict, not a version skew.
6. Never adopt a peer’s set. Compare only.

| Peer A | Peer B | Result |
|---|---|---|
| `{…,8000}` | `{…,8000,9000}` | compatible; B is a superset |
| `{…,8000}` | `{…,7000,8000}` | compatible; A is a superset at 8000 |
| `{…,8000}` | `{…,9000}` | no common height; reject |
| `{8000: X}` | `{8000: Y}` | conflict; reject, halt auto-resolution |
| `{…,8000}` | `{}` | no common height; reject after activation |

### 14.7 `protocolVersion` is defined (C-13)

`protocolVersion` is the **maximum block version the node validates**, not the version of the software package and not a string capability.

| Value | Meaning |
|---|---|
| `1` | V1-only binary; cannot validate version 2 |
| `2` | V2 binary; validates version 1 below `H` and version 2 at/above `H` |
| `3` | future binary; validates 1, 2, and 3 according to its era table |

Rules:

- `/api/node` reports the numeric value.
- At activation, V2 binaries report `2`.
- A V1 peer reports `1` or omits the field; it is compatible **before** `H` and not selected for V2 sync **at/after** `H`.
- A peer claiming `2` but serving a version 1 block above `H` is rejected on the chain, not on the claim.
- The original §10.1 example (`protocolVersion: 1` in a V2 handshake), §10.2 (“must match exactly”), TE-60 (`2`), and §12.6 (“carries the era”) are reconciled to this one definition. [Corrected]

### 14.8 Paged chain exchange (C-14, C-16, R-17)

The current `/api/peer/chain` returns the entire chain in one JSON body (`index.js:361-364`) with no pagination, no response cap, and the client calls `response.json()` before validating anything (`index.js:255-258`). That is both a memory risk and an unusable bootstrap protocol.

**Proposed constants:**

| Constant | Value | Purpose |
|---|---|---|
| `MAX_CHAIN_BLOCKS` | 100,000 | absolute chain length bound |
| `MAX_CHAIN_BYTES` | 256 MiB | absolute serialized chain bound |
| `MAX_PAGE_BLOCKS` | 500 | one page |
| `MAX_PAGE_BYTES` | 1 MiB | one page body |
| `MAX_BLOCK_BODY_BYTES` | 8 MiB | one block POST, dedicated route limit |
| `MAX_ENVELOPE_BYTES` | 2 MiB | handshake/manifest |
| `MAX_JSON_DEPTH` | 8 | structural bound |
| `MAX_SYNC_PAGES` | `MAX_CHAIN_BLOCKS / MAX_PAGE_BLOCKS` | loop bound |

**Protocol:**

```text
GET /api/peer/headers?from=0&to=499
GET /api/peer/blocks?from=0&to=499
```

Each response is an envelope:

```json
{
  "networkId": "BNKR-MAINNET-V1",
  "genesisHash": "49f9e886…",
  "protocolVersion": 2,
  "fromHeight": 0,
  "toHeight": 499,
  "pageIndex": 0,
  "prevPageHash": null,
  "pageHash": "<sha256 of the canonical page body>",
  "checkpointSetDigest": "<sha256 of the sorted checkpoint tuples>",
  "blocks": [ ... ]
}
```

Client rules:

1. Reject `Content-Length` above `MAX_PAGE_BYTES` **before reading**.
2. If `Content-Length` is absent, read with a byte counter and abort at `MAX_PAGE_BYTES`.
3. Parse only after the byte cap is satisfied.
4. Validate the envelope identity **before** touching `blocks`.
5. Verify `pageHash` and `prevPageHash`; reject gaps or reordering.
6. Verify each block’s header and checkpoint state; do not trust the page.
7. Bound the number of pages and total bytes per sync.
8. Never call `response.json()` on an unbounded body; the current code does exactly that. [Verified]

A full-chain GET may remain as an operator-only, authenticated diagnostic endpoint with the same caps, but it is not the bootstrap path.

### 14.9 V1 compatibility mode (C-15)

| Phase | V1 peer behavior | V2 node behavior |
|---|---|---|
| Before `H` | May omit `networkId`, `protocolVersion`, checkpoints | Accept for sync; validate under V1 rules; do not require V2 fields |
| Rolling upgrade, before `H` | Mixed | Prefer V2 peers, accept V1 peers; never use V2-only fields to reject a valid V1 chain |
| At `H` | V1 peer cannot validate block `H` | Drop V1 peers from sync selection; log `PEER_CANNOT_VALIDATE_ERA`; do not ban solely for being V1 |
| After `H` | V1 peer may serve a truncated chain | Reject its chain at `CP-ACT`; it is not a candidate |
| V2 peer with a lower checkpoint set | Compatible if a common height matches | Prefer the superset; do not reject |

The original §10.3 (“refuse to peer on mismatch”) and §10.4 (“old peers”) contradicted each other. This table is the corrected rule: **compare on the highest common checkpoint; drop only when the peer cannot validate the era or when a common value conflicts.**

### 14.10 Peer authentication (C-17)

The current peer identity is a self-asserted `origin-peer` header matched against a peer table (`index.js:133-143`, `:343-359`). That is not authentication. [Verified]

Required for write endpoints (`/api/peer/tx`, `/api/peer/block`, `/api/peers` POST):

1. Challenge: server sends a random 32-byte nonce and a timestamp.
2. Response: peer signs `SHA-256("BNKR-PEER-AUTH-V1" || networkId || nonce || timestamp || bodyHash)` with its Ed25519 key.
3. Server verifies the signature, the timestamp window (e.g. ±120 s), nonce freshness, and `networkId`.
4. The peer’s public key is its identity; no self-asserted string is trusted.
5. Replay of a used nonce is rejected.
6. Read-only peers may remain unauthenticated, but they get no write capability and are rate-limited.
7. TE-58 tests a signed challenge, not a recommendation. If the owner chooses not to implement authentication, TE-58 must be deleted from acceptance rather than left as an untestable “should”.

### 14.11 `networkState` / `expectedDifficulty` interaction (C-27)

The review's C-27 states that `networkState:1132` (`expectedDifficulty(blocks.slice(-ADJUSTMENT_INTERVAL), height + 1)`) throws at an adjustment height because `blocks.find(b => b.height === height - 10)` cannot find its target in a 10-element window. **That specific claim is not reproducible.**

Let `tip.height = h`; `networkState` passes `height + 1 = h + 1`. When `h + 1` is a multiple of 10, the function looks for height `(h + 1) − 10 = h − 9`. `blocks.slice(-10)` contains heights `h − 9 … h`. The target **is** present. An exhaustive check over tips 0…400 produced **0 throws** for both the `slice(-10)` call and the full-history call. `miningTemplate:911` uses the same shape and is likewise correct. [Verified: exhaustive evaluation of the exported function]

The real defects at this boundary are three, and they are different from the one the review named:

| # | Defect | Evidence | Severity |
|---|---|---|---|
| **D-1** | The genesis branch reports the wrong next difficulty. `networkState:1132` returns literal `4` when `height === 0`, while `expectedDifficulty(blocks[0..0], 1)` returns `1`. | verified: `expectedDifficulty(chain(0), 1) === 1` | observability bug; a miner reading `/api/state` at genesis is told 4 and `miningTemplate` issues 1 |
| **D-2** | `minDifficulty` is **not** enforced on non-adjustment heights. The floor is applied only in the `height < ADJUSTMENT_INTERVAL` branch and in the decrement clamp. Because `136 % 10 !== 0`, `expectedDifficulty(history, 136)` returns the **previous** block's difficulty, which can be 1, despite `PROTOCOL_UPGRADE_HEIGHT = 136` and `minDifficulty = 4`. | verified: `expectedDifficulty(chain(0..135), 136) === 1` | consensus-rule gap; no stored block currently exploits it (0 blocks at height ≥ 136 have difficulty < 4), so enforcing the floor is backward-compatible today |
| **D-3** | The window contract is implicit and fragile. `expectedDifficulty` requires its first argument to contain the block at `height − ADJUSTMENT_INTERVAL`, but the signature accepts any array. `networkState` and `miningTemplate` happen to satisfy it; any paging-based caller built for §14.8 would not. | function signature `:253` | design hazard, becomes a live bug as soon as sync is paged |

Corrections:

1. Replace the window parameter with an index keyed by height, or require the full history. The function must not depend on a caller's slice convention.
2. Apply `minDifficulty` at **every** height `≥ PROTOCOL_UPGRADE_HEIGHT`, not only at adjustment heights. Because no stored block violates it, this is a forward-looking fix, not a re-validation of history; it must nevertheless be released as a consensus-rule change with its own activation decision.
3. Delete the `height === 0 ? 4` special case and call `expectedDifficulty(blocks, 1)`, which already returns `minDifficulty`.
4. Keep the throw for genuinely insufficient history. Do **not** catch it and return a default; that would silently change consensus.
5. Add tests at heights 9, 10, 11, 135, 136, 139, 140, 141 and at every multiple of 10 thereafter.

D-2 is the substantive finding. It means the "difficulty floor of 4 after height 136" described in the specification is not actually a floor for heights 136–139 and can be bypassed at any non-adjustment height if the prior block's difficulty is lower. The chain escaped it by luck: difficulty had already reached 4 at height 40, so no block was affected. [Verified histogram: difficulty 1 at heights 1–19, 2 at 20–29, 3 at 30–39, 4 from 40 onward.]

### 14.12 Replacement observability

Emit structured events for every replacement decision:

```text
{ event: "chain.candidate", tip, work, checkpointSetDigest }
{ event: "chain.rejected", reason: "CHECKPOINT_VIOLATION", height, expected, actual }
{ event: "chain.reorg", base, depth, oldWork, newWork }
{ event: "chain.partition", depth, maxDepth, action: "halt" }
```

No secrets, no peer tokens, no full URLs. An operator must be able to tell “rejected because wrong network” from “rejected because corrupt” from “rejected because too deep”.

---

## 15. Monetary-policy validation

### 15.1 The rules as implemented

V2 does not change monetary policy. This section specifies what the existing rules are, proves what they imply, and adds the tests that were missing. Every constant below is unchanged by V2. [Verified]

| Constant | Value | Location |
|---|---|---|
| `COIN` | `100,000,000` atomic units per BNKR | `ledger.js:5` |
| `MAX_SUPPLY` | `21,000,000 × COIN = 2,100,000,000,000,000` units | `:6` |
| `INITIAL_REWARD` | `50 × COIN = 5,000,000,000` units | `:7` |
| `HALVING_INTERVAL` | `210,000` blocks | `:8` |
| `TARGET_BLOCK_SECONDS` | `15` | `:9` |
| `ADJUSTMENT_INTERVAL` | `10` | `:10` |
| `MAX_DIFFICULTY` | `6` | `:11` |
| `MIN_TRANSACTION_UNITS` | `1,000,000` (0.01 BNKR) | `:13` |
| `MIN_FEE_UNITS` | `100,000` (0.001 BNKR) | `:14` |

The subsidy function (`rewardForHeight:247-251`) is:

```text
halvings = floor((height - 1) / 210000)
nominal  = halvings >= 53 ? 0 : floor(5_000_000_000 / 2^halvings)
subsidy  = min(nominal, max(0, MAX_SUPPLY - supply_before_this_block))
```

The block-level rule (`validateBlock:364-370`) is:

```text
subsidy = rewardForHeight(height, state.supply_before)
reward  = subsidy + state.fees_this_block
require(block.reward.recipient === block.miner)
require(block.reward.amount === formatUnits(reward))     // exact string equality
```

The credit rule (`applyBlock:715-725`) is:

```text
reward_units = block.reward.amount === "0" ? 0 : parseAmount(block.reward.amount)
if (reward_units > 0) credit block.miner by reward_units
```

Fee accounting is inside `verifyBlockTransactions:305-338`: each fee is debited from the sender, accumulated in `next.fees`, and the sum is paid to the miner as part of the reward.

### 15.2 Theorem: supply is a function of height alone

Define `S(0) = 0` and, for `h ≥ 1`:

```text
S(h) = S(h-1) + subsidy(h, S(h-1))
```

`subsidy` depends only on `h` and `S(h-1)`. By induction, `S(h)` is a function of `h` alone.

Fees do not affect it: a fee is subtracted from the sender and added to the miner inside the same block, and `txState.supply += subsidy` (`validateBlock:375`) adds only the subsidy. Therefore:

```text
S(h) = Σ_{i=1..h} subsidy(i, S(i-1))
sum(balances at height h) = S(h)
sum(block rewards at height h) = S(h) + Σ fees paid
```

**Verified against the production database** (read-only copy of `bannekercoin.db`, height 858):

| Quantity | Measured |
|---|---|
| Blocks with a reward | 858 (height 1…858) |
| Rewards of `50` | 851 |
| Rewards of `50.001` (subsidy + one 0.001 fee) | 7 |
| Sum of all block rewards | `42,900.00700000` BNKR |
| `SUM(accounts.balance_units)` | `4,290,000,000,000` units = `42,900.00000000` BNKR |
| Difference | exactly `0.007` BNKR = 7 × 0.001 fee |

The difference is not an error. It is the theorem: rewards sum to `S(h) + fees`, balances sum to `S(h)`, and the 0.007 BNKR of fees was redistributed rather than created.

**Consequences:**

1. Any two valid chains of the same height have the same supply, automatically. Supply is **not** an independent consensus axis; it is derivable from height. A separate `supply` commitment would be redundant at this scale. This is a stronger argument for C-18's deferral than the original document gave.
2. A chain whose `SUM(accounts)` differs from `S(tip.height)` is corrupt, and the only way to detect that is a replay or an account-vs-replay comparison. **B0 cannot do this**: `accountsValid` and `accountsMatchValidation` exist only in the working tree (B2), not in `HEAD` (B1) and not in the deployed build (B0). A database writer can therefore inflate `accounts.balance_units` on the deployed system without `/api/validate` reporting it. That is a monetary-integrity gap, not merely a storage gap (§11.2, S7).
3. Because supply is height-determined, a reorg that ends at the same height preserves supply exactly. MT-08 tests this.

### 15.3 Halving arithmetic and the terminal supply

The nominal subsidy sequence floors at each halving:

| `k` | Heights | `nominal` units | BNKR | Interval total (units) | Cumulative (units) |
|---|---|---|---|---|---|
| 0 | 1 – 210,000 | 5,000,000,000 | 50 | 1,050,000,000,000,000 | 1,050,000,000,000,000 |
| 1 | 210,001 – 420,000 | 2,500,000,000 | 25 | 525,000,000,000,000 | 1,575,000,000,000,000 |
| 2 | 420,001 – 630,000 | 1,250,000,000 | 12.5 | 262,500,000,000,000 | 1,837,500,000,000,000 |
| 3 | 630,001 – 840,000 | 625,000,000 | 6.25 | 131,250,000,000,000 | 1,968,750,000,000,000 |
| 4 | 840,001 – 1,050,000 | 312,500,000 | 3.125 | 65,625,000,000,000 | 2,034,375,000,000,000 |
| 5 | 1,050,001 – 1,260,000 | 156,250,000 | 1.5625 | 32,812,500,000,000 | 2,067,187,500,000,000 |
| … | | | | | |
| 32 | last nonzero | **1** | 0.00000001 | 210,000 | 2,099,999,997,690,000 |

Exact terminal values, computed from the formula:

| Quantity | Value |
|---|---|
| Nominal sum over `k = 0…32` | `2,099,999,997,690,000` units |
| In BNKR | `20,999,999.97690000` |
| `MAX_SUPPLY` | `2,100,000,000,000,000` units |
| Shortfall | `2,310,000` units = **0.0231 BNKR** |
| Shortfall as a fraction of the cap | `0.00000011 %` |
| First height with subsidy `0` | `6,930,001` (after 33 complete intervals) |
| `halvings >= 53` guard | unreachable: `2^33 > 5 × 10^9`, so the reward is already `0` at `k = 33` |

**Two consequences that the original specification did not state:**

1. The truncation at atomic-unit precision means the schedule can never reach `MAX_SUPPLY`. The gap is 0.0231 BNKR, not zero. Any documentation that says "supply asymptotically approaches exactly 21,000,000" is wrong by 2,310,000 units. It is small, but it is exact and testable (MT-09).
2. Because the whole nominal schedule sums to **less** than `MAX_SUPPLY`, the clamp `min(nominal, MAX_SUPPLY - supply)` **never binds on any chain that follows the schedule**. Its proof is a one-line induction: if `S(h-1) = C(h-1) ≤ 2,099,999,997,690,000`, then `MAX_SUPPLY - S(h-1) ≥ 2,310,000 > nominal(h)` for every `h`.

The clamp is therefore dead code in normal operation. It is correct defence in depth, but it cannot be exercised through mining, so it must be tested at the function level — not by trying to mine near the cap, which would require a fabricated database.

### 15.4 The off-by-one at the boundary, stated exactly

`floor((height - 1) / 210000)` means:

| Height | `halvings` | Subsidy |
|---|---|---|
| 1 | 0 | 50 |
| 210,000 | 0 | 50 |
| 210,001 | 1 | 25 |
| 420,000 | 1 | 25 |
| 420,001 | 2 | 12.5 |

Interval `k` therefore contains exactly 210,000 blocks. A reader who assumes "halving happens **at** 210,000" is off by one block; a reader who assumes intervals are `[210000·k, 210000·(k+1))` **including** height 0 is off by one block in the other direction. Genesis has no subsidy and is not part of any interval. The formula is correct as written; the documentation must state the boundary explicitly rather than say "every 210,000 blocks".

### 15.5 Measured issuance timeline — and a correction to the cadence input

The independent review and the audit both used "~1,650–1,700 s average block time" as the observed cadence. That figure is **arithmetically reproducible and interpretively wrong**. Measured on a read-only copy of `bannekercoin.db` (858 inter-block gaps, heights 1…858):

| Statistic | Value |
|---|---|
| Gaps measured | 858 |
| Minimum | 2.4 s |
| Median (`p50`) | **8.0 s** |
| `p75` | 17.4 s |
| `p90` | 69.2 s |
| `p95` | 109.3 s |
| `p99` | 305.0 s |
| Maximum | **1,387,888.5 s = 16.06 days**, at height 1 (genesis → block 1) |
| Arithmetic mean of all gaps | **1,700.0 s** |
| Gaps longer than 1 hour | 3 (at heights 1, 317, 377) |
| Share of total span consumed by those 3 gaps | **98.56 %** |
| Mean after excluding gaps > 1 hour | **24.6 s** |
| Span of heights 1…858 | 70,685.9 s = 19.6 h |
| Active mining time (span minus gaps > 1 h) | 21,037 s = **5.84 h** |

The mean is dominated by a single interval: the gap between the hardcoded genesis timestamp (`Date.UTC(2026,10,1)`, `ledger.js:22`) and the first mined block, which is 16.06 days. The three long gaps account for 98.56 % of the chain's wall-clock span. Removing them leaves about 5.8 hours of actual mining.

**Therefore:**

1. The chain is not "17 days of slow mining". It is a chain whose genesis timestamp is 16 days older than its first block, mined in bursts totalling about 5.8 hours on or about 2026-11-17. [Verified from stored timestamps]
2. `TARGET_BLOCK_SECONDS = 15` is not 100× off from reality; the median gap is 8 s and the non-idle mean is 24.6 s. The target is within a factor of ~1.6 of the non-idle mean.
3. The audit's ~1,700 s figure must be labelled **"mean gap including a 16-day genesis offset and two 7-hour idle periods"**, never "observed block time". [Corrected interpretation]
4. Difficulty is pinned at 4–5 partly because the adjustment window is 10 blocks: a few fast blocks raise difficulty, then 7 hours of idle time at the next adjustment lowers it again. Difficulty on this chain measures *burst rate*, not sustained hashrate.

Halving wall-clock under each cadence:

| Cadence basis | Seconds per block | 210,000 blocks |
|---|---|---|
| `TARGET_BLOCK_SECONDS` | 15 | **36.46 days** |
| Measured median gap | 8.05 | **19.6 days** |
| Measured non-idle mean | 24.6 | **59.8 days** |
| Measured `p90` | 69.2 | **168.3 days** |
| Measured all-gap mean | 1,700.0 | **11.31 years** |
| "4 years" (Bitcoin-derived expectation) | 601.1 | 4.00 years |

**No measurement produces four years.** Four years requires 601.1 s per block — 40× the target, 24× the non-idle mean, and 7.5× the `p90`. The review reached the right conclusion with the wrong number: the conflict is not "36.5 days versus 11.3 years"; it is "19.6 days to 168 days under real cadence, 36.5 days at target, and 11.3 years only if one treats a 16-day genesis offset as block time". Under every reading, the schedule is not a four-year schedule. The historical design review left Q-15 open; the owner resolved it in §21.9 as height-only halving.

### 15.6 The three-way conflict, stated without a recommendation

| Source | What it says |
|---|---|
| **Code** (`:8`, `:247-251`) | Halving every 210,000 blocks, height-based, deterministic. |
| **Constants at target** (`:8`, `:9`) | One halving per 36.5 days; terminal supply reached in ~701 years of target-rate blocks. |
| **Measured cadence** (§15.5) | One halving per 19.6–168 days depending on which gap statistic is used. |
| **Common expectation** | "Bitcoin-style, ~4 years." Nothing in the code or constants produces this. |

The original specification did not resolve this; §16 of the review raised it as C-20/Q-15. The original design-only document also left it open because it is an intent question, not a consistency question. §21.9 now records the owner's resolution: height-only halving with `HALVING_INTERVAL=210000`, unchanged at V2, terminal subsidy zero, and a strict 21,000,000 BNKR cap.

What the review contributed was:

- the exact arithmetic so the choice was informed;
- a ban on monetary claims ("4-year halving", "deflationary schedule", "21M by 2140") before an owner decision;
- the observation that changing `HALVING_INTERVAL` is a **monetary-policy change** requiring its own audit, checkpoint impact analysis, and replay re-validation — not a one-line edit;
- confirmation that a timestamp-based halving was rejected for determinism reasons in §7.1 of the original, and that rejection stands.

**Owner-selected policy (Q-15, §21.9): RESOLVED.** Keep height-based halving, document the wall-clock range honestly, and do not describe the schedule as four-year. A future era may revisit it through a new consensus decision.

### 15.7 Monetary invariants

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **MI-1** | `supply(h) = S(h)`, a function of height alone | induction from `rewardForHeight`; `validateBlock:365-375` | MT-08, MT-11 |
| **MI-2** | `reward.amount = formatUnits(subsidy + fees)` exactly | `validateBlock:367-369` | MT-01, MT-02 |
| **MI-3** | `reward.recipient = miner` | `validateBlock:367` | MT-03 |
| **MI-4** | No subsidy above the schedule | `rewardForHeight:247-251` | MT-09 |
| **MI-5** | Fees never increase `supply` | `validateBlock:375` adds only `subsidy` | MT-05, MT-06 |
| **MI-6** | `sum(rewards) = supply + Σ fees` | debit/credit symmetry in `verifyBlockTransactions` + `applyBlock` | MT-06 |
| **MI-7** | No negative balance | `verifyBlockTransactions:325-326` | MT-04 |
| **MI-8** | No account above `MAX_SUPPLY` | `readAccounts:538`, `sumBalances:551`, `getSupply:657` | MT-07 |
| **MI-9** | `sum(balances) ≤ MAX_SUPPLY` | `sumBalances:551` | MT-07 |
| **MI-10** | Nonce is exactly previous + 1 | `verifyBlockTransactions:322-323` | MT-10 |
| **MI-11** | `amount ≥ 0.01`, `fee ≥ 0.001` (non-legacy) | `resolveTransactionAmounts:116-130` | MT-12 |
| **MI-12** | Legacy fee-less transactions only below height 136 | `allowLegacy: block.height < 136` | MT-13 |
| **MI-13** | A block cannot pay a reward to a non-miner | `validateBlock:367` | MT-03 |
| **MI-14** | Supply is preserved across a same-height reorg | MI-1 | MT-08 |
| **MI-15** | Zero reward is legal only when `subsidy + fees = 0` | `validateBlock:368` | MT-14 |

Three of these are **not currently observable in production**: MI-1, MI-6, MI-8, and MI-9 all depend on comparing accounts to replay, and B0 has no `accountsValid`. They are enforced by `validateBlock` during replay and by `applyBlock` during writes, but a direct edit of the `accounts` table is invisible to `/api/validate` on B0. That is the same defect as TE-48/TE-49, viewed monetarily.

### 15.8 Corrected work and attack arithmetic

Cumulative work is `16^difficulty` per block (`workForDifficulty:147-152`). The verified histogram of the 858 BNKR blocks and the resulting total:

| Difficulty | Blocks | Work each | Subtotal |
|---|---|---|---|
| 1 | 19 | 16 | 304 |
| 2 | 10 | 256 | 2,560 |
| 3 | 10 | 4,096 | 40,960 |
| 4 | 620 | 65,536 | 40,632,320 |
| 5 | 199 | 1,048,576 | 208,666,624 |
| **Total** | **858** | | **249,342,768** |

This matches the audit's total exactly. [Verified]

**Implied network hashrate** from the measured cadence at the modal difficulty 4 (`16^4 = 65,536` expected hashes):

| Cadence basis | Implied hashrate |
|---|---|
| Median 8.05 s | ~8,145 H/s |
| Non-idle mean 24.6 s | ~2,664 H/s |
| All-gap mean 1,700 s | ~38.6 H/s |

**Rewrite cost** for 100 blocks at difficulty 4 (`100 × 65,536 = 6,553,600` expected hashes):

| Attacker hashrate | Time for 100 blocks | Time for the whole 858-block chain |
|---|---|---|
| 1 kH/s | 1.82 h | 69.3 h |
| 10 kH/s | 10.9 min | 6.9 h |
| 100 kH/s | 65.5 s | 41.6 min |
| 1 MH/s | 6.55 s | 249 s |
| 5 MH/s | **1.31 s** | **49.9 s** |

The review's "roughly one second" is the `5 MH/s` row. That is an **assumption**, not a measurement, and no attacker hashrate has ever been measured on this network. The honest statement is: **a single commodity CPU at a few MH/s reproduces the entire chain's proof of work in under a minute, and a maximum-depth reorg in seconds to a minute.** The conclusion is unchanged and if anything stronger than the review stated, because the earlier figure implied the chain was slow enough to be expensive; it is not slow, it is small.

This is why:

1. `MAX_REORG_DEPTH = 100` is a liveness limit, not a security parameter, at this work level.
2. Checkpoints are the only practical fork resistance (§9.5).
3. V2 does not and cannot fix this; it only makes blocks identifiable. **Identity is not security.** [Verified arithmetic; attacker hashrate unmeasured]

### 15.9 Adversarial monetary cases (MT-01…MT-15)

Every case below is a test **to be written**. None has been executed. The "current code" column states what the code path does on inspection, not what a test observed.

| ID | Input | Expected result | Current code path | Covered today? |
|---|---|---|---|---|
| **MT-01** | `reward.amount = subsidy + 1 unit` | reject | `validateBlock:368` exact string compare | no test |
| **MT-02** | `reward.amount = subsidy + fees + 1 unit` | reject | same | no test |
| **MT-03** | `reward.recipient = sender` (not miner) | reject | `validateBlock:367` | no test |
| **MT-04** | Block paying out more than the sender's balance | reject | `verifyBlockTransactions:325` | partial |
| **MT-05** | Block whose reward equals `fees` and omits subsidy | reject | `validateBlock:368` | no test |
| **MT-06** | Block whose reward omits fees | reject | `validateBlock:368` | no test |
| **MT-07** | Fabricated `accounts` row above `MAX_SUPPLY` | reject / fatal | `readAccounts:538`, `sumBalances:551` (B2 only) | no test; B0 cannot detect |
| **MT-08** | Same-height reorg: supply identical on both branches | equal | MI-1 induction | no test |
| **MT-09** | `rewardForHeight(h, MAX_SUPPLY) = 0`; `(h, MAX_SUPPLY-1) = 1`; total schedule `= 2,099,999,997,690,000` | exact values | `rewardForHeight:247-251` | no test |
| **MT-10** | Two transactions from one sender with the same nonce | reject | `verifyBlockTransactions:322` | partial |
| **MT-11** | `supply(tip) != S(tip.height)` after a direct DB edit | detect and refuse | requires `accountsValid` (B2) | **B0 cannot** |
| **MT-12** | `amount = 0.00999999`; `fee = 0.00099999` | reject | `resolveTransactionAmounts:116,128` | yes (unit) |
| **MT-13** | Legacy fee-less transaction at height ≥ 136 | reject | `allowLegacy` gate | yes (unit) |
| **MT-14** | `reward.amount = "0"` when subsidy > 0 | reject | `validateBlock:368` | no test |
| **MT-15** | Miner spends its reward in the very next block, then a reorg orphans the reward block | the spend must be invalidated and not re-mined as valid | **no coinbase maturity exists**; `applyBlock` credits immediately; `replaceChainLocked` requeues orphaned transactions | no test |

**MT-15 is a finding, not a formality.** BNKR has no coinbase maturity window. A miner's reward is spendable in the next block. Bitcoin requires 100 confirmations precisely to avoid a class of reorg-induced invalidity. On BNKR, a one-block reorg after a miner spends its reward invalidates the spend; the node must drop it from the requeued mempool rather than accept it. `replaceChainLocked` re-queues orphaned transactions, and `acceptTransaction` would reject the spend for insufficient balance once the reward is gone — so the failure is safe, but it is untested and undocumented. This belongs to the reorg tests, not to V2, and no monetary rule changes to fix it. [Verified absence of maturity; consequence reasoned, not tested]

### 15.10 What V2 does and does not change

| Aspect | V2 effect |
|---|---|
| Subsidy schedule | **unchanged** |
| `MAX_SUPPLY`, `INITIAL_REWARD`, `HALVING_INTERVAL` | **unchanged** |
| Fee minimum and transaction minimum | **unchanged** |
| Reward recipient rule | **unchanged** |
| Supply accounting | **unchanged**; V2 adds no `supply` field to the header |
| Amount encoding | **stricter**: V2 requires canonical decimals and rejects `"1.50"`, `"1e-8"`, and numeric JSON amounts. This changes which transaction *encodings* are admissible in a V2 block, not the amounts themselves. Recorded as Q-24. |
| Transaction projection | **stricter**: exactly 7 fields; `amountUnits`/`feeUnits` are input aliases, not block fields |
| Fee-less legacy transactions | **rejected above `H`**; already rejected above 136 today |
| Coinbase maturity | **not added**; remains a separate decision |
| State/supply commitment | **not added** (§7.6) |

The only behavioural change a user could notice is that a wallet which submits `"1.50"` or a numeric amount would be rejected at a V2 block boundary. That is deliberate, and it is why Q-24 must be answered before wallets are updated.

### 15.11 Monetary observability requirements

A V2 node must expose, without exposing balances of individuals:

```json
{
  "height": 858,
  "supplyUnits": "4290000000000",
  "supplyExpectedUnits": "4290000000000",
  "nextSubsidyUnits": "5000000000",
  "nextRewardUnits": "5000000000",
  "halvingHeight": 210001,
  "sumRewardsUnits": "4290000700000",
  "accountsValid": true
}
```

`supplyUnits == supplyExpectedUnits` is the MI-1 check. `sumRewardsUnits - supplyUnits` equals total fees paid. If `accountsValid` is false or absent, `/health` must return 503. This is how an operator sees a monetary fault before a user does.

### 15.12 Residual monetary risks

| Risk | Status | Mitigation |
|---|---|---|
| Work is cheap; checkpoints are the only fork resistance | **open** | §9; Q-19 |
| Five distinct miner keys, almost certainly one operator | **open** | no mitigation exists in software |
| Only 7 transactions in 858 blocks; no fee market | **observed** | none needed at this scale; means fee-based security is negligible |
| Coinbase maturity parameter | **resolved in code** | `COINBASE_MATURITY=53`; Era 1 not re-judged; verified by Phase 4 rehearsal |
| No `accountsValid` on B0 | **open, critical** | S7; requires a new deployment |
| Halving wall-clock undefined | **resolved by decision** | Q-15 selected height-only halving; wall-clock range is documentation, not consensus |
| Direct DB edit of `accounts` is invisible on B0 | **open, critical** | replay comparison + `accountsValid` |
| Supply clamp is dead code | **accepted** | MI-4 unit test |
| Terminal supply is 0.0231 BNKR below the cap | **accepted** | document exactly; MT-09 |

---

## 16. Corrected test matrix

### 16.0 How to read this section

The matrix below was originally specified, not executed; its `NOT RUN`/disposition language is the historical design record. Later implementation and Phase 4 results are recorded in §21.9 and §22.7. No historical row should be read as a current test result.

Disposition vocabulary:

| Disposition | Meaning |
|---|---|
| **Keep** | The original test is sound; it is retained, possibly with an added assertion. |
| **Correct** | The original assertion was wrong, unreachable, or vacuous. The corrected assertion is stated. |
| **Split** | One test covered two incompatible behaviours; it becomes two. |
| **Replace** | The scenario is kept but the expected outcome changes materially. |
| **Blocked** | The test cannot be executed until an external artifact exists (second implementation, second operator). |

Layer codes used throughout:

| Code | Layer |
|---|---|
| `L1` | Pure serializer / parser — no I/O, no clock, no network |
| `L2` | Single-block admission and validation |
| `L3` | Chain, checkpoint, reorg, replacement |
| `L4` | Storage, startup, recovery, exit codes |
| `L5` | Peer, network, SSRF, authentication |
| `L6` | Build, interop, cross-implementation |
| `L7` | Derivation, manifest, governance procedure |
| `L8` | Monetary policy |

A test that cannot fail is not a test. Three of the original 62 could not fail as written (TE-13, TE-18, TE-62); that is why they are the ones that are corrected or split.

### 16.1 The 62-test matrix, per test

| ID | Original assertion (abridged) | Disposition | Corrected assertion | Layer |
|---|---|---|---|---|
| TE-01 | Same fields, `networkId` BNKR vs BLKC ⇒ hashes differ | **Keep** | Anchored to vectors V-02 vs V-06; assert the two exact preimage byte strings differ and the two digests are `2f760c32…` and `0a0c6500…` | L1 |
| TE-02 | Same fields, same `networkId`, serialized twice ⇒ identical hash | **Keep** | Strengthened: identical **bytes**, not merely identical digest; run twice in one process and once in a fresh process | L1 |
| TE-03 | V2 header without `networkId` ⇒ rejected before hashing | **Keep** | Reject with `MISSING_FIELD`; assert no hash was computed | L1 |
| TE-04 | `networkId: ""` ⇒ rejected | **Keep** | `INVALID_NETWORK_ID` | L1 |
| TE-05 | `networkId: null` ⇒ rejected | **Keep** | `INVALID_NETWORK_ID` | L1 |
| TE-06 | `networkId` differing by one character case ⇒ rejected | **Keep** | `NETWORK_ID_MISMATCH`; byte comparison, no case folding | L1 |
| TE-07 | Extra property `chainId` ⇒ rejected | **Keep, asymmetric** | Received/persisted **V2** block ⇒ `EXTRA_HEADER_FIELD`. Persisted **V1** block with `chainId` ⇒ ignored (history is frozen, §6.5) | L2 |
| TE-08 | `version: 1` at `height ≥ H` ⇒ rejected | **Keep** | `ERA_VIOLATION` | L2 |
| TE-09 | `version` absent at `height ≥ H` ⇒ rejected | **Keep** | `ERA_VIOLATION` | L2 |
| TE-10 | `version: 3` ⇒ rejected | **Split by context** | At admission: `UNSUPPORTED_VERSION`. In a persisted row at startup: exit 10, no repair (§10.3) | L2, L4 |
| TE-11 | `version: "2"` ⇒ rejected | **Keep** | `INVALID_VERSION_TYPE` | L1 |
| TE-12 | `version: 2` at `height = H−1` ⇒ rejected | **Keep** | `ERA_VIOLATION` | L2 |
| TE-13 | Reward amount as float `50.0` ⇒ rejected | **Correct** | The original test is **unreachable as written**: in JSON, `50.0` and `50` are the same numeric value after parsing, so a test cannot distinguish them. Corrected test: `typeof reward.amount !== "string"` ⇒ `INVALID_REWARD_TYPE`; and `reward.amount: "50.0"` ⇒ `NON_CANONICAL_DECIMAL` (§4.5) | L1, L2 |
| TE-14 | `message` non-null at height ≥ 1 ⇒ rejected | **Keep** | `NON_NULL_MESSAGE`; matches `validateBlock:363` | L2 |
| TE-15 | Recompute all 859 BNKR hashes with the v1 serializer ⇒ 0 mismatches | **Keep** | Also assert genesis `49f9e886…ebaa` and total work `249342768` | L1, L6 |
| TE-16 | Recompute all 297 BLKC hashes ⇒ 0 mismatches | **Keep** | Also total work `141732656` | L1, L6 |
| TE-17 | `validateChain` over the full BNKR chain ⇒ `valid:true`, height 858, work `249342768` | **Keep, extended** | Add `accountsValid:true` and `supplyUnits === S(858)` (§15.2) | L3, L8 |
| TE-18 | `validateChain` over the BLKC chain ⇒ `valid:true` **but** `replaceChain` rejects at `CP-PRE` | **Correct (blocker)** | **`validateChain` must return `valid:false`** with an identity reason (`CP-PRE` mismatch). A node must not report a foreign chain as valid through `/api/validate`. A separate audit-only `replayChain` may report economic validity without identity | L3 |
| TE-19 | Genesis header and hash after the change ⇒ byte-identical to `49f9e886…ebaa` | **Keep** | Also assert genesis carries no `version`/`networkId` and still uses the V1 serializer | L1 |
| TE-20 | `workForDifficulty` and total work unchanged ⇒ `249342768` | **Keep** | Assert the full histogram `19/10/10/620/199` and `16^d` per level | L1 |
| TE-21 | BNKR V2 fixture validated by a BLKC V2 validator ⇒ rejected at B4 | **Keep** | Identity check precedes work; assert work accessor not called | L5 |
| TE-22 | BLKC V2 fixture validated by a BNKR V2 validator ⇒ rejected at B4 | **Keep** | Same instrumentation | L5 |
| TE-23 | BLKC historical chain submitted to a BNKR node ⇒ rejected at checkpoint, never reaches work comparison | **Keep** | Assert `CHECKPOINT_VIOLATION` and work-not-read | L3 |
| TE-24 | Foreign chain with `10×` work and a wrong checkpoint ⇒ rejected; work never read | **Keep** | Instrumented counter must be 0 at rejection | L3 |
| TE-25 | Same genesis, wrong Era 1 prefix ⇒ rejected | **Keep** | `CP-PRE` is the only discriminator; assert genesis alone does **not** reject it (§7.7) | L3 |
| TE-26 | Higher-work chain sharing checkpoints, divergent above `CP-ACT` ⇒ accepted, state consistent | **Correct, extended** | Accepted only if: depth ≤ `MAX_REORG_DEPTH`, every checkpoint verifies, and `supply(tip) === S(tip.height)`. "State consistent" must be defined, not asserted | L3, L8 |
| TE-27 | Reorg replacing the `CP-PRE` block ⇒ rejected | **Keep** | `CHECKPOINT_VIOLATION` before work read | L3 |
| TE-28 | Reorg replacing the `CP-ACT` block ⇒ rejected | **Keep** | Same | L3 |
| TE-29 | Reorg of 50 above the highest checkpoint ⇒ accepted | **Keep** | Accepted **if** work is higher and depth ≤ cap | L3 |
| TE-30 | Reorg of 101 above the highest checkpoint ⇒ rejected | **Keep** | `REORG_TOO_DEEP`, reported as such, not as corruption | L3 |
| TE-31 | Mixed-era chain with a v1 block at `H+5` ⇒ rejected | **Keep** | `ERA_VIOLATION` | L2 |
| TE-32 | Chain with a gap in heights ⇒ rejected | **Keep** | `HEIGHT_GAP` in step A | L3 |
| TE-33 | Chain with duplicate height/hash ⇒ rejected | **Keep** | `DUPLICATE_BLOCK` | L3 |
| TE-34 | Template at `H−1` ⇒ no `version`/`networkId` | **Keep** | V1 projection only | L2 |
| TE-35 | Template at `H` ⇒ `version: 2`, `networkId` = local constant | **Keep** | Plus `message: null` and canonical reward | L2 |
| TE-36 | Miner hashes the template with the shared serializer; server validates ⇒ accepted | **Keep** | Requires the shared module (§7.4); fails on `HEAD` because the worker duplicates `headerOf` | L2, L6 |
| TE-37 | Miner submits `networkId: BLKC-MAINNET-V1` ⇒ rejected at B4 | **Keep** | `NETWORK_ID_MISMATCH` | L2 |
| TE-38 | Miner submits a tampered `hash` ⇒ server recomputes and rejects | **Keep** | `HASH_MISMATCH`; the supplied hash is never trusted | L2 |
| TE-39 | Browser worker and Node server hash the same template ⇒ identical hash | **Keep** | Must also assert identical **bytes**; currently fails by construction (`miner.worker.js:13-45`) | L6 |
| TE-40 | Independent (non-JS) implementation vs conformance vectors ⇒ identical hashes | **Keep, Blocked** | Cannot execute until a second implementation exists (gate A-3, Q-22). This is the single most important interop test and it has no artifact | L6 |
| TE-41 | `BNKR_STORAGE` missing ⇒ exit non-zero | **Keep** | Exit 13, before listen | L4 |
| TE-42 | `turso` mode, URL missing ⇒ exit | **Keep** | Exit 13 | L4 |
| TE-43 | `turso` mode, URL empty ⇒ exit | **Keep** | Exit 13; empty string is not "configured" | L4 |
| TE-44 | `turso` mode, token missing ⇒ exit | **Keep** | Exit 13; token never logged | L4 |
| TE-45 | `local` mode in production without override ⇒ exit | **Keep** | Exit 13 | L4 |
| TE-46 | Fresh empty DB in production ⇒ exit at S5 | **Keep, extended** | Exit 12. With `BNKR_RECOVERY_SYNC_ONLY=1` ⇒ start read-only instead (TE-85) | L4 |
| TE-47 | DB with the BLKC chain (height 296) ⇒ exit at S3/S4 | **Keep** | `CP-PRE` mismatch ⇒ exit 11 | L4 |
| TE-48 | DB rolled back below `CP-TIP-AT-RELEASE` ⇒ exit at S5 | **Keep, extended** | Exit 12; sync-only exception per TE-85 | L4 |
| TE-49 | Correct DB ⇒ serves; `/health` 200 | **Keep, extended** | `/health` must include `accountsValid:true` and a build id | L4 |
| TE-50 | Restored backup ⇒ S2–S5 pass; `/health` 200 | **Keep, extended** | Backup below the release checkpoint ⇒ TE-84, not a pass | L4 |
| TE-51 | Peer with `networkId` BLKC ⇒ registration refused | **Keep** | Refuse before any write capability | L5 |
| TE-52 | Peer with wrong `genesisHash` ⇒ refused | **Keep** | Same | L5 |
| TE-53 | Peer with wrong checkpoint ⇒ refused | **Correct** | Compare **checkpoint sets** on the highest common height. A superset is compatible; a mismatch at a common height is a conflict; no common height ⇒ refuse. Never adopt (§14.6) | L5 |
| TE-54 | Peer omitting identity fields ⇒ refused | **Keep** | Before `H`, omission is allowed for V1 peers (§14.9); at/after `H`, refuse for sync | L5 |
| TE-55 | Peer echoing correct identity but serving a non-checkpoint chain ⇒ dropped after validation | **Keep** | Drop; do not ban permanently for a single mismatch | L5 |
| TE-56 | Peer URL resolving to `127.0.0.1` / `169.254.169.254` / `10.0.0.1` ⇒ refused | **Keep** | Refuse at the SSRF filter **after** DNS resolution and again on connect | L5 |
| TE-57 | Peer URL with a redirect to a private address ⇒ refused | **Keep** | No redirect following, or re-filter every hop | L5 |
| TE-58 | Unauthenticated `POST /api/peer/block` ⇒ rejected | **Correct, conditional** | Requires the signed-challenge scheme of §14.10. If the owner decides against authentication (Q-4), this test is **deleted from acceptance**, not left as an untested "should" | L5 |
| TE-59 | Post-activation peer without `chain-v2` ⇒ not selected for sync | **Keep** | Defined via `protocolVersion` (§14.7): a peer reporting `1` is not selected at/after `H` | L5 |
| TE-60 | Restart after activation ⇒ serves with `protocolVersion` 2 semantics; era correct | **Keep** | `/api/node` reports `protocolVersion: 2` and the checkpoint digest | L4 |
| TE-61 | Restart with a DB written by an older binary (no `protocol_state`) ⇒ migrates the assertion row, validates checkpoints, serves | **Correct** | The row may be created, but `activation_height` and checkpoint fields must be `NULL`/absent until Q-1/Q-2 are answered. It must never fabricate a checkpoint or an activation height. Existing checkpoints are verified, not rewritten | L4 |
| TE-62 | Era 2 DB under a binary without V2 support ⇒ refuses to start, never silently truncates | **Split** | Unreachable for a real V1 binary: it truncates. Becomes **TE-62a** (new binary, safe refusal) and **TE-62b** (old binary, documented truncation harness). §16.10 | L4 |

### 16.1.1 Canonical-form and parser tests (TE-64, TE-66, TE-67, TE-76, TE-77, TE-80, TE-81)

These seven tests belong to the same layer as the 62 row matrix above and are referenced by §2.3 as §16.1 material.

**TE-64 — key-order invariance.** Build the V-01 header three ways: (a) literal in canonical order, (b) object populated in reverse order, (c) object built by shuffled incremental assignment. Expected: one identical preimage byte string and digest `5807a168…b47ba23` for all three. [L1]

*Limit of this test:* a reflective serializer that sorts keys also passes it. TE-64 proves order-invariance of the **result**, not the absence of reflection. Reflection is forbidden by build-time inspection (TE-88), because a sorted-key reflective serializer and a fixed-order serializer produce identical bytes today and different bytes the day a field is added.

**TE-66 — extra transaction field.** A V2 block containing a transaction with the seven canonical fields **plus** `amountUnits`. Expected: `EXTRA_TRANSACTION_FIELD` at B6, before any hash is computed. The same body with `amountUnits` at the **API** boundary and not inside the block resolves normally (TE-81). This is the asymmetry that lets wallets keep a units alias without letting the alias into the block. [L1]

**TE-67 — version type and float normalization.** Cases: `2.0` (parses to `2` ⇒ accepted at `height ≥ H`); `2.5` ⇒ `INVALID_VERSION_TYPE`; `null` ⇒ `INVALID_VERSION_TYPE`; `true` ⇒ `INVALID_VERSION_TYPE`; `"2"` ⇒ `INVALID_VERSION_TYPE`; `-0` ⇒ `ERA_VIOLATION` at `height ≥ H`; `1e0` (parses to `1`) ⇒ `ERA_VIOLATION`. Assert the check is `typeof v === "number" && Number.isSafeInteger(v)`, with no string coercion anywhere in the path. [L1]

**TE-76 — duplicate JSON keys.** Raw body containing `{"height":1,"height":2,…}`. `JSON.parse` keeps the last occurrence silently, and the server uses `express.json({ strict: true })` (`index.js:162`), which is a thin wrapper over `JSON.parse`. Expected: `DUPLICATE_KEY` from a duplicate-detecting parser. **Current system has no such parser**, so this test is expected to fail against B0/B1/B2 and is recorded as an open defect, not a skipped test. A test that silently passes because the duplicate was ignored is worse than no test. [L1]

**TE-77 — homoglyph and invisible-character `networkId`.** Variants: trailing space, leading space, internal space, Cyrillic `К` (U+041A) substituted for ASCII `K`, zero-width joiner U+200D inserted, full-width `ＢＮＫＲ`, and an NFD-decomposed form. Expected: `INVALID_NETWORK_ID` from the character-class rule (ASCII `A–Z`, `0–9`, `-` only, `§3.3`) **before** equality comparison with the local constant. Assert rejection is by class, not by inequality: a class check also rejects a well-formed but wrong ID with a different code path (`NETWORK_ID_MISMATCH`). [L1]

**TE-80 — `transactions` container type and count.** `null` ⇒ `INVALID_TRANSACTIONS`; `"[]"` (string) ⇒ `INVALID_TRANSACTIONS`; `{}` (object) ⇒ `INVALID_TRANSACTIONS`; 10,001 entries ⇒ `TOO_MANY_TRANSACTIONS`; 10,000 entries ⇒ passes the count rule (still subject to the 8 MiB body cap, TE-92). Assert the cap is a named exported constant, not an inline literal, so a second implementation can query it. [L1]

**TE-81 — amount-alias agreement.** API body with `amount:"1.5"` and `amountUnits:"150000000"` ⇒ accepted; `amountUnits:"150000001"` ⇒ `AMOUNT_ALIAS_MISMATCH`; `amountUnits` alone ⇒ accepted at the API; `amountUnits` inside a V2 block ⇒ `EXTRA_TRANSACTION_FIELD` (TE-66). Assert the canonical decimal written into the block is `"1.5"` — not `"1.50"`, not `1.5` as a number — and that its unit value is `150000000`. [L1, L2]

### 16.2 Hash, proof of work, and chain work (M-20 / TE-79)

**TE-79 — `chainWork` type and value.** Admit a block whose `chainWork` is: (a) the JSON number `0`; (b) the string `"00"`; (c) missing; (d) the string `"0"` at height 1; (e) the correct decimal string. Expected: (a), (b), (c) rejected with `CHAINWORK_MISMATCH`/`MISSING_FIELD`; (d) rejected because a height-1 block must carry `workForDifficulty(difficulty)`, not `0`; (e) accepted. Assert the canonical form is a decimal string with no leading zeros, matching `validateBlock:359` and `validateChainInternal:397`. [L2]

Additional assertions for this layer:

| ID | Assertion |
|---|---|
| HW-1 | `workForDifficulty(0)` and `workForDifficulty(7)` throw (`:148-150`); `1…6` return `16n ** BigInt(d)` — a BigInt, never a Number and never a string |
| HW-2 | PoW is tested on lowercase hex text: the digest must begin with `difficulty` copies of `"0"`, i.e. `4·difficulty` zero bits |
| HW-3 | `hash` is absent from the preimage: changing `hash` alone does not change the digest |
| HW-4 | `chainWork` is absent from the preimage |
| HW-5 | A digest beginning with uppercase `"A"` at position 0 fails PoW even when its numeric value is smaller than a passing digest; no case folding anywhere |

HW-5 is not pedantry. `hash.startsWith('0'.repeat(difficulty))` (`src/miner.worker.js:32`) is case-sensitive because the worker lowercases via `hex()`. A second implementation that compares uppercase hex would accept a different set of headers while producing the same digest string in a different case — a fork that no hash-vector test catches. The serializer must fix the case of the **text form**, not just the bytes hashed.

### 16.3 Historical preservation and identity (M-06 / TE-68)

**TE-68 — raw `validateChain` on a foreign chain.** Call the public `validateChain` (not `validateChainInternal`) with the BLKC block array. Expected: `valid:false`, `reason:"CP-PRE"`, and **no** balances or nonces in the response (`validateChain:427-430` strips them). Then call the audit-only `replayChain` and assert it reports economic validity while still refusing identity. This is TE-18 seen from the BLKC side; both must agree, or the two entry points can disagree about what "valid" means. [L3]

Additional assertions:

| ID | Assertion |
|---|---|
| HP-1 | 859 BNKR hashes recomputed = 0 mismatches, on a read-only copy |
| HP-2 | 297 BLKC hashes = 0 mismatches |
| HP-3 | 377 node-B hashes = 0 mismatches |
| HP-4 | Genesis is byte-identical across all three databases: `49f9e886…ebaa` |
| HP-5 | Injecting `version`/`networkId` into a stored V1 object changes 0 hashes **under the V1 path** (the fields are not read) |
| HP-6 | Serializing the same V1 block through the V2 path **does** change its hash — this proves the era branch is real and not a no-op |
| HP-7 | No test writes to `bannekercoin.db`, `blackcoin.db`, or `node-b.db`; SHA-256 before and after are equal |

HP-5 and HP-6 are a matched pair. HP-5 alone would pass on an implementation that ignores the era entirely; HP-6 alone would pass on an implementation that applies V2 to everything. Only the pair pins down "V1 is frozen, V2 is strict, and the switch is at `H`".

### 16.4 Era, checkpoint, and reorg (M-14 / TE-74, M-16 / TE-75)

**TE-74 — median-time-past across the era boundary.** `medianTimePast` (`ledger.js:340-344`) takes the middle of the last `MEDIAN_TIME_WINDOW = 11` timestamps, and `validateBlock:351` requires `block.timestamp > MTP`. Construct blocks `H−12 … H+2` so that the MTP for block `H` is above block `H`'s timestamp. Expected: `H` is rejected with the MTP error **even though its era fields are correct**; `H−1` remains valid. Then shift timestamps so `H` passes MTP and assert acceptance. The point is that the era check (B3) and the MTP check are independent and must not shadow each other — an implementation that checks era first and returns on success, but skips time checks above `H`, would pass every other test in this matrix. [L2, L3]

Note the boundary interaction the test must not miss: `validateChainInternal:395` re-validates with `history.slice(-MEDIAN_TIME_WINDOW)`, so the window at `H` contains `H−10 … H−1` and excludes any `CP-ACT` block at `H−1` only if it falls out of the window. Use a window that straddles the era boundary on purpose.

**TE-75 — reorg of 100 / 101 / 150 blocks above the checkpoint.** Three cases: depth 100 ⇒ accepted at the boundary if work is strictly higher; 101 ⇒ `REORG_TOO_DEEP`; 150 after a simulated partition ⇒ `PARTITION_TOO_DEEP`, the node halts automatic resolution and reports the state, it does not silently retry forever. Assert the error **class**, not a message string. [L3]

Additional assertions:

| ID | Assertion |
|---|---|
| ER-1 | `checkpointState` returns `NOT_YET_APPLICABLE` when `tip < checkpoint.height`, and never claims enforcement |
| ER-2 | `checkpointState` returns `VIOLATED` when `tip ≥ height` and the block is missing or mismatched |
| ER-3 | A checkpoint at height 0 alone does not reject a same-genesis BLKC prefix; only `CP-PRE` does (§7.7) |
| ER-4 | A candidate that would replace any checkpoint block is rejected **before** work is read (instrumented counter = 0) |
| ER-5 | A reorg to the same height preserves supply exactly (§15.2, MI-14) |
| ER-6 | A depth-100 reorg allowed at the boundary does not also bypass the checkpoint — both constraints apply, in that order |

ER-6 exists because "depth ≤ 100" and "does not replace a checkpoint" are separate tests that a single combined condition can accidentally collapse into an `or`.

### 16.5 Miner and client (M-24 / TE-83)

**TE-83 — stale browser bundle submits a V1-shaped block after activation.** A client built before V2 mines a block by hashing the 9-field V1 projection at a height ≥ `H`. Expected: the server recomputes under the V2 rules, obtains a different digest, and rejects with `HASH_MISMATCH` or `ERA_VIOLATION` — it must not accept the block because the client's digest "looks valid". The test must also assert that the client was **not** silently upgraded by a configuration value: the era is compiled, and a stale bundle cannot be taught V2 by an env var. [L2, L6]

This is a certain failure on the current tree, by inspection: `src/miner.worker.js:17-28` constructs exactly the nine V1 fields and calls `JSON.stringify(block)` directly. It has no `version`, no `networkId`, and no shared serializer. After `H`, every block that worker produces is V1-shaped. That is the correct behaviour for the test (the server rejects it), but it means **no miner can mine after `H` until the worker is rebuilt from the shared serializer** — an operational fact that must be in the upgrade notes, not discovered on activation day.

Additional assertions:

| ID | Assertion |
|---|---|
| MC-1 | `miningTemplate` at `H` returns `version: 2` and the **compiled** `networkId`, never an environment value |
| MC-2 | The template's reward equals `formatUnits(subsidy + fees)` and its recipient equals `miner` (`§15.1`) |
| MC-3 | A template is never issued for a height whose era the running binary cannot validate |
| MC-4 | The worker's header construction is byte-identical to the server's for the same template |
| MC-5 | The worker refuses to start if it cannot import the shared serializer, rather than falling back to `JSON.stringify` |
| MC-6 | A template issued at `H−1` contains no `version`/`networkId`, and the same worker mines it successfully |

MC-4 is the substantive one. Byte identity holds **today** only because `headerOf:36-48` and the worker list the same fields in the same order. It is accidental, not enforced: two literal field lists in two languages-of-build. Adding `version` and `networkId` to `headerOf` and forgetting the worker produces a fork that no hash vector detects, because both sides still produce valid hashes of different preimages. The fix is structural (§7.4 shared module), and TE-88 is what prevents the duplication from returning.

### 16.6 Storage, startup, and recovery (M-07, M-12, M-13, M-19, M-23, M-25, M-26)

Each test names the step it must reach in the S1–S10 sequence of §12.3 and the exit code of §10.7.

**TE-69 — chain shorter than `CP-PRE`.** A database whose tip is below `CP-PRE.height`, started in production without recovery mode. Expected: exit 12 at S5, database unchanged (SHA-256 equal before and after), port never bound. With `BNKR_RECOVERY_SYNC_ONLY=1`: starts read-only, `serving:false`, `/api/validate` 503, sync allowed. [L4]

**TE-72 — `protocol_state` mismatch or checkpoint removed.** Three independent cases: (a) `protocol_state.network_id = "BLKC-MAINNET-V1"` ⇒ exit 13 (`IDENTITY_VIOLATION`); (b) the binary's compiled checkpoint set is missing a tuple that the previous release contained ⇒ the binary fails its own continuity gate K-1 (§9.3) and refuses to start with exit 15, before touching the database; (c) a checkpoint row is deleted from the database ⇒ irrelevant to consensus, because the constant still applies, and the node starts normally. Case (c) is the control: it proves checkpoints are compiled, not stored. [L4]

**TE-73 — zero-checkpoint build on mainnet.** A build compiled with an empty checkpoint set, pointed at the mainnet database. Expected: refusal to start with `CHECKPOINT_SET_EMPTY`, exit 11. A mainnet binary without `CP-PRE` cannot distinguish BNKR from BLKC, and its `/api/validate` would report a foreign chain as valid (TE-18). This test is the operational enforcement of "no checkpoints, no mainnet". [L4]

**TE-78 — pre-activation tip below `H`.** Tip is `H−1`, no `CP-ACT` block exists. Expected: starts; `checkpointState(CP-ACT) = NOT_YET_APPLICABLE`; serves read-only above `H−1`; reports `activationPending:true` in `/api/node`. It must not report the checkpoint as enforced, and it must not refuse to serve the valid pre-activation chain. [L4]

**TE-82 — `protocol_state` says V2 but the tip is V1.** Expected: `IDENTITY_VIOLATION`, exit 13. A descriptive row must not be able to declare an era into existence; the tip block's own fields are the authority. [L4]

**TE-84 — stale backup below the release checkpoint.** Restore a backup at height `R−50`, where `R = CP-TIP-AT-RELEASE.height`. Expected: exit 12; with recovery mode, sync-only until the tip reaches `R`, then a **restart** is required to enter normal mode. The node never serves user traffic from the stale tip, even if that tip is internally consistent — the difference between "valid chain" and "the chain this release expects" is exactly what S5 encodes. [L4]

**TE-85 — sync-only recovery, then assert S2–S5.** Start with `BNKR_RECOVERY_SYNC_ONLY=1` on a backup below `R`. Assert: `/health` 200 with `serving:false`; normal API returns 503; sync progresses; on reaching `R` the node does **not** auto-flip to serving; after a restart, S2–S5 pass and `/health` reports `serving:true`. The no-auto-flip rule is deliberate: a node that silently changes its serving state when a number crosses a threshold is a node whose observable contract depends on timing. [L4]

| ID | Assertion |
|---|---|
| ST-1 | Every fatal startup failure leaves the database byte-identical (SHA-256 before = after) |
| ST-2 | No fatal path executes `INSERT`, `UPDATE`, `DELETE`, or a schema migration before the failing step |
| ST-3 | The port is not bound until S1–S10 pass, except in sync-only mode where only the read surface is bound |
| ST-4 | Exit codes are stable across runs and across machines for the same fault |
| ST-5 | Recovery mode relaxes S5 only; S1–S4 and S6–S10 still apply |
| ST-6 | Recovery mode is impossible to enable accidentally: the flag must be the literal `"1"`, and it must appear in `/health` |

### 16.7 Peer and network (M-03 / TE-65, M-08 / TE-70, M-09 / TE-71)

**TE-65 — rolling-upgrade checkpoint sets.** Peer A publishes `{CP-PRE, CP-ACT, 8000}`; peer B publishes `{CP-PRE, CP-ACT, 8000, 9000}`. Expected: compatible; the highest common height matches; B is preferred as a strict superset; neither is rejected. Then A publishes `{…, 8000: X}` and B publishes `{…, 8000: Y}` ⇒ conflict at a common height, refuse to sync from either, log both tuples. A peer's set is compared, **never adopted** (§14.6). [L5]

**TE-70 — DNS and redirect SSRF variants.** Peer URL host resolves to `127.0.0.1`, `::1`, `169.254.169.254`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `0.0.0.0`, or a name that resolves differently on the second lookup (rebinding). Expected: refused at resolution **and** again at connect; no request reaches the private address; redirects are not followed, or every hop is re-filtered. [L5]

**This test targets a defect that exists today.** `cleanPeerUrl` (`index.js:168-189`) enforces scheme, absence of credentials, and an empty path — nothing else. There is no address-class check, `fetch` follows redirects by default (`index.js:211`, `:255`, `:348`), and DNS is resolved by the runtime at connect time. A peer URL of `http://169.254.169.254` is accepted by the current code and fetched. On a cloud host that is the instance metadata service. This is an **open, unmitigated SSRF** on the deployed surface, not a V2 concern, and it does not require activation to matter.

**TE-71 — 200 MB peer chain body.** A peer serves `/api/peer/chain` with `Content-Length: 209715200`. Expected: rejected before reading; if `Content-Length` is absent, a byte counter aborts at `MAX_PAGE_BYTES`; the process does not allocate 200 MB; `response.json()` is never called on an unbounded body. [L5]

**Also a live defect.** `index.js:255-258` awaits `response.json()` with no length check and no streaming cap, then passes the parsed array to `replaceChain`. Any peer the operator has added — or any host that can answer on that URL after a takeover — can force the node to buffer an arbitrary body. Paged sync (§14.8) replaces this path; until it does, TE-71 fails.

Additional assertions:

| ID | Assertion |
|---|---|
| PN-1 | Peer identity is the Ed25519 key, not the self-asserted `origin-peer` header (`index.js:134`, `:375`, `:382`) |
| PN-2 | A replayed nonce in a signed peer challenge is rejected |
| PN-3 | A peer claiming `protocolVersion: 2` but serving a V1 block above `H` is rejected on the chain, not on the claim |
| PN-4 | A read-only peer is rate-limited and has no write capability |
| PN-5 | Paged sync rejects a page whose `prevPageHash` does not chain to the previous page |
| PN-6 | Peer responses larger than `MAX_PAGE_BYTES` abort the stream, not just the parse |
| PN-7 | A peer URL is re-validated on every dial, not only at registration |

PN-7 matters because DNS can change after registration; validating once at `addPeer` time and never again is equivalent to no validation against rebinding.

### 16.8 Restart and upgrade

| ID | Assertion |
|---|---|
| RU-1 | Restart on a healthy V2 database: S1–S10 pass, `/health` 200, `checkpointState = APPLICABLE`, tip unchanged |
| RU-2 | Restart twice: identical `buildId`, identical `checkpointSetDigest`, identical tip, identical supply |
| RU-3 | Restart after a crash mid-write: no partial block, no partial account row; recovery proceeds only above the highest checkpoint |
| RU-4 | Restart with a database written by a **newer** binary (unknown `version`): exit 10, no repair, database unmodified |
| RU-5 | Restart with a database written by an **older** binary and valid V1 history: starts, checkpoints `NOT_YET_APPLICABLE`, no fabricated activation height or checkpoint value |
| RU-6 | Restart with the same database but a **different** binary build: if `CHECKPOINT_SET_DIGEST` differs, exit 15 unless the new set is a strict superset with a valid `prevManifestDigest` chain (§9.3) |
| RU-7 | Restart after `SIGINT` during sync: no half-applied page; the resume point is a block boundary |

RU-3 and RU-7 are the two crash shapes that matter: crash inside a block write, and crash between pages. A node that can only survive clean shutdowns has not implemented fail-closed storage; it has implemented fail-closed startup.

### 16.9 Cross-machine and cross-implementation obligations

A test passes only if it passes on **two machines** and, for L1, in **two implementations**.

| Obligation | Consequence if unmet |
|---|---|
| V-01…V-12 reproduce byte-for-byte on a second OS and a second runtime version | the serializer is implementation-defined, not specified |
| TE-15/TE-16/TE-17 reproduce on two machines | the historical gate is machine-specific |
| TE-39 shows byte identity between worker and server | the network can fork on client build |
| TE-40 runs at least one non-JavaScript vector runner | "independently implementable" is unproven |
| Two implementations produce the same **error codes** for every negative vector | implementations can agree on hashes and disagree on validity |

The last row is the one usually omitted. Hash agreement is necessary and not sufficient: two implementations that compute identical digests but classify one header as `ERA_VIOLATION` and the other as `NETWORK_ID_MISMATCH` will partition the moment that header appears, because each will refuse blocks the other accepts. Conformance must cover the **code**, not only the digest.

`TE-40` is `Blocked`. It is not optional, and no amount of JavaScript testing substitutes for it.

### 16.10 TE-62 split

| Test | Setup | Expected | Classification |
|---|---|---|---|
| **TE-62a** | A V2 binary whose maximum supported version is 2 opens a database containing a block with `version: 3` | Exit 10; `UPGRADE REQUIRED`; row count and SHA-256 of the database unchanged; port not bound; no repair log; no `DELETE` executed | **PASS/FAIL** |
| **TE-62b** | The actual V1 binary from commit `908c642` opens a copy of a V2 database | Block count drops to `H`; V2 blocks deleted; process continues serving; accounts rebuilt from the prefix | **EXPECTED-UNSAFE**, documentation harness only |

TE-62b asserts the opposite of TE-62's original wording. It exists so that no one can later claim the old binary was safe. It is never a release gate, and its "pass" means "the documented truncation occurred", not "the system behaved correctly".

The mechanism is in the current tree, not inferred: `validateChainInternal`/repair (`ledger.js:569-616`) truncates stored blocks that fail validation, and a V1 binary has no notion of `version`, so a V2 block's extra field changes its hash under the V1 serializer and the block is discarded. The truncation is silent to the operator apart from the resulting height drop. This is why §10 requires withdrawing V1 binaries rather than documenting a compatibility mode that does not exist.

### 16.11 The 26 missing adversarial tests (index)

Every one of the review's 26 missing tests is now specified. None is executed. The `Specified in` column is where the detailed scenario lives; the `TE` column is the concrete identifier used elsewhere in this matrix.

| ID | Scenario | Expected | TE | Layer | Specified in |
|---|---|---|---|---|---|
| **M-01** | Store a block whose header differs but whose stored `hash` equals `CP.*.hash`; restart and sync | Rejected: recomputation differs; stored hash never trusted | TE-63 | L3 | §16.11 |
| **M-02** | Serialize a header built from a source object with keys in reverse order | Identical bytes and digest | TE-64 | L1 | §16.1.1 |
| **M-03** | Rolling-upgrade checkpoint sets: subset vs superset vs conflict | Subset compatible; superset preferred; conflict refused | TE-65 | L5 | §16.7 |
| **M-04** | Extra property on a transaction (`amountUnits` inside a V2 block) | `EXTRA_TRANSACTION_FIELD` | TE-66 | L1 | §16.1.1 |
| **M-05** | `version` as `2.0`, `null`, `true`, `2.5`, `"2"` | `2.0` parses to `2`; all others rejected by type | TE-67 | L1 | §16.1.1 |
| **M-06** | Raw `validateChain` on the foreign BLKC chain | `valid:false` with identity reason | TE-68 | L3 | §16.3 |
| **M-07** | Chain shorter than `CP-PRE` | Exit 12 at S5; sync-only mode available | TE-69 | L4 | §16.6 |
| **M-08** | DNS / redirect / rebinding SSRF variants | Refused at resolve and at connect | TE-70 | L5 | §16.7 |
| **M-09** | 200 MB peer chain body | Rejected before parse; no allocation | TE-71 | L5 | §16.7 |
| **M-10** | Reward = subsidy + 1; wrong recipient; fee paid as subsidy | All rejected | MT-01/02/03 | L8 | §15.9, §16.12 |
| **M-11** | Two blocks each claiming the remaining supply | Second subsidy is `0` at the cap; a chain claiming more is invalid | MT-09/MT-14 | L8 | §15.9, §16.12 |
| **M-12** | `protocol_state` mismatch; checkpoint removed from a release | Exit 13 / continuity failure exit 15 | TE-72 | L4 | §16.6 |
| **M-13** | Zero-checkpoint build on mainnet | Exit 11 | TE-73 | L4 | §16.6 |
| **M-14** | MTP across the era boundary | Era and MTP checked independently | TE-74 | L2, L3 | §16.4 |
| **M-15** | V1 binary opens a V2 database | Documented truncation, `EXPECTED-UNSAFE` | TE-62b | L4 | §16.10 |
| **M-16** | Reorg 100 / 101 / 150 above the checkpoint | 100 accepted at boundary; 101 rejected; 150 partition halt | TE-75 | L3 | §16.4 |
| **M-17** | Duplicate JSON keys (`{"height":1,"height":2}`) | Parser-level `DUPLICATE_KEY` | TE-76 | L1 | §16.1.1 |
| **M-18** | Homoglyph / trailing space / ZWJ in `networkId` | `INVALID_NETWORK_ID` | TE-77 | L1 | §16.1.1 |
| **M-19** | Pre-activation tip below `H` | `NOT_YET_APPLICABLE`; no false enforcement claim | TE-78 | L4 | §16.6 |
| **M-20** | `chainWork` as number, leading zeros, missing | `CHAINWORK_MISMATCH` / `MISSING_FIELD` | TE-79 | L2 | §16.2 |
| **M-21** | `transactions` null / string / 10,001 entries | `INVALID_TRANSACTIONS` / `TOO_MANY_TRANSACTIONS` | TE-80 | L1 | §16.1.1 |
| **M-22** | `amount` + `amountUnits` agree / disagree | Agree ⇒ accepted at API; disagree ⇒ rejected; neither enters the block | TE-81 | L1, L2 | §16.1.1 |
| **M-23** | `protocol_state` says V2 but the tip is V1 | Exit 13 | TE-82 | L4 | §16.6 |
| **M-24** | Stale browser V1 serializer submits after activation | Rejected on recomputation | TE-83 | L2, L6 | §16.5 |
| **M-25** | Stale backup below the release checkpoint | Exit 12; sync-only path | TE-84 | L4 | §16.6 |
| **M-26** | Sync-only recovery, then assert S2–S5 | Read-only until caught up; explicit restart to serve | TE-85 | L4 | §16.6 |

**TE-63 — stored hash is not a trust input.** Insert a row into `blocks` whose `json` column contains header `h₁` and whose `hash` column contains `CP-ACT.hash`. Restart. Expected: the checkpoint verifier re-serializes `h₁` from the stored JSON, obtains a digest different from `CP-ACT.hash`, and reports `CHECKPOINT_VIOLATION` (exit 11). The stored `hash` column must never be read as evidence.

This matters because `blocks` stores both a `hash` column and the full `json` (`ledger.js:510-511`, `:732-733`). Two sources for one identity invite a reader to use the cheap one. §8.3 already requires recomputation from canonical JSON; TE-63 is the test that makes the requirement real. It is also the test that distinguishes "we verify checkpoints" from "we compare a database row to a constant", which anyone with write access to the database can satisfy.

### 16.12 Monetary tests (MT-01…MT-15)

Specified with the enforcing code path in §15.9. Execution detail:

| ID | Fixture | Assertion | Layer |
|---|---|---|---|
| MT-01 | Synthetic block, reward = subsidy + 1 unit | reject `reward.amount` mismatch | L8 |
| MT-02 | Synthetic block, reward = subsidy + fees + 1 unit | reject | L8 |
| MT-03 | Reward to sender instead of miner | reject | L8 |
| MT-04 | Sender spends more than its balance | reject | L8 |
| MT-05 | Reward equal to fees only | reject | L8 |
| MT-06 | Reward omitting fees | reject | L8 |
| MT-07 | Fabricated `accounts` row above `MAX_SUPPLY` | reject; `accountsValid:false` | L8 |
| MT-08 | Same-height reorg | supply equal on both branches | L8 |
| MT-09 | `rewardForHeight` at `MAX_SUPPLY` and `MAX_SUPPLY−1`; sum the schedule | `0`, `1`, and `2,099,999,997,690,000` | L8 |
| MT-10 | Two transactions from one sender with the same nonce | reject | L8 |
| MT-11 | Direct DB edit of a balance | detect via replay comparison; refuse on B2+; **undetectable on B0** | L8 |
| MT-12 | `amount = "0.00999999"`, `fee = "0.00099999"` | reject | L8 |
| MT-13 | Legacy fee-less transaction at height ≥ 136 | reject | L8 |
| MT-14 | `reward.amount = "0"` with nonzero subsidy | reject | L8 |
| MT-15 | Miner spends its reward in the next block, then a reorg orphans it | spend invalidated; not requeued as valid | L8, L3 |

None of these tests exists today. `ledger.test.js` in the working tree (B2) contains fee and amount tests, but no test name references a reward, halving, supply, or issuance rule except as incidental setup. [Verified by inspection of test names]

The set is deliberately 15 and not 12. The review listed 12; this correction adds MT-11 (a direct database edit is the only way to actually forge supply, and it is invisible on B0), MT-14 (a zero reward with a nonzero subsidy is the simplest inflation-shaped encoding), and MT-15 (reorg interaction with an unmatured reward). §2.4 records the change.

### 16.13 Tests introduced by this correction (TE-86…TE-92)

| ID | Test | Expected | Layer |
|---|---|---|---|
| **TE-86** | Checkpoint derivation determinism: two operators, two chain copies, one published script | Byte-identical tuple and `manifestDigest`; any difference is a stop signal, not a troubleshooting item | L7 |
| **TE-87** | Manifest continuity across two releases | Release *n+1* contains every tuple of release *n* byte-identically, plus at least one new higher checkpoint; `prevManifestDigest` links correctly | L7 |
| **TE-88** | Build-time duplicate-serializer check | Build fails if a second `headerOf` / `serializeV2Header` / `NETWORK_ID` literal / `CHECKPOINTS` table exists outside the shared module | L6 |
| **TE-89** | Paged sync with envelope caps | `from`/`to` query bounds honoured and echoed as `fromHeight`/`toHeight`; `pageHash` and `prevPageHash` verified; `MAX_PAGE_BYTES` enforced mid-stream; no unbounded `GET` | L5 |
| **TE-90** | Historical gate over all three databases in one run | 0 mismatches; genesis shared; total work exact; no writes; SHA-256 unchanged | L1, L6 |
| **TE-91** | Monetary observability | `/api/node` exposes `supplyUnits == supplyExpectedUnits`; `/health` returns 503 when `accountsValid` is false | L8 |
| **TE-92** | V2 block route body cap | 8 MiB limit enforced before parse; oversize rejected with a typed error, not a connection reset | L2, L5 |

### 16.14 Execution rules

1. **No test is marked passed until it has run, on two machines, with recorded evidence.** This document records none.
2. Every run records: source commit, `buildId`, OS, runtime version, fixture id, seed (if any), and database SHA-256 before and after.
3. L1–L4 tests must not contact the network or the production database.
4. Any test that mutates a database uses a copy. `bannekercoin.db`, `blackcoin.db`, and `node-b.db` are read-only inputs.
5. Negative tests assert **error codes**, not message text.
6. Determinism tests run twice in-process and once in a fresh process.
7. A test whose expected outcome cannot occur is deleted or corrected, never marked skipped (TE-13, TE-18, TE-62 are the precedents).
8. Tests marked `Blocked` (TE-40) are reported as blocked, not omitted.
9. `EXPECTED-UNSAFE` (TE-62b) is a distinct classification from `PASS`.
10. A green matrix does not constitute a decentralization claim (§18, §19).

### 16.15 What this matrix cannot prove

- It cannot prove that a second operator exists (A-1).
- It cannot prove miner diversity (A-2).
- It cannot prove that a non-JavaScript implementation exists (A-3; TE-40 blocked).
- It cannot prove that a checkpoint value is the right one — only that two derivations agree (A-5).
- It cannot prove that the deployed system is the tested system (B0 ≠ B1 ≠ B2, §11).
- It cannot prove that an operator will refuse a malicious release (A-8).

Those are the gates in §13.2 and §22, and they are not test rows. A test matrix is evidence about code; it is not evidence about people, deployment, or intent.

---

## 17. Corrected threat-to-test mapping

### 17.1 Why the original mapping was wrong in every row

The original specification numbered its threats `T-1 … T-17` and its tests `TE-01 … TE-17` and then mapped `T-n → TE-n`. The review found this wrong for all 17 rows: the 17th test has nothing to do with the 17th threat. The result looks like coverage while providing none — every threat appears to have a test, and no threat actually has one.

The corrected mapping below is **semantic**: each threat maps to the tests whose scenario actually exercises its protection, and to at least one test that must fail against the current code. A threat whose tests all pass today is either not a threat or not tested.

### 17.2 The mapping

| Threat | Capability | Original (wrong) test | Corrected primary tests | Supporting tests |
|---|---|---|---|---|
| **T-1** Historical BLKC chain submitted to BNKR | Any peer or API caller | TE-01 (networkId hash difference) | **TE-23** BLKC chain rejected at checkpoint, work never read; **TE-18 / TE-68** `validateChain` returns `valid:false` | TE-25, TE-27, TE-47, HP-4, ER-3 |
| **T-2** BNKR chain submitted to BLKC | Any peer | TE-02 (same-network hash equality) | **TE-21 / TE-22** cross-network fixture rejected at B4 | TE-19, TE-37, TE-59 |
| **T-3** Higher-work foreign chain | Attacker with hashpower or a fabricated high-work chain | TE-03 (missing `networkId`) | **TE-24** 10× work with wrong checkpoint rejected; work accessor never called | TE-21, TE-23, ER-4, TE-26 |
| **T-4** Competing chain sharing genesis and Era 1 prefix | Attacker who re-mines a cheap Era 1 | TE-04 (`networkId: ""`) | **TE-25** same genesis, wrong Era 1 prefix ⇒ `CP-PRE` rejects | TE-27, TE-63, ER-3, HP-6 |
| **T-5** Incorrect `networkId` in a V2 block | Miner or peer | TE-05 (`networkId: null`) | **TE-06** byte-exact comparison; **TE-37** BLKC ID rejected | TE-04, TE-05, TE-77, TE-21 |
| **T-6** Missing V2 version field | Miner or peer | TE-06 (case difference) | **TE-09** absent at `height ≥ H` ⇒ `ERA_VIOLATION` | TE-08, TE-12, TE-31 |
| **T-7** Version downgrade | Peer replaying v1 above `H`, or v2 below `H` | TE-07 (extra `chainId`) | **TE-08** v1 at `H`; **TE-12** v2 at `H−1`; **TE-31** mixed era | TE-62a, TE-67 |
| **T-8** Peer lying about its network ID | Any HTTP server | TE-08 (`version: 1`) | **TE-55** echoed identity + bad chain ⇒ dropped after validation | TE-54, TE-53, PN-1, PN-3 |
| **T-9** Peer supplying a false checkpoint | Any peer | TE-09 (missing version) | **TE-53** compare sets, never adopt; conflict refused | TE-65, PN-5, ER-4 |
| **T-10** Malicious checkpoint configuration | Someone with deploy/env access | TE-10 (`version: 3`) | **TE-73** zero-checkpoint mainnet build refuses to start; **TE-72(b)** continuity gate | TE-86, TE-87, TE-61, RU-6 |
| **T-11** Reorganization across activation | Peer offering a fork replacing `H−1` or `H` | TE-11 (version string) | **TE-28** reorg replacing `CP-ACT` rejected before work read | TE-27, TE-74, TE-75, ER-6 |
| **T-12** Database rollback to a pre-upgrade state | Operator error or stale backup | TE-12 (v2 at `H−1`) | **TE-48** rolled-back DB ⇒ exit 12; **TE-84** stale backup | TE-69, TE-85, TE-82, TE-72(a) |
| **T-13** New node bootstrapping from an untrusted peer | Any peer the operator adds | TE-13 (float reward) | **TE-23 / TE-24** peer is transport, checkpoints are authority | TE-53, TE-55, TE-89, PN-5 |
| **T-14** Miner mining for another network | Miner controlling the client | TE-14 (`message` non-null) | **TE-37** BLKC ID rejected; **TE-38** tampered hash recomputed | TE-83, TE-36, MC-1, MC-4 |
| **T-15** Old software connecting after activation | Operator running an outdated binary | TE-15 (recompute hashes) | **TE-59** peer without `protocolVersion: 2` not selected; **TE-62b** documented truncation | TE-60, TE-61, RU-5 |
| **T-16** Fail-open storage | Misconfiguration, typo, missing env var | TE-16 (recompute BLKC) | **TE-41 … TE-47** each fatal misconfiguration exits non-zero | ST-1…ST-6, TE-46, TE-85, TE-77 |
| **T-17** Open peer submission relay | Anyone reaching `/api/peer/tx` or `/api/peer/block` | TE-17 (validate BNKR chain) | **TE-58** unauthenticated write rejected (conditional on Q-4) | PN-1, PN-2, PN-4, TE-51, TE-52, TE-92 |

### 17.3 Coverage checks

| Check | Result |
|---|---|
| Every threat `T-1…T-17` maps to at least one **primary** test | yes |
| Every primary test's scenario actually exercises the threat's stated protection | yes, by construction above |
| Every threat has at least one test that **fails on the current code** | yes — see the per-threat notes below |
| Every test in the matrix is reachable from some threat or invariant | mostly; TE-86/TE-87 are governance-procedure tests and TE-88 is a build test, which no threat row names |
| No threat is "covered" only by tests that already pass | yes |

**Where each threat is live today** (i.e. the test that should fail against B0/B1/B2, proving the threat is real and not hypothetical):

| Threat | Fails today because |
|---|---|
| T-1 | `validateChain` reports the 297-block BLKC chain as `valid:true` [Verified at B0 `/api/validate`] |
| T-2 | No header field distinguishes networks; a BNKR-prefix chain is accepted by a BLKC validator until transaction signatures fail |
| T-3 | A higher-work foreign chain with a valid-looking prefix is accepted on a fresh node; nothing checks identity |
| T-4 | Genesis is shared, so a re-mined Era 1 is indistinguishable |
| T-5 | No `networkId` field exists |
| T-6 | No `version` field exists |
| T-7 | No era rules exist |
| T-8 | `origin-peer` is self-asserted (`index.js:134`) and never checked against a key |
| T-9 | No checkpoints exist |
| T-10 | No compiled checkpoint set exists |
| T-11 | `MAX_REORG_DEPTH = 100` is the only bound; any checkpoint-free replacement is allowed |
| T-12 | A rolled-back database is served silently; S5 does not exist |
| T-13 | A fresh node adopts whatever validates — proven with BLKC |
| T-14 | No network concept in headers; the submitted hash is recomputed, but the header has no network |
| T-15 | A V1 binary truncates a V2 database instead of refusing (TE-62b) |
| T-16 | Missing `BNKR_STORAGE` silently creates a local genesis database with `valid:true`, height 0 |
| T-17 | `/api/peer/tx` and `/api/peer/block` are unauthenticated and rate-limited only |

### 17.4 Threats the original model omitted

The corrected mapping also exposes threats that the original 17 did not name. They are not new attacks; they are the same attacker with a different lever.

| Threat | Description | Covered by |
|---|---|---|
| **T-18** | SSRF via peer URL to cloud metadata or loopback | TE-70 (fails today: `cleanPeerUrl` filters scheme and path only) |
| **T-19** | Unbounded peer response exhausting memory | TE-71, TE-89 (fails today: `response.json()` on an unbounded body) |
| **T-20** | Direct database edit forging balances with no detection | TE-63, MT-07, MT-11 (undetectable on B0) |
| **T-21** | Duplicate JSON keys smuggling a different value past a signer | TE-76 (fails today: `express.json` uses `JSON.parse`) |
| **T-22** | Checkpoint publication captured by a single signer | TE-86, TE-87, Q-21 (three-of-five attestation proposed, not adopted) |
| **T-23** | A release that drops or alters a checkpoint | TE-72(b), RU-6, K-1 (continuity gate) |
| **T-24** | Miner stranded at activation by a stale worker bundle | TE-83, MC-4, MC-5 (certain failure: `src/miner.worker.js:17-28`) |

T-18 through T-24 are not folded into the original numbering because that would change the review's identifiers. They are recorded here so that the corrected matrix cannot be read as "17 threats and they are all handled".

---

## 18. Independent-node architecture

### 18.1 Operational definition

A node is **independent** when its operator can do all four of the following without asking the author of the software:

1. build the running binary from source, and verify that the binary is the build the source describes;
2. obtain the checkpoint manifest through a channel that the node does not also use for consensus data, and verify its signature;
3. validate the chain from genesis to tip **locally**, treating every peer as a transport and none as an authority;
4. refuse a release, a peer, or a chain, and keep serving the last state it validated.

Count nodes by `(operator, trust source)`, not by process. Ten processes on one host, started by one person, trusting one manifest, are one node. This definition is stricter than "a server is running", and it is the only one that makes the word useful.

### 18.2 The minimum artifact set a stranger needs

| Artifact | Purpose | Exists today? |
|---|---|---|
| Source tree at a named commit | Build from scratch | **Yes** — `908c642` is the current baseline |
| Reproducible build recipe with a `buildId` | Prove the binary matches the source | **No** |
| Positive conformance vectors V-01…V-12 | Verify a serializer without reading the code | **Partial** — JS runner passes; no non-JS runner |
| Negative conformance vectors with error codes | Verify classification, not just hashing | **Partial** — JS runner passes; no non-JS runner |
| Independent (non-JS) vector runner | Prove the spec is implementable | **No** (TE-40 blocked, A-3) |
| Checkpoint manifest + signed digest + `prevManifestDigest` | Establish identity out-of-band | **No** |
| Derivation script for checkpoints | Let a second operator reproduce each tuple | **Yes** — `scripts/derive-mainnet-checkpoint.mjs`; one derivation so far |
| Genesis constant | Fixed start of chain | **Yes** — `49f9e886…ebaa` |
| Storage-mode contract and exit codes | Fail closed, predictably | **Specified** §10, §12; not implemented |
| Sync protocol with paging and caps | Bootstrap without trusting the peer | **Partial** — paged transport exercised locally; no public peer/auth deployment |
| Bootstrap peer list | Find the network | **No** — `peers: 0` at baseline |
| Written decision record for `H` and the checkpoint set | Know what the network is | **Partial** — §21.9 records owner decisions; publication/attestation still open |

A stranger can build the current source, can verify genesis, and can now read the selected V2 height and checkpoint in §21.9. They still cannot verify a signed release, obtain an independently attested checkpoint, or find a public peer. That is the remaining gap between "open source" and "independently runnable".

### 18.3 The startup path, with no author in it

```text
build from source
  -> verify buildId == manifest.buildId
  -> read manifest, verify signature and prevManifestDigest
  -> load compiled constants (networkId, checkpoints); manifest may assert, never define
  -> open storage; S1-S4 (mode, reachability, schema, genesis)
  -> S5 (height >= CP-TIP-AT-RELEASE)
  -> S6-S10 (protocol_state, chain replay, account reconciliation, checkpoint ancestry)
  -> bind read surface
  -> sync from one untrusted peer, paged, each page verified
  -> validate locally to tip; checkpoint ancestry walked to genesis
  -> bind write surface; serve
```

Every arrow is local except the sync step, and the sync step's output is verified by the same code that verified the local chain. The author appears nowhere in this path. Today, steps 1, 2, 4 (partly), 7, and 9 do not exist.

### 18.4 Independence dimensions, measured

| Dimension | Independent count today | Evidence |
|---|---|---|
| Implementations of the serializer | **1** (JavaScript) | one `headerOf`, one `sha256` call site |
| Codebases | **1** | one repository, one maintainer history |
| Node operators | **1** | `peers: 0`; no operator attestation exists |
| Hosting providers | **1** | a single deployment target (U-1, unverified) |
| Data copies under independent control | **1** | three local databases, all on one machine, all derived from one chain |
| Funding sources | unknown | no disclosure |
| Mining operators | **5 keys, almost certainly 1 operator** | 5 distinct `miner` values in 858 blocks, no diversity evidence |
| Checkpoint attesters | **0** | no attestation scheme adopted (Q-21) |
| Governance signers | **1** (implicit) | no multi-party release authority |

Nine dimensions, one owner. V2 does not change any row in this table.

### 18.5 Single points of failure

| If this disappears | Consequence today | Would V2 change it? |
|---|---|---|
| The repository | no source to build | no |
| The author's database | no chain — there is no peer to re-sync from | no |
| The author's deployment | no network, because there is no second node | no |
| The author's signing key | no new checkpoints, no `H`, no delay notice | no; §9 proposes attestation, not a second key holder |
| The author | no one can answer Q-1, Q-2, Q-19, Q-23; no one can publish a rollback notice | no |

The last row is the founder-disappearance test of §9.8, and it is currently failed by construction: every governance answer in §21 that is marked "Owner" has exactly one owner of record.

### 18.6 Minimum viable independent node (MVIN) checklist

A node counts as independent only when every item is true. Each item names the artifact that makes it checkable.

| # | Requirement | Checkable by |
|---|---|---|
| MVIN-1 | Built from a named commit by a documented, reproducible recipe | Two builders produce the same `buildId` |
| MVIN-2 | `buildId` matches the signed manifest | `buildId` in `/api/node` versus the manifest |
| MVIN-3 | All V-01…V-12 vectors reproduce byte-for-byte | Vector runner output |
| MVIN-4 | Negative vectors produce the specified error **codes** | Vector runner output |
| MVIN-5 | Every checkpoint reproduces from the operator's own copy | Derivation output equals the manifest tuple |
| MVIN-6 | Checkpoint ancestry walks to genesis locally | §8.4 walk log |
| MVIN-7 | Sync succeeds from at least two peers, each treated as untrusted | Sync log with per-page verification |
| MVIN-8 | A poisoned peer is rejected without stalling the node | TE-55, TE-89 |
| MVIN-9 | The node refuses to start on a rolled-back or foreign database | TE-47, TE-48, TE-69 |
| MVIN-10 | The node serves nothing until S1–S10 pass | ST-3 |
| MVIN-11 | The operator can decline a release and keep serving | RU-6, TE-87 |
| MVIN-12 | `/api/node` discloses `protocolVersion`, `checkpointSetDigest`, `buildId`, `supplyUnits` | TE-91 |

MVIN-1 and MVIN-5 are the two that cannot be faked by writing more documentation. Everything else is code that can be tested.

### 18.7 Verdict

**BNKR is not independently runnable today, and V2 does not make it so.** The measured state is one implementation, one operator, one host, one data source, zero peers, zero attesters, and an unanswered activation height. The software can be made *verifiable*; it cannot be made *decentralized* by a specification, and this document does not claim otherwise.

The correct statement of what V2 accomplishes, stated narrowly:

> V2 makes it possible for a node to tell one BNKR chain from another BNKR-shaped chain, and to refuse a chain that is not the one its release expects. That is a prerequisite for independent operation. It is not independent operation.

### 18.8 Order of operations that would produce an independent node

Dependencies, not a schedule:

```text
shared serializer (§7.4)
  -> conformance vectors + runner (TE-40)        -> second implementation
  -> fail-closed storage (§12)                    -> a node that can refuse
  -> checkpoint derivation + manifest (§9)        -> identity out-of-band
  -> second operator with their own data copy     -> a second node
  -> second host / second network path            -> survives one provider
  -> attestation scheme (Q-21)                    -> survives one signer
  -> H and checkpoint set (Q-1, Q-2)              -> a network with a known identity
```

Each arrow is blocked by the item before it. The historical concern was that Q-1 and Q-2 chosen before those artifacts would be a decree. §21.9 records the owner's selection with a derived checkpoint and compiled implementation; the independent artifacts above are still required before the selection becomes a public-network fact rather than a local consensus constant.

---

## 19. Satoshi-philosophy governance assessment

### 19.1 The rubric

"Satoshi-style" is not a compliment; it is a set of falsifiable properties. The ones that can be checked against this repository are below.

| Property | What it requires |
|---|---|
| **Verification over trust** | A user can check the rules themselves; no privileged verifier |
| **Permissionless validation** | Anyone can run a node with no approval |
| **Permissionless participation** | Anyone can mine or transact without an allowlist |
| **Credible neutrality** | The rules do not favour a named party |
| **Minimal trusted setup** | No party must be honest for the system to be sound |
| **Exit** | A dissenting user can leave with their state intact |
| **Ossification / predictability** | Consensus changes are rare and hard, not routine |
| **Transparent monetary policy** | Issuance is a published function, not a discretion |

### 19.2 Scorecard

| Property | Status | Basis |
|---|---|---|
| Verification over trust | **Partial** | Source is public and the rules are readable. But the deployed build does not expose `accountsValid`, so a user cannot verify balances against replay on B0 (§15.2, §15.7). There is also no second implementation, so "verify" means "read the same JavaScript". |
| Permissionless validation | **Partial** | Anyone can clone and run. In practice there is nothing to sync from (`peers: 0`) and no published checkpoint to check against. Running a node today validates whatever the local database contains. |
| Permissionless participation | **Partial** | Mining has no allowlist. The chain shows 5 miner keys, almost certainly one operator, and 7 transactions in 858 blocks. Permissionless in code, unexercised in fact. |
| Credible neutrality | **Unproven** | No evidence of favouritism, and no mechanism that would make favouritism visible. A single maintainer can change the rules and a single deployer can ship them. Neutrality here is a reputation, not a structure. |
| Minimal trusted setup | **Fails** | One maintainer, one signer, one host, one database, zero attesters (§18.4). The system requires that party to be honest today. |
| Exit | **Fails** | A user can copy a database, but cannot validate an alternative chain without a second source, and cannot know the canonical checkpoint without the author's manifest. Exit without a verifiable destination is not exit. |
| Ossification | **Fails** | V2 is a consensus change authored, reviewed, and to be activated by one party. There is no rough consensus process, no activation threshold, and no veto. High change velocity with low ceremony is the opposite of ossification. |
| Transparent monetary policy | **Partial** | The schedule is a small, published function (§15.1). But the wall-clock meaning is undocumented and ambiguous by a factor of ~100 depending on the statistic (§15.5), and the "4-year" description is false under every measurement. A published function with a misleading description is not transparent. |

### 19.3 What the assessment actually says

The project has the **artifacts** of the philosophy — public source, no allowlist, a fixed supply function, a proof-of-work chain — and lacks the **structure**: multiple independent verifiers, multiple implementations, multiple signers, and a governance process that can say no to the maintainer.

This is not a moral failing and it is not fixable by a specification. It is the normal state of a young chain with one author. The error would be to describe that state with the vocabulary of the finished thing. Three specific claims must not be made:

1. **"BNKR is decentralized."** One implementation, one operator, zero peers. False.
2. **"V2 makes BNKR decentralized."** V2 makes networks distinguishable. It creates no nodes. False.
3. **"The network is trustless."** Every consensus constant is currently set by one party, and there is no way for a second party to overrule a bad release. False.

### 19.4 The accurate framing

> BNKR is a single-operator proof-of-work chain with public source, a fixed issuance function, and a checkpoint-based identity proposal (V2) that is specified but not implemented. It is a **separated continuation** of the original chain, not a new network: genesis is shared, Era 1 history is frozen, and the change is an additive header field plus a compiled identity anchor. Whether it becomes independently operated is an organizational question that no document can settle.

"Separated continuation" is also the recommendation recorded for Q-12, because it is the only framing consistent with the shared genesis and the frozen prefix.

### 19.5 What would move each row

| Property | First step that would move it |
|---|---|
| Verification over trust | Deploy `accountsValid` and the replay comparison (S7); publish the vector runner |
| Permissionless validation | Publish a checkpoint manifest and a bootstrap peer; get one other operator to sync |
| Permissionless participation | Nothing structural; exercise it — more than 5 miner keys and more than 7 transactions |
| Credible neutrality | Multi-party release signing (Q-20) and attestation (Q-21) |
| Minimal trusted setup | A second implementation (Q-22) and a second signer |
| Exit | A second data source and a published manifest a user can verify independently |
| Ossification | A written change process with a threshold and a veto (Q-23) |
| Transparent monetary policy | Answer Q-15; publish the cadence measurement and the wall-clock range |

Not one of these is a code change in this repository alone. That is the finding.

---

## 20. Roadmap

### 20.1 Phase structure

Phases are ordered by dependency, not by calendar. No phase may start before its exit gate passes, and no date is implied by their numbering. A phase that is "complete" while its gate is unmet is not complete.

| Phase | Deliverable | Exit gate | Blocked by |
|---|---|---|---|
| **P0** | Read-only evidence: audit, V2 specification, independent review, this correction | Four documents, three database hashes recorded and unchanged, no source edits | — **done** |
| **P1** | Shared serializer module; V-01…V-12 positive vectors; negative vectors with error codes; non-JS vector runner | TE-40 passes in a second language; TE-88 build check in place | A-3 (a second implementation author, Q-22) |
| **P2** | Fail-closed storage: S1–S10, exit codes, `/health`, `accountsValid`, replay comparison | TE-41…TE-50, TE-69…TE-85 pass on two machines | P1 (shared constants), deployment access (U-1) |
| **P3** | Checkpoint derivation script, manifest, continuity gate, publication channels | TE-86, TE-87 pass; two independent derivations agree (A-4) | P2 (a node that can verify), Q-8, Q-21 |
| **P4** | Paged sync with caps; SSRF filter; peer authentication decision | TE-70, TE-71, TE-89, TE-92, TE-58 pass | P2, Q-4 |
| **P5** | `BNKR-TESTNET-V1` chain; full matrix; rolling upgrade exercise | A-6; every unblocked test passes on two machines | P1–P4 |
| **P6** | Second implementation at parity; second operator syncing from their own data copy | A-1, A-3, MVIN-1…MVIN-12 | P1, P5; real people |
| **P7** | Production activation: set `H` and the checkpoint set, ship, monitor | Q-1, Q-2, Q-19, Q-23 answered; A-1…A-10 met | P3, P6 |
| **P8** | Post-activation: monitoring, rollback readiness, incident drills | A-7 exercised at least once on testnet | P7 |

### 20.2 Dependency graph

```text
P0 (evidence)
 └─> P1 (serializer + second implementation)
      ├─> P2 (fail-closed storage)
      │    ├─> P3 (checkpoints + manifest)
      │    └─> P4 (sync hardening)
      │         └─> P5 (testnet + full matrix)
      │              ├─> P6 (second implementation + second operator)
      │              └─> P7 (activation)  <- requires Q-1, Q-2, Q-19, Q-23
      └───────────────────────────────────┘
```

### 20.3 What cannot be parallelized

| Pair | Why not |
|---|---|
| P1 and P2 | Storage validation must call the same serializer the vectors describe; building storage against the old `headerOf` hard-codes a second implementation |
| P3 and P5 | A testnet checkpoint derived from a chain whose storage can still fail open is not evidence |
| P6 and P7 | Activating before a second implementation exists compiles a single implementation into consensus |
| Q-1/Q-2 and everything else | Historical sequencing concern. The owner decisions now exist in §21.9, but publication and independent derivation are still required before they become network evidence |

### 20.4 Definition of done, per phase

A phase is done when its exit gate is **evidenced** by an artifact that another person can inspect: a test report with machine-readable results, a derivation output with hashes, a build id, or a signed decision record. A PR description is not evidence. A green CI badge on a private runner is not evidence. "It works locally" is not evidence.

### 20.5 What this roadmap is not

- It is not a schedule. No phase carries a duration or a date.
- It is not an estimate. Estimating a phase whose blocking question is unanswered is arithmetic about a shape nobody has chosen.
- It is not approval. Nothing here authorises implementation, deployment, or activation.
- It is not a claim that P7 will happen. Q-1 and Q-2 are answered in §21.9, but P7 still requires independent verification, publication, governance, and deployment gates.

---

## 21. Owner decision register

### 21.1 The register

This register was written as a design-only record. The status column below is the current implementation status as of 2026-11-19. Q-1, Q-2, Q-15, and the coinbase-maturity parameter were selected by the owner and are compiled in `shared/protocol.js`. Q-1 was originally `2026` and was postponed to `5000` on 2026-11-19; Q-2 was extended from height `731` with a live-derived Checkpoint 2 at height `2500`. §21.2, §21.3, and §21.9 are the current decision record. Earlier sections that describe them as unresolved are retained as the historical review record and are superseded by those sections.

| ID | Question | Owner | Status | Evidence required | Blocking |
|---|---|---|---|---|---|
| **Q-1** | What is `PROTOCOL_V2_HEIGHT`? | Owner | **RESOLVED — 5000** (owner selected 2026 on 2026-11-18; compiled schedule postponed 2026-11-19; §21.2, §21.9) | Owner decision compiled as `V2_ACTIVATION_HEIGHT`; env override for isolated testnets | no code blocker; publication and cancellation authority remain |
| **Q-2** | Which heights become `CP-PRE`, `CP-ACT`, `CP-TIP-AT-RELEASE`? | Owner | **RESOLVED — Mainnet Checkpoints at heights 731 and 2500** (731 selected 2026-11-18; 2500 appended 2026-11-19; §21.3, §21.9) | Canonical derivation + full ancestry verified for both; independent second derivation/publication still open | no local-code blocker; P3 attestation/publication remains |
| **Q-3** | Merkle root in a future era? | Owner | Open | Cost/benefit of a transaction commitment | no (V2) |
| **Q-4** | Is peer authentication mandatory for write endpoints? | Owner | Open | Threat model §14.10, TE-58 | P4 |
| **Q-5** | Transaction-level version field? | Owner | Open | Wallet compatibility, Q-24 | no (V2) |
| **Q-6** | Public testnet and its `networkId`? | Owner | Open | `BNKR-TESTNET-V1` compilation and distribution | P5 |
| **Q-7** | Who operates the second node? | Owner | **Unresolved, blocking** | A named person or organization with their own data copy | P6, P7 |
| **Q-8** | Checkpoint publication channel(s)? | Owner | Open | At least two channels, one out-of-band | P3 |
| **Q-9** | `MAX_REORG_DEPTH` policy? | Owner | Open | Cadence measurement (§15.5), Q-19 | P3 |
| **Q-10** | Do `/api/peer/*` endpoints remain public? | Owner | Open | Rate-limit and auth design | P4 |
| **Q-11** | Rollback policy at `H`? | Owner | Open | §12.7; who calls it, how verified | P7 |
| **Q-12** | "New network" or "separated continuation"? | Owner | Open | Shared genesis, frozen Era 1 | messaging, not code |
| **Q-13** | Checkpoint cadence | Owner | Folded into Q-19 | — | P3 |
| **Q-14** | Release monotonicity and who may publish | Owner | **Rule corrected; signer set open** | §9.3, Q-20 | P3 |
| **Q-15** | Height-only halving or ~4-year target? | Owner | **RESOLVED — height-only** (2026-11-18; §21.9) | `HALVING_INTERVAL=210000`, `changesAtV2:false`, terminal subsidy 0, cap 21,000,000 BNKR | no (monetary policy recorded) |
| **MATURITY** | Coinbase maturity parameter (non-Q owner decision) | Owner | **RESOLVED — 53 blocks** (2026-11-18; §21.9) | Compiled default; Era 1 history not re-judged; env override for isolated testnets | no |
| **Q-16** | Is N-of-M checkpoint attestation required? | Owner | Open | §9.7 | P3 |
| **Q-17** | Who owns the third-party serializer, and by when? | Owner | **Unresolved** | §18.2, Q-22 | P1, P6 |
| **Q-18** | Add a state/account commitment? | Owner | Open; recommend **no** for V2 | §7.6 | future era only |
| **Q-19** | Checkpoint cadence tied to `MAX_REORG_DEPTH` | Owner | Open | §15.5 cadence table, §14.5 | P3, P7 |
| **Q-20** | Release signing and reproducible-build trust root | Owner | Open | §9.4, MVIN-1/2 | P1, P7 |
| **Q-21** | Which attestation scheme (3-of-5 proposed)? | Owner | Open | §9.7 | P3 |
| **Q-22** | Third-party serializer owner and due date | Owner | **Unresolved** | Q-17 duplicate; one decision closes both | P1 |
| **Q-23** | Who may cancel or delay activation, and how? | Owner | Open | §13.2 cancellation procedure | P7 |
| **Q-24** | V2 transaction canonicality strictness | Owner | Open; recommend **strict** | §4.5, §15.10, TE-13 | P1, wallet update |

### 21.2 Q-1 — activation height

**RESOLVED (owner decision 2026-11-18; compiled schedule corrected 2026-11-19).** The owner originally selected `H = 2026`, honouring the founding year of Banneker Coin in Baltimore. The live mainnet continued in Era 1 past that height, so the compiled default was postponed to `V2_ACTIVATION_HEIGHT = 5000` in `shared/protocol.js` and is re-exported by `server/ledger.js`. This current default matches the production activation schedule without requiring `BANNEKER_V2_ACTIVATION_HEIGHT`. Isolated testnets may still override it with that variable; the Phase 4 rehearsal used `2`.

Genesis and every height below 5000 remain Era 1. `targetBlockSecondsForHeight(height, activation)` keeps the frozen 15-second retarget target for Era 1 and selects the 60-second V2 target at `H`, so historical blocks replay exactly. At the 2026-11-19 live check the tip was height `2858`, entirely Era 1; no mainnet V2 block had been activated. The earlier statement that the tip was "far below 2026" is historical and no longer applies.

The original evidence pack in §13.2 remains the historical record of why this question was initially left open. The remaining operational work is publication through the Q-8 channels, a named cancellation authority (Q-23), and independent operation (Q-6/Q-7). Those are governance and deployment gaps, not a reason to leave the compiled value unselected.

### 21.3 Q-2 — checkpoint heights and hashes

**RESOLVED (731 selected 2026-11-18; 2500 appended 2026-11-19).** The owner selected Mainnet Checkpoint 1 at height `731`, honouring Banneker's birth year. Checkpoint 2 at height `2500` was derived from the live mainnet history under the corrected activation schedule and appended alongside it. The compiled tuples are:

| Field | Checkpoint 1 | Checkpoint 2 |
|---|---|---|
| `height` | `731` | `2500` |
| `protocolVersion` | `1` | `1` |
| `blockHash` | `000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8` | `000004f48c5efffd42058140ba6532eeff322a33871a030ce4aefb54bdc38dd7` |
| `chainWork` | `212511536` | `2482285360` |
| `genesisHash` | `49f9e88619178347aaf806ba33c00ab973d1d62e45db982a851e86728880ebaa` | `49f9e88619178347aaf806ba33c00ab973d1d62e45db982a851e86728880ebaa` |
| `networkId` | `BNKR-MAINNET-V1` | `BNKR-MAINNET-V1` |

The canonical digests of the complete two-checkpoint set are:

| Field | Value |
|---|---|
| manifest digest | `c383829f4a89d915643711f3f1eaadb26afbb4bedf8d62e95205d8be0c362f8f` |
| checkpoint-set digest | `85eb51755c230b5255fcaf1f169bba208dd89cd20b3722d62e1759490f22a346` |

`scripts/derive-mainnet-checkpoint.mjs` copies `bannekercoin.db` byte-for-byte to temporary storage, recomputes the canonical Era 1 hash from the block history (TE-63), verifies the full ancestry to genesis, and compares the derived tuple against Checkpoint 1. The live database is never opened in place. The result at the verified local tip (858) is an exact match. That script does **not** derive Checkpoint 2 because the local database tip is below height 2500.

Checkpoint 2 was derived from the live mainnet through the paged `/api/peer/blocks` endpoint for heights `0` through `2500`. Full ancestry was verified under the `5000` activation schedule; the recomputed top hash and cumulative chain work matched the stored block exactly. The stored `hash` column was not used as a trust input. No mainnet database file was modified during either derivation.

An anchor is enforced by default only while its height is an Era 1 fact, that is, when the activation height is greater than that anchor's height. With the compiled activation `5000`, both anchors apply. A testnet schedule with activation at or below `2500` excludes Checkpoint 2; one at or below `731` excludes both, so an Era 1 anchor is never applied to a V2 block.

The original two-independent-derivations requirement is not satisfied by a single operator and is recorded as an outstanding P3 attestation/publication gap in §21.9 and §22.8. It does not change the owner selection or the compiled values; it limits the claim that can be made about independent verification. `CP-ACT` and `CP-TIP-AT-RELEASE` remain unselected.

### 21.4 Q-19 — cadence and `MAX_REORG_DEPTH`

The trap: `MAX_REORG_DEPTH = 100` looks like a security parameter and is actually a duration expressed in blocks. §15.5 measured the durations:

| Cadence basis | 100 blocks |
|---|---|
| `p90` gap 69.2 s | 1.9 h |
| Non-idle mean 24.6 s | 41 min |
| Median gap 8.05 s | 13.4 min |
| Target 15 s | 25 min |
| Contaminated all-gap mean 1,700 s | 47.2 h |

You cannot choose the depth without choosing the duration, and you cannot choose the duration without deciding what a reorg is meant to cost an attacker. At the measured work level (§15.8), a 100-block rewrite at difficulty 4 is 6,553,600 expected hashes — seconds to a minute on one modern CPU. So the depth is not a security bound at all; it is a liveness bound. The security bound is the checkpoint, and the checkpoint cadence must therefore be chosen with Q-2, not with Q-9.

**Recommendation (not selected):** define the cadence in wall-clock terms relative to a published `T_obs`, derive the block depth from it, and stop treating 100 as meaningful. State explicitly that reorg cost is bounded by checkpoints, not by depth.

### 21.5 Q-20 — release trust root

A reproducible build is only useful if the recipe and the toolchain are pinned and if two people can run it. The trust root is therefore not the build; it is the set of people who sign manifests and the process by which a signer is added or removed. No such process exists.

**Recommendation (not selected):** at least two signers, a documented key rotation, a signed `prevManifestDigest` chain, and a build that fails if the checkpoint set is not a monotone extension.

### 21.6 Q-23 — cancellation authority

Before `H`, a delay is a signed notice plus a replacement binary with a later `H`. After `H`, a delay is a rollback and is a fork. The procedure must name:

- who may issue it;
- how the notice is authenticated and how an operator verifies it;
- how a malicious or coerced notice is rejected;
- what an operator does who has already upgraded;
- what happens to blocks mined between the original `H` and the delay notice.

None of these has an answer, and the absence is itself an availability risk: if the single owner is unavailable at activation time, no one can call a delay.

### 21.7 Q-24 — transaction canonicality

V2 requires canonical decimals inside blocks: `"1.5"`, never `"1.50"`, `"1e-8"`, or the JSON number `1.5` (§4.5). The question is whether the **API** should reject non-canonical input or normalize it.

| Option | Effect | Risk |
|---|---|---|
| **Strict** (recommended) | API rejects `"1.50"` with `NON_CANONICAL_DECIMAL` | wallets that send `"1.50"` break at the boundary; fix is one client change |
| Normalize | API accepts and rewrites to canonical | the rewrite is a signature-relevant transformation; a client that signs the original and sends the normalized form will fail verification in a way that looks like a wallet bug |
| Accept both in block | forbidden by the closed 7-field projection | reintroduces serializer ambiguity, which is the whole point of V2 |

**Recommendation (not selected):** strict at the API, with an explicit error code and a migration note. Silent normalization moves the failure from the client that caused it to the validator that received it.

### 21.8 What the register means

Twenty-four decisions are recorded. Four owner selections are now compiled and current: Q-1, Q-2, Q-15, and the coinbase-maturity parameter. The others retain the status shown in §21.1. The original design-only rule — that a reviewer must not invent an owner decision — is preserved; the selections come from the owner's 2026-11-18 instruction and the 2026-11-19 live-chain correction recorded in §21.2 and §21.3, not from an inference in this document.

Remaining activation gaps include Q-6 (public testnet identity), Q-7 (second operator), Q-17/Q-22 (third-party serializer), Q-19 (reorg/cadence policy), Q-23 (cancellation authority), Q-20/Q-21 (release and attestation), and the independent second derivation of both checkpoints. Q-1 and Q-2 no longer block a compiling local implementation, but publication and independent operation still block a public activation claim.

### 21.9 Phase 4 owner-selected parameters and live verification

The following values are the current compiled configuration. They are consensus constants: changing one requires a new binary and, for an activated network, an explicit scheduled upgrade. Empty environment values fall back to these compiled defaults rather than silently disabling consensus.

| Parameter | Selected value | Rationale | Compiled location | Status |
|---|---|---|---|---|
| `V2_ACTIVATION_HEIGHT` (Q-1) | `5000`; override `BANNEKER_V2_ACTIVATION_HEIGHT` for isolated testnets | Original founding-year height `2026` was postponed on 2026-11-19 because the live chain remained Era 1 past it; `5000` matches the production schedule | `shared/protocol.js`, exported by `server/ledger.js` | **RESOLVED** |
| Mainnet Checkpoint 1 (Q-2) | height `731`, hash `000053a9…ed2f8`, chain work `212511536` | Banneker's birth year; derived from canonical Era 1 history | `shared/protocol.js`, `server/ledger.js`, `scripts/derive-mainnet-checkpoint.mjs` | **RESOLVED** |
| Mainnet Checkpoint 2 (Q-2) | height `2500`, hash `000004f4…3dd7`, chain work `2482285360` | Derived from the live mainnet paged block history under activation `5000`; full ancestry verified | `shared/protocol.js`, `server/ledger.js` | **RESOLVED** |
| `TARGET_BLOCK_TIME_SECONDS` | `60` for V2; Era 1 remains `15` | One-minute blocks honour Banneker's 1753 striking clock; frozen Era 1 replay | `shared/protocol.js`; era-aware `expectedDifficulty` in `server/ledger.js` | **RESOLVED** |
| `COINBASE_MATURITY` | `53` blocks; override `BANNEKER_COINBASE_MATURITY` for isolated testnets | Honours 1753, the year Banneker carved America's first wooden striking clock | `shared/protocol.js`, `server/ledger.js` | **RESOLVED** |
| Halving and emission (Q-15) | `HALVING_INTERVAL=210000`, height-only, `changesAtV2:false`, terminal subsidy `0`, cap `21,000,000 BNKR` | Preserves Era 1 compatibility and a strictly capped supply; no wall-clock halving | `shared/protocol.js`, `rewardForHeight` in `server/ledger.js` | **RESOLVED** |
| Startup recovery | binary search over the rollback point | Chain validity is prefix-closed; O(log n) validation passes replace the old O(n²) replay loop that froze the event loop on multi-thousand-block chains | `server/ledger.js` | **RESOLVED** |

The live two-node rehearsal was performed with `scripts/phase4-testnet.mjs`. It is an isolated local rehearsal, not a public testnet; Q-6 remains open and the nodes reused `BNKR-MAINNET-V1`. Two server processes used temporary databases and ports 4184/4185 with `BANNEKER_V2_ACTIVATION_HEIGHT=2`, `BANNEKER_COINBASE_MATURITY=5`, and `BANNEKER_ALLOW_PRIVATE_PEERS=1`. The temporary databases and processes were removed at the end; no mainnet database was opened for write.

| Check | Result |
|---|---|
| Era boundary | height 1 mined as V1; heights 2 and 3 mined as V2 |
| Immature coinbase spend | rejected at tip 3 / next height 4 with HTTP 400 and `"Transaction spends immature coinbase funds or more than the confirmed balance."` |
| Past-maturity spend | signed Ed25519 V2 T7 transaction for `1` BNKR accepted with HTTP 202 at tip 7 and mined at height 8 |
| Paged peer sync | node 2 fetched and replaced node 1's chain over `/api/peer/blocks`; one page, approximately 4.2 kB per run |
| Identical tips | height `8`, chainWork `128`, and the same tip hash on both nodes (the hash itself varies because the rehearsal uses fresh keys and timestamps each run) |
| Validation | both nodes reported `valid:true`, `accountsValid:true`, `healthy:true`; recipient balance `100000000` units on both |
| Automated verification | `node --test`: 76/76 passing; `npm.cmd run build`: passed |
| Read-only derivation (Checkpoint 1) | `scripts/derive-mainnet-checkpoint.mjs`: `ancestryVerified:true`, `matchesCompiledAnchor:true` |
| Live derivation (Checkpoint 2) | paged `/api/peer/blocks` heights `0..2500`: full ancestry verified; derived hash and chain work matched the stored block |
| Mainnet database integrity | `bannekercoin.db`, `blackcoin.db`, and `node-b.db` SHA-256 hashes unchanged |

---

## 22. Acceptance criteria

### 22.1 Is this correction complete?

These criteria are about the document in front of you, not about the software.

| ID | Criterion | Status |
|---|---|---|
| **AC-D1** | All five review blockers have a stated resolution with a section reference | **Met** — §4/§5, §3/§6, §8, §9, §11 |
| **AC-D2** | All 5 blockers (R-01…R-05) and all 29 corrections (C-01…C-29) are dispositioned | **Met** — §2.1, §2.2, §2.3 |
| **AC-D3** | TE-18 and TE-62 are corrected | **Met** — §16.1, §16.3, §16.10 |
| **AC-D4** | All 26 missing tests are specified | **Met** — §16.11 index; detail in §16.1.1–§16.12 |
| **AC-D5** | All 17 threat mappings are replaced with semantic mappings | **Met** — §17.2 |
| **AC-D6** | Monetary policy is specified with adversarial tests | **Met** — §15.1–§15.12, MT-01…MT-15 |
| **AC-D7** | The serialization is complete enough to implement without reading the original code | **Met** — §4, §5 |
| **AC-D8** | No test is claimed to have passed | **Superseded** — this was a design-only criterion; §21.9 records the later local test run (76/76 passing) |
| **AC-D9** | No activation height, checkpoint height, or checkpoint hash is selected | **Superseded** — owner later selected Q-1 and Q-2 in §21.9; the historical record is retained |
| **AC-D10** | No claim of decentralization or implementation | **Current for decentralization; superseded for implementation** — a local Phase 4 implementation and rehearsal exist; no mainnet deployment or independent operation is claimed |

This document was originally complete **as a specification of what must be built**. §21.9 now records the later local implementation and verification evidence; it still makes no claim of public deployment or independent operation.

### 22.2 Is V2 implementable?

An implementation may begin when:

| ID | Criterion |
|---|---|
| **AC-I1** | The shared serializer module exists and is the only serializer in the tree (TE-88) |
| **AC-I2** | V-01…V-12 reproduce byte-for-byte on two machines |
| **AC-I3** | At least one non-JavaScript runner reproduces V-01…V-12 (TE-40) |
| **AC-I4** | Every negative vector returns the specified error **code** in both implementations |
| **AC-I5** | A V1 block and a V2 block with identical economic content produce different digests through the correct era paths (HP-5/HP-6) |
| **AC-I6** | Genesis remains `49f9e886…ebaa` and total work remains `249342768` |

AC-I3 is the one that converts "specified" into "implementable". Without it, the specification is a description of one codebase.

### 22.3 Is it testnet-ready?

| ID | Criterion |
|---|---|
| **AC-T1** | `BNKR-TESTNET-V1` exists as a compiled constant, not an env value |
| **AC-T2** | P2 fail-closed storage is deployed and TE-41…TE-50, TE-69…TE-85 pass |
| **AC-T3** | The full matrix has run on two machines; results are published with `buildId` and database hashes |
| **AC-T4** | A rolling upgrade has been exercised from a pre-V2 build to a V2 build on testnet |
| **AC-T5** | TE-62b has been run once and its truncation documented, so the behaviour is known rather than assumed |
| **AC-T6** | TE-40 passes in a second language |

**Verdict: not testnet-ready.** AC-T1…AC-T6 are all unmet. There is no testnet network id, no fail-closed storage deployed (B0 lacks `accountsValid` entirely), no published two-machine matrix, no rolling-upgrade exercise, and no second implementation.

### 22.4 Is it activation-ready?

| ID | Criterion |
|---|---|
| **AC-A1** | AC-I and AC-T are met |
| **AC-A2** | Q-1 answered: `H` selected (§21.9) **and** published with the §13.2 evidence pack |
| **AC-A3** | Q-2 answered: checkpoint selected and derived once locally (§21.9); two independent derivations and publication still required |
| **AC-A4** | Q-19 answered: checkpoint cadence and reorg depth chosen together and stated in wall-clock terms |
| **AC-A5** | Q-23 answered: a named authority can delay activation, and operators can verify the notice |
| **AC-A6** | Wallet and miner builds using the shared serializer are distributed **before** `H` (A-8) |
| **AC-A7** | A preflight tool that scans a database copy for future-version rows is published (TE-62a support) |
| **AC-A8** | V1 binaries are withdrawn from distribution and marked do-not-run (TE-62b) |

**Verdict: not activation-ready.** A1 and A6–A8 remain unmet, and A2–A3 are only partly met: the values are selected and compiled, but not published or independently attested. The local browser worker now builds era-aware blocks, as exercised by the Phase 4 rehearsal, but client builds still have to be distributed before `H`.

### 22.5 Is the network independently operated?

| ID | Criterion |
|---|---|
| **AC-N1** | At least two independent operators, each with their own data copy, agree on the tip (A-1) |
| **AC-N2** | At least one operator is not the author |
| **AC-N3** | Checkpoint attestation involves at least two parties (Q-21) |
| **AC-N4** | Release signing involves at least two parties (Q-20) |
| **AC-N5** | MVIN-1…MVIN-12 are satisfied by a node the author does not control |
| **AC-N6** | A miner other than the operator has produced a block in the last 1,000 (A-2) |

**Verdict: not independently operated.** One implementation, one operator, one host, zero peers, zero attesters, and five miner keys that are almost certainly one party. No criterion above is met, and none can be met by changing this repository alone.

### 22.6 Blocker closure

| Blocker | Original defect | Resolution | Evidence in this document |
|---|---|---|---|
| **C-01** | Serialization not fully specified | Closed 11-field ASCII header, closed 7-field transaction projection, byte-exact algorithm, 12 positive and 25 negative vectors, no-escaping theorem | §3, §4, §5 |
| **C-02** | Block schema underspecified | Four-layer validation (L1 parser → L2 block → L3 chain → L4 storage), per-field type/range/canonical-form table | §6 |
| **C-03** | Checkpoint authenticity unproven | Recompute from canonical JSON; walk ancestry to genesis; stored `hash` never a trust input; TE-63 | §8, §16.11 |
| **C-04** | Checkpoint continuity undefined | K-1…K-12, derivation-not-decree, publication-before-use, manifest digest chaining, conflict fatal | §9 |
| **C-05** | Production baseline wrong | Five separate baselines B0–B4 with distinct evidence; B0 lacks `accountsValid` | §11 |

All five are closed **as specification defects**. A local V2 implementation and rehearsal now exist (§21.9), but they are not a public deployment and do not satisfy the independent-implementation criteria in §22.2.

### 22.7 Attestation block

Deliberately unsigned. This is the form a future release would sign; filling it in and signing it is the act that turns a specification into a commitment. Nothing below has been signed, and no signature is implied.

```text
DOCUMENT        BNKR_PROTOCOL_V2_CORRECTION_SPECIFICATION
STATUS          PHASE 4 PARAMETERS COMPILED - LOCAL V2 REHEARSAL PASSED - MAINNET NOT ACTIVATED
NETWORK         BNKR (mainnet) / BNKR-TESTNET-V1 (not yet created)
GENESIS         49f9e88619178347aaf806ba33c00ab973d1d62e45db982a851e86728880ebaa
ERA 1 TIP       (not asserted in this document)
V2 HEIGHT       5000 (compiled; env override for isolated testnets) [Q-1 RESOLVED]
CHECKPOINTS     CP1 h731 000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8
                CP2 h2500 000004f48c5efffd42058140ba6532eeff322a33871a030ce4aefb54bdc38dd7 [Q-2 RESOLVED]
TARGET/MATURE   60s V2 / 15s Era 1 / maturity 53 blocks
EMISSION (Q-15) HEIGHT-ONLY; HALVING 210000; CAP 21000000 BNKR [RESOLVED]
REORG DEPTH     UNCHANGED (100); policy open         [Q-19]
ATTESTERS       NONE                                [Q-21]
SIGNERS         NONE                                [Q-20]
TEST RESULTS    node --test 76/76 PASS; npm run build PASS; local two-node V2 rehearsal PASS; checkpoint derivations MATCH
STARTUP         binary-search recovery; O(log n) validation passes
READ-ONLY INPUT bannekercoin.db  50D66081EE77C766C47932C769DCCB0E290270E6028DB4E05277EBF7B4105EBB
READ-ONLY INPUT blackcoin.db     EE60CC1F137C082A82BF53D3550B55ABA50770A5E56BF753333CFD4BB49C0817
READ-ONLY INPUT node-b.db        B830729708282DBDFF009308B1C0ED82FAF31A4CBD8E9974AD975F8F74B9BED9
SOURCE BASELINE  908c642b110945264665a437fc691f59a3a94208
SIGNATURE       NONE
```

### 22.8 Remaining blockers

Ordered by what unblocks the most.

| # | Blocker | Type | Unblocked by |
|---|---|---|---|
| 1 | No second operator with an independent data copy | organization | Q-7 |
| 2 | Checkpoint derivation has one operator; no second independent derivation | evidence/governance | P3, Q-8, Q-16/Q-21 |
| 3 | No public testnet identity or operator | artifact/organization | Q-6, Q-7 |
| 4 | No non-JavaScript serializer implementation | artifact | Q-17/Q-22, TE-40 |
| 5 | Mainnet V2 not deployed or announced | deployment/governance | P7, Q-11, Q-19, Q-23, A-1…A-10 |
| 6 | B0 lacks `accountsValid`; balances not verifiable | deployment | P2 + new deploy |
| 7 | SSRF on peer URLs; unbounded peer body | code, live | P4, TE-70/TE-71 |
| 8 | Rolling upgrade and client distribution untested on a public testnet | deployment | P4–P6 + client release |
| 9 | U-1/U-2 deployment facts unverified | evidence | production access |
| 10 | Single-signer releases; no attestation | governance | Q-20, Q-21 |
| 11 | Reorg depth and checkpoint cadence policy open | governance | Q-9, Q-19 |
| 12 | Activation cancellation authority unnamed | governance | Q-23 |

### 22.9 Final verdict

**The specification is implementable and the Phase 4 parameters are compiled. A local two-node V2 rehearsal passed. The network is still not publicly testnet-ready, not activation-ready, and not independently operated.**

Stated precisely:

1. **Five blockers closed as design defects.** Serialization, block schema, checkpoint authenticity, checkpoint continuity, and the production baseline are now specified completely enough that an implementation could be written and tested against them without reading the original code or this conversation.
2. **The corrections are corrections, not a rewrite.** Genesis, Era 1 history, total work, the reward function, and every stored hash are unchanged by design. V2 remains an additive header field plus a compiled identity anchor.
3. **Owner-selected parameters now exist.** Q-1 (`5000`), Q-2 (heights 731 and 2500), Q-15 (height-only halving), and coinbase maturity (`53`) are RESOLVED in §21.9 and compiled in `shared/protocol.js`. The original `2026` height was postponed to match the live Era 1 chain. No V2 block was activated on mainnet; the live tip was `2858` at the 2026-11-19 verification.
4. **A local implementation and rehearsal exist, not a public network.** The temporary two-node lifecycle proved the era boundary, immature-spend rejection, signed V2 transaction admission and mining, paged sync, and matching validation. Q-6 (public `networkId`) and Q-7 (second operator) remain open.
5. **The full matrix is not satisfied.** The original 93 `TE` identifiers and 15 `MT` cases were a specification, not evidence. Phase 4 adds 76 passing automated tests and a passing local rehearsal, but the public two-machine matrix, second implementation, and independent checkpoint derivation are still absent. A green local matrix is not a decentralization claim.
6. **The network is one operator.** One implementation, one host, one data source, zero public peers, and no independent attestation. V2 makes such a network *identifiable*. It does not make it *independent*.

The next action is still not another local parameter change. It is a second party running a node and the artifacts in §18.2 that would let them.

---

## Appendix A — Verified measurements

Every number below was measured read-only against a copy of the named database during this review. None is an estimate unless labelled.

| Measurement | Value | Source |
|---|---|---|
| BNKR blocks | 859 (genesis + 858) | `bannekercoin.db` |
| BNKR tip | 858 | `bannekercoin.db` |
| BLKC blocks | 297 | `blackcoin.db` |
| node-B blocks | 377 | `node-b.db` |
| Genesis hash | `49f9e886…ebaa`, identical in all three | recomputed |
| BNKR total work | `249,342,768` | `19·16 + 10·16² + 10·16³ + 620·16⁴ + 199·16⁵` |
| BLKC total work | `141,732,656` | audit |
| Difficulty histogram (BNKR) | d1 19 (h1–19), d2 10 (h20–29), d3 10 (h30–39), d4 620 (h40–849), d5 199 (h110–858) | SQL over `blocks.json` |
| Blocks with difficulty < 4 at height ≥ 136 | **0** | SQL |
| Inter-block gaps measured | 858 | timestamps |
| Median gap | 8.0 s | sorted gaps |
| `p75` / `p90` / `p95` / `p99` | 17.4 / 69.2 / 109.3 / 305.0 s | sorted gaps |
| Arithmetic mean gap | 1,700.0 s | includes a 16.06-day genesis→block-1 gap |
| Gaps > 1 h | 3 (heights 1, 317, 377) | 98.56 % of total span |
| Mean excluding gaps > 1 h | 24.6 s | non-idle cadence |
| Active mining time | 21,037 s ≈ 5.84 h | span minus long gaps |
| Transactions | 7 (one each in 7 blocks) | `blocks.json` |
| Distinct miner keys | 5 | SQL |
| Accounts | 6, sum `4,290,000,000,000` units = `42,900.00000000` BNKR | `accounts` |
| Sum of block rewards | `42,900.00700000` BNKR | `50 × 851 + 50.001 × 7` |
| Reward difference | exactly 0.007 BNKR = 7 × 0.001 fee | theorem §15.2 |
| Terminal nominal supply | `2,099,999,997,690,000` units | closed form |
| Shortfall vs `MAX_SUPPLY` | `2,310,000` units = 0.0231 BNKR | closed form |
| First zero-subsidy height | 6,930,001 | `halvings = 33` |
| 100-block rewrite at difficulty 4 | 6,553,600 expected hashes | 100 × 16⁴ |
| `expectedDifficulty` throws over tips 0…400 | 0 | exhaustive evaluation |
| `expectedDifficulty(chain(0..135), 136)` | `1` (floor not enforced) | direct evaluation |
| `networkState` genesis branch | returns literal `4`; function returns `1` | inspection + evaluation |

## Appendix B — Source locations cited

Working tree (B2) unless stated. `server/ledger.js` is 1,163 lines in B2 and 875 in HEAD (B1).

| Symbol | Location | Note |
|---|---|---|
| `COIN`, `MAX_SUPPLY`, `INITIAL_REWARD`, `HALVING_INTERVAL` | `ledger.js:5-8` | unchanged by V2 |
| `TARGET_BLOCK_SECONDS`, `ADJUSTMENT_INTERVAL`, `MAX_DIFFICULTY` | `ledger.js:9-11` | |
| `MIN_TRANSACTION_UNITS`, `MIN_FEE_UNITS` | `ledger.js:13-14` | |
| `MAX_REORG_DEPTH` | `ledger.js:17` | enforced `:962-964` |
| `MEDIAN_TIME_WINDOW` | `ledger.js:18` | 11 |
| `GENESIS_TIMESTAMP` | `ledger.js:22` | `Date.UTC(2026,10,1)` |
| `headerOf` | `ledger.js:36-48` | 9-field V1 projection |
| `workForDifficulty` | `ledger.js:147-152` | `16^d` |
| `rewardForHeight` | `ledger.js:247-251` | subsidy + clamp |
| `expectedDifficulty` | `ledger.js:253-268` | implicit window contract |
| `medianTimePast` | `ledger.js:340-344` | |
| `validateBlock` | `ledger.js:346-377` | MTP `:351`, reward `:364-370` |
| `validateChainInternal` | `ledger.js:379-425` | replay |
| `validateChain` | `ledger.js:427-430` | strips balances |
| `repair` / truncation | `ledger.js:569-616` | TE-62b mechanism |
| `applyBlock` | `ledger.js:671-741` | credit `:715-725` |
| `acceptBlockLocked` | `ledger.js:920-938` | |
| `replaceChainLocked` | `ledger.js:944-1029` | depth cap `:962-964` |
| `networkState` | `ledger.js:1113-1139` | genesis branch, `slice(-10)` |
| `getSupply` | `ledger.js:654-660` | `SUM(balance_units)` |
| `sumBalances` / `accountsValid` | `ledger.js:547-566`, `:524` | **B2 only**, absent in B1/B0 |
| `express.json` | `index.js:162` | 64 KiB body cap, `JSON.parse` semantics |
| `cleanPeerUrl` | `index.js:168-189` | no address-class filter |
| peer chain fetch | `index.js:255-258` | unbounded `response.json()` |
| `origin-peer` | `index.js:134`, `:375`, `:382` | self-asserted |
| browser worker header | `src/miner.worker.js:17-28` | 9-field V1, no shared serializer |

## Appendix C — Document set and read-only attestation

| Document | Role | Modified by this work? |
|---|---|---|
| `BNKR_NETWORK_IDENTITY_PROTOCOL_AUDIT_2026-11-17.md` | Phase A evidence | **No** |
| `BNKR_NETWORK_IDENTITY_PROTOCOL_V2_SPECIFICATION.md` | Phase B proposal, reviewed | **No** |
| `BNKR_PROTOCOL_V2_INDEPENDENT_REVIEW.md` | Phase C review | **No** |
| `BNKR_PROTOCOL_V2_CORRECTION_SPECIFICATION.md` | **This correction** | created |

Database inputs, hashed before and after this work:

| File | SHA-256 | Bytes |
|---|---|---|
| `bannekercoin.db` | `50D66081EE77C766C47932C769DCCB0E290270E6028DB4E05277EBF7B4105EBB` | 626,688 |
| `blackcoin.db` | `EE60CC1F137C082A82BF53D3550B55ABA50770A5E56BF753333CFD4BB49C0817` | 258,048 |
| `node-b.db` | `B830729708282DBDFF009308B1C0ED82FAF31A4CBD8E9974AD975F8F74B9BED9` | 307,200 |

All three hashes are unchanged. Every database measurement in this document was taken from a copy in the temporary directory, never from the files above.

## Appendix D — What this document did not do

- It did not edit the original specification or the independent review.
- It did not modify source, tests, or configuration.
- It did not stage, commit, push, or change branch.
- It did not start, stop, or restart any process.
- It did not submit a transaction or a block.
- It did not sync from or to a peer.
- It did not change a database, a genesis value, a `networkId`, a checkpoint, or an activation height.
- It did not implement V2.
- The design-only review did not select Q-1 or Q-2; §21.9 records the later owner selections and their compiled implementation.
- It did not claim that any test passed.
- It did not claim that BNKR is decentralized.

**End of document.**
