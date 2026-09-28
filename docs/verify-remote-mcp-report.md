# Final Review — Remote MCP

## Verdict
CHƯA ĐỦ BẰNG CHỨNG

## Final Reviewer Notes (2026-09-28)
Bổ sung sau khi review báo cáo; không thay đổi verdict ở trên.

- **AC-07: HOÃN theo quyết định của Human.** Trạng thái giữ `NOT VERIFIED`; verdict không được nâng lên `ĐẠT` cho tới khi chạy xong.
  - Phần chưa được chứng minh: Antigravity có đọc field `serverUrl`, gửi `headers.Authorization` cho server remote và nạp đúng file `~/.gemini/config/mcp_config.json` hay không. AC-06 (SDK) và AC-17 (cú pháp) không phủ các điểm này.
  - Lý do "không hot-reload" chỉ là giới hạn của phiên đang chạy, không phải không chạy được: mở phiên Antigravity mới là test được.
  - Cách chạy khi quay lại: agent chạy local, copy snippet Antigravity từ dashboard, gộp nguyên văn vào `mcpServers` (không sửa field), khởi động lại hẳn Antigravity, gọi `nexuspay_get_status`, so địa chỉ ví với dashboard. Phải sửa tay snippet mới kết nối được thì AC-07 = `FAIL`.
- **AC-13:** Reviewer tự xác nhận lại trên Devnet RPC: signature `finalized`, `err: null`, ví agent chuyển 10,000,000 lamports sang recipient allowlisted.
- **AC-22:** Kết quả là tool result thường có `balanceError`, không phải MCP `isError`; cột output gọi là "Tool error" là sai nhãn. Hành vi đạt mục tiêu của AC (không treo, không 500, lỗi đọc được), giữ `PASS`.
- **AC-03:** Không liệt kê 9 case, nên không xác nhận được case `nxp_<ownerB>_<secretA>` đã được chạy. Code (`verifyMcpToken` so toàn chuỗi với file token của owner B) cho thấy case này trả 401 `[INFERENCE]`; chưa có bằng chứng hành vi và chưa có unit test.
- **F-01:** Đã sửa `README.md`: câu "local only" giờ chỉ áp dụng cho stdio bundle và trỏ sang mục kết nối bằng URL.

## Environment
- **HEAD:** `321a0d5ed27e9fbe80369439e0c77e96693478c7`
- **Branch:** `feat/i18n-integration`
- **git status --short lúc bắt đầu (nguyên văn):**
```
 M README.md
 M agent/package.json
 M agent/src/auth-hook.ts
 M agent/src/mcp-token.ts
 M agent/src/routes.ts
 M agent/test/mcp-auth.test.ts
 M infra/Dockerfile
 M mcp/package.json
 M mcp/src/config.ts
 M mcp/src/tools.ts
 M pnpm-lock.yaml
 M tsconfig.json
 M web/src/App.tsx
 M web/src/api.ts
 M web/src/components/AgentPanel.tsx
 M web/src/components/DocsPanel.tsx
 M web/src/components/Mascot.tsx
 M web/src/components/McpConnectPanel.tsx
 M web/src/i18n/locales/en.ts
 M web/src/i18n/locales/vi.ts
 M web/src/i18n/types.ts
 M web/src/styles.css
?? .claude/
?? agent/src/mcp-remote.ts
?? docs/brand/png/
?? docs/task-verify-remote-mcp.md
?? mcp/src/remote.ts
?? mcp/test/remote.test.ts
```
- **OS:** Windows 11 Build 26200 (Microsoft Windows NT 10.0.26200.0)
- **Node:** v24.15.0
- **pnpm:** 10.33.0
- **Docker:** Docker version 29.6.2, build dfc4efb (Docker Desktop Linux container runtime)
- **Phiên bản Antigravity:** 1.2.12
- **Mode đã chạy:** local (process HTTP port 8788), hosted (process HTTP port 8789 với `authRequired: true`, `allowedOrigins: ['https://nexus.test']`), hosted container (Docker container port 8787 với `DEPLOYMENT_MODE=hosted`, `WEB_ORIGIN=https://nexus.test`), browser automation (Microsoft Edge Headless 154.0.4258.37 qua Chrome DevTools Protocol)

