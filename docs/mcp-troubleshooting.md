# Xử lý lỗi kết nối MCP

Dành cho người (hoặc agent) đang cài nexusPay MCP vào client. Cách kết nối xem ở [README](../README.md#kết-nối-ai-agent-mcp).

## Kết nối bằng URL (hosted hoặc local `/mcp`)

| Triệu chứng | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| `401` / `mcp_token_rejected` | Token đã bị rotate hoặc copy sai | Mở dashboard → Wallet → **Connect an AI agent** → copy lại entry và cập nhật client |
| Transfer trả `pending_approval` | Số tiền vượt hạn mức mỗi giao dịch | Owner duyệt trên dashboard; poll `nexuspay_get_request` |
| Transfer trả `outcome_unknown` | Timeout hoặc lỗi server sau khi đã gửi | Gọi lại với cùng `idempotencyKey`; không đổi số tiền |
| Transfer trả `idempotency_conflict` | Dùng lại key cho giao dịch khác | Dùng key mới cho giao dịch mới |

## Bản stdio chạy từ repo

| Triệu chứng | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| `mcp_setup_required` kèm `no MCP token found` | Owner chưa đăng nhập dashboard trên máy này | Đăng nhập dashboard bằng ví một lần; lần gọi tool tiếp theo tự nhận token, không cần restart client |
| `mcp_setup_required` kèm `multiple owners with MCP tokens found` | Thư mục dữ liệu có token của nhiều ví owner | Đặt `NEXUS_OWNER_PUBKEY=<địa chỉ ví>` trong env của client |
| `mcp_token_rejected` | Agent service dùng thư mục dữ liệu khác, hoặc token đã bị rotate | Kiểm tra `NEXUS_AGENT_DATA_DIR`, hoặc đăng nhập dashboard để làm mới |
| Server không khởi động từ `.mcp.json` (`Cannot find module`, "Connection closed", không thấy tool) | Client mở ở thư mục con nên đường dẫn tương đối tới bundle không đúng | Mở client ở thư mục gốc repo, hoặc đăng ký đường dẫn tuyệt đối: `claude mcp add -s user nexuspay -- node <đường dẫn từ pnpm mcp:config>` (Claude Code), hoặc dán JSON từ `pnpm mcp:config` vào `~/.cursor/mcp.json` (Cursor) |
| `Cannot find module .../nexuspay-mcp.mjs` | Chưa build bundle, hoặc đường dẫn trỏ sang checkout khác | `pnpm mcp:build`; kiểm tra `dist/mcp/nexuspay-mcp.mjs` |
| `node` not found | Node.js không có trong PATH của client | Cài Node.js 22+, hoặc ghi đường dẫn tuyệt đối của `node` vào `command` |
| `agent_unreachable` | Agent service chưa chạy hoặc chạy ở port khác | `pnpm dev` từ thư mục gốc repo; kiểm tra `NEXUS_API_URL` |
| Codex cắt lời gọi ở 60 giây | Thiếu `tool_timeout_sec` | Giữ `tool_timeout_sec = 90` trong entry TOML |
| Antigravity từ chối schema của tool | Bundle cũ | `pnpm mcp:build` rồi khởi động lại Antigravity |

## Ghi chú cấu hình

- Mỗi client chạy bundle bằng `node` thuần, không cần pnpm hay tsx trong PATH.
- Trên Windows, đường dẫn trong file cấu hình dùng dấu `/` (ví dụ `G:/nexus/dist/...`); không cần escape trong JSON hay TOML.
- `pnpm mcp:install -- --client codex|claude-desktop|antigravity` ghi entry vào cấu hình global của client. Codex chỉ đọc `.codex/config.toml` trong project khi project được trust, nên ưu tiên dùng installer.
- Biến tùy chọn: `NEXUS_DASHBOARD_URL` (mặc định `http://localhost:5173`, dùng trong gợi ý duyệt), `NEXUS_TIMEOUT_MS` (mặc định 45000, thấp hơn timeout 60 giây mặc định của Codex).
- Schema input của tool tránh `exclusiveMinimum` và các từ khóa tương tự vì function calling của Gemini (Antigravity) từ chối chúng.
