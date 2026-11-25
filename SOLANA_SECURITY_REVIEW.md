# Stoxhome engine: Solana money layer security review (adversarial, POC-backed)

**Scope:** `engine/src/solana.js` (`SolanaAdapter`, `parseCompanyTransfer`, `tokenDeltas`, `SolRpc`, `verifySolSignature`), `engine/src/auth.js` (the `solana` scheme), and the chain-agnostic withdrawal state machine in `engine/src/engine.js`. Everything was checked against `docs/ENGINE_API.md`, section "v2: Solana".

**Snapshot:** the code was read and re-read between 10:38 and 10:47 UTC on 2026-11-25. The porting agent was still editing it, so line numbers may drift.

**Status at 10:47 UTC:**
- **Fixed by the porting agent during the review (re-tested):** M1, M2, L1 and L2. Their POCs are now "DEFENCE (was POC …)" tests.
- **Partly fixed:** H1. `lockWithdrawal` and `POST /admin/withdrawals/:id/lock` have been added. The remaining gaps are listed under H1 below.
- **Open:** I1, I2, and the RPC trust issue noted under M2.

**POCs:** `engine/test/solana-security.test.js`. The tests use crafted jsonParsed transactions and a mock RPC. They use no network and start no servers. A "POC:" test passes when the bad outcome happens. A "DEFENCE:" test passes when the attack is blocked.

**Test results:**
- `node --test test/solana-security.test.js`: **24 pass, 0 fail.** It was run several times with the same result, because the tests use random keys.
- `npm test`: **87 pass, 0 fail.**

## Findings, ranked by severity

### H1. High: a user can cancel after the admin has paid, so the withdrawal is paid twice
- **Where:**
  - `engine.js:828-844`: `_unlockWithdrawal` / `cancelWithdrawal` allow a cancel whenever the status is `pending`.
  - `server.js:156`: the user cancel route.
  - `solana.js:356-359`: the watcher records the payout as `unmatched`.
- **How it happens:**
  1. The admin clicks Pay and the `transferChecked` is broadcast. It takes roughly 13 s or more to reach `finalized`, and the admin calls `/paid` only after that.
  2. Inside that window the user calls `POST /withdrawals/:id/cancel`. The 100 USDC is unlocked back to `available`.
  3. The payout finalizes. The watcher finds no pending withdrawal and stores the payout as `unmatched`. The admin's `/paid` fails with `NOT_PENDING`.
  4. The user requests and receives the same 100 again. A script that watches the company ATA, or the user's own ATA, at `processed` commitment can win this race every time.
- **POC:** `POC: user cancels after the admin has paid ...`. It still passes, because cancelling without a lock is still allowed.
- **Fix in progress (partial):**
  - `engine.js:850` adds `lockWithdrawal` (sets `processing_at`).
  - `engine.js:835` makes a user cancel throw `WITHDRAW_LOCKED` once the withdrawal is locked.
  - `server.js:179` adds `POST /admin/withdrawals/:id/lock`.
  - The DEFENCE test `H1 fix, engine-level` shows that the lock works.
- **Still open:**
  - (a) The lock is advisory. The admin Pay flow must call `/lock` and wait for it to succeed *before* it asks the wallet to sign. This review did not verify the web UI.
  - (b) `rejectWithdrawal` (`byAddress` = null) still unlocks a locked withdrawal. Rejecting a withdrawal with `processing_at` set should be allowed only after the payout blockhash's `lastValidBlockHeight` has passed and the watcher has found no outgoing transfer to that user since `processing_at`.
  - (c) There is still no defence in depth for an `unmatched` outgoing transfer to a user (see below).
- **Originally proposed fix:**
  - Add a `processing` state that the admin sets before signing, for example `POST /admin/withdrawals/:id/processing`, which the admin UI calls before it opens the wallet.
  - `engine.js:833`: when `byAddress` is set (a user cancel), require `w.status === 'pending'`. Rejecting a `processing` withdrawal must be admin-only, and only after the payout blockhash has expired (`lastValidBlockHeight`) with no payout landing.
  - `engine.js:851` (`markWithdrawalPaid`): accept `status IN ('pending','processing')`.
  - `solana.js:356`: query `status IN ('pending','processing')`.
  - `solana.js` `markPaid` (line ~424, and the re-check inside the tx): accept `processing`.
  - **Defence in depth:** in `_record`, if an `unmatched` outgoing goes to a user who has a recently cancelled withdrawal of the exact amount, re-lock that amount and raise an alert in `/admin/overview`.