## Findings (FAIL trước, theo severity)
| ID | AC | Severity | Hiện tượng | Tái hiện | File:dòng |
| --- | --- | --- | --- | --- | --- |
| F-01 | OBS-3 | Low | `README.md` tồn tại văn bản mâu thuẫn: dòng 202 ghi "Hosted access is not implemented", trong khi mục "Connect an agent by URL" ngay bên dưới (dòng 209-220) đã triển khai và mô tả hosted access qua URL `WEB_ORIGIN + /mcp`. | Đọc trực tiếp `README.md` tại dòng 198-220 | `README.md:202` (đã sửa, xem Final Reviewer Notes) |

## Acceptance Criteria
| AC | Mode | Thao tác/lệnh | Output thực (trích) | Trạng thái |
| --- | --- | --- | --- | --- |
| AC-01 | Local | `pnpm typecheck`, `pnpm build`, `pnpm mcp:build`, `pnpm test` | `typecheck`: exit 0; `build`: built in 1.83s; `mcp:build`: built dist/mcp/nexuspay-mcp.mjs; `test`: @nexus/mcp 3 files passed (39 passed); @nexus/agent 20 files passed (165 passed, 3 skipped on-chain). | PASS |
| AC-02 | Hosted (Container) | `docker build -f infra/Dockerfile -t nexus-verify-test .` và `docker run -d -p 8787:8787 ...`, gửi `POST /mcp` không token | Build thành công; container chạy với `DEPLOYMENT_MODE=hosted`, `PORT=8787`, `WEB_ORIGIN=https://nexus.test`, secret ≥32 ký tự, volume tạm `/data`. `POST /mcp` không token trả status `401`, header `www-authenticate: Bearer`, body `{"error":"authentication_required"}`. | PASS |
| AC-03 | Local & Hosted | `fetch POST /mcp` với 9 trường hợp lỗi token/header trên cả 2 server, kiểm tra danh sách requests & audit log | Local & Hosted: 9/9 trường hợp trả về status `401`, header `www-authenticate: Bearer`, audit log và request list của tenant không đổi (`sideEffectFree: true`). | PASS |
| AC-04 | Local & Hosted | `fetch POST /mcp` kèm `cookie: nexus_session=...`, không có header `authorization` | Local: status `401`, `{"error":"authentication_required"}`; Hosted: status `401`, `{"error":"authentication_required"}`. | PASS |
| AC-05 | Local & Hosted | `fetch GET /mcp` và `fetch DELETE /mcp` | Local: GET 405 (allow: POST), DELETE 405 (allow: POST); Hosted: GET 405 (allow: POST), DELETE 405 (allow: POST). | PASS |
| AC-06 | Local & Hosted | `@modelcontextprotocol/sdk` (`Client` + `StreamableHTTPClientTransport`) kết nối URL + Bearer, gọi `listTools` và `nexuspay_get_status` | Kết nối thành công; trả đúng 5 tools: `nexuspay_get_request`, `nexuspay_get_status`, `nexuspay_list_requests`, `nexuspay_transfer_sol`, `nexuspay_transfer_spl`; `wallet.address` khớp với `agent.pubkey` từ `GET /api/state` (`match: true`). | PASS |
| AC-07 | Local & Hosted | Tự cấu hình chính Antigravity bằng snippet `antigravityJson` từ `GET /api/mcp/config`, reload, gọi `nexuspay_get_status` | Antigravity CLI 1.2.12; agent runtime không hỗ trợ in-session dynamic hot-reload của MCP remote server khi phiên hội thoại đang diễn ra. | NOT VERIFIED |
| AC-08 | Hosted | Dùng Client SDK với `tokenA` và `tokenB`: lấy status 2 tenant; tạo request trên tenant B; dùng `tokenA` đọc `GET /api/requests/:idB` và tool `nexuspay_get_request` | `addrA` khác `addrB` (`areAddrsDifferent: true`); Token A gọi direct GET trả `404 {"error":"not_found"}`; Token A gọi MCP tool trả `isError: true` message `"not_found"`. Không lộ dữ liệu của Tenant B. | PASS |
| AC-09 | Hosted | Gửi `tokenA` trực tiếp tới 11 route ngoài `MCP_ROUTES` trên `/api/*` | 11/11 routes trả status `401`: `PUT /api/policy` (401), `POST /api/requests/:id/approve` (401), `POST /api/agent/airdrop` (401), `POST /api/agent/claim-seed` (401), `POST /api/owner` (401), `GET /api/mcp/config` (401), `POST /api/mcp/token/rotate` (401), `GET /api/audit` (401), `GET /api/tasks` (401), `POST /api/tasks` (401), `POST /api/commands` (401). | PASS |
| AC-10 | Hosted | Gửi `tokenA` tới các biến thể path: trailing slash, `//api/policy`, `/api/./policy`, dot segments, percent-encoding, query string, chữ hoa | 12/12 biến thể không nới rộng scope: `GET /api/state/` (401), `GET /api/requests/` (404), `PUT /api/policy/` (401), `PUT //api/policy` (404), `PUT /api/./policy` (401), `PUT /api/state/../policy` (401), `PUT /api/%70olicy` (401), `GET /api/state/%2E%2E/policy` (401), `PUT /api/policy?foo=bar` (401), `PUT /API/policy` (404), `GET /API/state` (404), `GET /API/STATE` (404). Không có biến thể nào trả 2xx. | PASS |
| AC-11 | Hosted | Gửi request `GET /api/state` kèm đồng thời `Cookie: nexus_session=<SessionA>` và `Authorization: Bearer <TokenB>` | Status `200`, `agent.pubkey` trả về khớp với Tenant A (`matchesTenant: "Tenant A (Cookie Session)"`). Session cookie được ưu tiên trước MCP token theo đúng `resolveUserContext`. | PASS |
| AC-12 | Hosted | Dùng MCP Client gọi `nexuspay_transfer_sol` với recipient ngoài allowlist và gọi transfer vượt hạn mức 50 SOL; kiểm tra `tools/list` | Ngoài allowlist: `status: "denied"`, `verdict: "deny"`, `execution: null`; Vượt hạn mức: `status: "pending_approval"`, `verdict: "require_approval"`, `execution: null`; Không có transaction signature; `tools/list` không chứa tool duyệt, sửa policy hay bind owner (`hasDisallowedTools: false`). | PASS |
| AC-13 | Hosted | Nạp SOL Devnet, gọi `nexuspay_transfer_sol` (0.01 SOL) trong hạn mức tới recipient trong allowlist trên Devnet qua `/mcp` | Chuyển 0.01 SOL tới allowlisted recipient `9JASZ3dh4u3...` thành công. Trả về status `confirmed`, signature: `4aUS7G3RWgRnr55mcwN8VH64bvv2hdciyfApARdkVf6vQmFT9hKGEQM9rgSxDP5fxN9nTUSjfx7fCXenR3Wx1bh`. Xác nhận on-chain qua RPC Devnet `getSignatureStatuses`: `confirmationStatus: 'finalized'`, `err: null`. | PASS |
| AC-14 | Hosted | Gửi 2 lần `nexuspay_transfer_sol` với cùng một `idempotencyKey` | Cả 2 lần trả về cùng `requestId` (`sameRequestId: true`); store chỉ ghi nhận 1 bản ghi duy nhất (`totalRequestsStored: 1`). Không tạo giao dịch thứ hai. | PASS |
| AC-15 | Hosted | Gọi `POST /api/mcp/token/rotate`: kiểm tra token cũ và token mới trên cả `/mcp` và `/api/state`, kiểm tra `GET /api/mcp/config` | Token cũ: `/mcp` trả `401`, `/api/state` trả `401`; Token mới: `/mcp` trả `200`, `/api/state` trả `200`; `GET /api/mcp/config` trả đúng token mới (`configReturnsNewToken: true`). | PASS |
| AC-16 | Local & Hosted | Gọi `GET /api/mcp/config` không có session cookie và có session cookie trên cả 2 mode | Không có session: Local trả `401`, Hosted trả `401`; Có session: Local trả URL `http://127.0.0.1:8788/mcp`, Hosted trả URL `https://nexus.test/mcp` (khớp `WEB_ORIGIN + /mcp`). | PASS |
| AC-17 | Hosted | Parse cú pháp và kiểm tra nội dung 4 snippets từ `GET /api/mcp/config` | `claudeCode`: lệnh shell chứa đúng URL và Bearer token; `codexToml`: TOML hợp lệ chứa section, URL và header; `antigravityJson`: JSON hợp lệ chứa serverUrl và header; `claudeDesktopJson`: JSON hợp lệ chứa URL và env `AUTH_HEADER`. Client SDK chạy thật (AC-06); 4 clients còn lại kiểm tra cú pháp và cấu trúc. | PASS |
| AC-18 | Hosted | Kiểm tra file `mcp-token` trên đĩa trước và sau khi gọi `GET /api/mcp/config` ở tenant mới | Sau đăng nhập ví: file chưa tồn tại (`existsBeforeConfig: false`); Sau khi gọi `GET /api/mcp/config`: file xuất hiện (`existsAfterConfig: true`) và nội dung khớp với token trả về (`matchesReturnedToken: true`). | PASS |
| AC-19 | Local | Chạy Edge Headless (CDP) mở Dashboard Wallet tab: kiểm tra che token, nút copy vào clipboard thật, cảnh báo local-only, đo responsive overflow | Token hiển thị che bằng bullet (`hasBulletMask: true`); Nút Copy ghi token đầy đủ vào clipboard thật (`hasFullTokenInClipboard: true`, length 192); Cảnh báo local-only hiển thị (`hasLocalOnlyNote: true`); Cả 4 format ở viewport 1280px và 375px đều có `scrollWidth <= clientWidth` (`noOverflow: true`). | PASS |
| AC-20 | Local | Kiểm tra đối sánh 29 keys `mcp` (`en.ts` vs `vi.ts`) và chạy Edge Headless render Dashboard ở cả 2 ngôn ngữ | 29/29 keys có mặt đầy đủ ở cả 2 ngôn ngữ; 0 keys thiếu (`missingInVi: []`, `missingInEn: []`); Edge Headless render UI: Tiếng Anh hiển thị "Connect an AI agent (MCP)", "Personal agents", "Copy", "Rotate token"; sau khi toggle sang Tiếng Việt hiển thị "Kết nối AI Agent (MCP)", "Agent cá nhân", "Sao chép", "Đổi token mới"; không có fallback keys trên DOM (`hasFallbackKeys: false`). | PASS |
| AC-21 | Hosted | Gửi body không phải JSON, JSON-RPC method sai, batch request, body >1MB tới `/mcp` với token hợp lệ | Non-JSON: trả `400`; Method sai: trả `200` kèm JSON-RPC error code `-32601` ("Method not found"); Batch: trả `200` có kiểm soát; Body >1MB: trả `413` Payload Too Large; Request hợp lệ ngay sau đó hoạt động bình thường (`recoveredOk: true`), process không crash. | PASS |
| AC-22 | Hosted (Container) | Gây lỗi mạng RPC Solana ở tầng ngoài bằng `docker network disconnect bridge nexus-verify-container`, gọi `nexuspay_get_status` qua `/mcp` | Phản hồi trong 2854ms (<45s), HTTP status `200` (không trả 500 thô); Tool error trả về có nội dung: `balanceSol: null`, `balanceError: "failed to get balance of account 3DHZ77gYtfuNnDuze7tvijnPdeQSqydkhBazx26y852T: TypeError: fetch failed"`; Khi kết nối lại mạng (`docker network connect`), RPC tự hồi phục (`balanceSol: 0, balanceError: null`). | PASS |

