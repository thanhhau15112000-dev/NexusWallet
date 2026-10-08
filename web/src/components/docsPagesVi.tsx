import type { TranslationDictionary } from '../i18n/types.js';
import { Callout, CodeBlock, Steps, TabLink, Tabs, type DocPage, type DocsContext } from './docsBlocks.js';

/**
 * Vietnamese copy of the pages built by `buildPages` in DocsPanel.tsx. Page ids, section ids, code
 * snippets and tab links must stay identical to the English pages; docs-parity.test.ts checks it.
 * Keep the two files edited together.
 */
export function buildPagesVi(ctx: DocsContext, dict: TranslationDictionary): DocPage[] {
  return [
    {
      id: 'overview',
      group: dict.docs.overview.group,
      title: dict.docs.overview.title,
      summary: dict.docs.overview.summary,
      keywords: 'introduction pipeline model policy signer giới thiệu chính sách',
      sections: [
        {
          id: 'what',
          title: 'nexusPay là gì',
          body: (
            <>
              <p>
                nexusPay là lớp bảo vệ thanh toán cho AI agent trên Solana Devnet. Mỗi ví chủ sở hữu có một ví agent
                riêng và một chính sách chi tiêu. Giao dịch nằm trong chính sách thì agent tự ký. Giao dịch vượt hạn
                mức thì chờ chủ ví duyệt trong ví. Người nhận ngoài danh sách cho phép bị từ chối.
              </p>
              <p>
                Model quyết định <em>thử làm gì</em>. Model không bao giờ quyết định <em>việc đó có được phép
                không</em>: chỉ có công cụ chính sách mới cho phép ký.
              </p>
            </>
          ),
        },
        {
          id: 'flow',
          title: 'Luồng xử lý một yêu cầu',
          body: (
            <>
              <CodeBlock
                label="Pipeline"
                code={[
                  'text command or MCP tool call',
                  '  -> intent + action plan   (4 action types, schema-validated)',
                  '  -> policy engine           allow | require_approval | deny',
                  '  -> agent signer            only after allow, or a verified owner signature',
                  '  -> Solana Devnet',
                ].join('\n')}
              />
              <p>
                Khi chưa có API key của model, agent dùng một bộ phân tích xác định thay thế. Các yêu cầu đó hiện
                {' '}<code>[fallback]</code> trong model trace; việc áp dụng chính sách vẫn như nhau.
              </p>
            </>
          ),
        },
        {
          id: 'map',
          title: 'Bản đồ dashboard',
          body: (
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Tab</th>
                  <th>Dùng để</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Tổng quan</td><td>Xem ví agent, kết nối ví chủ sở hữu, nạp vốn cho agent.</td></tr>
                <tr><td>Kho tác vụ</td><td>Khóa ngân sách tác vụ on-chain và trả cho worker qua escrow.</td></tr>
                <tr><td>Ra lệnh AI</td><td>Yêu cầu agent kiểm tra số dư hoặc gửi SOL bằng văn bản thường.</td></tr>
                <tr><td>Chính sách</td><td>Đặt hạn mức mỗi giao dịch và danh sách người nhận được phép.</td></tr>
                <tr><td>Phê duyệt</td><td>Xem lại mọi yêu cầu và duyệt các giao dịch đang chờ.</td></tr>
                <tr><td>Nhật ký kiểm toán</td><td>Đọc nhật ký chỉ ghi thêm về các quyết định và lần thực thi.</td></tr>
              </tbody>
            </table>
          ),
        },
      ],
    },
    {
      id: 'quickstart',
      group: 'Bắt đầu',
      title: 'Bắt đầu nhanh',
      summary: 'Kết nối ví, đặt chính sách, nạp vốn cho agent và chạy thử ba kết quả của chính sách.',
      keywords: 'demo tutorial first transfer hướng dẫn giao dịch đầu tiên',
      sections: [
        {
          id: 'before',
          title: 'Trước khi bắt đầu',
          body: (
            <ul>
              <li>Một ví Solana hỗ trợ ký tin nhắn (ví dụ Phantom), đặt ở mạng <strong>Devnet</strong>.</li>
              <li>Một ít SOL Devnet trong ví đó nếu bạn muốn tự nạp cho agent.</li>
            </ul>
          ),
        },
        {
          id: 'steps',
          title: 'Năm bước',
          body: (
            <Steps>
              <li>
                <strong>Đăng nhập.</strong> Kết nối ví và ký tin nhắn đăng nhập. Việc này chỉ tạo một phiên làm
                việc; nó không duyệt khoản thanh toán nào.
              </li>
              <li>
                <strong>Đặt chính sách.</strong> Đặt <em>Hạn mức mỗi giao dịch</em> là <code>0.1</code> SOL, bấm
                {' '}<em>Dùng ví cá nhân</em> để đưa ví của bạn vào danh sách cho phép với tên <code>my-wallet</code>,
                rồi bấm Lưu.{' '}
                <TabLink tab="policy" label="Chính sách" ctx={ctx} />
              </li>
              <li>
                <strong>Nạp vốn cho agent.</strong> Nhận seed 0.1 SOL (một lần) hoặc nạp từ ví của bạn.{' '}
                <TabLink tab="wallet" label="Tổng quan" ctx={ctx} />
              </li>
              <li>
                <strong>Chạy một lệnh.</strong> <code>Send 0.05 SOL to my-wallet</code> nằm trong hạn mức, nên agent
                ký và hiện liên kết Explorer.{' '}
                <TabLink tab="commands" label="Ra lệnh AI" ctx={ctx} />
              </li>
              <li>
                <strong>Thử các kết quả còn lại.</strong> <code>Send 0.5 SOL to my-wallet</code> bị giữ chờ bạn duyệt.
                Giao dịch tới một địa chỉ không có trong danh sách cho phép bị từ chối và không có lời mời duyệt.
              </li>
            </Steps>
          ),
        },
        {
          id: 'check',
          title: 'Kiểm tra kết quả',
          body: (
            <p>
              Mọi yêu cầu đều hiện trong tab Phê duyệt cùng trạng thái và kết luận của chính sách; mọi quyết định đều
              được ghi vào nhật ký kiểm toán kèm phiên bản chính sách tại thời điểm quyết định.{' '}
              <TabLink tab="approvals" label="Phê duyệt" ctx={ctx} />
            </p>
          ),
        },
      ],
    },
    {
      id: 'wallet',
      group: 'Hướng dẫn',
      title: 'Ví và nạp vốn',
      summary: 'Ví agent, ví chủ sở hữu và các cách nạp SOL Devnet vào agent.',
      keywords: 'airdrop faucet seed deposit balance owner nạp số dư',
      sections: [
        {
          id: 'two-wallets',
          title: 'Hai loại ví',
          body: (
            <ul>
              <li>
                <strong>Ví chủ sở hữu</strong> — ví của chính bạn. Ví này dùng để đăng nhập và là ví duy nhất duyệt
                được các giao dịch đang chờ. Khóa của nó không bao giờ rời khỏi ví.
              </li>
              <li>
                <strong>Ví agent</strong> — một cặp khóa riêng được tạo cho ví chủ sở hữu của bạn. Agent ký bằng ví
                này. Khóa riêng được mã hóa khi lưu và không bao giờ đưa cho model.
              </li>
            </ul>
          ),
        },
        {
          id: 'funding',
          title: 'Các cách nạp vốn',
          body: (
            <>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Nút</th>
                    <th>Điều gì xảy ra</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td>Nhận 0.1 SOL seed</td><td>Chuyển một lần từ ví cấp phát của dịch vụ. Mỗi agent chỉ nhận được một lần.</td></tr>
                  <tr><td>Nạp 0.1 SOL</td><td>Ví của bạn gửi 0.1 SOL cho agent. Ví sẽ yêu cầu bạn xác nhận.</td></tr>
                  <tr><td>Airdrop 1 SOL</td><td>Yêu cầu SOL từ vòi Devnet công khai. Thường bị giới hạn tần suất.</td></tr>
                  <tr><td>Trang vòi Solana chính thức</td><td>Mở faucet.solana.com với địa chỉ agent đã điền sẵn.</td></tr>
                </tbody>
              </table>
              <Callout tone="note" title="Số dư bằng 0 vẫn kiểm tra được chính sách">
                Quyết định của chính sách không phụ thuộc vào số dư. Chỉ giao dịch on-chain mới cần có tiền.
              </Callout>
              <TabLink tab="wallet" label="Tổng quan" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'policy',
      group: 'Hướng dẫn',
      title: 'Chính sách chi tiêu',
      summary: 'Hạn mức mỗi giao dịch, danh sách người nhận được phép và cách quyết định từng kết luận.',
      keywords: 'allowlist limit recipient verdict allow deny require_approval version hạn mức người nhận phiên bản',
      sections: [
        {
          id: 'fields',
          title: 'Các trường',
          body: (
            <ul>
              <li>
                <strong>Hạn mức mỗi giao dịch</strong> — số SOL lớn nhất agent được gửi mà không cần hỏi bạn.
              </li>
              <li>
                <strong>Người nhận</strong> — các địa chỉ có tên mà agent được phép trả tiền. Lệnh và công cụ MCP có
                thể gọi người nhận bằng tên hoặc đúng địa chỉ của họ.
              </li>
              <li>
                <strong>Dùng ví cá nhân</strong> — thêm ví bạn đang kết nối vào danh sách với tên <code>my-wallet</code>.
              </li>
            </ul>
          ),
        },
        {
          id: 'verdicts',
          title: 'Cách quyết định kết luận',
          body: (
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Điều kiện</th>
                  <th>Kết luận</th>
                  <th>Kết quả</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Người nhận không có trong danh sách cho phép</td><td><code>deny</code></td><td>Không ký gì cả. Không có lời mời duyệt.</td></tr>
                <tr><td>Số tiền bằng 0 hoặc không hợp lệ</td><td><code>deny</code></td><td>Không ký gì cả.</td></tr>
                <tr><td>Số tiền vượt hạn mức</td><td><code>require_approval</code></td><td>Giữ lại cho tới khi chủ ví duyệt.</td></tr>
                <tr><td>Có trong danh sách cho phép và trong hạn mức</td><td><code>allow</code></td><td>Agent ký và gửi giao dịch.</td></tr>
                <tr><td>Kiểm tra số dư</td><td><code>allow</code></td><td>Chỉ đọc, luôn được phép.</td></tr>
              </tbody>
            </table>
          ),
        },
        {
          id: 'versions',
          title: 'Phiên bản chính sách',
          body: (
            <>
              <p>
                Mỗi lần lưu làm tăng phiên bản chính sách. Mỗi quyết định và mỗi lần duyệt đều ghi lại phiên bản mà
                nó được đưa ra.
              </p>
              <Callout tone="warn" title="Lưu chính sách làm mất hiệu lực các yêu cầu đang chờ duyệt">
                Một lần duyệt gắn với phiên bản chính sách tại lúc yêu cầu bị giữ. Sau khi bạn lưu chính sách mới, việc
                duyệt một yêu cầu cũ đang giữ sẽ bị từ chối; hãy chạy lại lệnh.
              </Callout>
              <TabLink tab="policy" label="Chính sách" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'commands',
      group: 'Hướng dẫn',
      title: 'Lệnh',
      summary: 'Những chỉ dẫn bằng văn bản agent hiểu được, và những gì agent sẽ từ chối.',
      keywords: 'prompt console natural language presets fallback lệnh gợi ý',
      sections: [
        {
          id: 'actions',
          title: 'Các hành động được hỗ trợ',
          body: (
            <>
              <p>Một lệnh được chuyển thành đúng một trong các hành động này. Mọi thứ khác không được thực thi.</p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Hành động</th>
                    <th>Lệnh ví dụ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>get_balance</code></td><td>What is my balance?</td></tr>
                  <tr><td><code>transfer_sol</code></td><td>Send 0.05 SOL to my-wallet</td></tr>
                  <tr><td><code>transfer_spl</code></td><td>Send 5 USDC to my-wallet (chỉ khi mint đó nằm trong danh sách cho phép; mặc định chưa có mint nào)</td></tr>
                  <tr><td><code>request_manual_approval</code></td><td>Dùng khi yêu cầu chưa rõ; không có gì được thực thi.</td></tr>
                </tbody>
              </table>
            </>
          ),
        },
        {
          id: 'presets',
          title: 'Lệnh gợi ý',
          body: (
            <p>
              Khi đã có một người nhận trong danh sách cho phép, trang Ra lệnh AI hiện ba lệnh gợi ý: một lệnh dưới
              hạn mức (Tự động), một lệnh vượt hạn mức (Cần duyệt) và một lệnh tới địa chỉ không bao giờ nằm trong danh
              sách (Bị chặn). Đây là cách nhanh nhất để thấy cả ba kết luận.{' '}
              <TabLink tab="commands" label="Ra lệnh AI" ctx={ctx} />
            </p>
          ),
        },
        {
          id: 'retry',
          title: 'Thử lại',
          body: (
            <p>
              Nếu một lệnh thất bại vì phản hồi bị mất, chạy lại đúng văn bản đó sẽ dùng lại cùng khóa idempotency, nên
              agent không trả tiền hai lần cho một lệnh.
            </p>
          ),
        },
      ],
    },
    {
      id: 'approvals',
      group: 'Hướng dẫn',
      title: 'Phê duyệt',
      summary: 'Duyệt một giao dịch đang chờ bằng chữ ký ví, và chữ ký đó bao phủ những gì.',
      keywords: 'approve sign message expiry owner pending duyệt ký hết hạn',
      sections: [
        {
          id: 'how',
          title: 'Duyệt một giao dịch đang chờ',
          body: (
            <Steps>
              <li>Mở tab Phê duyệt. Các yêu cầu đang giữ có trạng thái <em>Chờ duyệt</em> và thời điểm hết hạn.</li>
              <li>Mở <em>Thông điệp ký</em> để đọc nội dung bạn sắp ký: số tiền, người nhận, phiên bản chính sách và thời hạn.</li>
              <li>Bấm <em>Duyệt</em> và ký thông điệp trong ví. Sau đó agent gửi giao dịch.</li>
            </Steps>
          ),
        },
        {
          id: 'rules',
          title: 'Quy tắc',
          body: (
            <ul>
              <li>Chỉ ví chủ sở hữu mới duyệt được. Ví khác đang kết nối sẽ thấy <em>Kết nối ví chủ sở hữu</em>.</li>
              <li>Bạn ký một thông điệp, không phải một giao dịch. Chữ ký chỉ cho phép đúng một yêu cầu, đúng một lần.</li>
              <li>Dashboard dựng lại thông điệp ngay trên máy bạn và từ chối ký nếu bản từ server khác.</li>
              <li>Lần duyệt hết hạn sau 5 phút theo mặc định. Quá thời gian đó, hãy chạy lại lệnh.</li>
            </ul>
          ),
        },
      ],
    },
    {
      id: 'task-vault',
      group: 'Hướng dẫn',
      title: 'Kho tác vụ',
      summary: 'Cấp cho agent một ngân sách tác vụ có giới hạn on-chain và trả worker qua escrow và biên nhận.',
      keywords: 'escrow receipt worker service capability pda revoke refund settle biên nhận thu hồi hoàn tiền',
      sections: [
        {
          id: 'concept',
          title: 'Khái niệm',
          body: (
            <p>
              Thay vì để agent chi tiêu tự do, chủ ví nạp vốn cho một <strong>Task Capability</strong>: một ngân sách,
              một hạn mức mỗi lần chi, một thời hạn và tùy chọn một worker và dịch vụ được phép. Agent chỉ chuyển được
              tiền từ vault của tác vụ vào escrow, và escrow chỉ giải phóng cho worker khi có biên nhận hợp lệ.
            </p>
          ),
        },
        {
          id: 'lifecycle',
          title: 'Vòng đời',
          body: (
            <Steps>
              <li>
                <strong>Nạp vốn.</strong> Nhập mã tác vụ, tổng ngân sách, hạn mức mỗi lần chi và thời hạn (1–168 giờ).
                Chọn <em>Gửi giao dịch on-chain lên Solana Devnet qua ví Phantom</em> để tạo trên Devnet qua ví của bạn;
                nếu không thì tác vụ chỉ được mô phỏng.
              </li>
              <li>
                <strong>Giải ngân.</strong> Chuyển một khoản vào escrow cho một worker. Worker và dịch vụ phải khớp giới
                hạn của tác vụ, và số tiền phải nằm trong hạn mức mỗi lần chi cùng ngân sách còn lại.
              </li>
              <li>
                <strong>Quyết toán kèm biên nhận.</strong> Worker trả về một biên nhận có chữ ký; escrow được giải
                phóng theo biên nhận đó.
              </li>
              <li>
                <strong>Đóng.</strong> <em>Thu hồi tác vụ</em> dừng các khoản thanh toán mới. <em>Hoàn tiền &amp; Đóng
                kho</em> trả ngân sách chưa chi về cho chủ ví khi không còn escrow nào đang giữ.
              </li>
            </Steps>
          ),
        },
        {
          id: 'modes',
          title: 'Tác vụ on-chain và mô phỏng',
          body: (
            <>
              <p>
                Tác vụ on-chain hiện nhãn <em>Giao dịch Devnet</em> và có liên kết Explorer. Tác vụ mô phỏng giữ cùng
                máy trạng thái nhưng ngoài chain và được gắn nhãn <em>Mô phỏng</em>.
              </p>
              <Callout tone="note" title="Hành động on-chain cần ví của bạn">
                Tạo, thu hồi và đóng một tác vụ on-chain đều do ví chủ sở hữu ký. Trình duyệt phải có Phantom.
              </Callout>
              <TabLink tab="tasks" label="Kho tác vụ" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'audit',
      group: 'Hướng dẫn',
      title: 'Nhật ký kiểm toán',
      summary: 'Bản ghi chỉ ghi thêm về mọi quyết định, lần duyệt và lần thực thi.',
      keywords: 'log history ciphertext sealed nhật ký lịch sử bản mã hóa',
      sections: [
        {
          id: 'contents',
          title: 'Những gì được ghi lại',
          body: (
            <>
              <p>
                Mỗi mục có thời gian, tên sự kiện, mã yêu cầu và phần chi tiết. Phần chi tiết được niêm phong bằng
                AES-256-GCM khi lưu; bật <em>Bản mã hóa</em> để xem dạng được lưu.
              </p>
              <TabLink tab="audit" label="Nhật ký kiểm toán" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'mcp',
      group: 'Tích hợp',
      title: 'MCP cho agent cá nhân',
      summary: 'Cho Claude Code, Cursor, Codex, Claude Desktop hoặc Antigravity dùng ví agent qua cùng cổng chính sách.',
      keywords: 'model context protocol claude cursor codex antigravity tools stdio integration token tích hợp',
      sections: [
        {
          id: 'about',
          title: 'Cách hoạt động',
          body: (
            <>
              <p>
                AI client của bạn là bên lập kế hoạch: nó gọi một công cụ với một giao dịch có cấu trúc, và dịch vụ
                agent chạy giao dịch đó qua cùng chính sách như một lệnh trên dashboard. Trong chính sách thì agent ký;
                vượt hạn mức thì yêu cầu chờ bạn duyệt tại đây; người nhận ngoài danh sách cho phép bị từ chối.
              </p>
              <p>
                Client kết nối tới URL <code>/mcp</code> của agent (Streamable HTTP) với MCP token cá nhân của bạn làm
                bearer header. Không cài gì lên máy của client: hãy sao chép cấu hình cho client của bạn từ card MCP
                trên trang <TabLink tab="commands" label="Ra lệnh AI" ctx={ctx} />.
              </p>
              <Callout tone="note" title="URL trỏ tới đâu">
                Trên dashboard hosted, URL là origin của dashboard, nên máy nào cũng kết nối được. Khi bạn tự chạy cả
                hệ thống, URL là <code>http://127.0.0.1:8787/mcp</code> và chỉ truy cập được từ cùng máy. Nếu bạn đã
                clone repository, bạn cũng có thể dùng bản stdio chạy local được mô tả ở mục{' '}
                <em>Cài đặt từ repository</em>.
              </Callout>
            </>
          ),
        },
        {
          id: 'tools',
          title: 'Công cụ',
          body: (
            <>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Công cụ</th>
                    <th>Chức năng</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>nexuspay_get_status</code></td><td>Địa chỉ agent, số dư SOL, hạn mức mỗi giao dịch, các nhãn trong danh sách cho phép.</td></tr>
                  <tr><td><code>nexuspay_list_requests</code></td><td>Các yêu cầu gần đây kèm kết luận và kết quả. Có thể lọc theo trạng thái.</td></tr>
                  <tr><td><code>nexuspay_get_request</code></td><td>Một yêu cầu, ví dụ để xem bạn đã duyệt hay chưa.</td></tr>
                  <tr><td><code>nexuspay_transfer_sol</code></td><td>Đề xuất chuyển SOL. Chính sách quyết định.</td></tr>
                  <tr><td><code>nexuspay_transfer_spl</code></td><td>Đề xuất chuyển token SPL. Người nhận và mint phải nằm trong danh sách cho phép.</td></tr>
                </tbody>
              </table>
              <p>
                Không có công cụ nào để đổi chính sách, liên kết chủ sở hữu hay duyệt một yêu cầu. MCP token chỉ truy
                cập được trạng thái ví, danh sách yêu cầu, một yêu cầu và các đề xuất chuyển tiền mới. Chính sách, phê
                duyệt, nạp vốn và các hành động Kho tác vụ vẫn cần phiên ví của bạn trên dashboard này.
              </p>
            </>
          ),
        },
        {
          id: 'connect',
          title: 'Kết nối một client',
          body: (
            <>
              <Steps>
                <li>
                  Đăng nhập dashboard này bằng ví, rồi mở <em>Hiện kết nối của tôi</em> trong card MCP trên trang
                  {' '}<TabLink tab="commands" label="Ra lệnh AI" ctx={ctx} />. Trên dashboard hosted, bấm
                  {' '}<em>Tạo token kết nối</em>; token chỉ hiện một lần.
                </li>
                <li>
                  Chọn client của bạn và sao chép cấu hình tương ứng. Card hiện token ở dạng bị ẩn; <em>Sao chép</em>
                  {' '}vẫn chép đủ giá trị vào clipboard.
                  <table className="docs-table">
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th>Cấu hình đặt ở đâu</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr><td>Claude Code</td><td>Chạy một lần lệnh <code>claude mcp add --transport http …</code>.</td></tr>
                      <tr><td>Codex</td><td><code>~/.codex/config.toml</code> (<code>url</code> + <code>http_headers</code>).</td></tr>
                      <tr><td>Antigravity</td><td><code>~/.gemini/config/mcp_config.json</code> (<code>serverUrl</code> + <code>headers</code>).</td></tr>
                      <tr><td>Claude Desktop</td><td><code>claude_desktop_config.json</code>, qua cầu nối <code>mcp-remote</code> (cần Node.js).</td></tr>
                    </tbody>
                  </table>
                </li>
                <li>
                  Khởi động lại hoặc tải lại client, rồi hỏi nó kiểu như <em>&ldquo;Kiểm tra trạng thái ví nexusPay của
                  tôi&rdquo;</em>.
                </li>
              </Steps>
            </>
          ),
        },
        {
          id: 'setup',
          title: 'Cài đặt từ repository',
          body: (
            <>
              <p>Nếu bạn tự chạy hệ thống, bản stdio chạy local không cần token:</p>
              <Steps>
                <li>
                  Khởi động hệ thống từ thư mục gốc của repository. Lệnh này cũng build bundle MCP tại
                  {' '}<code>dist/mcp/nexuspay-mcp.mjs</code>.
                  <CodeBlock label="Terminal" code="pnpm dev" />
                </li>
                <li>
                  Đăng nhập dashboard này bằng ví một lần. Việc đó tạo agent của bạn và MCP token của nó.
                </li>
                <li>
                  Kết nối client của bạn:
                  <Tabs
                    items={[
                      {
                        id: 'claude-code',
                        label: 'Claude Code',
                        body: (
                          <p className="docs-muted">
                            Mở Claude Code ở thư mục gốc của repository, không phải thư mục con, và đồng ý cho dùng
                            server của dự án từ <code>.mcp.json</code> khi được hỏi. File này đã được commit sẵn; không có
                            đường dẫn hay bí mật nào cần điền.
                          </p>
                        ),
                      },
                      {
                        id: 'cursor',
                        label: 'Cursor',
                        body: (
                          <p className="docs-muted">
                            Mở thư mục gốc của repository (không phải thư mục con) và bật <code>nexuspay</code> từ file
                            {' '}<code>.cursor/mcp.json</code> đã commit sẵn.
                          </p>
                        ),
                      },
                      {
                        id: 'codex',
                        label: 'Codex',
                        body: (
                          <>
                            <p className="docs-muted">
                              Đăng ký server vào <code>~/.codex/config.toml</code>. Repository cũng có sẵn
                              {' '}<code>.codex/config.toml</code> của dự án, nhưng Codex chỉ đọc nó với các dự án được tin
                              cậy, nên dùng trình cài đặt là cách chắc chắn.
                            </p>
                            <CodeBlock label="Terminal" code="pnpm mcp:install -- --client codex" />
                          </>
                        ),
                      },
                      {
                        id: 'claude-desktop',
                        label: 'Claude Desktop',
                        body: (
                          <>
                            <p className="docs-muted">
                              Đăng ký server vào <code>claude_desktop_config.json</code>. Sau đó hãy khởi động lại
                              Claude Desktop.
                            </p>
                            <CodeBlock label="Terminal" code="pnpm mcp:install -- --client claude-desktop" />
                          </>
                        ),
                      },
                      {
                        id: 'antigravity',
                        label: 'Antigravity',
                        body: (
                          <>
                            <p className="docs-muted">
                              Đăng ký server vào <code>~/.gemini/config/mcp_config.json</code>.
                            </p>
                            <CodeBlock label="Terminal" code="pnpm mcp:install -- --client antigravity" />
                          </>
                        ),
                      },
                    ]}
                  />
                </li>
                <li>
                  Hỏi client của bạn kiểu như <em>&ldquo;Kiểm tra trạng thái ví nexusPay của tôi&rdquo;</em>, rồi
                  {' '}<em>&ldquo;Gửi 0.05 SOL tới my-wallet&rdquo;</em>.
                </li>
              </Steps>
              <Callout tone="note" title="Về trình cài đặt">
                Khi không có <code>--client</code>, <code>pnpm mcp:install</code> đăng ký cùng lúc Codex, Claude Desktop
                và Antigravity. Nó ghi đường dẫn tuyệt đối và không ghi token, đồng thời giữ bản sao lưu cho mỗi file cấu
                hình nó thay đổi (<code>.bak</code>, hoặc <code>.bak-…</code> có dấu thời gian khi đã có sẵn). Thêm
                {' '}<code>--dry-run</code> để xem trước cấu hình.
              </Callout>
              <p>
                Phương án dự phòng: chạy <code>pnpm mcp:config</code> để lấy cấu hình với đường dẫn tuyệt đối của bundle,
                hoặc dùng URL từ xa trong card MCP (xem <em>Kết nối một client</em>).
              </p>
            </>
          ),
        },
        {
          id: 'token',
          title: 'MCP token',
          body: (
            <ul>
              <li>
                Gửi đi dưới dạng bearer token. File token là <code>agent/data/users/&lt;owner&gt;/mcp-token</code>. Trên
                dashboard hosted, file chỉ chứa bản băm SHA-256 của token: bản thân token chỉ hiện một lần, lúc bạn tạo
                hoặc đổi token, và không thể hiện lại. Khi bạn tự chạy hệ thống ở local, file chứa chính token đó, nên
                server MCP đọc được nó từ thư mục dữ liệu của agent.
              </li>
              <li>
                <em>Đổi token mới</em> trong card MCP ở trang Ra lệnh AI sẽ thay token. Các client kết nối bằng URL sẽ
                ngừng hoạt động cho tới khi bạn sao chép lại cấu hình của chúng. Bản stdio chạy local đọc lại file khi
                agent từ chối token cũ nên không cần khởi động lại; token ghim bằng
                {' '}<code>NEXUS_AGENT_TOKEN</code> không được đọc lại và phải cập nhật thủ công.
              </li>
              <li>
                File ở local là plaintext trên đĩa, nằm trong cùng ranh giới tin cậy với keystore của agent. Trên Windows,
                quyền truy cập phụ thuộc vào ACL của thư mục. Việc băm không bảo vệ được token đã sao chép sang client:
                hãy đổi token nếu nó bị lộ.
              </li>
            </ul>
          ),
        },
        {
          id: 'env',
          title: 'Thiết lập tùy chọn',
          body: (
            <>
              <p>
                Với một chủ ví duy nhất và cấu hình mặc định thì không cần cái nào. Đặt chúng trong khối
                {' '}<code>env</code> của client.
              </p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Biến</th>
                    <th>Mặc định</th>
                    <th>Khi nào cần đặt</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>NEXUS_OWNER_PUBKEY</code></td><td>tự động</td><td>Có hơn một chủ ví đã đăng nhập trên máy này.</td></tr>
                  <tr><td><code>NEXUS_AGENT_DATA_DIR</code></td><td>tự động</td><td>Dịch vụ agent dùng thư mục dữ liệu khác mặc định.</td></tr>
                  <tr><td><code>NEXUS_AGENT_TOKEN</code></td><td>tự động</td><td>Dùng một token cụ thể thay cho token trên đĩa.</td></tr>
                  <tr><td><code>NEXUS_API_URL</code></td><td><code>http://127.0.0.1:8787</code></td><td>Agent chạy ở cổng khác. Chỉ loopback.</td></tr>
                  <tr><td><code>NEXUS_DASHBOARD_URL</code></td><td><code>http://localhost:5173</code></td><td>Hiện trong gợi ý duyệt. Chỉ loopback.</td></tr>
                  <tr><td><code>NEXUS_TIMEOUT_MS</code></td><td><code>45000</code></td><td>Giữ dưới mức timeout công cụ mặc định 60 giây của Codex.</td></tr>
                </tbody>
              </table>
            </>
          ),
        },
        {
          id: 'retries',
          title: 'Phê duyệt và thử lại',
          body: (
            <ul>
              <li>
                Giao dịch vượt hạn mức trả về <code>pending_approval</code> kèm thời hạn. Hãy duyệt nó trong tab Phê
                duyệt; client có thể poll <code>nexuspay_get_request</code> để biết kết quả.
              </li>
              <li>
                Mỗi giao dịch mang một khóa idempotency. Nếu một lệnh gọi bị timeout hoặc agent trả lỗi server, công cụ
                trả về <code>outcome_unknown</code> kèm khóa đó. Thử lại với cùng khóa thì không thể trả tiền hai lần;
                không bao giờ đổi số tiền khi thử lại.
              </li>
              <li>
                Dùng lại một khóa cho giao dịch khác trả về <code>IDEMPOTENCY_CONFLICT</code>. Hai lệnh gọi với hai khóa
                khác nhau là hai giao dịch, chỉ bị giới hạn bởi chính sách.
              </li>
            </ul>
          ),
        },
        {
          id: 'mcp-troubleshooting',
          title: 'Xử lý sự cố',
          body: (
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Triệu chứng</th>
                  <th>Cách xử lý</th>
                </tr>
              </thead>
              <tbody>
                <tr><td><code>mcp_setup_required</code>: không tìm thấy MCP token</td><td>Đăng nhập dashboard này bằng ví một lần trên máy này. Lần gọi công cụ kế tiếp sẽ nhận token; không cần khởi động lại client.</td></tr>
                <tr><td><code>mcp_setup_required</code>: có nhiều chủ ví</td><td>Đặt <code>NEXUS_OWNER_PUBKEY</code> bằng địa chỉ ví của bạn trong env của client.</td></tr>
                <tr><td><code>mcp_token_rejected</code></td><td>Token đã bị đổi hoặc agent dùng thư mục dữ liệu khác. Kiểm tra <code>NEXUS_AGENT_DATA_DIR</code>, hoặc đăng nhập lại.</td></tr>
                <tr><td><code>agent_unreachable</code></td><td>Chạy <code>pnpm dev</code> từ thư mục gốc của repository; kiểm tra <code>NEXUS_API_URL</code>.</td></tr>
                <tr><td>Server không khởi động được từ <code>.mcp.json</code></td><td>Client được mở ở thư mục con nên đường dẫn tương đối tới bundle không phân giải được. Hãy mở nó ở thư mục gốc của repository, hoặc đăng ký đường dẫn tuyệt đối: <code>claude mcp add -s user nexuspay -- node &lt;path from pnpm mcp:config&gt;</code> cho Claude Code, hoặc dán JSON của <code>pnpm mcp:config</code> vào <code>~/.cursor/mcp.json</code> cho Cursor. <code>pnpm mcp:install</code> chỉ bao gồm Codex, Claude Desktop và Antigravity.</td></tr>
                <tr><td><code>Cannot find module .../nexuspay-mcp.mjs</code></td><td>Chạy <code>pnpm mcp:build</code> và kiểm tra <code>dist/mcp/nexuspay-mcp.mjs</code>.</td></tr>
                <tr><td>Không tìm thấy <code>node</code></td><td>Cài Node.js 22+, hoặc đặt đường dẫn tuyệt đối của <code>node</code> vào <code>command</code>.</td></tr>
                <tr><td>Codex cắt lệnh gọi ở 60 giây</td><td>Giữ <code>tool_timeout_sec = 90</code> trong cấu hình Codex.</td></tr>
                <tr><td>Antigravity từ chối schema của công cụ</td><td>Chạy <code>pnpm mcp:build</code> và khởi động lại Antigravity.</td></tr>
                <tr><td><code>AGENT_FROZEN</code></td><td>Chủ ví đã khóa agent. Nhờ chủ ví mở khóa trên dashboard; đừng thử lại giao dịch khi agent đang bị khóa.</td></tr>
                <tr><td><code>RATE_LIMITED</code></td><td>Quá nhiều request từ token hoặc địa chỉ này. Chờ <code>details.retryAfterSeconds</code> giây rồi thử lại; với giao dịch thì dùng lại đúng <code>idempotencyKey</code>.</td></tr>
                <tr><td><code>DAILY_LIMIT_EXCEEDED</code></td><td>Đã vượt hạn mức chi tiêu 24 giờ. Chủ ví phải duyệt giao dịch này trên dashboard, hoặc chờ hạn mức được hoàn lại.</td></tr>
              </tbody>
            </table>
          ),
        },
      ],
    },
    {
      id: 'statuses',
      group: 'Tham chiếu',
      title: 'Trạng thái yêu cầu',
      summary: 'Mọi trạng thái một yêu cầu có thể có và ý nghĩa của chúng.',
      keywords: 'status pending confirmed failed denied expired queued trạng thái',
      sections: [
        {
          id: 'table',
          title: 'Các trạng thái',
          body: (
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Nhãn</th>
                  <th>Trạng thái</th>
                  <th>Ý nghĩa</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Chờ xử lý</td><td><code>planned</code></td><td>Đã lập kế hoạch, chưa có quyết định.</td></tr>
                <tr><td>Tự động</td><td><code>auto_approved</code></td><td>Chính sách cho phép; agent đang ký.</td></tr>
                <tr><td>Chờ duyệt</td><td><code>pending_approval</code></td><td>Vượt hạn mức; đang chờ chủ ví.</td></tr>
                <tr><td>Đã duyệt</td><td><code>approved</code></td><td>Chủ ví đã duyệt; agent đang gửi giao dịch.</td></tr>
                <tr><td>Thành công</td><td><code>confirmed</code></td><td>Đã được xác nhận trên Devnet. Có liên kết Explorer.</td></tr>
                <tr><td>Bị từ chối</td><td><code>denied</code></td><td>Bị chính sách từ chối. Không có gì được ký.</td></tr>
                <tr><td>Đã hết hạn</td><td><code>expired</code></td><td>Khung thời gian duyệt đã đóng.</td></tr>
                <tr><td>Thất bại</td><td><code>failed</code></td><td>Gửi giao dịch thất bại, ví dụ do số dư thấp.</td></tr>
              </tbody>
            </table>
          ),
        },
      ],
    },
    {
      id: 'troubleshooting',
      group: 'Tham chiếu',
      title: 'Xử lý sự cố',
      summary: 'Các lỗi thường gặp trên dashboard và cách xử lý.',
      keywords: 'error faq 429 session expired phantom lỗi phiên hết hạn',
      sections: [
        {
          id: 'common',
          title: 'Vấn đề thường gặp',
          body: (
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Triệu chứng</th>
                  <th>Nguyên nhân và cách xử lý</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Airdrop lỗi 429</td><td>Vòi công khai đang bị giới hạn tần suất. Hãy nạp từ ví của bạn hoặc dùng liên kết Trang vòi Solana chính thức.</td></tr>
                <tr><td>“Kết nối ví chủ sở hữu” ở nút Duyệt</td><td>Ví đang kết nối không phải ví chủ sở hữu. Hãy chuyển sang ví bạn đã dùng để đăng nhập.</td></tr>
                <tr><td>Lần duyệt bị từ chối</td><td>Yêu cầu đã hết hạn, hoặc chính sách đã được lưu sau khi yêu cầu bị giữ. Hãy chạy lại lệnh.</td></tr>
                <tr><td>“Phiên làm việc đã hết hạn”</td><td>Hãy đăng nhập lại bằng ví. Đổi tài khoản ví cũng làm kết thúc phiên.</td></tr>
                <tr><td>Yêu cầu hiện <code>[fallback]</code></td><td>Chưa cấu hình API key của model. Bộ phân tích xác định xử lý các lệnh đơn giản.</td></tr>
                <tr><td>Thực thi thất bại</td><td>Số dư của agent không đủ cho số tiền cộng phí. Hãy nạp vốn cho agent.</td></tr>
              </tbody>
            </table>
          ),
        },
        {
          id: 'security',
          title: 'Ranh giới bảo mật',
          body: (
            <ul>
              <li>Seed phrase của bạn nằm lại trong ví. Dịch vụ chỉ thấy public key và chữ ký của bạn.</li>
              <li>Ví agent giữ một ngân sách Devnet nhỏ. Dù dịch vụ bị xâm nhập cũng không chạm được vào tiền của bạn.</li>
              <li>Không bao giờ dán khóa riêng hay seed phrase vào một lệnh, một MCP client hay dashboard này.</li>
            </ul>
          ),
        },
      ],
    },
  ];
}
