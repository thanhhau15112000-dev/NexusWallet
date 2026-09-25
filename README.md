# nexusPay

nexusPay is a payment guard for AI agents on Solana Devnet.

An agent gets its own wallet and a spending policy. Transfers inside the policy are signed by the
agent automatically. Anything outside it is held until the owner signs an approval in Phantom.
A model decides *what* to attempt; it never decides *whether it is allowed*.

```
user text prompt
  -> Gemini (extended thinking)   stage 1: context -> IntentEnvelope
  -> Groq openai/gpt-oss-120b     stage 2: intent  -> ActionPlan (JSON, 4 actions only)
  -> Policy engine                allow | require_approval | deny
  -> Agent signer                 only reachable from allow, or a verified owner signature
  -> Solana Devnet
```

## What is enforced

| Guard | Where |
| --- | --- |
| The model may only return 4 action types, schema-validated | [contract.ts](shared/src/contract.ts) |
| Only `evaluatePolicy` can authorise a signature | [policy.ts](shared/src/policy.ts) |
| Off-allowlist recipient is denied, not escalated | [policy.ts](shared/src/policy.ts) |
| Approval is bound to request, amount, recipient, policy version, nonce, expiry | [contract.ts](shared/src/contract.ts) |
| Approval must be signed by the bound owner wallet, single use | [approvals.ts](agent/src/approvals.ts) |
| Hosted API requires an expiring session created by the pinned owner's Phantom signature | [sessions.ts](agent/src/sessions.ts) |
| Agent private key is AES-256-GCM encrypted at rest, never logged, never in a prompt | [crypto.ts](agent/src/crypto.ts) |
| Audit payloads sealed with AES-256-GCM, append-only | [audit.ts](agent/src/audit.ts) |
| Only the official Solana Devnet RPC endpoint is accepted at startup | [config.ts](agent/src/config.ts) |
| Local mode is loopback-only; hosted mode requires one HTTPS dashboard origin | [config.ts](agent/src/config.ts) |

The model never sees a private key, a signer handle or an RPC endpoint. It receives the user's
text plus the allowlist labels, and returns structured action JSON only. It cannot craft raw transactions
or access RPC methods directly.

## Where things live

Three workspace packages, one file per job. `shared` exists because the dashboard
has to rebuild the approval message and render policy verdicts itself.

```
shared/src/contract.ts   units, the two model-stage schemas, approval message, request shape
shared/src/policy.ts     evaluatePolicy - the one function that authorises a signature

agent/src/server.ts      entry point: Fastify, CORS, signed cookies, hosted dashboard
agent/src/routes.ts      API endpoints and Phantom login challenge
agent/src/sessions.ts    one-time login challenges and expiring server-side sessions
agent/src/pipeline.ts    understand -> plan -> policy -> execute | hold | deny
agent/src/approvals.ts   owner signature verification
agent/src/chain.ts       every Solana RPC call, including the signer
agent/src/crypto.ts      keystore, AES-256-GCM sealing, ed25519 verification
agent/src/store.ts       state.json (policy, owner, requests)
agent/src/audit.ts       audit.jsonl (append-only, sealed payloads)
agent/src/model/         prompts, the two providers, the deterministic fallback

web/src/App.tsx          all dashboard state and actions
web/src/api.ts           typed client, resolves the agent host
web/src/phantom.ts       provider detection and signMessage
web/src/components/      one file per panel

extension/               Manifest V3 popup, host settings, and Devnet health check
scripts/build-extension.mjs  creates the unpacked Chrome build under dist/

infra/                   Dockerfile + compose for the agent service
```

Change the rules -> `shared/src/policy.ts`. Change what the model may do ->
`shared/src/contract.ts`. Change what the agent can reach -> `agent/src/chain.ts`.

## Run it

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` starts the agent service on `127.0.0.1:8787` and the dashboard on `http://localhost:5173`.

Without `GEMINI_API_KEY` / `GROQ_API_KEY` the pipeline runs a deterministic parser instead, and
every request shows `[fallback]` in its model trace. The demo works either way. Set `MODEL_MODE=mock`
to force it.

### Local / private runtime

The agent runs strictly on loopback (`127.0.0.1`) and accepts requests only from local CORS origins
(`http://localhost:5173`). Public wildcard bindings (`0.0.0.0`) and non-official/non-Devnet RPC
URLs are rejected at startup to prevent exposing the agent API or keys to untrusted networks.

### Hosted hackathon demo

The hosted image serves the API and dashboard from one HTTPS origin. It is a single-owner,
single-instance Devnet demo. Before starting it, configure these environment variables on the host:

