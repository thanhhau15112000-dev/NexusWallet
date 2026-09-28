# [Feature / Hackathon]: Task Capability Vault cho Autonomous Agents

## 1. Tóm tắt

Nâng NexusPay từ một **policy guard cho chuyển tiền** thành một **programmable
treasury cho agent**.

Owner không cấp quyền cho agent rút tiền tự do. Owner cấp một `Task Capability`
có ngân sách, thời hạn, phạm vi protocol và điều kiện quyết toán. Agent được tự
chủ thực hiện nhiều bước trong phạm vi đó; smart contract giữ tiền, escrow,
kiểm tra điều kiện và hoàn tiền phần dư.

Prototype không phụ thuộc việc mua hàng thật. Worker/service được mô phỏng bằng
local service hoặc một agent thứ hai, nhưng thanh toán, escrow, expiry, refund
và proof receipt phải chạy thật trên Solana Devnet.

## 2. Vấn đề hiện tại

Flow hiện tại chỉ hỗ trợ các action cố định:

```text
get_balance
transfer_sol
transfer_spl
request_manual_approval
```

Policy hiện chủ yếu kiểm tra recipient, mint và hạn mức từng giao dịch. Cách này
chứng minh được kiểm soát chi tiêu, nhưng chưa chứng minh được agent có thể hoàn
thành một nhiệm vụ kinh tế nhiều bước hoặc tương tác an toàn với agent/service
khác.

Source hiện tại vẫn dùng agent key off-chain và policy JSON; việc này phải tiếp
tục được coi là legacy fallback cho đến khi prototype on-chain có bằng chứng
Devnet riêng. Xem [`docs/mvp-plan.md`](./mvp-plan.md) và
[`docs/solana-vault-policy-guard.md`](./solana-vault-policy-guard.md).

## 3. Mục tiêu

- Tạo một Task Capability có ngân sách và expiry rõ ràng.
- Cho phép agent thực hiện nhiều thanh toán trong cùng task.
- Giới hạn quyền theo task, không chỉ theo từng transaction.
- Thanh toán cho worker/service qua escrow.
- Chỉ release tiền khi có receipt/proof hợp lệ.
- Refund phần dư khi task hoàn tất, hết hạn hoặc bị revoke.
- Ghi execution receipt để owner kiểm tra được intent, hành động và settlement.
- Giữ flow direct-key hiện tại hoạt động như fallback demo có gắn nhãn rõ ràng.

## 4. Ngoài phạm vi prototype

- Mua hàng thật, logistics hoặc delivery ngoài chain.
- Mainnet và tiền có giá trị thực.
- Arbitrary DeFi/CPI tới mọi chương trình.
- Full Token-2022 extension matrix.
- ZK Compression cho audit log.
- Tự động đánh giá proof bằng LLM.
- Thay thế toàn bộ pipeline hiện tại trong issue đầu tiên.

## 5. Thiết kế domain

### 5.1 Task Capability

Mỗi task có một capability account hoặc PDA riêng:

```text
TaskCapability
- owner
- agent_signer
- task_id / nonce
- budget_lamports
- spent_lamports
- expiry
- allowed_programs hoặc service_ids
- allowed_assets
- max_loss_lamports
- policy_version
- status: active | completed | revoked | expired
```

Capability phải bind với `program_id`, vault, task nonce và domain name để không
thể replay sang task hoặc chương trình khác.

### 5.2 Escrow

```text
Owner -> Task Vault / Escrow PDA -> Worker hoặc Service
```

Escrow giữ số tiền đã được task cam kết. `execute_task_payment` chỉ chuyển tiền
từ Vault sang Escrow PDA; worker không được nhận tiền trước khi điều kiện release
được thỏa mãn. Một task chỉ được settle một lần; mọi nhánh settle phải atomic.

### 5.3 Receipt / Proof

Receipt tối thiểu cần bind:

```text
task_id
worker_id
request_hash
result_hash
amount
created_at / expiry
```

Prototype chỉ cần proof hash hoặc chữ ký worker; không gọi đây là proof về chất
lượng kết quả ngoài chain.

## 6. Instruction/API dự kiến

