# nexusPay

**Ví có kiểm soát chi tiêu cho AI agent trên Solana.**

AI agent (Claude, Cursor, Codex, Antigravity...) được cấp một ví Solana riêng và một chính sách chi tiêu do chủ sở hữu đặt. Agent tự đề xuất thanh toán qua MCP; chính sách quyết định. Giao dịch trong hạn mức được ký ngay, giao dịch vượt hạn mức chờ chủ sở hữu ký duyệt bằng ví (hoặc hủy), người nhận ngoài allowlist bị từ chối. Với nhiệm vụ nhiều bước, chủ sở hữu cấp một **Task Capability Vault** on-chain: ngân sách, thời hạn và worker được phép nằm trong smart contract, tiền đi qua escrow và phần dư được hoàn lại.

> Model quyết định *làm gì*. Model không bao giờ quyết định *có được phép hay không*.

- Demo hosted (Solana Devnet): https://nexuspay-56wn.onrender.com
- MCP endpoint: `https://nexuspay-56wn.onrender.com/mcp`
- Program Task Vault (Devnet): [`3N4GYuQXvqhDeFKLWh4GiXdD3pr3PWcNRtkUyxSYPaUK`](https://explorer.solana.com/address/3N4GYuQXvqhDeFKLWh4GiXdD3pr3PWcNRtkUyxSYPaUK?cluster=devnet)

---

## Vấn đề

AI agent ngày càng tự thực hiện công việc có chi phí: gọi API trả phí, thuê agent/dịch vụ khác, mua tài nguyên. Hiện có hai lựa chọn đều không ổn:

1. **Đưa private key cho agent** — một prompt injection là mất toàn bộ tài sản.
2. **Bắt người duyệt từng giao dịch** — agent không còn tự chủ, mọi việc nhỏ đều phải chờ người.

Thiếu một lớp ở giữa: cho agent tự chi trong phạm vi được cấp, và chặn cứng mọi thứ vượt phạm vi — bằng code và chữ ký, không bằng lời nhắc trong prompt.

## Giải pháp

nexusPay có hai lớp kiểm soát:

| Lớp | Dùng cho | Cơ chế |
| --- | --- | --- |
| **Policy Guard** (ví agent) | Thanh toán lẻ: gửi SOL / SPL token | Hạn mức mỗi giao dịch, trần chi SOL trong 24 giờ, allowlist người nhận và mint. Vượt hạn mức → chủ sở hữu ký duyệt bằng ví hoặc hủy. Ngoài allowlist → từ chối, không có đường duyệt. Owner có kill switch để khóa agent. |
| **Task Capability Vault** (on-chain) | Nhiệm vụ nhiều bước, trả tiền cho worker/service | Anchor program giữ ngân sách task trong PDA. Agent chỉ chuyển được tiền vào escrow; worker chỉ nhận khi ký receipt; hết hạn hoặc bị thu hồi thì phần dư về lại chủ sở hữu. |

Agent kết nối qua **MCP (Model Context Protocol)** — chỉ cần một URL và token, không cài đặt gì trên máy agent.

## Vì sao là Solana

nexusPay dùng trực tiếp các đặc tính của Solana, không chỉ dùng Solana làm nơi chuyển tiền:

- **Phí thấp, xác nhận nhanh → micro-payment cho agent khả thi.** Agent có thể trả nhiều khoản nhỏ trong một task mà phí mạng không lấn át giá trị giao dịch.
- **PDA làm "hợp đồng quyền hạn".** Mỗi task là một capability PDA (`["capability", owner, task_id]`) kèm vault PDA và escrow/receipt PDA theo từng payment. Quyền của agent bị giới hạn bởi account on-chain, không bởi backend.
- **Signer tách vai trò.** `create_and_fund_task` và `revoke_task` cần chữ ký owner; `execute_task_payment` cần chữ ký `agent_signer`; `settle_with_receipt` cần chữ ký worker. Không vai trò nào tự làm thay vai trò khác.
- **Đóng account để thu hồi rent.** Capability, vault, escrow và receipt được đóng sau khi settle/refund; rent của task về owner, rent của receipt về worker đã trả nó — không để account rác trên chain.
- **Refund không cần tin backend.** Sau khi task hết hạn hoặc bị thu hồi, bất kỳ ai cũng có thể gọi `refund_and_close`; escrow chưa settle thì ai cũng hoàn được sau expiry qua `refund_expired_escrow`. Tiền vẫn chỉ về owner. Backend chết thì tiền không bị kẹt.
- **Chữ ký ed25519 của ví owner làm bằng chứng duyệt.** Thông điệp duyệt gắn chặt request, số tiền, người nhận, phiên bản policy, nonce và thời hạn; dùng một lần.
- **SPL Token** cho thanh toán token, kiểm soát bằng allowlist mint.

## Kiến trúc

```text
                 ┌─────────────────────────────┐
 AI agent ──MCP──▶  /mcp  (Streamable HTTP)     │
 (Claude, Cursor, │  Bearer token theo owner    │
  Codex, ...)     └──────────────┬──────────────┘
                                 │ structured action (transfer_sol / transfer_spl)
 Dashboard ─ AI Commands (phụ) ──┤ text prompt → model → action JSON
                                 ▼
                      evaluatePolicy (shared/src/policy.ts)
                   allow │ require_approval │ deny
                         │         │
                         │   owner ký duyệt bằng ví (ed25519)
                         ▼         ▼
                   Agent signer (agent/src/chain.ts)
                                 │
                                 ▼
                          Solana Devnet
            ┌──────────────────────────────────────────┐
            │ nexus-task-vault (Anchor)                 │
            │ capability PDA → vault PDA → escrow PDA   │
            │            → worker (receipt) / refund    │
            └──────────────────────────────────────────┘
```

- **MCP là luồng chính.** Agent bên ngoài tự lập kế hoạch và gửi action có cấu trúc tới `POST /api/agent/intents`, đi thẳng vào policy.
- **Tab AI Commands trên dashboard là luồng phụ** để thử nhanh khi không có MCP client: prompt → model (Groq, hai bước: hiểu yêu cầu rồi lập action; có fallback parser tất định) → action JSON → cùng một policy.
- Nếu model trả `request_manual_approval` cho một lệnh chuyển tiền đã rõ người nhận và số tiền, pipeline dùng plan tất định dựng từ intent (ghi trong model trace là `fallback`); mọi action vẫn đi qua `evaluatePolicy`. Plan lệch intent (khác người nhận hoặc số tiền) vẫn bị từ chối.
- Dù vào từ đâu, chỉ `evaluatePolicy` hoặc một chữ ký duyệt hợp lệ của owner mới dẫn tới bước ký.

## Bảo đảm an toàn

| Bảo đảm | Vị trí |
| --- | --- |
| Chỉ `evaluatePolicy` có quyền cho phép ký | [policy.ts](shared/src/policy.ts) |
| Người nhận ngoài allowlist bị từ chối, không chuyển sang chờ duyệt | [policy.ts](shared/src/policy.ts) |
| Tổng chi SOL trong 24 giờ vượt trần → chờ owner duyệt; tính theo cửa sổ trượt, không lách được bằng cách chia nhỏ hay gửi đồng thời | [policy.ts](shared/src/policy.ts), [pipeline.ts](agent/src/pipeline.ts) |
| Kill switch: khi owner khóa, ví agent không ký giao dịch chuyển giá trị nào (MCP, AI Commands, duyệt lệnh, Task Vault payment/settle); giữ nguyên qua restart | [pipeline.ts](agent/src/pipeline.ts), [approvals.ts](agent/src/approvals.ts), [routes.ts](agent/src/routes.ts) |
| Model chỉ trả về 4 loại action, có schema validation; không thấy private key, signer hay RPC | [contract.ts](shared/src/contract.ts) |
| Chữ ký duyệt gắn request, số tiền, người nhận, phiên bản policy, nonce, thời hạn; dùng một lần | [contract.ts](shared/src/contract.ts), [approvals.ts](agent/src/approvals.ts) |
| Yêu cầu chờ duyệt quá hạn (mặc định 300 giây) chuyển sang trạng thái `expired` và không duyệt được nữa | [approvals.ts](agent/src/approvals.ts) |
| Owner hủy được yêu cầu đang chờ duyệt; yêu cầu đã hủy không duyệt lại được. Route hủy cần session ví, MCP token không gọi được | [approvals.ts](agent/src/approvals.ts), [routes.ts](agent/src/routes.ts) |
| MCP không có tool sửa policy, gắn owner hay duyệt request | [tools.ts](mcp/src/tools.ts) |
| MCP token chỉ truy cập 4 route (status, danh sách request, chi tiết request, đề xuất giao dịch); lịch sử ví, hủy và duyệt cần session ví | [mcp-token.ts](agent/src/mcp-token.ts) |
| Retry cùng `idempotencyKey` không trả tiền hai lần; cùng key khác action → `409` | [pipeline.ts](agent/src/pipeline.ts) |
| Private key agent mã hóa AES-256-GCM khi lưu, không log, không đưa vào prompt | [crypto.ts](agent/src/crypto.ts) |
| Audit log append-only, payload mã hóa | [audit.ts](agent/src/audit.ts) |
| Hosted: API cần session tạo từ chữ ký ví, có thời hạn | [sessions.ts](agent/src/sessions.ts) |
| Chỉ chấp nhận RPC Devnet chính thức | [config.ts](agent/src/config.ts) |

## Task Capability Vault

Anchor program tại `programs/nexus-task-vault`.

| Instruction | Người ký | Tác dụng |
| --- | --- | --- |
| `create_and_fund_task` | owner | Tạo capability PDA + vault PDA, nạp ngân sách, đặt `budget`, `per_payment_cap`, `expiry`, worker và service được phép |
| `execute_task_payment` | agent_signer | Chuyển một khoản từ vault sang escrow PDA; kiểm tra budget, cap, expiry, worker/service |
| `settle_with_receipt` | worker | Worker ký receipt (`request_hash`, `result_hash`), nhận tiền từ escrow |
| `revoke_task` | owner | Dừng task, chặn mọi payment tiếp theo |
| `refund_and_close` | owner, hoặc bất kỳ ai sau expiry / revoke | Hoàn phần dư và rent về owner, đóng account |
| `refund_expired_escrow` | bất kỳ ai sau expiry | Hoàn escrow chưa settle về owner |
| `close_receipt` | owner hoặc worker | Đóng receipt; rent về worker |

State machine: `active → completed | revoked | expired`. Một escrow chỉ settle hoặc refund một lần.

Receipt chứng minh worker đã ký xác nhận kết quả với `result_hash`; nó **không** chứng minh chất lượng kết quả ngoài chain.

**Trạng thái:** program đã build và deploy trên Devnet; có test trên local validator cho nhiều payment, settle, refund, revoke, từ chối worker ngoài allowlist. Bằng chứng giao dịch Devnet cho happy path và các trường hợp bị chặn đã ghi trong [#6](../../issues/6).

## Kết nối AI agent (MCP)

Đăng nhập dashboard bằng ví Phantom (Devnet) → tab **AI Commands** (hoặc bấm card **Set up MCP** ở tab **Overview**, sẽ mở đúng chỗ này) → card **Connect an AI agent (MCP)** → **Show my connection** → copy entry cho client của bạn. Token bị che trên màn hình; nút Copy vẫn đặt token đầy đủ vào clipboard.

| Client | Cách thêm |
| --- | --- |
| Claude Code | `claude mcp add --transport http nexuspay <url> --header "Authorization: Bearer <token>"` |
| Codex | `[mcp_servers.nexuspay]` với `url` và `http_headers` trong `~/.codex/config.toml` |
| Antigravity | `serverUrl` và `headers` trong `~/.gemini/config/mcp_config.json` |
| Claude Desktop | `npx -y mcp-remote <url> --header Authorization:${AUTH_HEADER}` trong `claude_desktop_config.json` |

| Tool | Tác dụng |
| --- | --- |
| `nexuspay_get_status` | Địa chỉ ví, số dư SOL, hạn mức mỗi giao dịch, trần ngày và mức đã chi 24 giờ, label allowlist, trạng thái `frozen` |
| `nexuspay_list_requests` / `nexuspay_get_request` | Trạng thái request, verdict, link Explorer |
| `nexuspay_transfer_sol` / `nexuspay_transfer_spl` | Đề xuất giao dịch; policy quyết định |

Nếu transfer trả `outcome_unknown` (timeout), gọi lại với **cùng** `idempotencyKey`, không đổi số tiền. Dùng lại một key cho giao dịch khác trả `IDEMPOTENCY_CONFLICT`. Hai lần gọi với hai key khác nhau là hai giao dịch, chỉ policy giới hạn chúng. Rotate token trên dashboard sẽ ngắt các client đang dùng token cũ.

Kết quả bị từ chối, thất bại hoặc chờ duyệt trả về `code`, `message`, `remediation` và `details` để agent tự điều chỉnh thay vì retry cùng tham số:

| `code` | Ý nghĩa |
| --- | --- |
| `RECIPIENT_NOT_IN_ALLOWLIST` | Người nhận không có trong allowlist |
| `MINT_NOT_IN_ALLOWLIST` | Mint không có trong allowlist |
| `INVALID_AMOUNT` | Số tiền không hợp lệ |
| `INSUFFICIENT_FUNDS_INCLUDING_FEES` | Ví agent không đủ số dư kể cả phí mạng |
| `IDEMPOTENCY_CONFLICT` | Key đã dùng cho một giao dịch khác |
| `PENDING_APPROVAL_REQUIRED` | Chờ owner duyệt; `details.reason` là `AMOUNT_EXCEEDS_TRANSACTION_LIMIT` hoặc `DAILY_LIMIT_EXCEEDED` |
| `DAILY_LIMIT_EXCEEDED` | Tổng chi tiêu SOL trong 24 giờ vượt hạn mức ngày |
| `AGENT_FROZEN` | Owner đã khóa agent |

Số tiền SOL trong `details` có cả SOL và lamports dạng số nguyên. Giao dịch chờ duyệt trả thêm `pollIntervalMs` và `dashboardUrl` mở thẳng request đó trong tab Approvals. `nexuspay_get_status` trả `estimatedFeeSol` — phần phí cần giữ lại ngoài số tiền chuyển. Kết quả request đã chạy có `execution.explorerUrl`. Agent qua MCP chưa đọc được lịch sử SOL vào/ra của ví (chỉ xem được request của chính nó); lịch sử đó nằm ở tab **Wallet history** của dashboard.

Chạy local: có bản stdio MCP (`pnpm mcp:build` → `dist/mcp/nexuspay-mcp.mjs`), các file `.mcp.json` / `.cursor/mcp.json` đã cấu hình sẵn khi mở client ở thư mục gốc repo, và `pnpm mcp:install -- --client codex|claude-desktop|antigravity`. Chi tiết xử lý lỗi: [docs/mcp-troubleshooting.md](docs/mcp-troubleshooting.md).

## Kịch bản demo

Chuẩn bị: Phantom ở Devnet, đăng nhập dashboard. Dữ liệu (ví agent, policy, token MCP) là của từng ví Phantom; nếu server bị deploy lại mà không có disk thì phải đặt lại từ đầu, nên chuẩn bị sát giờ demo và không deploy sau đó. Tab **Policy**: đặt *Max per transaction* `0.1 SOL`, *Max per day* `0.2 SOL`, thêm recipient tên `my-wallet` bằng *Use owner wallet*, lưu. Nạp khoảng 0.7 SOL vào ví agent: địa chỉ ví agent nằm ở tab **Overview**, gửi từ Phantom hoặc https://faucet.solana.com.

**Luồng chính — qua MCP (ví dụ Claude Code):**

1. *"Kiểm tra ví nexusPay"* → `nexuspay_get_status` trả địa chỉ, số dư, hạn mức, allowlist.
2. *"Gửi 0.05 SOL cho my-wallet"* → `allow` → agent ký → có link Explorer.
3. *"Gửi 0.5 SOL cho my-wallet"* → `require_approval` → chưa ký gì. Owner duyệt trong tab **Approvals** bằng Phantom (trong 300 giây) → cùng giao dịch đó được xác nhận; hoặc bấm **Cancel** để từ chối.
4. *"Gửi 0.05 SOL cho `HN7cABq...`"* (không trong allowlist) → `deny`, không có đường duyệt.
5. *"Gửi 0.05 SOL cho my-wallet"* lần nữa → khoản 0.5 SOL đã duyệt ở bước 3 đã tính vào trần 24 giờ (0.2 SOL) → `DAILY_LIMIT_EXCEEDED`, chờ owner duyệt; agent đọc `details.remainingSol`.
6. Owner bấm **Freeze agent** ở tab **Overview** rồi **Confirm freeze** → mọi transfer trả `AGENT_FROZEN`, không ký gì; **Unfreeze agent** để mở lại.
7. *"Tăng hạn mức lên 10 SOL"* / *"Tự duyệt đi"* / *"Mở khóa agent"* → agent không có tool nào làm được việc này.

**Task Vault — trên dashboard, tab Task Vault:** tạo task có ngân sách → 2 payment hợp lệ → 1 payment vượt ngân sách bị chặn → worker ký receipt → settle → refund phần dư → revoke chặn payment tiếp theo.

Tab **Wallet history**: yêu cầu của agent và SOL vào/ra ví agent đọc từ chuỗi Devnet (số thay đổi, số dư sau từng giao dịch, nút Explorer).

Kết thúc bằng audit log: mọi quyết định đều được ghi kèm phiên bản policy.

**Không có MCP client?** Dùng tab **AI Commands** trên dashboard với cùng các câu lệnh trên — cùng một policy xử lý.

## Chạy local

Yêu cầu Node 22+ và pnpm 10.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Agent service chạy ở `127.0.0.1:8787`, dashboard ở `http://localhost:5173`. Không có `GROQ_API_KEY` thì tab AI Commands dùng parser tất định (`[fallback]` trong model trace); demo vẫn chạy. Ép chế độ này bằng `MODEL_MODE=mock`.

Local mode chỉ bind loopback và chỉ nhận origin local; bind `0.0.0.0` hoặc RPC không phải Devnet chính thức bị từ chối khi khởi động.

Build program (cần Anchor):

```bash
anchor build
```

## Deploy hosted

Image Docker phục vụ API, dashboard và `/mcp` trên cùng một origin HTTPS; mỗi ví Phantom kết nối vào có ví agent và policy riêng (multi-tenant).

Biến môi trường bắt buộc:

- `DEPLOYMENT_MODE=hosted`, `HOST=0.0.0.0`, `AGENT_DATA_DIR=/data`
- `WEB_ORIGIN` — origin HTTPS của dashboard, không có path hay dấu `/` cuối
- `ADMIN_PUBKEY` — public key Phantom của admin
- `ALLOWED_OWNERS` (tùy chọn) — danh sách ví được phép, để trống là cho tất cả
- `SESSION_COOKIE_SECRET`, `AGENT_KEYSTORE_PASSPHRASE`, `AUDIT_ENCRYPTION_PASSPHRASE` — ba giá trị ngẫu nhiên khác nhau, tối thiểu 32 ký tự

Cần persistent disk cho `/data`; không có disk thì mỗi lần deploy lại sẽ sinh ví agent và MCP token mới (đã gặp trên gói free của Render, gói này cũng tự ngủ khi không có truy cập nên request đầu tiên có thể trễ 50 giây trở lên). `GET /api/health` trả thêm `commit` (từ `RENDER_GIT_COMMIT` hoặc `GIT_COMMIT`) để biết bản đang chạy. Chỉ chạy một instance (session và store JSON ở trong process). TLS kết thúc ở nền tảng hosting hoặc reverse proxy.

## Kiểm thử

```bash
pnpm test    # policy, approval, pipeline, task vault, MCP tools
pnpm build   # web bundle + typecheck toàn workspace
pnpm e2e     # 3 luồng demo + các case tấn công (khi agent đang chạy)
```

`pnpm e2e` chạy allow / approval / deny và các case: duyệt bằng ví không phải owner, chữ ký trên thông điệp bị sửa, replay chữ ký duyệt, duyệt dưới phiên bản policy cũ.

## Cấu trúc repo

```text
shared/src/policy.ts        evaluatePolicy — hàm duy nhất cho phép ký
shared/src/contract.ts      schema action, thông điệp duyệt, đơn vị
shared/src/task-vault.ts    schema và state machine của Task Vault

agent/src/pipeline.ts       prompt/action → policy → ký | chờ duyệt | từ chối
agent/src/approvals.ts      xác minh chữ ký duyệt của owner
agent/src/chain.ts          mọi lời gọi RPC Solana và signer
agent/src/task-vault-chain.ts  build/submit instruction Task Vault
agent/src/mcp-remote.ts     endpoint /mcp (Streamable HTTP)
agent/src/mcp-token.ts      bearer token theo owner, allowlist route

programs/nexus-task-vault/  Anchor program
mcp/src/tools.ts            5 tool MCP; chỉ gọi API agent, không gọi chain
web/src/                    dashboard React (en / vi)
extension/                  Chrome extension (Developer mode)
infra/                      Dockerfile + compose
```

## Phạm vi và giới hạn

**Có:** Solana Devnet, SOL và SPL token theo allowlist, policy theo từng owner, hạn mức mỗi giao dịch, trần chi SOL trong 24 giờ, kill switch, duyệt bằng chữ ký Phantom hoặc hủy yêu cầu chờ duyệt, tab Wallet history (SOL vào/ra ví agent, phân trang, link Explorer), remote MCP, Task Capability Vault (SOL), audit log mã hóa, giao diện tiếng Anh / tiếng Việt.

**Không có:** mainnet, swap/staking/NFT, gọi program tùy ý, trần ngày cho SPL token, quy đổi fiat, xử lý seed phrase.

**Giới hạn đã biết:**

- Ví agent của Policy Guard là **custodial**: key do agent service giữ (đã mã hóa). Tính chất non-custodial chỉ áp dụng cho tiền nằm trong Task Vault.
- MCP token hiện lưu plaintext trên disk của agent service; lưu dạng hash nằm trong lộ trình.
- Tab Wallet history đọc từ RPC Devnet công khai (10 giao dịch mỗi trang, chỉ bước từng trang); RPC có thể giới hạn tần suất và khi đó tab hiện thông báo lỗi. Thay đổi tính theo số dư của ví agent, đã gồm phí mạng.
- Receipt không chứng minh chất lượng kết quả ngoài chain.
- Không dùng cho tiền thật.

## Lộ trình

Theo dõi tại [epic #18](../../issues/18) (label `backlog`): `outputSchema` cho tool MCP, tool đọc lịch sử ví qua MCP, hash MCP token và rate limit, tool Task Vault qua MCP, đối chiếu record Task Vault với chain, cảnh báo Telegram / email, thanh toán Task Vault bằng stablecoin.