### M1. Medium (FIXED during the review): more than 20 pages of new signatures makes older deposits disappear for good
- **Where:** `solana.js:312-316`. The loop `for (let page = 0; page < 20; page++)` stops at 20,000 signatures without reaching `until`.
- **How it happens:**
  - The loop then processes the 20,000 newest signatures oldest-first, so `sol_until:<mint>` is set past every signature it never fetched.
  - An attacker can send about 20k transactions that only touch the company ATA, which costs about 0.1 SOL in fees. Any deposits from other users that land just before the spam are then never credited. The funds stay in the company ATA with no record.
  - The same thing happens without an attacker after a long outage.
- **POC:** `POC: more than 20 pages (20,000 sigs) ...`
- **Fix:**
  - Never move `until` past a range that was not fully fetched.
  - Either page until `batch.length < limit` with no cap, or store a backfill cursor (`sol_backfill_before:<mint>`) and process from the oldest fetched signature backward.
  - At minimum: if the loop ends because of the cap, `throw` before processing anything, and alert.

### M2. Medium (FIXED during the review): a lagging or inconsistent fallback RPC causes a paging gap, and lost deposits
- **Where:**
  - `solana.js:312-316`: `if (batch.length < 1000) break;` treats an empty `before` page as "done".
  - `SolRpc.call`: falls through to the next URL on every call, so page 1 and page 2 can come from different nodes.
- **How it happens:** a node that has not yet seen the `before` signature returns `[]`. The scan stops and the cursor skips everything older.
- **POC:** `POC: lagging fallback RPC answers [] to a before page ...`
- **Fix:**
  - Pin all pages of one scan to a single endpoint.
  - Treat "full page followed by an empty page" as an error: throw, and do not advance.
  - Confirm continuity before advancing: `getSignatures(ata, { before: oldestFetched, limit: 1 })` must return `until`, or nothing when `until` is empty.
- **Related trust issue (not exploitable without an RPC compromise):** the single RPC is fully trusted. A malicious or compromised RPC can return a fabricated `getTransaction` result and mint any amount of credit. The first DEFENCE test shows that a crafted transaction is credited as-is.
  - Cross-check deposits above a threshold against a second, independent provider (same `slot` and token balances).
  - Reconcile on every poll: `liabilities` against `getTokenAccountBalance(companyATA)` at `finalized`. Halt auto-credit when liabilities exceed on-chain balance plus a tolerance.

### L1. Low/Medium (FIXED during the review): a non-signer or off-curve owner (a PDA) is auto-credited
- **Where:** `solana.js:203-211`. The rule is "single decreasing owner", with no check that the owner can sign.
- **How it happens:**
  - A user swaps through an AMM or aggregator with the output sent to the company ATA. The only decreasing owner is the pool vault authority, a PDA.
  - The deposit is credited to that PDA. Nobody can sign in as it, and the real payer gets nothing.
  - This is not theft, but the user loses funds silently and it needs a manual fix. The same applies to any program-owned escrow.
- **POC:** `POC: non-signer PDA ...`
- **Fix:** at `solana.js:211`, set `reason = 'sender_off_curve'` when `!isOnCurve(decodePubkey(senders[0]))`, so the deposit becomes `unattributed`.
  - Optional stricter rule: also mark it unattributed when the owner is not a `signer` in `transaction.message.accountKeys`. Note that this changes the spec's delegate behaviour.