Tên instruction là đề xuất cần đối chiếu với Anchor version được pin trước khi
code; không được coi là API đã tồn tại.

MVP cố ý cắt offer/marketplace. Chỉ có năm instruction cốt lõi:

```text
create_and_fund_task(params)
execute_task_payment(task, amount, service_id)
settle_with_receipt(task, result_hash)
refund_and_close(task)
revoke_task(task)
```

- `create_and_fund_task`: authority tạo capability, Vault và số dư ban đầu
  trong một transaction.
- `execute_task_payment`: agent signer chuyển khoản cam kết từ Vault sang
  Escrow PDA; không trả thẳng cho worker.
- `settle_with_receipt`: worker phải là transaction signer; contract kiểm tra
  worker đã được capability cho phép rồi chuyển Escrow cho worker.
- `refund_and_close`: hoàn số dư chưa dùng và đóng các PDA program-owned; có thể
  gọi bởi owner, hoặc bởi bất kỳ relayer nào sau expiry để tránh phụ thuộc vào
  một backend duy nhất.
- `revoke_task`: owner dừng task và khóa mọi payment tiếp theo.

Không được thêm arbitrary CPI; chỉ hỗ trợ một mock worker/service program hoặc
adapter cố định. Worker signer chứng minh worker đã ủy quyền receipt, không phải
chứng minh chất lượng kết quả ngoài chain.

## 7. Kế hoạch triển khai

### Phase 0 — Contract và demo boundary

**Thực hiện**

- Chốt một flow duy nhất: owner cấp ngân sách cho agent thuê worker/service.
- Chốt state machine: `active -> completed`, `active -> expired`,
  `active -> revoked`.
- Chốt semantics cho budget tổng, per-payment cap, expiry và refund.
- Chốt account close và recipient của rent refund; không dùng con số rent cố
  định vì chi phí phụ thuộc kích thước account và cluster.
- Viết request/receipt schema dùng chung trong `shared`.

**Tham chiếu**

- [`shared/src/contract.ts`](../shared/src/contract.ts) cho Zod schema và
  canonical approval message.
- [`docs/solana-vault-policy-guard.md`](./solana-vault-policy-guard.md) cho
  policy version, PDA binding và atomic consume.

**Kiểm chứng**

- Có state-transition table cho mọi trạng thái terminal.
- Có test vector cho task hash, receipt hash và domain separator.

**Không làm**

- Không đưa model vào quyền ký.
- Không để model tự trả về raw transaction hoặc program ID tùy ý.

### Phase 1 — Anchor Task Vault tối giản

**Thực hiện**

- Tạo workspace `programs/nexus-task-vault`.
- Tạo capability PDA, vault PDA và escrow/receipt PDA.
- Implement đúng năm instruction MVP ở mục 6.
- Đóng capability, escrow và receipt PDA sau settle/refund khi account không còn
  lamports hoặc trạng thái pending.
- Chỉ hỗ trợ SOL trong phase này.

**Tham chiếu**

- Giữ invariant trong [`docs/solana-vault-policy-guard.md`](./solana-vault-policy-guard.md).
- Cô lập lời gọi RPC/transaction builder theo pattern hiện có ở
  [`agent/src/chain.ts`](../agent/src/chain.ts).

**Kiểm chứng**

- Unauthorized owner/agent/worker bị từ chối.
- Payment vượt budget hoặc expiry bị từ chối.
- Double settle, double refund và receipt replay bị từ chối.
- Worker không ký receipt thì settle bị từ chối.
- `refund_and_close` trả rent và số dư dư về đúng owner.
- Sau expiry, permissionless refund vẫn hoạt động nếu backend worker không chạy.
- Revoke có hiệu lực ngay.
- Refund phần dư chính xác.
- `anchor build` và instruction tests pass trên local validator.

**Không làm**

- Không giữ private key owner trong backend.
- Không dùng một global budget cho mọi user/task.
- Không gọi CPI tùy ý tới protocol chưa có adapter.

### Phase 2 — Mock worker/service và agent adapter

**Thực hiện**