- `DEPLOYMENT_MODE=hosted`, `HOST=0.0.0.0`, and `AGENT_DATA_DIR=/data`.
- `OWNER_PUBKEY` to the exact Phantom public key allowed to sign in.
- `WEB_ORIGIN` to the dashboard's HTTPS origin, with no path or trailing slash.
- `SESSION_COOKIE_SECRET`, `AGENT_KEYSTORE_PASSPHRASE`, and
  `AUDIT_ENCRYPTION_PASSPHRASE` as three distinct random values of at least 32 characters.
- Persist `/data` across restarts so the agent key, policy, request state, and audit log survive.

The container expects TLS to terminate at the hosting platform or a reverse proxy. Keep its
8787 port private behind that HTTPS origin. Sessions and login challenges are held in memory,
and the JSON store is for one replica; do not run multiple app instances. A private source repo
does not make the running backend private: the HTTPS endpoint is reachable publicly, while API
access is limited by the owner signature and session cookie.

`infra/docker-compose.yml` binds port 8787 to host loopback for a reverse proxy. Use the same
hosted environment values when running it; the local `.env.example` passphrases are rejected in
hosted mode.

### Chrome extension Developer mode

```bash
pnpm extension:build
```

In Chrome, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select
`dist/chrome-extension`. Open the extension's settings and enter the dashboard HTTPS origin. Chrome
asks for access to that one host when saving. The popup checks the public health endpoint and opens
the dashboard in a tab, where Phantom is injected by the normal HTTPS page. Sign-in uses a separate
message that creates a session; it is not a transaction approval. This build is for Developer mode,
not a Chrome Web Store submission.

### Fund the agent wallet

The agent starts with an empty wallet and its address is shown in the dashboard. The public devnet
faucet is rate-limited per IP, so the in-app airdrop button often returns 429. Either:

- send devnet SOL from your own Phantom wallet to the agent address, or
- use <https://faucet.solana.com> with the agent address.

Policy decisions work with a zero balance; only the on-chain transfer needs funds.

## Demo script

1. **Connect Phantom** (set to Devnet). The wallet is bound as the agent owner.
2. **Set the policy**: per-transaction limit `0.1 SOL`, then *Allowlist my Phantom wallet* so the
   agent has somewhere legitimate to send.
3. **Fund the agent** with ~0.7 SOL.
4. `Send 0.05 SOL to my-wallet` -> policy `allow` -> agent signs -> Explorer link appears.
5. `Send 0.5 SOL to my-wallet` -> policy `require_approval` -> nothing is signed. Approve in
   Phantom -> the same transfer now confirms, and the audit log shows who approved it.
6. `Send 0.05 SOL to HN7cABq...` (not allowlisted) -> policy `deny` -> no transaction, no approval
   offered.

Point at the audit log at the end: every decision is recorded with its policy version.

## Verify without a browser

With the agent running:

```bash
pnpm e2e
```

Drives all three demo paths plus the attack cases: approval from a non-owner wallet, a signature
over a tampered message, a replayed approval, and an approval issued under a stale policy version.
It binds its own throwaway key as the owner, so reconnect Phantom afterwards.

```bash
pnpm test        # policy, approval and fallback-pipeline unit tests
pnpm build       # web bundle + workspace typecheck
```

One `tsconfig.json`, one lockfile, one `.env` at the root. There is no build step for the
agent: `tsx` runs the TypeScript directly, and `pnpm build` is what proves it compiles.

## Scope

In: devnet, SOL, text-only input, one agent wallet, one policy, per-transaction limits, recipient/mint allowlists,
Phantom approval, encrypted audit log. SPL transfer is implemented and gated by the mint allowlist,
but ships with an empty allowlist — configure a mint to enable it.

Out: mainnet, voice / Gemini Live, multi-owner hosted service, swaps, staking, NFTs, arbitrary programs,
seed-phrase handling, daily budgets, fiat conversion.

## Security notes

- The owner's seed phrase stays in Phantom. The service only ever sees a public key and a
  signature over a message it issued itself.
- The agent wallet is a separate keypair holding a small devnet budget. Compromising the service
  cannot reach the owner's funds.
- Approving is signing a message, not a transaction. The message states the exact amount,
  recipient, policy version and expiry, and the dashboard refuses to sign if the server's copy of
  the message does not match the payload it was derived from.
- Hosted login is a separate signed message bound to the pinned wallet and dashboard origin. The
  resulting HttpOnly cookie expires; it does not authorize a payment by itself.
- The extension stores only the configured dashboard origin and checks `/api/health`; it does not
  store wallet keys or session cookies.
- `.env`, `data/` (keystore, state, audit log) are gitignored. Do not reuse these passphrases for
  anything real.
