# nexusPay MVP — Agent Payment Guard

## 1. Định hướng sản phẩm

nexusPay là lớp kiểm soát chi tiêu cho agent trên Solana, tập trung vào một flow hackathon hoàn chỉnh thay vì clone Phantom đầy đủ:

- User kết nối Phantom làm ví gốc.
- Agent chạy trên một VM bằng ví agent riêng.
- Agent gửi SOL và một SPL token được allowlist trên Devnet.
- Giao dịch trong hạn mức được tự động thực hiện.
- Giao dịch vượt hạn mức phải được user ký approval bằng Phantom.
- Request và kết quả được ghi vào audit log mã hóa.
- Model chỉ phân tích ý định và trả về action JSON; không được ký hoặc tạo raw transaction.

Flow demo chính:

```text
Agent yêu cầu thanh toán dưới hạn mức
  -> policy pass -> agent wallet ký -> Devnet transaction thành công

Agent yêu cầu thanh toán vượt hạn mức
  -> policy chặn -> user ký approval bằng Phantom
  -> agent wallet ký -> Devnet transaction thành công
```

## 2. Phạm vi MVP dưới một tuần

### Làm

- Web app React/Vite + TypeScript.
- Kết nối Phantom injected provider.
- Agent service Node.js/TypeScript chạy trên một VM.
- Ví agent riêng với key được mã hóa khi lưu.
- Đọc số dư và gửi SOL.
- Gửi một SPL token được cấu hình bằng mint address.
- Hạn mức theo từng giao dịch.
- Allowlist mint, recipient và Solana programs.
- Manual approval bằng chữ ký message từ Phantom.
- Encrypted audit log.
- Devnet transaction signature và link Explorer.
- Mock model fallback và provider model adapter.
- Docker image/Compose cho agent service.

### Hoãn sau hackathon

- Voice input, Gemini Live audio stream (MVP hiện tại chỉ dùng text-only prompt).
- Triển khai public Codespaces / auth session công khai (MVP hiện tại chạy local loopback).
- Recovery phrase và multi-account riêng.
- Chrome extension riêng.
- Wallet Standard provider.
- Full Phantom feature parity.
- Swap, DeFi, staking, NFT và arbitrary programs.
- Mainnet.
- Fine-tune model, daily budget, price oracle và fiat conversion.

## 3. Kiến trúc và trust boundary

```text
Web app
- Connect Phantom
- Hiển thị policy/approval/audit
- User ký challenge và approval

        HTTPS/REST

Agent service trên VM
- Model adapter
- Action validator
- Policy engine
- Transaction builder/simulator
- Agent wallet signer
- SQLite state + encrypted audit payload
- RPC queue/rate limiter

        Solana Devnet RPC
```

- Seed/private key của ví gốc chỉ nằm trong Phantom.
- Agent wallet là keypair riêng, chỉ giữ ngân sách nhỏ.
- Model không được truy cập key, signer hoặc RPC tùy ý.
- VM chỉ ký giao dịch agent sau khi policy pass hoặc approval hợp lệ.
- Approval phải bind với transaction hash, agent ID, destination, mint, amount, policy version, nonce và expiry.
- On-chain transaction vẫn public; chỉ metadata/audit payload lưu off-chain được mã hóa.

## 4. Tool và môi trường

### Môi trường hiện tại

- Node.js `v24.15.0`.
- npm `11.12.1`.
- pnpm `10.33.0`.
- Git `2.54.0`.
- Docker Compose `5.3.1`.
- `node:sqlite` đã có trong Node hiện tại.

Không cần cài thêm Node, Git, pnpm hoặc Docker trên máy hiện tại.

### Dependency chính

- Frontend: `react`, `react-dom`, `vite`, `typescript`.
- Solana: `@solana/web3.js` 1.x, `@solana/spl-token`.
- Validation: `zod`.
- API: `fastify`, `@fastify/cors`.
- Logging: `pino`.
- Signature/encoding: `tweetnacl`, `bs58`.
- Test/build: `vitest`, `tsx`, TypeScript compiler.
- Crypto/storage: Node built-in `node:crypto`, `node:sqlite`.

Pin `@solana/web3.js` ở nhánh 1.x và cô lập mọi lời gọi Solana trong `agent/src/chain.ts`. Không dùng API v2/v3 thử nghiệm trong MVP.

### Model

- Không cài Python, CUDA, PyTorch hoặc training stack trong MVP.
- `ModelAdapter` có hai mode:
  - `mock`: deterministic để test và demo fallback.
  - `provider`: model API có structured JSON output.
- Dùng Zod validate output trước khi đưa vào policy engine.
- Không đưa seed, private key, access token hoặc raw transaction vào prompt.

## 5. Cấu trúc project

```text
G:\Nexus\
  agent/          agent service (API, model pipeline, policy gate, signer, audit)
  web/            dashboard (Phantom, policy, command console, approvals)
  shared/         contract + policy engine, imported by both
  infra/
    Dockerfile
    docker-compose.yml
  docs/
  .env.example
  package.json
  pnpm-workspace.yaml
  tsconfig.json
```