- Tạo một worker/service adapter cố định, chạy local hoặc bằng program mock trên
  Devnet.
- Agent tạo payment request theo capability, tạo transaction và submit.
- Lưu request, simulation, receipt và settlement vào audit hiện tại.
- Giữ direct-key pipeline sau feature flag `LEGACY_CUSTODY_MODE`.
- Thêm background worker định kỳ tìm task quá expiry và gọi `refund_and_close`;
  đây là cơ chế liveness, không phải invariant bảo mật của contract.

**Tham chiếu**

- Pipeline policy/recheck hiện tại ở [`agent/src/pipeline.ts`](../agent/src/pipeline.ts).
- Actions endpoint hiện tại ở [`agent/src/routes.ts`](../agent/src/routes.ts).

**Kiểm chứng**

- Một task có ít nhất hai payment hợp lệ trong cùng budget.
- Payment vượt budget bị reject trước khi broadcast.
- Worker không nộp receipt thì escrow không release.
- Task expiry/revoke tạo refund, không để tiền treo.
- Mỗi execution có Devnet signature và receipt hash.

**Không làm**

- Không mô tả mock worker là merchant thật.
- Không claim chất lượng kết quả chỉ từ result hash.

### Phase 3 — Dashboard và demo flow

**Thực hiện**

- Hiển thị task budget, spent, remaining, expiry và status.
- Hiển thị worker/service được chọn, receipt và settlement.
- Thêm nút fund, revoke và claim refund.
- Thêm cảnh báo rõ ràng giữa `Task Vault` và `Legacy Agent Wallet`.

**Kiểm chứng**

- Browser smoke test trên Devnet với một owner wallet.
- Refresh/restart không làm mất task state hoặc receipt.
- Revoke từ dashboard ngăn execution tiếp theo.

**Không làm**

- Không gọi sản phẩm production-ready.
- Không gộp bằng chứng local, Devnet và deployment thành một claim duy nhất.

### Phase 4 — Hackathon verification

**Thực hiện**

- Chạy full build, typecheck, unit/instruction tests.
- Deploy program lên Devnet bằng key quản lý riêng.
- Ghi program ID, upgrade authority và transaction signatures vào report.
- Kiểm tra replay, expiry, revoke, refund và unauthorized CPI trên Devnet.

**Done criteria**

- Có một video hoặc live demo hoàn chỉnh:

```text
Owner fund task
  -> Agent chọn worker
  -> Hai payment hợp lệ
  -> Một payment vượt budget bị chặn
  -> Worker submit receipt
  -> Task settle
  -> Phần dư refund
  -> Revoke task chặn payment tiếp theo
```

- Mọi claim về non-custodial chỉ áp dụng cho Task Vault đã deploy và được kiểm
  chứng; legacy direct-key flow phải được ghi riêng.

## 8. Tiêu chí nghiệm thu tổng hợp

- [ ] Task capability cô lập theo owner/task, không dùng global policy.
- [ ] Agent chỉ tiêu trong budget tổng, per-payment cap và expiry.
- [ ] Worker/service chỉ nhận tiền qua escrow.
- [ ] Các PDA program-owned được close sau settle/refund để tránh rent leak.
- [ ] Receipt replay và double settlement bị từ chối on-chain.
- [ ] Refund/revoke/expiry hoạt động atomic.
- [ ] Expiry refund không phụ thuộc duy nhất vào background worker.
- [ ] Có Devnet proof cho happy path và failure path.
- [ ] Build/test pass; không còn claim `102 tests pass` nếu full suite vẫn timeout.
- [ ] Legacy custodial path được gắn nhãn và không được dùng làm bằng chứng
  non-custodial.

## 9. Rủi ro và quyết định cần chốt

- Chọn `mock worker program` hay local service có receipt ký bằng worker key.
- Chọn chỉ SOL trong MVP hay thêm một SPL mint duy nhất sau khi SOL flow ổn định.
- Chọn giữ upgrade authority trong ví nhóm cho demo hay dùng multisig.
- Định nghĩa “proof” là chữ ký worker, hash artifact hay một assertion on-chain;
  không dùng từ “proof of quality” nếu chưa có verifier.