### L2. Low (FIXED during the review): ed25519 verification accepts small-order public keys, which allows a universal signature forgery
- **Where:** `solana.js:59-63`. `ed25519.verify` uses its default `zip215: true` and does not reject small-order keys. `normSolAddress` accepts the identity encoding.
- **How it happens:**
  - Anyone can sign in as `4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi` (the identity point) using R = identity and S = 0, for any nonce. Other small-order points are also affected.
  - These addresses hold nothing unless someone credits them, for example by an admin manual credit or a typo. Even so, it is an authentication bypass.
- **POCs:**
  - `POC: ed25519 verify accepts a universal forgery ...`
  - `POC: SIWS sign-in as the small-order identity-point address ...`
- **Fix:** at `solana.js:63`:
  ```js
  const pk = decodePubkey(address);
  if (ed25519.ExtendedPoint.fromHex(pk).isSmallOrder()) return false;
  return ed25519.verify(sig, Buffer.from(message, 'utf8'), pk, { zip215: false });
  ```
  Checked: with `zip215: false` the forgery is rejected.

### I1. Info: sessions are not bound to the chain
- **Where:** `auth.js` `check()` (end of file) returns `p.a` without validating it against the scheme.
- **Risk:** if v2 reuses the BSC-era `SESSION_SECRET`, old `0x…` session tokens stay valid for up to 7 days in Solana mode. Withdrawals to those addresses can never match a Solana owner, so they stay pending forever. This is from code reading; there is no test for it.
- **Fix:** rotate `SESSION_SECRET` for v2, or add a `c: this.chain` claim in `sign()`, and in `check()` require `p.c === this.chain` and `this.scheme.norm(p.a) === p.a`.

### I2. Info: watcher auto-match edge cases (safe)
- Auto-match marks the *oldest* pending withdrawal with the exact amount. If the admin paid w2, w1 may be marked paid instead. The amounts and user are the same, so nothing is lost.
- `markPaid` refuses a batched payout transaction for a second withdrawal. That is a safe false negative.

### L3. Low (residual, from code reading, no test): signature spam slows deposit crediting
- **What happens after the M1 fix:** every poll pages all the way back to `until`, but it processes at most `maxTxPerPoll` (default 200) transactions.
- **Impact:**
  - About 20k spam transactions that only touch the company ATA (about 0.1 SOL) delay every deposit by about 100 polls, roughly 8 minutes at a 5 s poll interval.
  - About 1M spam transactions (about 5 SOL) exceed `maxSignaturePages` (1000), and the watcher stops with an error until someone intervenes.
  - No funds are lost.
- **Fix:**
  - Skip `getTransaction` for signatures whose `getSignaturesForAddress` entry has `err != null`.
  - Raise or remove the per-poll cap for transactions that turn out to be `none`.
  - Alert when `maxSignaturePages` is hit.

## Defences verified (all have a passing DEFENCE test)
- **Idempotency:** a deposit is credited once per `signature:mint`, across re-polls, duplicate signatures in history, and a cursor reset or restart.
- **Mint checks:**
  - A fake mint is ignored.
  - Token-2022 balance rows that claim the USDC mint are ignored (programId filter).
  - A look-alike or non-ATA company-owned account is not counted as the company ATA (exact derived-ATA match).
- **Attribution rules:**
  - Failed transactions, even with crafted balance changes, become `unattributed:failed`.
  - Several sending owners become `multiple_senders`.
  - A missing owner becomes `unknown_sender`.
  - None of these are auto-credited.
- **Transaction layout:**
  - A sender that closes its account in the same transaction (pre row only) is credited the correct amount.
  - In v0 transactions with address lookup tables, `accountIndex` maps correctly over the static plus loaded jsonParsed `accountKeys`.
  - A delegate transfer credits the token-account owner, not the delegate signer.
- **ATA derivation:** it matches the real mainnet fixture (`fixtures/usdc-transfer-1.json`).
- **`getTransaction` null:** a null result stops the scan without moving the cursor, and the deposit is credited on a later poll.
- **`/paid` checks:** `/paid` rejects:
  - the wrong mint;
  - the wrong owner;
  - an underpayment of 1 micro;
  - an underpayment split across two of the user's accounts;
  - a failed transaction;
  - a deposit transaction;
  - a peer-to-peer transfer that does not involve the company;
  - reuse of one signature for a second withdrawal.
