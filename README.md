# nexusPay

[![CI](https://github.com/thanhhau15112000-dev/NexusWallet/actions/workflows/ci.yml/badge.svg?branch=staging)](https://github.com/thanhhau15112000-dev/NexusWallet/actions/workflows/ci.yml)

**Ví có kiểm soát chi tiêu cho AI agent trên Solana.**

> Model quyết định *làm gì*. Model không bao giờ quyết định *có được phép hay không*.

- Demo (Solana Devnet): https://nexuspay-56wn.onrender.com
- MCP endpoint: `https://nexuspay-56wn.onrender.com/mcp`
- Program Task Vault (Devnet): [`3N4GYuQXvqhDeFKLWh4GiXdD3pr3PWcNRtkUyxSYPaUK`](https://explorer.solana.com/address/3N4GYuQXvqhDeFKLWh4GiXdD3pr3PWcNRtkUyxSYPaUK?cluster=devnet)

## Mục lục

1. [Tóm tắt](#tóm-tắt)
2. [Vấn đề nexusPay giải quyết](#vấn-đề-nexuspay-giải-quyết)
3. [Cách nexusPay hoạt động](#cách-nexuspay-hoạt-động)
4. [Điểm nổi bật](#điểm-nổi-bật)
5. [Thử nhanh](#thử-nhanh)
6. [Khó khăn và cách khắc phục](#khó-khăn-và-cách-khắc-phục)
7. [Phạm vi và giới hạn](#phạm-vi-và-giới-hạn)
8. Chi tiết kỹ thuật: [Vì sao là Solana](#vì-sao-là-solana) · [Kiến trúc](#kiến-trúc) · [Bảo đảm an toàn](#bảo-đảm-an-toàn) · [Task Capability Vault](#task-capability-vault) · [Kết nối AI agent (MCP)](#kết-nối-ai-agent-mcp) · [Kịch bản demo](#kịch-bản-demo) · [Chạy local](#chạy-local) · [Deploy hosted](#deploy-hosted) · [Kiểm thử](#kiểm-thử) · [Cấu trúc repo](#cấu-trúc-repo) · [Lộ trình](#lộ-trình) · [Giấy phép](#giấy-phép)

## Tóm tắt

nexusPay cho phép AI agent tự trả tiền trên Solana, trong khi chủ ví vẫn giữ quyền kiểm soát.

Chủ ví đặt luật chi tiêu: mỗi lần được chi tối đa bao nhiêu, mỗi ngày tối đa bao nhiêu, và được trả cho những ai. Agent chỉ được *đề xuất* giao dịch. Hệ thống so đề xuất với luật rồi quyết định:

- Khoản nhỏ, người nhận quen → ký ngay, không cần ai duyệt.
- Khoản vượt hạn mức → chờ chủ ví duyệt bằng ví Phantom.
- Người nhận không có trong danh sách → từ chối.

Agent không có cách nào tự đổi luật, tự duyệt hay tự mở khóa cho mình. Với công việc nhiều bước, chủ ví có thể khóa ngân sách vào một hợp đồng trên chain (Task Vault) để agent chỉ tiêu được trong ngân sách và thời hạn đó.

Dự án chạy trên Solana Devnet, là mạng thử nghiệm nên tiền không có giá trị thật.

## Vấn đề nexusPay giải quyết

AI agent ngày càng tự làm những việc tốn tiền: gọi API trả phí, thuê agent hoặc dịch vụ khác, mua tài nguyên. Muốn agent trả được tiền, hiện có hai cách và cả hai đều có vấn đề:

1. **Đưa private key cho agent.** Agent có toàn quyền với ví. Chỉ cần một prompt độc hại lừa được agent là có thể mất hết tiền.
2. **Bắt người duyệt từng giao dịch.** An toàn hơn, nhưng agent không còn tự chủ. Khoản nhỏ nào cũng phải chờ người bấm duyệt.

Còn thiếu một lớp ở giữa: cho agent tự chi trong phạm vi được cấp, và chặn hẳn mọi thứ vượt phạm vi. Việc chặn phải nằm trong code và chữ ký số, không dựa vào lời dặn trong prompt.

## Cách nexusPay hoạt động

**Bước 1. Chủ ví thiết lập.** Đăng nhập dashboard bằng ví Phantom. Mỗi chủ ví nhận một ví agent riêng, rồi đặt luật chi tiêu: hạn mức mỗi giao dịch, trần chi trong 24 giờ, danh sách người nhận được phép (allowlist).

**Bước 2. Kết nối AI agent.** Agent kết nối qua MCP, giao thức để AI agent gọi công cụ bên ngoài. Chỉ cần một URL và một token, không cài gì trên máy chạy agent. Dashboard tạo sẵn cấu hình cho Claude Code, Codex và Antigravity.

**Bước 3. Agent đề xuất, luật quyết định.** Mỗi đề xuất chuyển tiền có một trong ba kết quả:

| Kết quả | Khi nào | Điều xảy ra |
| --- | --- | --- |
| Cho phép | Trong hạn mức, người nhận có trong allowlist | Ví agent ký ngay, trả về link Explorer |
| Chờ duyệt | Vượt hạn mức một giao dịch hoặc trần 24 giờ | Chưa ký gì. Chủ ví duyệt bằng Phantom trong 300 giây, hoặc hủy |
| Từ chối | Người nhận ngoài allowlist, số tiền không hợp lệ, agent đang bị khóa | Không ký, không có đường duyệt |

Chủ ví có nút khóa khẩn cấp (kill switch): khi bật, ví agent không ký bất kỳ giao dịch chuyển tiền nào.

**Bước 4 (tùy chọn). Task Vault cho công việc nhiều bước.** Chủ ví nạp ngân sách cho một nhiệm vụ vào hợp đồng trên Solana, kèm thời hạn, mức trả tối đa mỗi lần và danh sách worker được nhận tiền. Agent trả cho worker qua một khoản tạm giữ (escrow). Worker phải ký xác nhận kết quả thì mới nhận được tiền. Hết hạn hoặc bị thu hồi thì phần còn lại trả về chủ ví. Các luật này nằm trên chain, không phụ thuộc server của nexusPay.

## Điểm nổi bật

Mỗi điểm dưới đây có test hoặc giao dịch trên chain để kiểm tra lại.

**1. Luật nằm trong code, không nằm trong prompt.** Agent chỉ có 5 công cụ: xem trạng thái, xem request và đề xuất chuyển tiền. Không công cụ nào đổi luật, duyệt request hay mở khóa agent. Nếu agent bị lừa qua prompt, nó vẫn chỉ chi được trong hạn mức và cho người nhận trong allowlist. Nếu model lập kế hoạch lệch yêu cầu ban đầu (đổi người nhận hoặc số tiền), giao dịch bị từ chối, kể cả khi người nhận mới cũng nằm trong allowlist.
Kiểm chứng: [policy.test.ts](agent/test/policy.test.ts), [pipeline.test.ts](agent/test/pipeline.test.ts), [mcp.test.ts](mcp/test/mcp.test.ts)

**2. Duyệt bằng chữ ký ví, không giả mạo hay dùng lại được.** Chữ ký duyệt gắn với đúng request, số tiền, người nhận, phiên bản luật và thời hạn. Hệ thống từ chối chữ ký từ ví khác, chữ ký trên nội dung đã bị sửa, chữ ký dùng lại lần hai, chữ ký quá hạn, và chữ ký ký trên phiên bản luật cũ.
Kiểm chứng: [approval.test.ts](agent/test/approval.test.ts), [e2e.ts](agent/scripts/e2e.ts)

**3. Trần chi SOL theo ngày không lách được.** Chia nhỏ khoản tiền hay gửi nhiều giao dịch cùng lúc đều không vượt trần 24 giờ khi chưa có chủ ví duyệt. Trần này áp dụng cho SOL; SPL token chỉ có hạn mức mỗi giao dịch. Gọi lại cùng một giao dịch sau khi timeout cũng không bị trả tiền hai lần.
Kiểm chứng: [daily-cap.test.ts](agent/test/daily-cap.test.ts)

**4. Nút khóa khẩn cấp có hiệu lực ở mọi đường ký.** Khi bật, mọi đường ví agent ký chuyển tiền đều bị chặn: qua MCP, qua dashboard, qua duyệt request, qua thanh toán và settle của Task Vault. Hoàn tiền Task Vault về chủ ví và thu hồi task vẫn được phép. Trạng thái khóa vẫn giữ sau khi server khởi động lại, với điều kiện thư mục dữ liệu của server được giữ lại. Khóa agent của một chủ ví không ảnh hưởng chủ ví khác.
Kiểm chứng: [kill-switch.test.ts](agent/test/kill-switch.test.ts)

**5. Task Vault đã chạy trên Devnet.** Bảng giao dịch của lần kiểm tra ngày 28/9 có 28 chữ ký: 16 thành công, 12 bị program từ chối đúng như mong đợi (vượt mức mỗi lần trả, vượt ngân sách, worker hoặc service không được phép, sai người ký). Tại thời điểm kiểm tra, binary trên chain khớp từng byte với bản build local; program vẫn có quyền nâng cấp.
Kiểm chứng: [issue #6](../../issues/6), [verify-task-vault-devnet.ts](agent/scripts/verify-task-vault-devnet.ts)

**6. Phản hồi viết để agent tự hiểu.** Khi bị chặn hoặc phải chờ duyệt, agent nhận về mã lỗi, hướng xử lý và số liệu cụ thể, ví dụ còn bao nhiêu SOL trong trần ngày. Agent dựa vào đó để điều chỉnh thay vì thử lại y nguyên.
Kiểm chứng: [mcp.test.ts](mcp/test/mcp.test.ts), [policy.ts](shared/src/policy.ts)

Tổng cộng `pnpm test` có 273 test pass. 3 test chạy trên chain bị bỏ qua khi máy không chạy Solana local validator ([chi tiết](#kiểm-thử)). Dự án chưa được audit bảo mật độc lập.

## Thử nhanh

1. Cài ví Phantom, bật **Testnet Mode** trong Developer Settings và chọn Solana Devnet.
2. Mở https://nexuspay-56wn.onrender.com và kết nối ví.
3. Nạp SOL Devnet cho ví agent: dùng nút nhận 0.1 SOL hoặc Airdrop trên dashboard, hoặc lấy ở https://faucet.solana.com.
4. Làm theo [Kịch bản demo](#kịch-bản-demo): đặt luật, kết nối agent qua MCP, thử lần lượt các trường hợp cho phép, chờ duyệt, từ chối và khóa agent.

## Khó khăn và cách khắc phục

### Khi dùng thử

| Gặp tình huống | Lý do | Cách xử lý |
| --- | --- | --- |
| Không ký được, hoặc giao dịch không hiện trên Explorer Devnet | Phantom đang ở mainnet | Bật **Testnet Mode** trong Developer Settings của Phantom, chọn Solana Devnet |
| Agent báo `INSUFFICIENT_FUNDS_INCLUDING_FEES` | Ví agent không đủ SOL, tính cả phí mạng | Nạp thêm bằng nút nhận 0.1 SOL (mỗi agent được một lần) hoặc Airdrop trên dashboard. Nếu airdrop bị giới hạn, dùng https://faucet.solana.com |
| Khi nạp tiền cho agent, Phantom báo không đủ SOL ở dòng phí | Cảnh báo do Phantom tự quét giao dịch, không phải từ nexusPay | Kiểm tra `receiver` đúng địa chỉ ví agent rồi xác nhận. Chi tiết ở [mcp-troubleshooting.md](docs/mcp-troubleshooting.md#nạp-sol-từ-phantom-trên-dashboard) |
| Agent báo `RECIPIENT_NOT_IN_ALLOWLIST` | Đúng thiết kế: người nhận chưa có trong allowlist | Thêm người nhận ở tab **Policy**, ví dụ bằng *Use owner wallet* |
| Khoản nhỏ vẫn bị giữ lại, báo `DAILY_LIMIT_EXCEEDED` | Đúng thiết kế: tổng chi trong 24 giờ đã chạm trần | Duyệt trên dashboard, hoặc tăng *Max per day* ở tab **Policy** |
| Request không duyệt được nữa, trạng thái `expired` | Đã quá 300 giây kể từ lúc request được tạo | Cho agent đề xuất lại giao dịch |
| Mọi giao dịch đều báo `AGENT_FROZEN` | Chủ ví đang bật khóa khẩn cấp | Bấm **Unfreeze agent** ở tab **Overview** |
| Dashboard tự đăng xuất, báo phiên đã hết hạn | Phiên đăng nhập hết hạn (mặc định 30 phút) | Kết nối và ký lại bằng Phantom |
| Client MCP báo `401` hoặc `mcp_token_rejected` | Token đã bị đổi, hoặc copy thiếu | Copy lại cấu hình ở card **Connect an AI agent (MCP)** rồi cập nhật client |
| Payment của Task Vault bị từ chối dù task vẫn còn ngân sách | Số tiền vượt mức trả tối đa mỗi lần của task | Nhập số tiền không vượt mức đó |
| Không đóng được Task Vault | Vẫn còn khoản escrow đang tạm giữ | Cho worker ký xác nhận để nhận tiền, hoặc chờ task hết hạn rồi hoàn tiền |

Lỗi khi cài MCP vào từng client: xem [docs/mcp-troubleshooting.md](docs/mcp-troubleshooting.md).

### Khi xây dựng

Những vấn đề nhóm đã gặp hoặc đã lường trước trong quá trình làm, và cách xử lý trong code:

| Vấn đề | Cách xử lý | Kiểm chứng |
| --- | --- | --- |
| Agent gọi lại sau khi timeout có thể làm trả tiền hai lần | Mỗi đề xuất mang một `idempotencyKey`. Gọi lại cùng key thì nhận lại kết quả cũ. Nhiều lần gọi lại cùng lúc dùng chung một kết quả. Dùng key cũ cho giao dịch khác thì bị từ chối | [pipeline.test.ts](agent/test/pipeline.test.ts), [daily-cap.test.ts](agent/test/daily-cap.test.ts) |
| Nhiều giao dịch gửi cùng lúc có thể cùng lọt qua trần ngày | Có test gửi đồng thời bằng `Promise.all`, tổng chi không vượt trần | [daily-cap.test.ts](agent/test/daily-cap.test.ts) |
| Model có thể lập kế hoạch sai, hoặc đổi người nhận và số tiền | Kế hoạch của model được đối chiếu với yêu cầu ban đầu, lệch thì từ chối. Kế hoạch đúng vẫn phải qua luật chi tiêu | [pipeline.test.ts](agent/test/pipeline.test.ts) |
| Chủ ví đổi luật trong lúc giao dịch đang được xử lý | Luật được kiểm lại ngay trước khi ký. Chữ ký duyệt trên phiên bản luật cũ không còn hiệu lực | [pipeline.test.ts](agent/test/pipeline.test.ts), [approval.test.ts](agent/test/approval.test.ts) |
| Gửi số SOL tối đa làm giao dịch thất bại vì ví agent thiếu tiền rent | Khi tính số tiền tối đa có thể gửi, giữ lại cả phí mạng lẫn mức rent tối thiểu | PR [#55](../../pull/55) |
| Antigravity (Gemini) từ chối một số từ khóa trong schema của công cụ | Schema của công cụ chỉ dùng các từ khóa Gemini chấp nhận | [mcp.test.ts](mcp/test/mcp.test.ts) |
| Server nexusPay ngừng hoạt động thì tiền trong Task Vault có thể bị kẹt | Sau khi task hết hạn, bất kỳ ai cũng gọi được lệnh hoàn tiền trên chain, và tiền chỉ trả về chủ ví | [Task Capability Vault](#task-capability-vault) |

### Rủi ro chưa xử lý: bị botnet hoặc DDoS làm sập

**Hiện trạng.** Server chưa giới hạn số request theo IP hay theo token (rate limit); việc này đang nằm trong [lộ trình](#lộ-trình). Nếu bị botnet gửi request dồn dập, server có thể chậm hoặc ngừng phản hồi.

**Nếu server sập, tiền sẽ ra sao:**

| Phần | Ảnh hưởng |
| --- | --- |
| Ví agent | Không có giao dịch nào được ký, vì chỉ server giữ key của ví agent. Tiền vẫn nằm trên chain và không mất, nhưng cả agent lẫn chủ ví đều không chuyển được tiền đi cho tới khi server chạy lại |
| Task Vault | Tiền nằm trong hợp đồng trên chain. Sau khi task hết hạn, bất kỳ ai cũng gọi được lệnh hoàn tiền về chủ ví mà không cần server |
| Request đang chờ duyệt | Quá 300 giây thì hết hạn; agent phải đề xuất lại sau khi server hoạt động trở lại |

Riêng nút nhận 0.1 SOL: mỗi ví agent được nhận một lần, nhưng chưa có giới hạn tổng. Botnet tạo nhiều ví Phantom có thể dùng hết SOL của ví cấp phát. Khi đó người dùng mới không nhận được seed và phải lấy SOL từ faucet. Đây là SOL Devnet, không có giá trị thật.

**Hướng khắc phục (chưa làm):**

- Rate limit theo IP và theo token cho các route đăng nhập, đề xuất giao dịch và nhận seed.
- Đặt CDN hoặc WAF có chống DDoS phía trước server.
- Giới hạn tổng số seed phát ra mỗi ngày. Khi cần, chỉ cho phép một danh sách ví đăng nhập bằng biến `ALLOWED_OWNERS` (đã có).
- Về lâu dài: cho chủ ví tự rút tiền khỏi ví agent mà không cần server, ví dụ chuyển ví agent sang program on-chain như Task Vault.

## Phạm vi và giới hạn

**Đã có:** Solana Devnet, chuyển SOL và SPL token theo allowlist, luật riêng cho từng chủ ví, hạn mức mỗi giao dịch, trần chi SOL trong 24 giờ, khóa khẩn cấp, duyệt bằng chữ ký Phantom hoặc hủy request, lịch sử ví agent, remote MCP, Task Capability Vault (SOL), audit log mã hóa, giao diện tiếng Anh và tiếng Việt.

**Chưa có:** mainnet, swap/staking/NFT, gọi program tùy ý, trần ngày cho SPL token, quy đổi tiền pháp định, xử lý seed phrase.

**Giới hạn đã biết:**

- Ví agent do server nexusPay giữ key (đã mã hóa AES-256-GCM). Chỉ tiền nằm trong Task Vault mới không phụ thuộc server.
- MCP token đang lưu dạng plaintext trên disk của server. Chuyển sang lưu dạng hash nằm trong lộ trình.
- Chữ ký xác nhận của worker chỉ chứng minh worker đã xác nhận kết quả, không chứng minh kết quả đó tốt hay đúng.
- Chưa có rate limit; botnet hoặc DDoS có thể làm server ngừng phản hồi ([chi tiết](#rủi-ro-chưa-xử-lý-bị-botnet-hoặc-ddos-làm-sập)).

---

# Chi tiết kỹ thuật

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

Chuẩn bị: Phantom ở Devnet, đăng nhập dashboard. Dữ liệu (ví agent, policy, token MCP) là của từng ví Phantom. Tab **Policy**: đặt *Max per transaction* `0.1 SOL`, *Max per day* `0.2 SOL`, thêm recipient tên `my-wallet` bằng *Use owner wallet*, lưu. Nạp khoảng 0.7 SOL vào ví agent: địa chỉ ví agent nằm ở tab **Overview**, gửi từ Phantom hoặc https://faucet.solana.com.

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

Cần persistent disk cho `/data`. `GET /api/health` trả thêm `commit` (từ `RENDER_GIT_COMMIT` hoặc `GIT_COMMIT`) để biết bản đang chạy. Chỉ chạy một instance (session và store JSON ở trong process). TLS kết thúc ở nền tảng hosting hoặc reverse proxy.

## Kiểm thử

```bash
pnpm test    # policy, approval, pipeline, task vault, MCP tools
pnpm build   # web bundle + typecheck toàn workspace
pnpm e2e     # 3 luồng demo + các case tấn công (khi agent đang chạy)
```

`pnpm e2e` chạy allow / approval / deny và các case: duyệt bằng ví không phải owner, chữ ký trên thông điệp bị sửa, replay chữ ký duyệt, duyệt dưới phiên bản policy cũ.

Kết quả `pnpm test` hiện tại: agent 226 pass, 3 skip (25 file); mcp 47 pass (3 file). Ba test bị skip (`task-vault-onchain`, `task-vault-persistence`, `task-vault-routes-onchain`) chỉ chạy khi có Solana local validator ở `127.0.0.1:8899`; không có validator thì chúng tự skip, không tính là pass.

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

## Lộ trình

Theo dõi tại [epic #18](../../issues/18) (label `backlog`): `outputSchema` cho tool MCP, tool đọc lịch sử ví qua MCP, hash MCP token và rate limit, tool Task Vault qua MCP, đối chiếu record Task Vault với chain, cảnh báo Telegram / email, thanh toán Task Vault bằng stablecoin.

## Giấy phép

[MIT](LICENSE).
