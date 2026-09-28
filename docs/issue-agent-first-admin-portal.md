# [Architecture / RFC]: Chuyển Dịch sang Admin Control Plane & Onboarding Agent-First (Pure Agents)

## 1. Tóm tắt & Động lực Thay đổi

Hiện tại, NexusPay vẫn còn mang nặng tư duy của một **dApp tiêu dùng truyền thống**:
- Người dùng bắt buộc phải cài đặt ví Phantom trên trình duyệt.
- Người dùng phải mở Web Dashboard, kết nối ví và ký thông điệp Ed25519 thì hệ thống mới tạo thư mục người dùng và sinh `mcp-token`.
- Nếu chưa có ví Phantom, AI Agent hoàn toàn không thể khởi động hoặc sử dụng được MCP server.

Điều này đi ngược lại định hướng **Pure Autonomous Agents (Agent thuần)**. Đối với một AI Agent hoạt động độc lập (trên Claude Desktop, Codex, Cursor, Antigravity...), Agent phải là **tác nhân độc lập cấp 1 (First-Class Citizen)**:
1. **Agent-First Onboarding:** Cài đặt MCP xong là Agent hoạt động được ngay lập tức, có sẵn ví Solana riêng, không bắt buộc người dùng phải cài ví Phantom hay mở trình duyệt web trước.
2. **Quản trị Đa Ví Agent (Multi-Agent Fleet Management):** Một chủ sở hữu (ví Phantom) có thể quản lý nhiều Agent độc lập, mỗi Agent có ví riêng, policy riêng, và ngân sách riêng.
3. **Dịch chuyển dApp thành Admin Control Plane:** Giao diện Web trở thành **Trang quản trị & Giám sát (Governance & Control Plane)**: thể hiện rõ ràng Agent đang được quản trị, cấp vốn nhanh, giám sát audit log và phê duyệt lệnh vượt ngưỡng.
4. **Phê duyệt Cục bộ Không Cần Trình Duyệt (Native CLI Popup / Zero-Browser UX):** Các lệnh duyệt nhạy cảm (như gửi ví lạ hoặc mở khóa ví) được thực hiện trực tiếp qua cửa sổ CLI / OS Dialog ngay tại desktop, không bắt người dùng phải chuyển ngữ cảnh sang trình duyệt web.
5. **Phòng thủ Chống Tool Điều Khiển Máy Tính (Anti-Automation / Anti-Computer-Use Defense):** Chống lại việc bot AI (như Claude Computer Use, PyAutoGUI, script giả lập chuột phím) tự động click hoặc gõ phím duyệt lệnh.
6. **Kênh Cảnh Báo Khẩn Cấp & Công Tắc Ngắt Từ Xa (Emergency Notification & Remote Kill Switch):** Tích hợp thông báo tức thời qua Telegram Bot và Email SMTP (miễn phí) để người dùng giám sát và khóa ví khẩn cấp từ điện thoại ngay cả khi không ngồi trước máy tính.

---

## 2. Phân tích Kỹ thuật: Bỏ Đăng nhập Phantom Lúc Đầu Có Khả Thi Không?

### 2.1. Đánh giá Tính Khả thi
- `[FACT]`: Hoàn toàn khả thi về mặt kỹ thuật. Bản chất ví Agent (`agentPubkey`) là một Keypair Solana độc lập nằm trên backend hoặc máy cục bộ, không phụ thuộc vào private key của Phantom.
- `[FACT]`: Sự phụ thuộc hiện tại vào Phantom chỉ xuất phát từ quy ước định danh: backend dùng `ownerPubkey` làm khóa định danh tenant thư mục (`users/<ownerPubkey>/`). Nếu người dùng chưa đăng nhập, backend chưa biết gán tenant cho ai.