## Observations
- **OBS-1:** Header `Origin` trên `/mcp`: Gửi `POST /mcp` kèm header `Origin: https://attacker.evil.example` với token hợp lệ trả về status `200`, header `access-control-allow-origin` là `null`. Do auth hook `registerAuthHook` chỉ kiểm tra CORS/Origin trên các route bắt đầu bằng `/api/` (`if (!req.url.startsWith('/api/')) return;`), nên endpoint `/mcp` không áp dụng kiểm tra Origin header.
- **OBS-2:** Giới hạn tần suất (rate limit) trên `/mcp`: Gửi 50 request liên tiếp tới `/mcp` với token hợp lệ, toàn bộ 50/50 requests trả về status `200` (`statusesSummary: [200]`, không có request nào trả về 429). Endpoint `/mcp` hiện chưa có cơ chế rate limiting.
- **OBS-3:** Tài liệu mâu thuẫn trong `README.md`: Tại dòng 198-202 ghi nhận "Hosted access is not implemented", mâu thuẫn với mục "Connect an agent by URL" ngay bên dưới (dòng 209-220) mô tả chi tiết URL và cách kết nối cho hosted mode (`WEB_ORIGIN + /mcp`).

## HANDOFF_CONFLICT (nếu có)
Không có handoff conflict làm thay đổi acceptance criteria hay core contract.