- **Auto-match:** after an auto-match, `/paid` with the same signature cannot mark a second withdrawal. A USDT payout does not auto-match a USDC withdrawal.
- **Signatures and addresses:**
  - A malleated signature (S + L), a truncated signature, the wrong message and the wrong key are all rejected.
  - Base58 edge cases are rejected: leading-`1` padding to 33 bytes, `0`/`O`/`I`/`l`, 33-byte keys and whitespace.
  - There is no case-folding onto the admin key.
- **SIWS:** the nonce is single-use, bound to the address and the exact message, checked against the domain, and expires after 10 minutes. A forged or edited HMAC session token is rejected, and `isAdmin` is set only for the exact base58 company key.
- **Ledger:** 6-decimal amounts are credited 1:1 as micro-USD with no rounding (1 raw unit = 1 micro), and `checkLedger` stays balanced.

## Test output
```
ok 1 - DEFENCE: plain deposit credited once to the sending owner; re-polling and duplicate sigs never double-credit
ok 2 - DEFENCE: fake mint, and Token-2022 balance rows claiming the USDC mint, are ignored
ok 3 - DEFENCE: a non-ATA token account owned by the company (or a look-alike address) is not treated as the company ATA
ok 4 - DEFENCE: failed tx, multiple sending owners and unknown sender are never auto-credited
ok 5 - DEFENCE: sender closing its token account in the same tx (pre only, no post row) is credited the right amount
ok 6 - DEFENCE: v0 tx with address-lookup-table keys: accountIndex maps over static+loaded keys (jsonParsed accountKeys)
ok 7 - DEFENCE: delegate transfer credits the token-account OWNER (victim), not the delegate signer
ok 8 - DEFENCE: ATA derivation matches the real mainnet fixture (owner -> its USDC token account)
ok 9 - DEFENCE (was POC L1): non-signer PDA (AMM vault authority in a CPI swap routed to the company ATA) is held as unattributed, not credited to the PDA
ok 10 - DEFENCE (was POC M1): more than 20 pages (20,000 sigs) of new history -> older signatures are still fetched and the victim deposit is credited
ok 11 - DEFENCE (was POC M2): lagging fallback RPC answering [] to a `before` page aborts the poll without advancing; the deposit is credited next poll
ok 12 - DEFENCE: getTransaction returning null (not yet finalized on this node) stops the scan without advancing the cursor
ok 13 - POC: user cancels after the admin has paid (before finality) -> paid on chain AND refunded in the ledger (double withdrawal)
ok 14 - DEFENCE: /paid rejects wrong mint, wrong owner, underpayment, failed tx, unrelated tx, and reuse for a second withdrawal
ok 15 - DEFENCE: watcher auto-match then admin /paid with the same signature cannot mark a second withdrawal
ok 16 - DEFENCE: an outgoing USDT payout does not auto-match a USDC withdrawal of the same amount
ok 17 - DEFENCE (was POC L2): universal forgery for a small-order public key (identity point) is rejected
ok 18 - DEFENCE: malleated signature (S + L) and wrong-key / truncated signatures are rejected
ok 19 - DEFENCE: base58 address edge cases (wrong length, leading-1 padding, 0/O/I/l, non-canonical) are rejected
ok 20 - DEFENCE: 6-decimal token amounts are credited 1:1 as micro-USD (no rounding), 1 raw unit stays 1 micro
ok 21 - DEFENCE: SIWS nonce is single-use, bound to address+exact message+domain, and expires
ok 22 - DEFENCE: isAdmin only for the exact base58 company key; forged/edited session tokens are rejected
ok 23 - DEFENCE (was POC L2): SIWS sign-in as the small-order identity-point address without a private key is rejected
ok 24 - DEFENCE (H1 fix, engine-level): after admin lockWithdrawal the user cannot cancel; the payout then auto-matches
# tests 24  # pass 24  # fail 0
npm test (whole engine suite, 10:47 UTC): # tests 87  # pass 87  # fail 0
```
When a fix lands, flip the matching POC's assertion so that it becomes a DEFENCE test.
