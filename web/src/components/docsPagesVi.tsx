import type { TranslationDictionary } from '../i18n/types.js';
import { Callout, CodeBlock, Steps, TabLink, Tabs, type DocPage, type DocsContext } from './docsBlocks.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';

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
                Khi chưa có API key của model, agent dùng một deterministic parser dự phòng. Các yêu cầu đó hiện
                {' '}<code>[fallback]</code> trong model trace; việc áp dụng chính sách vẫn như nhau.
              </p>
            </>
          ),
        },
        {
          id: 'map',
          title: 'Bản đồ dashboard',
          body: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tab</TableHead>
                  <TableHead>Dùng để</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>Tổng quan</TableCell><TableCell>Xem ví agent, kết nối ví chủ sở hữu, nạp vốn cho agent.</TableCell></TableRow>
                <TableRow><TableCell>Task Vault</TableCell><TableCell>Khóa ngân sách tác vụ on-chain và trả cho worker qua escrow.</TableCell></TableRow>
                <TableRow><TableCell>Yêu cầu thanh toán</TableCell><TableCell>Yêu cầu agent kiểm tra số dư hoặc gửi SOL bằng văn bản thường.</TableCell></TableRow>
                <TableRow><TableCell>Chính sách chi tiêu</TableCell><TableCell>Đặt hạn mức mỗi giao dịch và danh sách người nhận được phép.</TableCell></TableRow>
                <TableRow><TableCell>Chờ duyệt</TableCell><TableCell>Xem lại mọi yêu cầu và duyệt các giao dịch đang chờ.</TableCell></TableRow>
                <TableRow><TableCell>Nhật ký kiểm toán</TableCell><TableCell>Đọc nhật ký chỉ ghi thêm về các quyết định và lần thực thi.</TableCell></TableRow>
              </TableBody>
            </Table>
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
                {' '}<em>Dùng ví chủ sở hữu</em> để đưa ví của bạn vào danh sách cho phép với tên <code>my-wallet</code>,
                rồi bấm Lưu.{' '}
                <TabLink tab="policy" label="Chính sách chi tiêu" ctx={ctx} />
              </li>
              <li>
                <strong>Nạp vốn cho agent.</strong> Nhận seed 0.1 SOL (một lần) hoặc nạp từ ví của bạn.{' '}
                <TabLink tab="wallet" label="Tổng quan" ctx={ctx} />
              </li>
              <li>
                <strong>Chạy một lệnh.</strong> <code>Send 0.05 SOL to my-wallet</code> nằm trong hạn mức, nên agent
                ký và hiện liên kết Explorer.{' '}
                <TabLink tab="commands" label="Yêu cầu thanh toán" ctx={ctx} />
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
              Mọi yêu cầu đều hiện trong tab Chờ duyệt cùng trạng thái và kết luận của chính sách; mọi quyết định đều
              được ghi vào nhật ký kiểm toán kèm phiên bản chính sách tại thời điểm quyết định.{' '}
              <TabLink tab="approvals" label="Chờ duyệt" ctx={ctx} />
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
      keywords: 'faucet seed deposit balance owner nạp số dư',
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nút</TableHead>
                    <TableHead>Điều gì xảy ra</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell>Nhận 0.1 SOL seed</TableCell><TableCell>Chuyển một lần từ ví cấp phát của dịch vụ. Mỗi agent chỉ nhận được một lần.</TableCell></TableRow>
                  <TableRow><TableCell>Nạp 0.1 SOL</TableCell><TableCell>Ví của bạn gửi 0.1 SOL cho agent. Ví sẽ yêu cầu bạn xác nhận.</TableCell></TableRow>
                  <TableRow><TableCell>Trang vòi Solana chính thức</TableCell><TableCell>Mở faucet.solana.com với địa chỉ agent đã điền sẵn.</TableCell></TableRow>
                </TableBody>
              </Table>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Điều kiện</TableHead>
                  <TableHead>Kết luận</TableHead>
                  <TableHead>Kết quả</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>Người nhận không có trong danh sách cho phép</TableCell><TableCell><code>deny</code></TableCell><TableCell>Không ký gì cả. Không có lời mời duyệt.</TableCell></TableRow>
                <TableRow><TableCell>Số tiền bằng 0 hoặc không hợp lệ</TableCell><TableCell><code>deny</code></TableCell><TableCell>Không ký gì cả.</TableCell></TableRow>
                <TableRow><TableCell>Số tiền vượt hạn mức</TableCell><TableCell><code>require_approval</code></TableCell><TableCell>Giữ lại cho tới khi chủ ví duyệt.</TableCell></TableRow>
                <TableRow><TableCell>Có trong danh sách cho phép và trong hạn mức</TableCell><TableCell><code>allow</code></TableCell><TableCell>Agent ký và gửi giao dịch.</TableCell></TableRow>
                <TableRow><TableCell>Kiểm tra số dư</TableCell><TableCell><code>allow</code></TableCell><TableCell>Chỉ đọc, luôn được phép.</TableCell></TableRow>
              </TableBody>
            </Table>
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
              <TabLink tab="policy" label="Chính sách chi tiêu" ctx={ctx} />
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hành động</TableHead>
                    <TableHead>Lệnh ví dụ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell><code>get_balance</code></TableCell><TableCell>What is my balance?</TableCell></TableRow>
                  <TableRow><TableCell><code>transfer_sol</code></TableCell><TableCell>Send 0.05 SOL to my-wallet</TableCell></TableRow>
                  <TableRow><TableCell><code>transfer_spl</code></TableCell><TableCell>Send 5 USDC to my-wallet (chỉ khi mint đó nằm trong danh sách cho phép; mặc định chưa có mint nào)</TableCell></TableRow>
                  <TableRow><TableCell><code>request_manual_approval</code></TableCell><TableCell>Dùng khi yêu cầu chưa rõ; không có gì được thực thi.</TableCell></TableRow>
                </TableBody>
              </Table>
            </>
          ),
        },
        {
          id: 'presets',
          title: 'Lệnh gợi ý',
          body: (
            <p>
              Khi đã có một người nhận trong danh sách cho phép, trang Yêu cầu thanh toán hiện ba lệnh gợi ý: một lệnh dưới
              hạn mức mỗi giao dịch, một lệnh vượt hạn mức mỗi giao dịch và một lệnh tới địa chỉ ngoài danh
              sách cho phép. Kết quả còn phụ thuộc vào số dư, hạn mức 24 giờ và trạng thái khóa agent.{' '}
              <TabLink tab="commands" label="Yêu cầu thanh toán" ctx={ctx} />
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
      title: 'Chờ duyệt',
      summary: 'Duyệt một giao dịch đang chờ bằng chữ ký ví, và chữ ký đó bao phủ những gì.',
      keywords: 'approve sign message expiry owner pending duyệt ký hết hạn',
      sections: [
        {
          id: 'how',
          title: 'Duyệt một giao dịch đang chờ',
          body: (
            <Steps>
              <li>Mở tab Chờ duyệt. Các yêu cầu đang giữ có trạng thái <em>Chờ duyệt</em> và thời điểm hết hạn.</li>
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
      title: 'Task Vault',
      summary: 'Cấp cho agent một ngân sách tác vụ có giới hạn on-chain và trả worker qua escrow và Receipt.',
      keywords: 'escrow receipt worker service capability pda revoke refund settle Receipt thu hồi hoàn tiền',
      sections: [
        {
          id: 'concept',
          title: 'Khái niệm',
          body: (
            <p>
              Thay vì để agent chi tiêu tự do, chủ ví nạp vốn cho một <strong>Task Capability</strong>: một ngân sách,
              một hạn mức mỗi lần chi, một thời hạn và tùy chọn một worker và dịch vụ được phép. Agent chỉ chuyển được
              tiền từ vault của tác vụ vào escrow. Worker bàn giao output để kiểm tra; chủ ví phải ký nghiệm thu đúng output và khoản thanh toán trước khi trả tiền.
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
                Chọn <em>Ghi tác vụ lên Solana Devnet bằng ví Phantom</em> để tạo trên Devnet qua ví của bạn;
                nếu không thì tác vụ chỉ được mô phỏng.
              </li>
              <li>
                <strong>Giữ tiền trong Escrow.</strong> Chuyển một khoản vào escrow cho một worker. Worker và dịch vụ phải khớp giới
                hạn của tác vụ, và số tiền phải nằm trong hạn mức mỗi lần chi cùng ngân sách còn lại.
              </li>
              <li>
                <strong>Bàn giao output.</strong> Mock Worker tạo output và ký hash của nội dung đó. Output được lưu để kiểm tra; tiền vẫn giữ trong Escrow.
              </li>
              <li>
                <strong>Nghiệm thu và trả tiền.</strong> Đọc output đã bàn giao, xác nhận đồng ý nghiệm thu và ký bằng ví chủ sở hữu trước khi tác vụ hết hạn. Program kiểm tra chữ ký cho đúng output, Escrow và số tiền. Chất lượng do chủ ví kiểm tra; chưa có xác minh độc lập hoặc phân xử tranh chấp. Nếu không nghiệm thu, tiền giữ đến expiry rồi có thể hoàn về chủ ví. Chưa hỗ trợ thay thế output hoặc luồng sửa lại.
              </li>
              <li>
                <strong>Đóng.</strong> <em>Thu hồi quyền chi</em> dừng các khoản thanh toán mới. <em>Hoàn tiền và đóng Task Vault</em> trả ngân sách chưa phân bổ về cho chủ ví khi không còn Escrow đang giữ. Sau expiry, Escrow còn giữ cần được hoàn riêng; màn hình hiện chưa hỗ trợ thao tác này.
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
                điều kiện ngân sách và trạng thái nhưng chỉ lưu bản ghi local, không chuyển SOL trên Devnet; được gắn nhãn <em>Mô phỏng</em>.
              </p>
              <Callout tone="note" title="Hành động on-chain cần ví của bạn">
                Tạo, nghiệm thu output, thu hồi và đóng tác vụ đều cần ví chủ sở hữu. Trình duyệt phải có Phantom.
              </Callout>
              <TabLink tab="tasks" label="Task Vault" ctx={ctx} />
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
                Ứng dụng AI gửi yêu cầu chuyển tiền có cấu trúc qua MCP. Dịch vụ
                agent kiểm tra cùng chính sách chi tiêu như yêu cầu trên dashboard. Đáp ứng chính sách thì ví agent ký;
                vượt hạn mức thì yêu cầu chờ bạn duyệt tại đây; người nhận ngoài danh sách cho phép bị từ chối.
              </p>
              <p>
                Client kết nối tới URL <code>/mcp</code> của agent (Streamable HTTP) với MCP token cá nhân của bạn làm
                bearer header. Không cài gì lên máy của client: hãy sao chép cấu hình cho client của bạn từ card MCP
                trên trang <TabLink tab="commands" label="Yêu cầu thanh toán" ctx={ctx} />.
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Công cụ</TableHead>
                    <TableHead>Chức năng</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell><code>nexuspay_get_status</code></TableCell><TableCell>Địa chỉ agent, số dư SOL, hạn mức mỗi giao dịch, các nhãn trong danh sách cho phép.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_list_requests</code></TableCell><TableCell>Các yêu cầu gần đây kèm kết luận và kết quả. Có thể lọc theo trạng thái.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_get_request</code></TableCell><TableCell>Một yêu cầu, ví dụ để xem bạn đã duyệt hay chưa.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_transfer_sol</code></TableCell><TableCell>Đề xuất chuyển SOL. Chính sách quyết định.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_transfer_spl</code></TableCell><TableCell>Đề xuất chuyển token SPL. Người nhận và mint phải nằm trong danh sách cho phép.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_list_tasks</code></TableCell><TableCell>Đọc Task Vault đã được cấp quyền, ngân sách còn lại, cap và expiry.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_get_task</code></TableCell><TableCell>Đọc task, Escrow và Receipt. Record local chưa được reconcile lại với chain.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_execute_task_payment</code></TableCell><TableCell>Tạo Escrow trong capability đã cấp. Worker nhận tiền ở bước settlement riêng.</TableCell></TableRow>
                </TableBody>
              </Table>
              <p>
                MCP có thể đọc trạng thái ví, request và task, đề xuất transfer và tạo Escrow trong capability đã cấp.
                Đổi chính sách, ký duyệt, tạo/nạp task, thu hồi quyền, settlement, refund và khóa/mở khóa agent
                vẫn cần phiên ví chủ sở hữu.
              </p>
              <p>
                Task payment kiểm tra giới hạn của capability và không vào hàng chờ duyệt transfer. Khi retry kết quả
                chưa rõ, giữ nguyên <code>paymentId</code> và các tham số. Task mô phỏng không chuyển SOL;
                bản Devnet hiện sử dụng Mock Worker do server giữ signer.
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
                  Đăng nhập dashboard này bằng ví, rồi mở <em>Xem cấu hình kết nối</em> trong card MCP trên trang
                  {' '}<TabLink tab="commands" label="Yêu cầu thanh toán" ctx={ctx} />. Trên dashboard hosted, bấm
                  {' '}<em>Tạo token kết nối</em>; token chỉ hiện một lần.
                </li>
                <li>
                  Chọn client của bạn và sao chép cấu hình tương ứng. Card hiện token ở dạng bị ẩn; <em>Sao chép</em>
                  {' '}vẫn chép đủ giá trị vào clipboard.
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client</TableHead>
                        <TableHead>Cấu hình đặt ở đâu</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow><TableCell>Claude Code</TableCell><TableCell>Chạy một lần lệnh <code>claude mcp add --transport http …</code>.</TableCell></TableRow>
                      <TableRow><TableCell>Codex</TableCell><TableCell><code>~/.codex/config.toml</code> (<code>url</code> + <code>http_headers</code>).</TableCell></TableRow>
                      <TableRow><TableCell>Antigravity</TableCell><TableCell><code>~/.gemini/config/mcp_config.json</code> (<code>serverUrl</code> + <code>headers</code>).</TableCell></TableRow>
                      <TableRow><TableCell>Claude Desktop</TableCell><TableCell><code>claude_desktop_config.json</code>, qua cầu nối <code>mcp-remote</code> (cần Node.js).</TableCell></TableRow>
                    </TableBody>
                  </Table>
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
                          <p className="text-muted">
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
                          <p className="text-muted">
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
                            <p className="text-muted">
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
                            <p className="text-muted">
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
                            <p className="text-muted">
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
                dashboard hosted, file chỉ chứa SHA-256 hash của token: bản thân token chỉ hiện một lần, lúc bạn tạo
                hoặc đổi token, và không thể hiện lại. Khi bạn tự chạy hệ thống ở local, file chứa chính token đó, nên
                server MCP đọc được nó từ thư mục dữ liệu của agent.
              </li>
              <li>
                <em>Tạo token mới</em> trong card MCP ở trang Yêu cầu thanh toán sẽ thay token. Các client kết nối bằng URL sẽ
                ngừng hoạt động cho tới khi bạn sao chép lại cấu hình của chúng. Bản stdio chạy local đọc lại file khi
                agent từ chối token cũ nên không cần khởi động lại; token ghim bằng
                {' '}<code>NEXUS_AGENT_TOKEN</code> không được đọc lại và phải cập nhật thủ công.
              </li>
              <li>
                File ở local là plaintext trên đĩa, nằm trong cùng ranh giới tin cậy với keystore của agent. Trên Windows,
                quyền truy cập phụ thuộc vào ACL của thư mục. Cơ chế hash không bảo vệ được token đã sao chép sang client:
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Biến</TableHead>
                    <TableHead>Mặc định</TableHead>
                    <TableHead>Khi nào cần đặt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell><code>NEXUS_OWNER_PUBKEY</code></TableCell><TableCell>tự động</TableCell><TableCell>Có hơn một chủ ví đã đăng nhập trên máy này.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_AGENT_DATA_DIR</code></TableCell><TableCell>tự động</TableCell><TableCell>Dịch vụ agent dùng thư mục dữ liệu khác mặc định.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_AGENT_TOKEN</code></TableCell><TableCell>tự động</TableCell><TableCell>Dùng một token cụ thể thay cho token trên đĩa.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_API_URL</code></TableCell><TableCell><code>http://127.0.0.1:8787</code></TableCell><TableCell>Agent chạy ở cổng khác. Chỉ loopback.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_DASHBOARD_URL</code></TableCell><TableCell><code>http://localhost:5173</code></TableCell><TableCell>Hiện trong gợi ý duyệt. Chỉ loopback.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_TIMEOUT_MS</code></TableCell><TableCell><code>45000</code></TableCell><TableCell>Giữ dưới mức timeout công cụ mặc định 60 giây của Codex.</TableCell></TableRow>
                </TableBody>
              </Table>
            </>
          ),
        },
        {
          id: 'retries',
          title: 'Chờ duyệt và thử lại',
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Triệu chứng</TableHead>
                  <TableHead>Cách xử lý</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell><code>mcp_setup_required</code>: không tìm thấy MCP token</TableCell><TableCell>Đăng nhập dashboard này bằng ví một lần trên máy này. Lần gọi công cụ kế tiếp sẽ nhận token; không cần khởi động lại client.</TableCell></TableRow>
                <TableRow><TableCell><code>mcp_setup_required</code>: có nhiều chủ ví</TableCell><TableCell>Đặt <code>NEXUS_OWNER_PUBKEY</code> bằng địa chỉ ví của bạn trong env của client.</TableCell></TableRow>
                <TableRow><TableCell><code>mcp_token_rejected</code></TableCell><TableCell>Token đã bị đổi hoặc agent dùng thư mục dữ liệu khác. Kiểm tra <code>NEXUS_AGENT_DATA_DIR</code>, hoặc đăng nhập lại.</TableCell></TableRow>
                <TableRow><TableCell><code>agent_unreachable</code></TableCell><TableCell>Chạy <code>pnpm dev</code> từ thư mục gốc của repository; kiểm tra <code>NEXUS_API_URL</code>.</TableCell></TableRow>
                <TableRow><TableCell>Server không khởi động được từ <code>.mcp.json</code></TableCell><TableCell>Client được mở ở thư mục con nên đường dẫn tương đối tới bundle không phân giải được. Hãy mở nó ở thư mục gốc của repository, hoặc đăng ký đường dẫn tuyệt đối: <code>claude mcp add -s user nexuspay -- node &lt;path from pnpm mcp:config&gt;</code> cho Claude Code, hoặc dán JSON của <code>pnpm mcp:config</code> vào <code>~/.cursor/mcp.json</code> cho Cursor. <code>pnpm mcp:install</code> chỉ bao gồm Codex, Claude Desktop và Antigravity.</TableCell></TableRow>
                <TableRow><TableCell><code>Cannot find module .../nexuspay-mcp.mjs</code></TableCell><TableCell>Chạy <code>pnpm mcp:build</code> và kiểm tra <code>dist/mcp/nexuspay-mcp.mjs</code>.</TableCell></TableRow>
                <TableRow><TableCell>Không tìm thấy <code>node</code></TableCell><TableCell>Cài Node.js 22+, hoặc đặt đường dẫn tuyệt đối của <code>node</code> vào <code>command</code>.</TableCell></TableRow>
                <TableRow><TableCell>Codex cắt lệnh gọi ở 60 giây</TableCell><TableCell>Giữ <code>tool_timeout_sec = 90</code> trong cấu hình Codex.</TableCell></TableRow>
                <TableRow><TableCell>Antigravity từ chối schema của công cụ</TableCell><TableCell>Chạy <code>pnpm mcp:build</code> và khởi động lại Antigravity.</TableCell></TableRow>
                <TableRow><TableCell><code>AGENT_FROZEN</code></TableCell><TableCell>Chủ ví đã khóa agent. Nhờ chủ ví mở khóa trên dashboard; đừng thử lại giao dịch khi agent đang bị khóa.</TableCell></TableRow>
                <TableRow><TableCell><code>RATE_LIMITED</code></TableCell><TableCell>Quá nhiều request từ token hoặc địa chỉ này. Chờ <code>details.retryAfterSeconds</code> giây rồi thử lại; với giao dịch thì dùng lại đúng <code>idempotencyKey</code>.</TableCell></TableRow>
                <TableRow><TableCell><code>DAILY_LIMIT_EXCEEDED</code></TableCell><TableCell>Đã vượt hạn mức chi tiêu 24 giờ. Chủ ví phải duyệt giao dịch này trên dashboard, hoặc chờ hạn mức được hoàn lại.</TableCell></TableRow>
              </TableBody>
            </Table>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nhãn</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Ý nghĩa</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>Chờ xử lý</TableCell><TableCell><code>planned</code></TableCell><TableCell>Đã lập kế hoạch, chưa có quyết định.</TableCell></TableRow>
                <TableRow><TableCell>Tự động</TableCell><TableCell><code>auto_approved</code></TableCell><TableCell>Chính sách cho phép; agent đang ký.</TableCell></TableRow>
                <TableRow><TableCell>Chờ duyệt</TableCell><TableCell><code>pending_approval</code></TableCell><TableCell>Vượt hạn mức; đang chờ chủ ví.</TableCell></TableRow>
                <TableRow><TableCell>Đã duyệt</TableCell><TableCell><code>approved</code></TableCell><TableCell>Chủ ví đã duyệt; agent đang gửi giao dịch.</TableCell></TableRow>
                <TableRow><TableCell>Thành công</TableCell><TableCell><code>confirmed</code></TableCell><TableCell>Đã được xác nhận trên Devnet. Có liên kết Explorer.</TableCell></TableRow>
                <TableRow><TableCell>Bị từ chối</TableCell><TableCell><code>denied</code></TableCell><TableCell>Bị chính sách từ chối. Không có gì được ký.</TableCell></TableRow>
                <TableRow><TableCell>Đã hết hạn</TableCell><TableCell><code>expired</code></TableCell><TableCell>Khung thời gian duyệt đã đóng.</TableCell></TableRow>
                <TableRow><TableCell>Thất bại</TableCell><TableCell><code>failed</code></TableCell><TableCell>Gửi giao dịch thất bại, ví dụ do số dư thấp.</TableCell></TableRow>
              </TableBody>
            </Table>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Triệu chứng</TableHead>
                  <TableHead>Nguyên nhân và cách xử lý</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>“Kết nối ví chủ sở hữu” ở nút Duyệt</TableCell><TableCell>Ví đang kết nối không phải ví chủ sở hữu. Hãy chuyển sang ví bạn đã dùng để đăng nhập.</TableCell></TableRow>
                <TableRow><TableCell>Lần duyệt bị từ chối</TableCell><TableCell>Yêu cầu đã hết hạn, hoặc chính sách đã được lưu sau khi yêu cầu bị giữ. Hãy chạy lại lệnh.</TableCell></TableRow>
                <TableRow><TableCell>“Phiên làm việc đã hết hạn”</TableCell><TableCell>Hãy đăng nhập lại bằng ví. Đổi tài khoản ví cũng làm kết thúc phiên.</TableCell></TableRow>
                <TableRow><TableCell>Yêu cầu hiện <code>[fallback]</code></TableCell><TableCell>Chưa cấu hình API key của model. Deterministic parser xử lý các lệnh đơn giản.</TableCell></TableRow>
                <TableRow><TableCell>Thực thi thất bại</TableCell><TableCell>Số dư của agent không đủ cho số tiền cộng phí. Hãy nạp vốn cho agent.</TableCell></TableRow>
              </TableBody>
            </Table>
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