Cấu trúc phẳng theo KISS/YAGNI: chỉ tách package khi thực sự có hai bên dùng
chung. `crypto` và `solana` chỉ agent dùng nên nằm thẳng trong `agent/src/`.
Xem README mục "Where things live" để biết file nào giữ việc gì.

## 6. Domain contract

### Allowed actions

```text
get_balance
transfer_sol
transfer_spl
request_manual_approval
```

Model chỉ chọn action và parameters; không trả về instruction, serialized transaction hoặc program ID tùy ý.

### Policy

```text
agentId
maxSolLamportsPerTx
allowedMints[]
allowedRecipients[]
maxTokenUnitsByMint{}
allowedPrograms[]
```

Unknown mint, unknown recipient hoặc unknown program phải chuyển sang manual approval hoặc bị từ chối theo policy.

### Approval state

```text
draft
-> simulated
-> auto_approved hoặc pending_approval
-> signed
-> submitted
-> confirmed / failed / expired
```

Mọi request cần `requestId` và idempotency key để retry không gửi trùng transaction.

## 7. Lịch triển khai 5–7 ngày

### Ngày 1 — Foundation

- Khởi tạo pnpm workspace.
- Tạo web app và agent service.
- Kết nối Phantom và Devnet.
- Tạo domain schemas, `.env.example` và error model.

Kiểm tra: `pnpm build`, connect Phantom, đọc public key và SOL balance.

### Ngày 2 — Agent wallet và SOL

- Tạo agent keypair riêng.
- Encrypt/decrypt key bằng Node crypto.
- Implement balance và SOL transfer.
- Lưu request state trong SQLite.

Kiểm tra: Devnet airdrop, gửi SOL, xác nhận signature, restart không mất state.

### Ngày 3 — Policy và approval

- Implement policy engine.
- Auto-approve giao dịch dưới hạn mức.
- Tạo pending approval khi vượt hạn mức.
- Verify chữ ký approval từ Phantom.

Kiểm tra: approval sai hash, sai nonce, hết hạn và replay đều bị từ chối.

### Ngày 4 — SPL và encrypted audit

- Allowlist một mint SPL.
- Implement SPL transfer.
- Encrypt audit payload.
- Hiển thị log trên dashboard.
- Thêm RPC retry/backoff và idempotency.

### Ngày 5 — Model và demo flow

- Implement `ModelAdapter`.
- Validate structured output bằng Zod.
- Thêm mock fallback.
- Hoàn thiện hai flow dưới hạn mức/vượt hạn mức.

### Ngày 6–7 — Deploy và kiểm thử

- Dockerize agent service.
- Chạy trên Linux VM.
- Cấu hình RPC, secrets và model provider.
- Viết README và hướng dẫn chạy.
- Quay pitch/technical demo.
- Sửa lỗi cuối cùng.

## 8. Test và acceptance criteria

### Functional

- Phantom connect thành công.
- Agent đọc được số dư Devnet.
- SOL transfer thành công.
- SPL transfer chỉ chạy với mint allowlist.
- Dưới hạn mức tự động thành công.
- Vượt hạn mức bị chặn cho tới khi user approve.
- Signature xem được trên Solana Explorer.

### Security

- VM không có seed ví gốc.
- Model không gọi trực tiếp signer.
- Không có private key trong prompt hoặc log.
- Approval bị bind đúng transaction hash.
- Approval hết hạn/replay bị từ chối.
- Unknown instruction/program bị chặn.

### Reliability

- Retry không tạo transaction trùng.
- RPC `429` không làm worker crash.
- VM restart resume được pending request.
- Model provider lỗi vẫn trả trạng thái rõ ràng hoặc dùng mock fallback.

### Build

- TypeScript compile pass.
- Web build pass.
- Agent build pass.
- Unit test policy/approval pass.
- Devnet integration flow pass.

## 9. Acceptance demo cuối cùng

Một video ngắn phải chứng minh:

1. User đặt hạn mức cho agent.
2. Agent yêu cầu gửi tiền dưới hạn mức và tự hoàn tất.
3. Agent yêu cầu gửi tiền vượt hạn mức và bị chặn.
4. User ký approval bằng Phantom.
5. Transaction hoàn tất trên Devnet.
6. Dashboard hiển thị policy result, signature và audit log mã hóa.

## 10. Nguyên tắc không mở rộng scope

- Không tạo wallet extension riêng trong MVP.
- Không thêm token/program mới nếu chưa có test policy.
- Không để model quyết định quyền ký.
- Không commit `.env`, keypair, seed hoặc secret.
- Không dùng `git add .` khi bắt đầu commit; luôn kiểm tra `git status` và stage path cụ thể.
- GitHub repository tạo sau khi source MVP đã được khởi tạo và kiểm tra local.