### 2.2. Giải pháp Kiến trúc: Default Self-Provisioned Agent
Thay vì chờ `ownerPubkey`, khi backend hoặc MCP server khởi chạy lần đầu:
1. Backend tự động khởi tạo một **Local Agent Profile** (định danh theo `agentId` hoặc public key của chính agent: `agentPubkey`).
2. Tự động sinh `mcp-token` cục bộ.
3. Cấp một **Default Restrictive Policy (Chính sách Sandbox)**:
   - Hạn mức cực nhỏ (ví dụ tối đa 0.05 SOL/giao dịch).
   - Chỉ cho phép giao dịch trong danh mục allowlist mặc định.
   - Trạng thái quyền sở hữu: `UNCLAIMED` (Chưa liên kết chủ sở hữu).
4. AI Agent kết nối MCP và hoạt động được ngay:
   - Agent kiểm tra trạng thái (`nexuspay_get_status`): `"Wallet address: 3BJU..., Balance: 0 SOL, Status: UNCLAIMED"`.
   - Bất kỳ ai (từ sàn CEX, từ ví di động, từ airdrop) đều có thể chuyển thẳng SOL vào địa chỉ ví của Agent để cấp vốn hoạt động ban đầu mà không cần mở Dashboard.

---

## 3. Kiến Trúc Quản Trị Đa Ví Agents (Multi-Agent Fleet Management)

Một chủ sở hữu (1 ví Phantom) có thể sở hữu và điều hành một hạm đội nhiều AI Agents (ví dụ: Agent Code, Agent Cào Dữ Liệu, Agent Mạng Xã Hội).

### 3.1. Nguyên Tắc Cô Lập Rủi Ro (Risk Compartmentalization)
- Mỗi Agent sở hữu:
  - Cặp khóa Solana riêng biệt (`agentPubkey`).
  - File keystore mã hóa riêng biệt.
  - Token MCP riêng biệt (`nxp_<owner>_<agentId>_<secret>`).
  - Spending Policy riêng biệt (ví dụ: Agent Code có hạn mức 0.2 SOL chỉ thanh toán cho RPC node; Agent Cào Dữ Liệu có hạn mức 0.05 SOL chỉ trả phí proxy).
- Nếu một Agent bị lỗi hoặc bị dính prompt injection, các Agent khác và tài sản chính trong ví Phantom hoàn toàn không bị ảnh hưởng.

### 3.2. Hiển Thị Minh Bạch Trên Trang Quản Trị
Trên Admin Control Plane, giao diện bắt buộc phải thể hiện rõ Agent nào đang được chọn quản trị qua **Active Agent Card**:
- Tên định danh Agent (ví dụ: `Agent #1 - Coding Assistant`).
- Địa chỉ ví Agent (`agentPubkey`) kèm link Solana Explorer.
- Số dư thực tế (`SOL` & token SPL).
- Trạng thái Keystore (Đã mở khóa / Đang khóa / TTL còn lại).
- Hạn mức tiêu thụ trong ngày: `Đã tiêu / Trần cho phép` (ví dụ: `0.02 / 0.1 SOL`).

---

## 4. Cơ Chế Cấp Vốn Từ Ví Phantom Sang Ví Agent

### 4.1. Rào Cản Kỹ Thuật Của Phantom (`[FACT]`)
- Phantom Extension là môi trường bảo mật độc lập trong trình duyệt. Mọi hành vi rút tiền từ ví Phantom bắt buộc phải có thao tác click "Approve" của người dùng trên popup Phantom. Không có script hay backend nào được phép tự động rút tiền ngầm từ ví Phantom.

### 4.2. Cơ Chế 1: 1-Click Quick Top-Up (Bán tự động trên Dashboard)
- Trên Admin Dashboard, bên cạnh từng Agent Card có các nút: `[+0.1 SOL]`, `[+0.5 SOL]`, `[+1.0 SOL]`.
- Người dùng bấm nút $\rightarrow$ Dashboard tự tạo transaction chuyển SOL với địa chỉ người nhận là ví của Agent đó $\rightarrow$ Popup Phantom tự bật lên với số tiền đã điền sẵn.
- Người dùng bấm **"Approve" (1 giây)**. Tiền vào ví Agent mà không cần copy-paste địa chỉ thủ công.

