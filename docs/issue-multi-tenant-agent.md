# [Feature]: Triển khai kiến trúc Multi-Tenant Isolated Agent cho từng tài khoản người dùng

## 1. Bối cảnh & Vấn đề (Context & Problem Statement)
Hệ thống hiện tại được thiết kế theo mô hình đơn chủ sở hữu (single-owner):
- Toàn bộ phiên làm việc chỉ chấp nhận 1 địa chỉ ví cá nhân cố định (`:adminPubkey`).
- Toàn bộ các yêu cầu thanh toán dùng chung 1 ví agent ký on-chain (`data/agent-keystore.json`).
- Toàn bộ dữ liệu (chính sách, lịch sử lệnh, bản đồ chống lặp) được lưu trữ chung trong một tệp (`data/state.json`).

Hệ quả khi triển khai bản demo cho nhiều người dùng:
- Các tài khoản người dùng khác không thể tạo phiên đăng nhập (lỗi `403 wallet_not_owner`).
- Nếu vô hiệu hóa xác thực, các tài khoản người dùng sẽ ghi đè trạng thái chủ sở hữu của nhau, làm mất quyền phê duyệt giao dịch (`wrong_signer`).
- Không có sự phân tách tài chính: mọi giao dịch đều tiêu trừ trực tiếp số dư của cùng một ví agent.

## 2. Yêu cầu nghiệp vụ & Tiêu chuẩn nghiệm thu (Acceptance Criteria)

- [ ] **AC-1 (Đăng nhập đa tài khoản):** Bất kỳ tài khoản người dùng nào kết nối ví cá nhân hợp lệ đều có thể ký challenge để khởi tạo phiên làm việc độc lập.
- [ ] **AC-2 (Cấp phát ví Agent riêng biệt):** Khi tài khoản người dùng đăng nhập lần đầu, máy chủ tự động khởi tạo và mã hóa cặp khóa ví agent riêng cho tài khoản đó tại `data/users/:ownerPubkey/agent-keystore.json`.
- [ ] **AC-3 (Cô lập dữ liệu tuyệt đối):** Dữ liệu chính sách (`Policy`), nhật ký kiểm toán (`AuditLog`), và lịch sử yêu cầu (`PaymentRequest`) của tài khoản người dùng A không thể bị truy cập hoặc ghi đè bởi tài khoản người dùng B.
- [ ] **AC-4 (Bảo lưu dữ liệu quản trị viên):** Trạng thái, chính sách và lịch sử hiện có của `:adminPubkey` được tự động bảo lưu và chuyển vào thư mục `data/users/:adminPubkey/`.
- [ ] **AC-5 (Cơ chế cấp vốn ban đầu một lần):** Máy chủ duy trì một ví tổng (`Master Funder`) để cấp một khoản vốn thử nghiệm cố định (~0.1 SOL Devnet) cho ví agent mới khi tài khoản người dùng kích hoạt nhận vốn lần đầu. Mỗi tài khoản chỉ được nhận 1 lần duy nhất.
- [ ] **AC-6 (Nạp tiền từ ví cá nhân):** Giao diện cung cấp chức năng cho phép tài khoản người dùng nạp Devnet SOL trực tiếp từ ví cá nhân sang ví agent của mình.
- [ ] **AC-7 (Xác thực phê duyệt chuẩn xác):** Giao dịch vượt hạn mức của tài khoản người dùng nào thì chỉ có ví cá nhân của chính tài khoản đó mới có quyền ký phê duyệt.

## 3. Thiết kế kỹ thuật chi tiết (Technical Specifications)

### 3.1. Phân vùng lưu trữ dữ liệu
```text
data/
├── master-funder.json           # Cặp khóa ví tổng cấp vốn của máy chủ (AES-256-GCM)
└── users/
    ├── :adminPubkey/            # Thư mục dữ liệu của Quản trị viên (bảo lưu dữ liệu cũ)
    │   ├── agent-keystore.json
    │   ├── state.json
    │   └── audit.jsonl
    └── :ownerPubkey/            # Thư mục dữ liệu riêng của từng tài khoản người dùng
        ├── agent-keystore.json  # Khóa bí mật ví agent của user (AES-256-GCM)
        ├── state.json           # Policy, Requests, Idempotency map
        └── audit.jsonl          # Nhật ký kiểm toán riêng biệt
```

### 3.2. Quy cách module cần sửa đổi

1. **Cấu hình & Phiên (`agent/src/config.ts`, `agent/src/sessions.ts`):**
   - Hỗ trợ biến cấu hình `:adminPubkey` (nhận diện tài khoản quản trị).
   - `SessionManager`: Xóa bỏ kiểm tra cố định một địa chỉ ví duy nhất; lưu trữ phiên dạng `:tokenHash -> { owner: :ownerPubkey, expiresAt: number }`.
2. **Quản lý quỹ cấp vốn (`agent/src/funder.ts`):**
   - Khởi tạo và quản lý cặp khóa ví tổng cấp vốn (`Master Funder`).
   - Cung cấp hàm chuyển 0.1 SOL từ ví tổng sang ví agent của tài khoản người dùng.
3. **Quản lý lưu trữ & Ngữ cảnh người dùng (`agent/src/store.ts`, `agent/src/context.ts`):**
   - Bổ sung trường `claimedInitialFunding: boolean` vào cấu trúc `StoreData`.
   - Hàm `getUserContext(:ownerPubkey)`: Tải hoặc khởi tạo riêng rẽ cặp khóa ví agent, `Store`, và `AuditLog` theo từng thư mục tài khoản.
4. **Tầng định tuyến API (`agent/src/server.ts`, `agent/src/routes.ts`):**
   - Middleware `preHandler`: Giải mã phiên để xác định `:ownerPubkey`.
   - Các endpoint nghiệp vụ (`/api/state`, `/api/policy`, `/api/commands`, `/api/requests`, `/api/requests/:id/approve`) thao tác theo context của `:ownerPubkey`.
   - Endpoint mới: `POST /api/agent/claim-seed` cho phép nhận vốn một lần.
5. **Giao diện Dashboard (`web/src/api.ts`, `web/src/App.tsx`, `web/src/components/AgentPanel.tsx`):**
   - Hiển thị song song địa chỉ ví cá nhân và ví agent riêng biệt.
   - Bổ sung nút nhận vốn ban đầu ("Claim 0.1 SOL") và nút nạp tiền ("Deposit from Phantom").
   - Hiển thị liên kết/icon tới trang vòi Devnet chính thức của mạng Solana.

## 4. Kế hoạch kiểm thử & nghiệm thu
- Chạy toàn bộ unit tests: `pnpm test` (PASS).
- Kiểm tra toàn bộ kiểu dữ liệu và bản dựng: `pnpm build` (PASS).
- Kiểm tra độc lập trên 2 phiên trình duyệt đồng thời để xác nhận tính cô lập dữ liệu.