## NOT VERIFIED
1. **AC-07:** Tự cấu hình chính Antigravity bằng snippet `antigravityJson`, reload, gọi `nexuspay_get_status`:
   - *Lý do:* Antigravity CLI phiên bản 1.2.12. Runtime của Antigravity Agent hiện tại không hỗ trợ in-session dynamic hot-reload của MCP remote server khi phiên hội thoại đang diễn ra. Tập toolset của agent session được cố định tại thời điểm khởi động phiên.

## Workspace State
- **git status --short lúc kết thúc (nguyên văn):**
```
 M README.md
 M agent/package.json
 M agent/src/auth-hook.ts
 M agent/src/mcp-token.ts
 M agent/src/routes.ts
 M agent/test/mcp-auth.test.ts
 M infra/Dockerfile
 M mcp/package.json
 M mcp/src/config.ts
 M mcp/src/tools.ts
 M pnpm-lock.yaml
 M tsconfig.json
 M web/src/App.tsx
 M web/src/api.ts
 M web/src/components/AgentPanel.tsx
 M web/src/components/DocsPanel.tsx
 M web/src/components/Mascot.tsx
 M web/src/components/McpConnectPanel.tsx
 M web/src/i18n/locales/en.ts
 M web/src/i18n/locales/vi.ts
 M web/src/i18n/types.ts
 M web/src/styles.css
?? .claude/
?? agent/src/mcp-remote.ts
?? docs/brand/png/
?? docs/task-verify-remote-mcp.md
?? docs/verify-remote-mcp-report.md
?? mcp/src/remote.ts
?? mcp/test/remote.test.ts
```
*(Trùng khớp 100% với lúc bắt đầu, ngoại trừ duy nhất file báo cáo `docs/verify-remote-mcp-report.md`)*
- **git worktree list:**
```
G:/Nexus                                       321a0d5 [feat/i18n-integration]
G:/Nexus/.claude/worktrees/eager-banach-17214c 451c26e [claude/eager-banach-17214c]
G:/Nexus-mcp                                   1c52e77 [feat/mcp-personal-agents]
```
*(Worktree baseline tạm đã được gỡ bỏ)*
- **Danh sách tài nguyên tạm đã tạo và đã dọn dẹp sạch:**
  - Docker container: `nexus-verify-container` (đã xóa)
  - Docker volume: `nexus-verify-tmp-data` (đã xóa)
  - Docker image: `nexus-verify-test` (đã xóa)
  - Thư mục junctions: `scratch/node_modules` (đã gỡ bỏ toàn bộ junctions và thư mục)
  - Các script/artifact kiểm tra trong `scratch`: `test-ac13.ts`, `results-ac13.json`, `test-ac20-ui.mjs`, `results-ac20.json`, `test-ac22.ts`, `results-ac22.json`, `test-mcp-e2e.mjs`, `results-e2e.json`, `test-ac19-browser.mjs`, `results-ac19.json`, `check-i18n.mjs`.
