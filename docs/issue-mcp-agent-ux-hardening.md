# [Feature / Architecture]: Nâng cấp MCP Server & Chuẩn hóa Trải nghiệm cho Autonomous Agents (MCP-First Pivot)

## 1. Tóm tắt & Bối cảnh

Trước đây, NexusPay được định hướng phát triển xoay quanh mô hình **dApp** (người dùng kết nối ví trên Web Dashboard để quản trị policy, nạp tiền, tạo Task Vault và duyệt giao dịch thủ công). 

Hiện tại, trọng tâm kiến trúc chuyển dịch dứt khoát sang **MCP-First (Autonomous Personal AI Agents)**: AI Agent (chạy trên Claude Desktop, Codex, Cursor, Antigravity...) đóng vai trò tác nhân kinh tế tự chủ. Agent trực tiếp giữ ví, phân tích ngữ cảnh, lập kế hoạch chi tiêu và thanh toán thông qua **Model Context Protocol (MCP)** dưới sự giám sát của Spending Policy và Task Capability Vault.

Sau đợt phát hành MVP (PR #11), tầng MCP đã cung cấp 5 công cụ cơ bản (`nexuspay_get_status`, `nexuspay_list_requests`, `nexuspay_get_request`, `nexuspay_transfer_sol`, `nexuspay_transfer_spl`) cùng cơ chế zero-config token discovery. Tuy nhiên, toàn bộ luồng MCP hiện bộc lộ nhiều khoảng trống kỹ thuật và hạn chế trải nghiệm (Agent UX) cần được chuẩn hóa để phục vụ đúng định hướng mới.

---

## 2. Vấn đề Hiện tại (Current Limitations & Agent UX Gaps)

### 2.1. Schema Dễ Gây Lỗi Parser và Nguy cơ Hallucinate
- `[FACT]`: Một số engine function-calling của các mô hình LLM (như Gemini trên Antigravity, hoặc các model open-source) rất nhạy cảm với các từ khóa JSON Schema mở rộng (`exclusiveMinimum`, `exclusiveMaximum`, `$schema`, `anyOf` phức tạp). Ví dụ trong PR #11, codebase đã phải xử lý bằng cách thay `z.number().positive()` bằng `min(1e-9)` để tránh crash parser.
- `[FACT]`: Các schema hiện tại vẫn còn thiếu trường `outputSchema` tường minh, khiến model phải dựa vào text phản hồi dạng tự do thay vì cấu trúc JSON có định kiểu trước.
- *Hệ quả:* Agent dễ sinh ra các tham số ảo (hallucinated parameters) hoặc gặp lỗi parser ngay tại tầng client của LLM runtime.

### 2.2. Mã Lỗi Thiếu Tính Tự Sửa Sai (Unstructured Errors Gây Retry Storms)
- `[FACT]`: Khi bị từ chối (`deny`) hoặc bị treo chờ duyệt (`pending_approval`), response từ backend chủ yếu là mã lỗi chung chung như `code: "policy_denied"` kèm chuỗi text giải thích tự do (ví dụ: `"recipient \"unknown_address\" is not on the allowlist"` hoặc `"amount 500000000 lamports exceeds the per-transaction limit of 100000000 lamports"`).
- `[FACT]`: Mã lỗi không có tính chất machine-readable (dạng enum mã định danh kỹ thuật chuẩn) và không kèm chỉ dẫn khắc phục (`remediation hint`).
- *Hệ quả:* Thay vì tự điều chỉnh kế hoạch (ví dụ: hạ số tiền gửi xuống dưới limit, đổi recipient sang allowlisted label, hoặc thông báo rõ ràng cho người dùng cuối vào dashboard duyệt), AI Agent thường rơi vào **vòng lặp gọi lại liên tục (retry storm)** với cùng tham số sai, gây lãng phí token và làm tắc nghẽn agent server.

### 2.3. Rủi ro Double-Spend khi Devnet Timeout (Thiếu Cam kết Idempotency Tuyệt đối)
- `[FACT]`: Mạng Solana Devnet thường xuyên gặp tình trạng nghẽn mạng hoặc RPC dropped websocket, dẫn đến timeout khi confirm giao dịch (`outcome_unknown`).
- `[FACT]`: Mặc dù pipeline đã có cơ chế deduplication in-flight và store lookup, nhưng tầng MCP wrapper và API routes cần được bảo chứng nghiêm ngặt để đảm bảo rằng khi agent retry với cùng `idempotencyKey`, giao dịch tuyệt đối **không bao giờ bị double-spend** (gửi trùng lặp on-chain), và kết quả trả về phải mang tính deterministic (cùng signature, cùng trạng thái).

### 2.4. Vắng mặt Hoàn toàn Công cụ Task Capability Vault trong MCP
- `[FACT]`: Hợp đồng thông minh Task Capability Vault trên Solana Devnet đã hoàn thành (quản lý ngân sách, escrow, worker allowlist, biên lai receipt), nhưng **0/5 công cụ MCP** hỗ trợ tương tác với chương trình này.
- `[FACT]`: Danh sách route MCP được phép truy cập ([`MCP_ROUTES`](file:///g:/Nexus/agent/src/mcp-token.ts#L17-L22)) bị giới hạn cứng ở 4 endpoint ví trực tiếp (`GET /api/state`, `GET /api/requests`, `GET /api/requests/:id`, `POST /api/agent/intents`). Các endpoint `/api/tasks/*` bị chặn hoàn toàn đối với token bearer của MCP.
- *Hệ quả:* AI Agent qua MCP hoàn toàn "mù" trước các Task Capability Vault được cấp quyền. Agent không thể tra cứu danh sách task, không kiểm tra được budget/cap/expiry của task, và không thể khởi tạo giao dịch thanh toán kèm escrow bảo chứng.

### 2.5. Không Đồng nhất Đơn vị Tiền tệ (SOL vs Lamports)
- `[FACT]`: Đầu vào của tool yêu cầu đơn vị `SOL` (ví dụ: `amountSol: 0.05`), tool `nexuspay_get_status` trả về `balanceSol` và `maxSolPerTransaction` theo `SOL`.
- `[FACT]`: Tuy nhiên, chuỗi lý do từ chối từ Policy Engine lại trả về đơn vị `lamports` dạng chuỗi thô (`"amount 500000000 lamports exceeds..."`).
- *Hệ quả:* Buộc mô hình ngôn ngữ (LLM) phải tự chuyển đổi số học giữa SOL và Lamports, gây rủi ro hallucination đối với các model nhỏ.

### 2.6. Thiếu Thông số Ước lượng Phí Mạng (Network Fee Guidance)
- `[FACT]`: Khi số dư ví bằng đúng số tiền muốn chuyển, giao dịch thất bại tại tầng thực thi blockchain: `"agent wallet has 0 SOL, needs :amount SOL including fees"`.
- `[FACT]`: Cả trong schema lẫn tool `nexuspay_get_status` đều không định nghĩa mức phí ước tính (~0.00001 SOL), khiến agent không thể tự động trừ phí khi thực hiện lệnh chuyển sạch số dư (`sweep balance`).

---

## 3. Mục tiêu Nâng cấp (Objectives)

1. **Chuẩn hóa Schema Chống Hallucinate & Parser-Safe:**
   - Triệt tiêu 100% các từ khóa gây lỗi parser trên mọi engine (không dùng `exclusiveMinimum`, `exclusiveMaximum`, `$schema`, `anyOf` phức tạp).
   - Quy định constraints rõ ràng: `regex`, `minLength`, `maxLength`, `enum`, mô tả trường súc tích, mang tính định hướng.
   - Bổ sung `outputSchema` tường minh theo chuẩn Model Context Protocol specification.
2. **Hệ thống Mã lỗi Có tính Tự Sửa Sai (Actionable Technical Error Codes):**
   - Thay thế các chuỗi lỗi tự do bằng mã định danh kỹ thuật có cấu trúc (Machine-Readable Error Enums).
   - Trả về metadata chi tiết và trường `remediation` để agent biết chính xác hành động tiếp theo: điều chỉnh tham số, chờ người dùng duyệt, hay hủy bỏ lệnh.
3. **Bảo đảm Idempotency Tuyệt đối (Zero Double-Spend Guarantee):**
   - Đảm bảo tính bất biến của `idempotencyKey` qua timeout Devnet: Khi agent retry với cùng key và fingerprint, hệ thống trả về chính xác transaction/status đã thực hiện hoặc đang xử lý.
   - Từ chối ngay lập tức nếu cùng `idempotencyKey` nhưng khác fingerprint (`IdempotencyConflictError`).
4. **Mở rộng MCP sang Hợp đồng Task Capability Vault:**
   - Bổ sung công cụ truy vấn các Task Vault được cấp cho ví agent: `nexuspay_list_task_vaults`, `nexuspay_get_task_capability`.
   - Bổ sung công cụ kích hoạt thanh toán task escrow: `nexuspay_execute_task_payment`.
   - Mở rộng whitelist route trong [`mcpOwnerFor`](file:///g:/Nexus/agent/src/mcp-token.ts) cho các endpoint task vault an toàn.
5. **Đồng nhất Đơn vị Tiền tệ:**
   - Định dạng toàn bộ lý do và hạn mức trong phản hồi của Policy Engine về cùng đơn vị tiền tệ (`SOL` hoặc hiển thị song song `X SOL (Y lamports)`).
6. **Bổ sung Ước tính Phí và Nhịp Polling:**
   - Thêm trường `estimatedFeeSol` (mặc định 0.00001 SOL) vào phản hồi của `nexuspay_get_status`.
   - Thêm trường `pollIntervalMs: 5000` trong payload `approval` của request chờ duyệt.

---

## 4. Đặc tả Kỹ thuật Chi tiết (Detailed Technical Specifications)

### 4.1. Hệ thống Mã Lỗi Có Tính Tự Sửa Sai (Actionable Error Codes & Remediation)

Khi giao dịch bị từ chối hoặc cần duyệt, phản hồi JSON trả về cho agent bắt buộc tuân theo cấu trúc:

```typescript
interface ActionableErrorPayload {
  code:
    | 'RECIPIENT_NOT_IN_ALLOWLIST'
    | 'MINT_NOT_IN_ALLOWLIST'
    | 'AMOUNT_EXCEEDS_TRANSACTION_LIMIT'
    | 'INSUFFICIENT_FUNDS_INCLUDING_FEES'
    | 'PENDING_APPROVAL_REQUIRED'
    | 'TASK_CAPABILITY_NOT_FOUND'
    | 'TASK_BUDGET_EXCEEDED'
    | 'TASK_EXPIRED'
    | 'IDEMPOTENCY_CONFLICT';
  message: string;
  remediation: string;
  details: Record<string, unknown>;
}
```

#### Ma trận mã lỗi và hành động tự sửa sai:

| Mã lỗi (`code`) | Chi tiết đính kèm (`details`) | Chỉ dẫn hành động (`remediation`) | Hành vi mong đợi của Agent |
| :--- | :--- | :--- | :--- |
| `RECIPIENT_NOT_IN_ALLOWLIST` | `providedRecipient`, `allowedRecipients: [{label, address}]` | `"Use an allowlisted recipient label or address, or ask the owner to add it in the dashboard."` | Tự động đối chiếu với danh sách label hoặc dừng lệnh, không retry vô ích. |
| `MINT_NOT_IN_ALLOWLIST` | `providedMint`, `allowedMints: [{label, address}]` | `"Use an allowlisted mint label or address, or ask the owner to add it in the dashboard."` | Đổi mint hợp lệ hoặc dừng lệnh. |
| `AMOUNT_EXCEEDS_TRANSACTION_LIMIT` | `requestedSol`, `maxSolPerTx`, `unit: "SOL"` | `"Reduce amountSol to <= maxSolPerTx to auto-approve, or proceed to submit for manual owner approval."` | Tự động hạ số tiền xuống nếu ngữ cảnh cho phép, hoặc thông báo user cần duyệt. |
| `INSUFFICIENT_FUNDS_INCLUDING_FEES` | `currentBalanceSol`, `requiredSol`, `estimatedFeeSol: 0.00001` | `"Agent wallet needs at least requiredSol including network fee. Request funding from owner."` | Báo người dùng nạp thêm tiền hoặc điều chỉnh số tiền chuyển = `balance - fee`. |
| `PENDING_APPROVAL_REQUIRED` | `requestId`, `expiresAt`, `dashboardUrl`, `pollIntervalMs: 5000` | `"Owner approval required. Notify the user to approve at dashboardUrl before expiresAt. Poll nexuspay_get_request with recommended interval."` | Báo link cho người dùng và thiết lập nhịp poll hợp lý, không spam tool call. |
| `TASK_BUDGET_EXCEEDED` | `taskId`, `requestedSol`, `remainingBudgetSol` | `"Payment exceeds remaining task budget. Check nexuspay_get_task_capability."` | Không retry, điều chỉnh ngân sách payment hoặc kết thúc task. |

---

### 4.2. Tiêu Chuẩn Schema An Toàn Cho Engine Function Calling (Parser-Safe)

Toàn bộ công cụ MCP phải tuân thủ nghiêm ngặt các quy tắc schema:
1. **Không sử dụng từ khóa mở rộng:**
   - Thay vì `z.number().positive()`, sử dụng `z.number().min(1e-9).max(1_000_000_000)`.
   - Tuyệt đối không để lọt `exclusiveMinimum`, `exclusiveMaximum`, `$schema`, `patternProperties`.
2. **Mô tả tường minh và định dạng chuẩn:**
   - Trường địa chỉ: `z.string().trim().min(1).max(64).describe("An allowlisted recipient label (e.g. 'treasury') or exact base58 Solana address.")`.
   - Trường số tiền: Ghi rõ đơn vị SOL, ví dụ `0.05`.
   - Khai báo đầy đủ `outputSchema` với schema object tường minh cho từng công cụ.

---

### 4.3. Cơ Chế Idempotency Tuyệt Đối (Zero Double-Spend Protocol)

1. **Khởi tạo Key Phía Client MCP:**
   - Trước khi gửi request sang `/api/agent/intents`, client MCP tạo key deterministic `mcp:<uuid>` nếu agent không truyền vào.
2. **Khoá Trùng lặp In-Flight tại Backend Agent:**
   - Module [`pipeline.ts`](file:///g:/Nexus/agent/src/pipeline.ts) lưu trữ `inFlightCommands` dạng Map theo tenant. Nếu có 2 request đồng thời mang cùng `idempotencyKey`:
     - Nếu cùng action fingerprint: Request thứ hai chờ và dùng chung Promise của request đầu tiên (trả về cùng một kết quả thực thi duy nhất).
     - Nếu khác action fingerprint: Ném lỗi `IdempotencyConflictError` (`409 Conflict`) ngay lập tức.
3. **Bền vững qua Restart và Timeout Devnet:**
   - Khi giao dịch blockchain bị timeout tại RPC (`outcome_unknown`), `PaymentRequest` đã được ghi vào store với trạng thái đang xử lý.
   - Khi AI Agent gọi lại với cùng `idempotencyKey`: Backend đối chiếu trong persistent store (`store.findByIdempotencyKey`), trả về trạng thái của giao dịch ban đầu thay vì ký lại một transaction mới lên mạng Solana.

---

### 4.4. Đặc Tả Công Cụ MCP Mới và Nâng Cấp

#### Nhóm 1: Direct Agent Wallet (Cải tiến)
- `nexuspay_get_status`:
  - Output bổ sung: `estimatedFeeSol: 0.00001`, `currency: "SOL"`.
- `nexuspay_list_requests`:
  - Input bổ sung: `cursor?: string`, `limit?: number (1-50)`.
- `nexuspay_get_request`:
  - Bổ sung output schema chi tiết.
- `nexuspay_transfer_sol` & `nexuspay_transfer_spl`:
  - Bổ sung `ActionableErrorPayload` chuẩn hóa cho mọi trường hợp deny, over-limit, thiếu tiền.

#### Nhóm 2: Task Capability Vault (Bổ sung mới)
- `nexuspay_list_task_vaults`:
  - Liệt kê các task capabilities mà ví agent là `agent_signer`.
  - Output: `tasks: [{ taskId, owner, budgetSol, spentSol, perPaymentCapSol, expiry, allowedWorker, allowedServiceId, status }]`.
- `nexuspay_get_task_capability`:
  - Xem chi tiết tiến độ, danh sách payment held và receipt đã settle của một task cụ thể.
- `nexuspay_execute_task_payment`:
  - Kích hoạt thanh toán có bảo chứng escrow từ Task Vault.
  - Input: `taskId`, `paymentId`, `amountSol`, `workerPubkey`, `serviceId`, `requestHash`, `idempotencyKey?`.

---

## 5. Phạm vi Ngoài Đợt này (Out of Scope)
- Cho phép agent tự sửa đổi Spending Policy hoặc tự nạp tiền ví mà không cần chữ ký của owner.
- Ký duyệt các giao dịch vượt hạn mức (chức năng duyệt bắt buộc thuộc quyền sở hữu của người dùng qua chữ ký ví cá nhân trên Dashboard).
- Triển khai MPC / Multisig ngoài kiến trúc Solana native PDA.

---

## 6. Tiêu chí Nghiệm thu (Acceptance Criteria)

- [ ] **Schema Parser-Safe:** Toàn bộ công cụ MCP khởi tạo thành công và tương thích hoàn toàn trên cả Gemini (Antigravity), Claude (Claude Desktop/Code) và OpenAI (Codex), không xuất hiện lỗi parse schema.
- [ ] **Actionable Errors:** Khi thực hiện transfer bị deny hoặc pending, payload trả về chứa đúng mã định danh kỹ thuật (`RECIPIENT_NOT_IN_ALLOWLIST`, `AMOUNT_EXCEEDS_TRANSACTION_LIMIT`,...) kèm trường `remediation` và thông số cụ thể.
- [ ] **Zero Double-Spend:** Kiểm thử kịch bản giả lập timeout Devnet: Khi agent retry 3 lần liên tiếp với cùng một `idempotencyKey`, chỉ có đúng 1 giao dịch được ký và nộp lên blockchain, 2 lần sau nhận về cùng execution record / signature.
- [ ] **Task Vault Tools:** AI Agent gọi được `nexuspay_list_task_vaults` và `nexuspay_execute_task_payment` qua MCP token mà không bị chặn quyền 401/403.
- [ ] **Đồng nhất Đơn vị:** 100% phản hồi từ chối từ Policy Engine sử dụng đơn vị `SOL`, không còn chuỗi text `lamports` chưa quy đổi.
- [ ] **Test Coverage:** Bổ sung test suites mới cho actionable errors và idempotency retry trong `@nexus/mcp` và `@nexus/agent`, toàn bộ tests đạt 100% PASS.