### 4.3. Cơ Chế 2: Auto-Refill / Drip Allowance Vault (Tự động hóa hoàn toàn qua Smart Contract)
- Người dùng dùng ví Phantom ký nạp (ví dụ 2 SOL) vào một Smart Contract Vault gọi là `AllowanceVault`.
- Quy tắc on-chain: *"Ví Agent `3BJU...` được quyền tự động rút tối đa `0.05 SOL/ngày` từ Vault này khi số dư ví của nó dưới `0.01 SOL`."*
- Khi Agent sắp cạn tiền gas, Agent tự gọi instruction `claim_allowance` trên Smart Contract để nạp tiền về ví mình. Người dùng không cần mở Phantom duyệt tay hàng ngày.
- Người dùng có quyền rút toàn bộ số dư còn lại trong Vault về ví Phantom bất kỳ lúc nào.

---

## 5. Phê Duyệt Cục Bộ Tách Rời (Native CLI Popup & Zero-Browser UX)

Khi giao dịch được thanh toán bằng chính **Ví Vận Hành của Agent** (đã có sẵn tiền lẻ) nhưng gặp điều kiện cần phê duyệt (như chuyển tới ví lạ ngoài allowlist):

### 5.1. Loại Bỏ Sự Phụ Thuộc Vào Trình Duyệt Web
- Người dùng đang làm việc trong IDE / Claude Desktop không cần bị ép nhảy sang trình duyệt web.
- Agent Daemon tự động bật một cửa sổ dòng lệnh độc lập (**Native CLI Popup / Terminal Dialog**) ngay trên desktop:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ [NexusPay Security Guard - Action Authorization]                       │
├────────────────────────────────────────────────────────────────────────┤
│ AI Agent đang yêu cầu thực hiện giao dịch:                             │
│ • Thao tác:   Chuyển SOL                                               │
│ • Số tiền:    0.1 SOL (~$15.00)                                        │
│ • Người nhận: abc123xyz...                                             │
│ • Cảnh báo:   Địa chỉ này CHƯA CÓ trong Danh bạ An toàn                │
├────────────────────────────────────────────────────────────────────────┤
│ Nhập lựa chọn của bạn:                                                 │
│   [Y] Duyệt chuyển 1 lần duy nhất                                      │
│   [A] Duyệt và TỰ ĐỘNG THÊM vào Danh bạ (lần sau tự chuyển)            │
│   [N] Từ chối (Hủy lệnh)                                               │
│                                                                        │
│ Lựa chọn (Y/A/N) và Mật khẩu mở khóa ví: [ A / ********** ]             │
└────────────────────────────────────────────────────────────────────────┘
```

- Người dùng gõ lựa chọn kèm mật khẩu (nếu ví đang khóa) và bấm Enter $\rightarrow$ Cửa sổ CLI gửi dữ liệu qua Local IPC về Daemon và **tự động biến mất trong tích tắc**.
- Agent Daemon ký bằng ví Agent và gửi giao dịch lên mạng. AI Agent trong chat thông báo hoàn tất.

---

## 6. Phòng Thủ Chống Tool Điều Khiển Máy Tính (Anti-Automation / Anti-Computer-Use)

Một vấn đề an ninh cốt tử: **Liệu cửa sổ CLI Popup có bị các công cụ AI điều khiển chuột/bàn phím (như Claude Computer Use, PyAutoGUI, mã độc SendInput) tự động bấm duyệt hay không?**

### 6.1. Lỗ Hổng Của Prompt `[Y/N]` Đơn Thuần
- `[FACT]`: Nếu CLI chỉ hỏi `"Bạn có đồng ý không? (Y/N)"`, một script Python gọi `pyautogui.press('y')` hoặc `SendInput('y')` có thể dễ dàng bypass và tự duyệt lệnh mà người dùng thật không hề chạm vào bàn phím. **Cấm tuyệt đối thiết kế này.**

### 6.2. Ba Tầng Phòng Thủ Chống Tự Động Hóa Giả Mạo:

1. **Bắt buộc Mật khẩu Mở khóa (Passphrase Input):**
   - Tool điều khiển máy tính không thể biết mật khẩu trong đầu người dùng là gì để gõ vào ô mật khẩu (vốn hiển thị ký tự ẩn `***`).
2. **Phát hiện Phím Ảo (Synthetic Input Detection):**
   - `[FACT]`: Trên Windows, các sự kiện bàn phím do phần mềm tạo ra (`SendInput`, `keybd_event`) đều bị hệ điều hành gắn cờ `LLKHF_INJECTED`.
   - Daemon cài đặt hook bàn phím cấp thấp: Nếu phát hiện cờ `INJECTED` ➔ **Lập tức từ chối giao dịch** và cảnh báo: *"Phát hiện thao tác phím ảo từ phần mềm tự động hóa!"*. Tín hiệu duyệt bắt buộc phải xuất phát từ phần cứng bàn phím vật lý.
3. **Sinh Trắc Học Phần Cứng (Hardware Biometrics / FIDO2 - Mức Tối Cao):**
   - Tích hợp Windows Hello (Vân tay / Face ID) hoặc Mac Touch ID / Khóa bảo mật vật lý YubiKey.
   - `[FACT]`: Không một phần mềm hay AI nào có thể dùng code để giả lập tín hiệu quét vân tay người thật hoặc chạm vào nút cảm ứng điện dung của YubiKey.

---

## 7. Kênh Thông Báo Khẩn Cấp & Công Tắc Ngắt Từ Xa (Emergency Notification & Remote Kill Switch)

Khi AI Agent chạy tự động trong nền (ban đêm, hoặc khi người dùng không ngồi trước máy tính), việc phát hiện sự cố bất thường phải được gửi ngay tức thì về điện thoại của người dùng mà không phụ thuộc vào màn hình máy tính.

### 7.1. Các Tình Huống Kích Hoạt Cảnh Báo Khẩn Cấp (Trigger Events)
1. **Phát hiện Tấn công Tự động hóa:** Phát hiện cờ `LLKHF_INJECTED` giả lập phím gõ vào popup CLI.
2. **Giao dịch Vượt Ngưỡng Cao:** Lệnh chi tiêu lớn rơi vào trạng thái `pending_approval`.
3. **Cảnh báo Cạn Kiệt Số Dư (Low Balance):** Số dư ví Agent giảm xuống dưới mức tối thiểu cần để vận hành.
4. **Vi Phạm Chính Sách Liên Tiếp (Consecutive Policy Denials):** Dấu hiệu Agent bị spam hoặc tấn công prompt injection liên tục.

### 7.2. Kênh 1: Telegram Bot (Ưu tiên số 1 - Khuyên dùng tối đa)
- **Ưu điểm vượt trội:**
  - **Miễn phí 100% vĩnh viễn, không giới hạn số lượng tin nhắn.**
  - Nhận Push Notification tức thì trên điện thoại và đồng hồ thông minh (độ trễ < 1 giây).
  - Không cần mua tên miền hay cấu hình DNS phức tạp.
- **Tương tác 2 Chiều & Công Tắc Ngắt Từ Xa (Remote Kill Switch):**
  - Tin nhắn cảnh báo gửi kèm các nút bấm hành động (Inline Keyboard Buttons):
    ```text
    🚨 [NexusPay Alert] Phát hiện giao dịch vượt hạn mức!
    • Agent: Coding Assistant
    • Số tiền: 0.8 SOL (~$120.00)
    • Người nhận: 8xQe... (Ví lạ)

    [ 🟢 Phê duyệt ]   [ 🔴 KHÓA VÍ KHẨN CẤP (Kill Switch) ]
    ```
  - Khi người dùng bấm **`[ Khóa ví khẩn cấp ]`** trên điện thoại: Telegram Bot gửi webhook về Agent Daemon để **ngắt kết nối MCP, đóng băng ví Agent và vô hiệu hóa token ngay lập tức**.

### 7.3. Kênh 2: Email SMTP Miễn Phí (Giải Pháp Thay Thế Resend Thu Phí)
- `[FACT]`: Các dịch vụ như Resend thường giới hạn khắt khe tài khoản miễn phí và bắt buộc người dùng phải sở hữu tên miền riêng (`custom domain`) có xác thực bản ghi DNS (SPF, DKIM).
- **Giải pháp tối ưu không tốn phí:** Sử dụng **Nodemailer với chuẩn SMTP cá nhân (Gmail App Password / Outlook / iCloud)**:
  - 100% miễn phí, không mất bất kỳ chi phí duy trì nào.
  - Người dùng chỉ cần tạo một **Mật khẩu Ứng dụng (App Password)** trên tài khoản Gmail cá nhân và điền vào file `.env`:
    ```env
    ALERT_SMTP_HOST=smtp.gmail.com
    ALERT_SMTP_PORT=465
    ALERT_SMTP_USER=user@example.com
    ALERT_SMTP_PASS=xxxx-xxxx-xxxx-xxxx
    ALERT_NOTIFY_EMAIL=user@example.com
    ```
  - Daemon tự động gửi email cảnh báo chi tiết có format HTML chuẩn khi xảy ra sự cố nghiêm trọng.

### 7.4. Kênh 3: Discord Webhook (Tùy chọn bổ sung)
- Cung cấp tùy chọn cấu hình URL Discord Webhook để gửi thông báo vào một channel Discord riêng tư của người dùng (thiết lập trong 30 giây, hoàn toàn miễn phí).

---

## 8. Phân tích Rủi ro & Bất biến Bảo mật (Security Invariants)

| Rủi ro | Giải pháp kỹ thuật bảo vệ |
| :--- | :--- |
| **Tool AI tự duyệt lệnh của chính nó** | Cấm prompt `Y/N` đơn thuần; áp dụng Synthetic Input Detection (chặn cờ `LLKHF_INJECTED`) và bắt buộc mật khẩu / Windows Hello. |
| **Lộ mật khẩu qua Agent** | Áp dụng Out-of-Band Pinentry; Agent hoàn toàn không có tham số nhận mật khẩu trong context chat. |
| **Front-running Claim khi Agent chưa có chủ** | Nonce liên kết (`claimNonce`) chỉ được sinh trên máy cục bộ, yêu cầu kết nối loopback (`localhost`). |
| **Rút tiền trái phép từ ví Phantom** | Rào cản sandbox của Phantom Extension bắt buộc người dùng click Approve trên popup độc lập. |
| **Thiệt hại tối đa khi ví Agent bị thỏa hiệp** | Bị giới hạn trong số dư tiền lẻ của ví Agent đó; tài sản chính trong ví Phantom và các Agent khác được cô lập tuyệt đối. |
| **Sự cố ngoài giờ làm việc** | Telegram Bot push cảnh báo tức thì kèm nút Remote Kill Switch ngắt hoạt động ví Agent ngay trên điện thoại. |

---

## 9. Tiêu chí Nghiệm thu (Acceptance Criteria)

- [ ] AI Agent khởi động MCP server và truy vấn được trạng thái ví ngay cả khi chưa từng đăng nhập vào Web Dashboard.
- [ ] Admin Control Plane hiển thị chính xác thẻ thông tin của Agent Wallet đang được quản trị (tên, pubkey, số dư, policy, trạng thái keystore).
- [ ] Tính năng 1-Click Quick Top-up trên Dashboard tạo đúng transaction nạp tiền vào ví Agent và kích hoạt popup Phantom thành công.
- [ ] Khi gặp giao dịch cần phê duyệt, Daemon bật cửa sổ CLI popup độc lập trên desktop, nhận lệnh người dùng và tự động đóng lại mà không cần mở trình duyệt.
- [ ] Cửa sổ CLI từ chối các sự kiện phím ảo mang cờ `LLKHF_INJECTED` từ các công cụ tự động hóa chuột/phím.
- [ ] Khi phát hiện hành vi phím ảo khả nghi hoặc lệnh vượt ngưỡng, Daemon tự động bắn thông báo tức thời qua **Telegram Bot** và **Email SMTP (Gmail App Password)**.
- [ ] Người dùng bấm nút **Kill Switch** trên Telegram Bot làm đóng băng ví Agent thành công ngay lập tức.
- [ ] Người dùng ghép nối ví Owner qua quy trình Claiming thành công và chuyển trạng thái Agent sang `CLAIMED`.
