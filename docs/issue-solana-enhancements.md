# [Feature / Proposal]: Tối ưu hóa hạ tầng giao dịch Solana và mở rộng kiến trúc On-chain Guard & Blinks

## 1. Bối cảnh & Vấn đề (Context & Problem Statement)

Module tương tác mạng Solana của hệ thống hiện tại tập trung trong các tệp [`agent/src/chain.ts`](file:///g:/Nexus/agent/src/chain.ts), [`agent/src/approvals.ts`](file:///g:/Nexus/agent/src/approvals.ts), và [`web/src/phantom.ts`](file:///g:/Nexus/web/src/phantom.ts). Qua rà soát kỹ thuật, hệ thống đang bộc lộ 4 nhóm hạn chế chính:

1. **Hạn chế định dạng giao dịch & Thiếu cơ chế phí ưu tiên (Compute Budget):**
   - Đang dùng định dạng cũ (`Legacy Transaction`), bị giới hạn MTU 1232 bytes và không thể dùng Address Lookup Tables (ALTs).
   - Không thiết lập `ComputeBudgetProgram` (`setComputeUnitPrice` và `setComputeUnitLimit`). Khi mạng Solana hoặc Devnet rơi vào trạng thái tải cao, giao dịch của ví agent dễ bị nghẽn (starvation) hoặc rớt khỏi mempool của validator.

2. **Quy trình chuyển SPL Token chưa nguyên tử (Non-atomic Token Transfers):**
   - Hàm `transferSpl` sử dụng `getOrCreateAssociatedTokenAccount` tuần tự. Nếu tài khoản nhận (`recipient`) chưa có ATA, thư viện sẽ phát một giao dịch tạo ATA riêng trước, sau đó mới gửi giao dịch chuyển tiền.
   - Luồng này làm tăng số lần round-trip mạng, tốn thêm RPC request và có nguy cơ thất bại giữa chừng nếu bước tạo ATA thành công nhưng bước chuyển token thất bại.

3. **Thiếu bước tiền kiểm tra mô phỏng (Pre-flight Simulation) & Hỗ trợ Token-2022:**
   - Giao dịch được ký và phát sóng trực tiếp bằng `sendAndConfirmTransaction` mà không thông qua `simulateTransaction`. Nếu có lỗi thực thi (tài khoản đích bị đóng băng, thiếu rent, logic lỗi), hệ thống vẫn mất phí mạng của ví agent mà không trích xuất được log chi tiết trước khi gửi.
   - Chưa phân biệt chương trình quản lý mint (`TOKEN_PROGRAM_ID` chuẩn cũ vs `TOKEN_2022_PROGRAM_ID` - Token Extensions).

4. **Kênh phê duyệt hạn chế & Rủi ro tín nhiệm tập trung (Off-chain Custody):**
   - Luồng phê duyệt khi vượt hạn mức (`pending_approval`) hiện phụ thuộc hoàn toàn vào giao diện web dashboard. Người dùng không thể phê duyệt tức thời từ ứng dụng chat hoặc ví di động.
   - Logic chính sách chi tiêu (`policy.ts`) hoàn toàn chạy off-chain trên máy chủ. Khóa riêng ví agent lưu trên đĩa (mã hóa AES-256-GCM), đồng nghĩa với việc vẫn tồn tại rủi ro nếu máy chủ bị xâm phạm trực tiếp.

---

## 2. Tiêu chuẩn nghiệm thu (Acceptance Criteria)

- [ ] **AC-1 (Nâng cấp Versioned Transaction & Compute Budget):**
  - Chuyển đổi toàn bộ cấu trúc giao dịch trong [`chain.ts`](file:///g:/Nexus/agent/src/chain.ts) và [`phantom.ts`](file:///g:/Nexus/web/src/phantom.ts) sang `VersionedTransaction` (message v0).
  - Tích hợp instruction `ComputeBudgetProgram.setComputeUnitLimit` và `ComputeBudgetProgram.setComputeUnitPrice` với mức phí ưu tiên động (dynamic priority fee) tính toán từ mạng.
- [ ] **AC-2 (Nguyên tử hóa giao dịch SPL Token):**
  - Gộp lệnh tạo ATA idempotent (`createAssociatedTokenAccountIdempotentInstruction`) và lệnh chuyển tiền (`createTransferCheckedInstruction`) vào chung **1 giao dịch duy nhất**.
  - Loại bỏ hoàn toàn 2 bước RPC rời rạc hiện tại trong `transferSpl`.
- [ ] **AC-3 (Tiền kiểm định bằng Transaction Simulation):**
  - Trước khi phát sóng giao dịch ra mạng, hệ thống chạy `connection.simulateTransaction()`. Nếu mô phỏng thất bại, ghi nhận mã lỗi và log chi tiết vào nhật ký kiểm toán (`audit.jsonl`), từ chối phát sóng để bảo toàn phí mạng.
- [ ] **AC-4 (Hỗ trợ SPL Token-2022):**
  - Tự động nhận diện mint thuộc `TOKEN_PROGRAM_ID` hay `TOKEN_2022_PROGRAM_ID` khi truy vấn thông tin mint, đảm bảo giao dịch chuyển token dùng đúng program ID đích.
- [ ] **AC-5 (Triển khai giao thức Solana Actions & Blinks cho luồng phê duyệt):**
  - Cung cấp endpoint chuẩn Solana Actions (`GET` và `POST` tại `/api/actions/approve/:requestId`).
  - Cho phép tài khoản chủ sở hữu mở liên kết Blink trên các nền tảng hỗ trợ (X/Twitter, Dialect, Phantom, Backpack) để ký phê duyệt giao dịch vượt hạn mức mà không cần mở web dashboard.
- [ ] **AC-6 (Nghiên cứu kiến trúc On-chain Vault & Policy Guard):**
  - Xây dựng đặc tả kỹ thuật và POC chương trình Anchor quản lý kho tiền (PDA Vault) và chính sách chi tiêu trên chain, hướng tới mô hình bảo mật Non-custodial hoàn toàn.

---

## 3. Thiết kế kỹ thuật chi tiết (Technical Specifications)

### 3.1. Tối ưu hóa cấu trúc giao dịch (`agent/src/chain.ts`)

Chuyển đổi luồng tạo giao dịch sang `VersionedTransaction`:

```typescript
// Định dạng cấu trúc message v0 với ComputeBudget
const recentPriorityFees = await connection.getRecentPrioritizationFees();
const priorityFee = calculatePriorityFee(recentPriorityFees); // median microLamports

const instructions = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey(recipient),
    lamports,
  }),
];

const messageV0 = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: blockhash,
  instructions,
}).compileToV0Message();

const tx = new VersionedTransaction(messageV0);
```

### 3.2. Chuyển token SPL nguyên tử (Atomic Transfer)

Xây dựng instruction ghép khối cho luồng `transferSpl`:

1. Lấy thông tin mint và program ID (`TOKEN_PROGRAM_ID` hoặc `TOKEN_2022_PROGRAM_ID`).
2. Xác định địa chỉ ATA nguồn (`sourceAta`) và đích (`destAta`).
3. Chuỗi instruction trong 1 transaction:
   - Instruction 1: `ComputeBudgetProgram.setComputeUnitLimit` + `setComputeUnitPrice`.
   - Instruction 2: `createAssociatedTokenAccountIdempotentInstruction(payer, destAta, recipient, mint, programId)`.
   - Instruction 3: `createTransferCheckedInstruction(sourceAta, mint, destAta, payer, baseUnits, decimals, [], programId)`.
4. Ký và gửi 1 lần duy nhất; loại bỏ rủi ro trạng thái không nhất quán giữa việc tạo ATA và chuyển tiền.

### 3.3. Quy cách đặc tả Solana Actions cho luồng phê duyệt

Đường dẫn: `agent/src/routes.ts` (hoặc module hóa tại `agent/src/actions.ts`):

- **`GET /api/actions/approve/:requestId`**:
  - Trả về metadata chuẩn Action:
    ```json
    {
      "icon": "https://:domain/icon.png",
      "title": "Phê duyệt giao dịch ví Agent",
      "description": "Yêu cầu chuyển :amount SOL đến địa chỉ :recipientAddress.",
      "label": "Ký phê duyệt"
    }
    ```
- **`POST /api/actions/approve/:requestId`**:
  - Nhận `account` (địa chỉ ví cá nhân của chủ sở hữu).
  - Kiểm tra tính hợp lệ và quyền sở hữu với `:requestId`.
  - Trả về payload chứa message cần ký (hoặc transaction xác thực) theo chuẩn Dialect Actions / Blinks spec.

---

## 4. Kế hoạch phân kỳ thực hiện (Phased Roadmap)

| Giai đoạn | Nội dung trọng tâm | Phạm vi tệp ảnh hưởng | Rủi ro hồi quy & Lưu ý |
| :--- | :--- | :--- | :--- |
| **P1** | - Tích hợp `VersionedTransaction (v0)`<br>- Cấu hình `ComputeBudgetProgram`<br>- Atomic SPL Token transfer<br>- Pre-flight `simulateTransaction` | [`agent/src/chain.ts`](file:///g:/Nexus/agent/src/chain.ts)<br>[`web/src/phantom.ts`](file:///g:/Nexus/web/src/phantom.ts) | Cần kiểm tra kỹ khả năng tương thích của ví Phantom với transaction message v0 khi nạp tiền. |
| **P2** | - Hỗ trợ Token-2022 (SPL Token Extensions)<br>- Triển khai Solana Actions & Blinks API | [`shared/src/contract.ts`](file:///g:/Nexus/shared/src/contract.ts)<br>[`agent/src/routes.ts`](file:///g:/Nexus/agent/src/routes.ts) | Actions API yêu cầu cấu hình CORS và headers đặc thù (`actions.json`). |
| **P3** | - Nghiên cứu và triển khai On-chain Anchor Program (PDA Vault)<br>- Thử nghiệm ZK Compression cho Audit Log | Repo/workspace mới hoặc `programs/` | Chuyển dịch mô hình lưu trữ, cần kế hoạch di trú dữ liệu cho các tài khoản hiện hữu. |

---

## 5. Kế hoạch kiểm thử & Tiêu chuẩn bảo đảm (Verification Gate)

1. **Kiểm thử đơn vị (Unit Tests):**
   - Viết test mô phỏng xây dựng transaction v0 và tính toán Compute Budget trong `agent/test/chain.test.ts`.
   - Kiểm tra logic phân nhánh giữa `TOKEN_PROGRAM_ID` và `TOKEN_2022_PROGRAM_ID`.
2. **Kiểm thử tích hợp trên Solana Devnet (`pnpm e2e`):**
   - Kịch bản chuyển SOL với priority fee: Kiểm tra signature trên Solana Explorer xác nhận có instruction Compute Budget.
   - Kịch bản chuyển SPL token tới địa chỉ ví nhận hoàn toàn mới (chưa có ATA): Xác nhận ATA được tạo và tiền được chuyển trong cùng 1 transaction slot.
   - Kịch bản mô phỏng lỗi: Gửi giao dịch với số dư không đủ hoặc tài khoản không hợp lệ, xác nhận hệ thống chặn lại ở bước simulation trước khi ký và phát sóng.
3. **Kiểm tra biên dịch & mã nguồn:**
   - Chạy `pnpm build` và `pnpm typecheck` đạt trạng thái PASS tuyệt đối.
