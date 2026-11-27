import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from './icons.js';
import { useI18n } from '../i18n/context.js';
import type { TranslationDictionary } from '../i18n/types.js';
import { cn } from '../lib/utils.js';
import { Input } from './ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import {
  Callout,
  CodeBlock,
  Steps,
  TabLink,
  Tabs,
  type DocPage,
  type DocsContext,
  type DocsLinkTab,
} from './docsBlocks.js';
import { buildPagesVi } from './docsPagesVi.js';

export type { DocsLinkTab };

const NAV_HEADING = 'mb-1.5 text-xs font-medium text-muted';
const PAGER_LINK =
  'flex cursor-pointer flex-col items-start gap-0.5 rounded-md border border-line bg-panel px-3.5 py-2.5 text-left hover:border-line-strong hover:bg-surface-muted';
/** Prose styles for a docs section body: paragraphs, lists and inline code written as plain elements in the page builders. */
const PROSE = cn(
  'mt-7 scroll-mt-5 text-ink',
  '[&_p]:mb-3 [&_p]:text-[13.5px] [&_p]:leading-relaxed',
  '[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-[13.5px] [&_ul]:leading-relaxed',
  '[&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:text-[13.5px] [&_ol]:leading-relaxed',
  '[&_li+li]:mt-1.5',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-surface-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-xs [&_:not(pre)>code]:[overflow-wrap:anywhere]',
  '[&_td_code]:whitespace-nowrap [&_td_code]:[overflow-wrap:normal] [&_table]:mb-3',
);

export function buildPages(ctx: DocsContext, dict: TranslationDictionary): DocPage[] {
  return [
    {
      id: 'overview',
      group: dict.docs.overview.group,
      title: dict.docs.overview.title,
      summary: dict.docs.overview.summary,
      keywords: 'introduction pipeline model policy signer',
      sections: [
        {
          id: 'what',
          title: 'What nexusPay is',
          body: (
            <>
              <p>
                nexusPay is a payment guard for AI agents on Solana Devnet. Each owner wallet gets a separate agent
                wallet and a spending policy. Transfers inside the policy are signed by the agent. Transfers above
                the limit wait for the owner to approve in a wallet. Recipients outside the allowlist are denied.
              </p>
              <p>
                A model decides <em>what</em> to attempt. It never decides <em>whether it is allowed</em>: only the
                policy engine can authorise a signature.
              </p>
            </>
          ),
        },
        {
          id: 'flow',
          title: 'Request flow',
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
                Without model API keys the agent uses a deterministic parser instead. Those requests show
                {' '}<code>[fallback]</code> in their model trace; policy enforcement is the same.
              </p>
            </>
          ),
        },
        {
          id: 'map',
          title: 'Dashboard map',
          body: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tab</TableHead>
                  <TableHead>Use it to</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>Overview</TableCell><TableCell>See the agent wallet, connect the owner wallet, fund the agent, and connect Claude, Codex or another AI client over MCP.</TableCell></TableRow>
                <TableRow><TableCell>Policy</TableCell><TableCell>Set the per-transaction limit and the recipient allowlist.</TableCell></TableRow>
                <TableRow><TableCell>Approvals</TableCell><TableCell>Review every request and approve held transfers.</TableCell></TableRow>
                <TableRow><TableCell>Task Vault</TableCell><TableCell>Lock a task budget on-chain and pay workers through escrow.</TableCell></TableRow>
                <TableRow><TableCell>History</TableCell><TableCell>See SOL moving in and out of the agent wallet, and the append-only audit log.</TableCell></TableRow>
                <TableRow><TableCell>Try commands</TableCell><TableCell>Ask the agent to check its balance or send SOL in plain text.</TableCell></TableRow>
              </TableBody>
            </Table>
          ),
        },
      ],
    },
    {
      id: 'quickstart',
      group: 'Get started',
      title: 'Quickstart',
      summary: 'Connect a wallet, set a policy, fund the agent and run the three policy outcomes.',
      keywords: 'demo tutorial first transfer',
      sections: [
        {
          id: 'before',
          title: 'Before you start',
          body: (
            <ul>
              <li>A Solana wallet that supports message signing (for example Phantom), set to <strong>Devnet</strong>.</li>
              <li>Some Devnet SOL in that wallet if you want to deposit to the agent yourself.</li>
            </ul>
          ),
        },
        {
          id: 'steps',
          title: 'Five steps',
          body: (
            <Steps>
              <li>
                <strong>Sign in.</strong> Connect your wallet and sign the login message. It creates a session; it
                does not approve any payment.
              </li>
              <li>
                <strong>Set the policy.</strong> Set <em>Max per transaction</em> to <code>0.1</code> SOL, click
                {' '}<em>Use owner wallet</em> to allowlist your wallet as <code>my-wallet</code>, then Save.{' '}
                <TabLink tab="policy" label="Policy" ctx={ctx} />
              </li>
              <li>
                <strong>Fund the agent.</strong> Claim the one-time 0.1 SOL seed or deposit from your wallet.{' '}
                <TabLink tab="wallet" label="Overview" ctx={ctx} />
              </li>
              <li>
                <strong>Run a command.</strong> <code>Send 0.05 SOL to my-wallet</code> is inside the limit, so the
                agent signs it and an Explorer link appears.{' '}
                <TabLink tab="commands" label="Try commands" ctx={ctx} />
              </li>
              <li>
                <strong>Try the other outcomes.</strong> <code>Send 0.5 SOL to my-wallet</code> is held for your
                approval. A transfer to an address that is not allowlisted is denied with no approval offered.
              </li>
            </Steps>
          ),
        },
        {
          id: 'check',
          title: 'Check the result',
          body: (
            <p>
              Every request appears under Approvals with its status and policy verdict, and every decision is
              written to the audit log in History with the policy version it was made under.{' '}
              <TabLink tab="approvals" label="Approvals" ctx={ctx} />
            </p>
          ),
        },
      ],
    },
    {
      id: 'wallet',
      group: 'Guides',
      title: 'Wallet and funding',
      summary: 'The agent wallet, the owner wallet, and the ways to put Devnet SOL in the agent.',
      keywords: 'faucet seed deposit balance owner',
      sections: [
        {
          id: 'two-wallets',
          title: 'Two wallets',
          body: (
            <ul>
              <li>
                <strong>Owner wallet</strong> — your own wallet. It signs in, and it is the only wallet that can
                approve held transfers. Its keys never leave the wallet.
              </li>
              <li>
                <strong>Agent wallet</strong> — a separate keypair created for your owner wallet. The agent signs
                with it. The private key is encrypted at rest and is never shown to a model.
              </li>
            </ul>
          ),
        },
        {
          id: 'funding',
          title: 'Funding options',
          body: (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Button</TableHead>
                    <TableHead>What happens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell>Get 0.1 free test SOL</TableCell><TableCell>One-time transfer from the service funder. Available once per agent.</TableCell></TableRow>
                  <TableRow><TableCell>Send 0.1 SOL from my wallet</TableCell><TableCell>Your wallet sends 0.1 SOL to the agent. Your wallet asks you to confirm.</TableCell></TableRow>
                  <TableRow><TableCell>More test SOL</TableCell><TableCell>Opens faucet.solana.com with the agent address filled in.</TableCell></TableRow>
                </TableBody>
              </Table>
              <Callout tone="note" title="Zero balance is fine for policy checks">
                The policy decision does not depend on the balance. Only the on-chain transfer needs funds.
              </Callout>
              <TabLink tab="wallet" label="Overview" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'policy',
      group: 'Guides',
      title: 'Spending policy',
      summary: 'Per-transaction limit, recipient allowlist, and how each verdict is decided.',
      keywords: 'allowlist limit recipient verdict allow deny require_approval version',
      sections: [
        {
          id: 'fields',
          title: 'Fields',
          body: (
            <ul>
              <li>
                <strong>Max per transaction</strong> — the largest SOL amount the agent may send without asking you.
              </li>
              <li>
                <strong>Recipients</strong> — named addresses the agent may pay. Commands and MCP tools can refer to a
                recipient by its name or its exact address.
              </li>
              <li>
                <strong>Use owner wallet</strong> — adds your connected wallet as <code>my-wallet</code>.
              </li>
            </ul>
          ),
        },
        {
          id: 'verdicts',
          title: 'How the verdict is decided',
          body: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Condition</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>Recipient not on the allowlist</TableCell><TableCell><code>deny</code></TableCell><TableCell>Nothing is signed. No approval is offered.</TableCell></TableRow>
                <TableRow><TableCell>Amount is zero or invalid</TableCell><TableCell><code>deny</code></TableCell><TableCell>Nothing is signed.</TableCell></TableRow>
                <TableRow><TableCell>Amount above the limit</TableCell><TableCell><code>require_approval</code></TableCell><TableCell>Held until the owner approves.</TableCell></TableRow>
                <TableRow><TableCell>Allowlisted and within the limit</TableCell><TableCell><code>allow</code></TableCell><TableCell>The agent signs and submits.</TableCell></TableRow>
                <TableRow><TableCell>Balance check</TableCell><TableCell><code>allow</code></TableCell><TableCell>Read-only, always allowed.</TableCell></TableRow>
              </TableBody>
            </Table>
          ),
        },
        {
          id: 'versions',
          title: 'Policy versions',
          body: (
            <>
              <p>
                Every save increments the policy version. Each decision and approval records the version it was made
                under.
              </p>
              <Callout tone="warn" title="Saving a policy invalidates pending approvals">
                An approval is bound to the policy version at the time the request was held. After you save a new
                policy, approving an older held request is rejected; run the command again.
              </Callout>
              <TabLink tab="policy" label="Policy" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'commands',
      group: 'Guides',
      title: 'Commands',
      summary: 'Plain-text instructions the agent understands, and what it will refuse.',
      keywords: 'prompt console natural language presets fallback',
      sections: [
        {
          id: 'actions',
          title: 'Supported actions',
          body: (
            <>
              <p>A command is turned into exactly one of these actions. Anything else is not executed.</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Example command</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell><code>get_balance</code></TableCell><TableCell>What is my balance?</TableCell></TableRow>
                  <TableRow><TableCell><code>transfer_sol</code></TableCell><TableCell>Send 0.05 SOL to my-wallet</TableCell></TableRow>
                  <TableRow><TableCell><code>transfer_spl</code></TableCell><TableCell>Send 5 USDC to my-wallet (only if that mint is allowlisted; none are by default)</TableCell></TableRow>
                  <TableRow><TableCell><code>request_manual_approval</code></TableCell><TableCell>Used when the request is unclear; nothing is executed.</TableCell></TableRow>
                </TableBody>
              </Table>
            </>
          ),
        },
        {
          id: 'presets',
          title: 'Presets',
          body: (
            <p>
              Once a recipient is allowlisted, the Try commands page shows three presets: one within the per-transaction limit,
              one above that limit, and one to an address outside the allowlist. Results also depend on balance, the 24-hour
              limit and whether the agent is frozen. <TabLink tab="commands" label="Try commands" ctx={ctx} />
            </p>
          ),
        },
        {
          id: 'retry',
          title: 'Retries',
          body: (
            <p>
              If a command fails because the response was lost, running the same text again reuses the same
              idempotency key, so the agent does not pay twice for one command.
            </p>
          ),
        },
      ],
    },
    {
      id: 'approvals',
      group: 'Guides',
      title: 'Approvals',
      summary: 'Approve a held transfer with a wallet signature, and what that signature covers.',
      keywords: 'approve sign message expiry owner pending',
      sections: [
        {
          id: 'how',
          title: 'Approve a held transfer',
          body: (
            <Steps>
              <li>Open Approvals. Held requests show an <em>Approval</em> status and an expiry time.</li>
              <li>Open <em>Message</em> to read what you are about to sign: amount, recipient, policy version and expiry.</li>
              <li>Click <em>Approve</em> and sign the message in your wallet. The agent then submits the transfer.</li>
            </Steps>
          ),
        },
        {
          id: 'rules',
          title: 'Rules',
          body: (
            <ul>
              <li>Only the owner wallet can approve. Another connected wallet sees <em>Connect owner wallet</em>.</li>
              <li>You sign a message, not a transaction. It authorises one specific request, once.</li>
              <li>The dashboard rebuilds the message locally and refuses to sign if the server copy differs.</li>
              <li>Approvals expire (5 minutes by default). After that, run the command again.</li>
            </ul>
          ),
        },
      ],
    },
    {
      id: 'task-vault',
      group: 'Guides',
      title: 'Task Vault',
      summary: 'Give the agent a bounded task budget on-chain and pay workers through escrow and receipts.',
      keywords: 'escrow receipt worker service capability pda revoke refund settle',
      sections: [
        {
          id: 'concept',
          title: 'Concept',
          body: (
            <p>
              Instead of letting the agent spend freely, the owner funds a <strong>Task Capability</strong>: a budget,
              a per-payment cap, an expiry and optionally one allowed worker and service. The agent can only move funds
              from the task vault into escrow. The worker submits output for review, and payment requires the owner's acceptance signature for that exact output and payment.
            </p>
          ),
        },
        {
          id: 'lifecycle',
          title: 'Lifecycle',
          body: (
            <Steps>
              <li>
                <strong>Fund.</strong> Choose the payment asset: SOL or a token the policy allows, such as USDC. The
                budget moves from your wallet into the vault, so the form checks your balance of that asset. Enter a
                total budget, per-payment cap and expiry (1–168 hours). Under <em>Advanced settings</em>, the Devnet
                option is on by default and creates the task through your wallet; untick it to simulate.
              </li>
              <li>
                <strong>Hold payment.</strong> Move an amount into escrow for a worker. The worker and service must
                match the task limits, and the amount must fit the cap and the remaining budget.
              </li>
              <li>
                <strong>Get demo result.</strong> The task's Worker (the demo merchant, or the server-held Mock Worker) produces valid or invalid output and signs its hash. The demo merchant works only for an Escrow it can see on Devnet. Submission saves the output and runs deterministic verification checks while the Escrow remains held.
              </li>
              <li>
                <strong>Review, reject or accept.</strong> Inspect the verification report and submitted output. Failed checks block settlement; you can reject invalid output with a reason to open up to 3 revision attempts before task expiry. For valid output, confirm and sign acceptance with the owner wallet to release payment. Without acceptance, funds remain held until expiry.
              </li>
              <li>
                <strong>Close.</strong> <em>Revoke Task</em> stops new payments. After expiry, refund any remaining held Escrow on the dashboard before closing. <em>Refund and close task</em> returns the unallocated budget to the owner once no Escrow is held.
              </li>
            </Steps>
          ),
        },
        {
          id: 'modes',
          title: 'On-chain and simulated tasks',
          body: (
            <>
              <p>
                On-chain tasks show a <em>Devnet Tx</em> badge and link to Explorer. Simulated tasks check budget and
                state conditions in local records, without moving funds on Devnet, and are labelled <em>Simulated</em>.
              </p>
              <Callout tone="note" title="On-chain actions need your wallet">
                Creating, accepting output, revoking and closing a task require the owner wallet. Phantom must be
                available in the browser.
              </Callout>
              <TabLink tab="tasks" label="Task Vault" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'audit',
      group: 'Guides',
      title: 'Audit log',
      summary: 'The append-only record of every decision, approval and execution.',
      keywords: 'log history ciphertext sealed',
      sections: [
        {
          id: 'contents',
          title: 'What is recorded',
          body: (
            <>
              <p>
                Each entry has a time, an event name, the request ID and a detail payload. Payloads are sealed with
                AES-256-GCM at rest; open an entry and expand <em>Encrypted record</em> to see the stored form. The
                log is under <em>Audit log</em> in History.
              </p>
              <TabLink tab="history" label="History" ctx={ctx} />
            </>
          ),
        },
      ],
    },
    {
      id: 'mcp',
      group: 'Integrations',
      title: 'MCP for personal agents',
      summary: 'Let Claude Code, Cursor, Codex, Claude Desktop or Antigravity use the agent wallet through the same policy gate.',
      keywords: 'model context protocol claude cursor codex antigravity tools stdio integration token',
      sections: [
        {
          id: 'about',
          title: 'How it works',
          body: (
            <>
              <p>
                Your AI client is the planner: it calls a tool with a structured transfer, and the agent service runs
                it through the same policy as a dashboard command. Inside the policy the agent signs; above the limit
                the request waits for your approval here; off-allowlist recipients are denied.
              </p>
              <p>
                The client connects to the agent&apos;s <code>/mcp</code> URL (Streamable HTTP) with your personal MCP
                token as a bearer header. Nothing is installed on the client&apos;s machine: copy the entry for your
                client from the <TabLink tab="wallet" label="Overview" ctx={ctx} /> page.
              </p>
              <Callout tone="note" title="Where the URL points">
                On a hosted dashboard the URL is the dashboard origin, so any machine can connect. When you run the
                stack yourself it is <code>http://127.0.0.1:8787/mcp</code>, reachable only from the same computer.
                If you cloned the repository you can also use the local stdio bundle described under{' '}
                <em>Set up from the repository</em>.
              </Callout>
            </>
          ),
        },
        {
          id: 'tools',
          title: 'Tools',
          body: (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tool</TableHead>
                    <TableHead>What it does</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell><code>nexuspay_get_status</code></TableCell><TableCell>Agent address, SOL balance, per-transaction limit, allowlist labels.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_list_requests</code></TableCell><TableCell>Recent requests with verdicts and outcomes. Optional status filter.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_get_request</code></TableCell><TableCell>One request, for example to see whether you approved it.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_transfer_sol</code></TableCell><TableCell>Propose a SOL transfer. The policy decides.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_transfer_spl</code></TableCell><TableCell>Propose an SPL token transfer. Recipient and mint must be allowlisted.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_x402_fetch</code></TableCell><TableCell>Fetch an HTTP 402 resource via x402 v2 (SPL on Solana devnet) and send <code>PAYMENT-SIGNATURE</code> on retry.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_x402_resolve</code></TableCell><TableCell>Evaluate and sign an x402 v2 challenge without broadcasting; returns the <code>PAYMENT-SIGNATURE</code> header value.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_list_tasks</code></TableCell><TableCell>Read delegated Task Vault records, remaining budgets, caps and expiry.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_get_task</code></TableCell><TableCell>Read a task, its Escrows and Receipts. Local records are not a fresh chain reconciliation.</TableCell></TableRow>
                  <TableRow><TableCell><code>nexuspay_execute_task_payment</code></TableCell><TableCell>Create an Escrow within an existing capability. Worker settlement is a separate step.</TableCell></TableRow>
                </TableBody>
              </Table>
              <p>
                MCP can read wallet status, requests and tasks, propose transfers and create Escrows within a delegated
                capability. Policy changes, approvals, task creation/funding, revocation, settlement, refunds and
                agent freeze/unfreeze still require the owner&apos;s wallet session.
              </p>
              <p>
                Task payments use capability limits and do not enter the transfer approval queue. Keep the same{' '}
                <code>paymentId</code> and parameters when retrying an uncertain outcome. Simulated tasks do not
                move funds. On Devnet the Worker is either the demo merchant, which signs its own output and settlement, or the server-held Mock Worker.
              </p>
            </>
          ),
        },
        {
          id: 'x402',
          title: 'x402 payments (SPL on Devnet)',
          body: (
            <>
              <p>
                x402 supports protocol v2 with scheme <code>exact</code> for SPL tokens on Solana Devnet
                (<code>solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1</code>). The facilitator named in the challenge pays the
                network fee: the agent signs a <code>TransferChecked</code> transaction with that facilitator as fee
                payer, does not broadcast it, and attaches it in <code>PAYMENT-SIGNATURE</code>. Calling again with the
                key of a payment that already landed sends nothing and returns <code>X402_ALREADY_PAID</code>.
              </p>
              <p>
                Requests over <code>maxTokenAmountByMint</code> wait for owner approval and remain in{' '}
                <code>approved</code> until the agent retries with the same <code>idempotencyKey</code>. While the
                signed transaction is still valid on chain, retries reuse it; a new transaction is signed only after
                the old blockhash expires, and the request becomes <code>confirmed</code> only when the signature lands
                on chain.
              </p>
              <Steps>
                <li>
                  Add the merchant recipient and SPL mint to the allowlist and set <code>maxTokenAmountByMint</code> in{' '}
                  <TabLink tab="policy" label="Policy" ctx={ctx} />.
                </li>
                <li>
                  Fund the agent with Devnet SOL for fees and the SPL token, and make sure the merchant wallet already
                  has an associated token account for that mint.
                </li>
                <li>
                  Call <code>nexuspay_x402_fetch</code> (or <code>nexuspay_x402_resolve</code>) and keep the returned{' '}
                  <code>idempotencyKey</code> when resuming after owner approval or retrying settlement.
                </li>
              </Steps>
            </>
          ),
        },
        {
          id: 'connect',
          title: 'Connect a client',
          body: (
            <>
              <Steps>
                <li>
                  Sign in to this dashboard with your wallet, then open <em>Show my connection</em> on
                  the <TabLink tab="wallet" label="Overview" ctx={ctx} /> page. On a hosted dashboard click
                  {' '}<em>Create connection token</em>; the token appears once.
                </li>
                <li>
                  Pick your client and copy its entry. The card shows the token masked; <em>Copy</em> puts the full
                  value on the clipboard.
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client</TableHead>
                        <TableHead>Where the entry goes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow><TableCell>Claude Code</TableCell><TableCell>Run the <code>claude mcp add --transport http …</code> command once.</TableCell></TableRow>
                      <TableRow><TableCell>Codex</TableCell><TableCell><code>~/.codex/config.toml</code> (<code>url</code> + <code>http_headers</code>).</TableCell></TableRow>
                      <TableRow><TableCell>Antigravity</TableCell><TableCell><code>~/.gemini/config/mcp_config.json</code> (<code>serverUrl</code> + <code>headers</code>).</TableCell></TableRow>
                      <TableRow><TableCell>Claude Desktop</TableCell><TableCell><code>claude_desktop_config.json</code>, through the <code>mcp-remote</code> bridge (needs Node.js).</TableCell></TableRow>
                    </TableBody>
                  </Table>
                </li>
                <li>
                  Restart or reload the client, then ask it something like <em>&ldquo;Check my nexusPay wallet
                  status&rdquo;</em>.
                </li>
              </Steps>
            </>
          ),
        },
        {
          id: 'setup',
          title: 'Set up from the repository',
          body: (
            <>
              <p>If you run the stack yourself, the local stdio bundle needs no token at all:</p>
              <Steps>
                <li>
                  Start the stack from the repository root. This also builds the MCP bundle at
                  {' '}<code>dist/mcp/nexuspay-mcp.mjs</code>.
                  <CodeBlock label="Terminal" code="pnpm dev" />
                </li>
                <li>
                  Sign in to this dashboard with your wallet once. That creates your agent and its MCP token.
                </li>
                <li>
                  Connect your client:
                  <Tabs
                    items={[
                      {
                        id: 'claude-code',
                        label: 'Claude Code',
                        body: (
                          <p className="text-muted">
                            Open Claude Code in the repository root, not a subfolder, and approve the project server
                            from <code>.mcp.json</code> when prompted. It is already committed; there are no paths or
                            secrets to fill in.
                          </p>
                        ),
                      },
                      {
                        id: 'cursor',
                        label: 'Cursor',
                        body: (
                          <p className="text-muted">
                            Open the repository root (not a subfolder) and enable <code>nexuspay</code> from the committed
                            {' '}<code>.cursor/mcp.json</code>.
                          </p>
                        ),
                      },
                      {
                        id: 'codex',
                        label: 'Codex',
                        body: (
                          <>
                            <p className="text-muted">
                              Registers the server in <code>~/.codex/config.toml</code>. A project
                              {' '}<code>.codex/config.toml</code> is also committed, but Codex reads it only for trusted
                              projects, so the installer is the reliable path.
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
                              Registers the server in <code>claude_desktop_config.json</code>. Restart Claude Desktop
                              afterwards.
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
                              Registers the server in <code>~/.gemini/config/mcp_config.json</code>.
                            </p>
                            <CodeBlock label="Terminal" code="pnpm mcp:install -- --client antigravity" />
                          </>
                        ),
                      },
                    ]}
                  />
                </li>
                <li>
                  Ask your client something like <em>&ldquo;Check my nexusPay wallet status&rdquo;</em>, then
                  {' '}<em>&ldquo;Send 0.05 SOL to my-wallet&rdquo;</em>.
                </li>
              </Steps>
              <Callout tone="note" title="About the installer">
                Without <code>--client</code>, <code>pnpm mcp:install</code> registers Codex, Claude Desktop and
                Antigravity together. It writes absolute paths and no token, and keeps a backup of each config it changes
                (<code>.bak</code>, or a timestamped <code>.bak-…</code> when one already exists). Add <code>--dry-run</code> to preview the entry first.
              </Callout>
              <p>
                Fallback: run <code>pnpm mcp:config</code> for an entry with the absolute bundle path, or use the remote URL
                from the MCP card (see <em>Connect a client</em>).
              </p>
            </>
          ),
        },
        {
          id: 'token',
          title: 'The MCP token',
          body: (
            <ul>
              <li>
                Sent as a bearer token. The token file is <code>agent/data/users/&lt;owner&gt;/mcp-token</code>. On a
                hosted dashboard it holds only the SHA-256 hash of the token: the token itself is shown once, when you
                create or rotate it, and cannot be shown again. When you run the stack locally the file holds the token
                itself, so the MCP server can read it from the agent&apos;s data directory.
              </li>
              <li>
                <em>Rotate token</em> on the Overview page replaces it. Clients connected by URL stop
                working until you copy their entry again. The local stdio bundle re-reads the file when the agent
                rejects the old token, so it needs no restart; a token pinned with
                {' '}<code>NEXUS_AGENT_TOKEN</code> is not re-read and must be updated by hand.
              </li>
              <li>
                A local file is plaintext on disk, inside the same trust boundary as the agent keystore. On Windows,
                access depends on the folder&apos;s ACLs. Hashing does not protect a token that was already copied to a
                client: rotate it if it leaks.
              </li>
            </ul>
          ),
        },
        {
          id: 'env',
          title: 'Optional settings',
          body: (
            <>
              <p>
                None are needed for a single owner on the default setup. Set them in the client&apos;s
                {' '}<code>env</code> block.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Variable</TableHead>
                    <TableHead>Default</TableHead>
                    <TableHead>When to set it</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell><code>NEXUS_OWNER_PUBKEY</code></TableCell><TableCell>auto</TableCell><TableCell>More than one owner has signed in on this machine.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_AGENT_DATA_DIR</code></TableCell><TableCell>auto</TableCell><TableCell>The agent service uses a non-default data directory.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_AGENT_TOKEN</code></TableCell><TableCell>auto</TableCell><TableCell>Use a specific token instead of the one on disk.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_API_URL</code></TableCell><TableCell><code>http://127.0.0.1:8787</code></TableCell><TableCell>The agent runs on another port. Loopback only.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_DASHBOARD_URL</code></TableCell><TableCell><code>http://localhost:5173</code></TableCell><TableCell>Shown in approval hints. Loopback only.</TableCell></TableRow>
                  <TableRow><TableCell><code>NEXUS_TIMEOUT_MS</code></TableCell><TableCell><code>45000</code></TableCell><TableCell>Kept below the 60 s default tool timeout in Codex.</TableCell></TableRow>
                </TableBody>
              </Table>
            </>
          ),
        },
        {
          id: 'retries',
          title: 'Approvals and retries',
          body: (
            <ul>
              <li>
                A transfer above the limit returns <code>pending_approval</code> with an expiry. Approve it in the
                Approvals tab; the client can poll <code>nexuspay_get_request</code> for the outcome.
              </li>
              <li>
                Each transfer carries an idempotency key. If a call times out or the agent returns a server error, the
                tool returns <code>outcome_unknown</code> with that key. Retrying with the same key cannot pay twice;
                never change the amount on a retry.
              </li>
              <li>
                Reusing a key for a different transfer returns <code>IDEMPOTENCY_CONFLICT</code>. Two calls with
                different keys are two transfers, limited only by the policy.
              </li>
            </ul>
          ),
        },
        {
          id: 'mcp-troubleshooting',
          title: 'Troubleshooting',
          body: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symptom</TableHead>
                  <TableHead>Fix</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell><code>mcp_setup_required</code>: no MCP token found</TableCell><TableCell>Sign in to this dashboard with your wallet once on this machine. The next tool call picks the token up; no client restart.</TableCell></TableRow>
                <TableRow><TableCell><code>mcp_setup_required</code>: multiple owners</TableCell><TableCell>Set <code>NEXUS_OWNER_PUBKEY</code> to your wallet address in the client env.</TableCell></TableRow>
                <TableRow><TableCell><code>mcp_token_rejected</code></TableCell><TableCell>The token was rotated or the agent uses another data directory. Check <code>NEXUS_AGENT_DATA_DIR</code>, or sign in again.</TableCell></TableRow>
                <TableRow><TableCell><code>agent_unreachable</code></TableCell><TableCell>Run <code>pnpm dev</code> from the repository root; check <code>NEXUS_API_URL</code>.</TableCell></TableRow>
                <TableRow><TableCell>Server fails to start from <code>.mcp.json</code></TableCell><TableCell>The client was opened in a subfolder, so the relative bundle path does not resolve. Open it in the repository root, or register an absolute path: <code>claude mcp add -s user nexuspay -- node &lt;path from pnpm mcp:config&gt;</code> for Claude Code, or the <code>pnpm mcp:config</code> JSON in <code>~/.cursor/mcp.json</code> for Cursor. <code>pnpm mcp:install</code> covers Codex, Claude Desktop and Antigravity only.</TableCell></TableRow>
                <TableRow><TableCell><code>Cannot find module .../nexuspay-mcp.mjs</code></TableCell><TableCell>Run <code>pnpm mcp:build</code> and check <code>dist/mcp/nexuspay-mcp.mjs</code>.</TableCell></TableRow>
                <TableRow><TableCell><code>node</code> not found</TableCell><TableCell>Install Node.js 22+, or put the absolute path of <code>node</code> in <code>command</code>.</TableCell></TableRow>
                <TableRow><TableCell>Codex cuts the call at 60 s</TableCell><TableCell>Keep <code>tool_timeout_sec = 90</code> in the Codex entry.</TableCell></TableRow>
                <TableRow><TableCell>Antigravity rejects the tool schema</TableCell><TableCell>Run <code>pnpm mcp:build</code> and restart Antigravity.</TableCell></TableRow>
                <TableRow><TableCell><code>AGENT_FROZEN</code></TableCell><TableCell>The owner has locked the agent. Ask the owner to unfreeze it on the dashboard; do not retry transfers while frozen.</TableCell></TableRow>
                <TableRow><TableCell><code>RATE_LIMITED</code></TableCell><TableCell>Too many requests from this token or address. Wait <code>details.retryAfterSeconds</code> seconds, then retry; reuse the same <code>idempotencyKey</code> for a transfer.</TableCell></TableRow>
                <TableRow><TableCell><code>DAILY_LIMIT_EXCEEDED</code></TableCell><TableCell>The 24-hour spending limit was exceeded. The owner must approve this transfer in the dashboard, or wait for capacity to reset.</TableCell></TableRow>
              </TableBody>
            </Table>
          ),
        },
      ],
    },
    {
      id: 'statuses',
      group: 'Reference',
      title: 'Request statuses',
      summary: 'Every status a request can have and what it means.',
      keywords: 'status pending confirmed failed denied expired queued',
      sections: [
        {
          id: 'table',
          title: 'Statuses',
          body: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Meaning</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>Queued</TableCell><TableCell><code>planned</code></TableCell><TableCell>Planned, not yet decided.</TableCell></TableRow>
                <TableRow><TableCell>Auto</TableCell><TableCell><code>auto_approved</code></TableCell><TableCell>Allowed by policy; the agent is signing.</TableCell></TableRow>
                <TableRow><TableCell>Approval</TableCell><TableCell><code>pending_approval</code></TableCell><TableCell>Above the limit; waiting for the owner.</TableCell></TableRow>
                <TableRow><TableCell>Approved</TableCell><TableCell><code>approved</code></TableCell><TableCell>Owner approved; the agent is submitting (for x402, awaits retry with <code>PAYMENT-SIGNATURE</code>).</TableCell></TableRow>
                <TableRow><TableCell>Confirmed</TableCell><TableCell><code>confirmed</code></TableCell><TableCell>Confirmed on Devnet. Explorer link available.</TableCell></TableRow>
                <TableRow><TableCell>Denied</TableCell><TableCell><code>denied</code></TableCell><TableCell>Rejected by policy. Nothing was signed.</TableCell></TableRow>
                <TableRow><TableCell>Expired</TableCell><TableCell><code>expired</code></TableCell><TableCell>The approval window closed.</TableCell></TableRow>
                <TableRow><TableCell>Failed</TableCell><TableCell><code>failed</code></TableCell><TableCell>Submission failed, for example low balance.</TableCell></TableRow>
              </TableBody>
            </Table>
          ),
        },
      ],
    },
    {
      id: 'troubleshooting',
      group: 'Reference',
      title: 'Troubleshooting',
      summary: 'Common errors in the dashboard and how to resolve them.',
      keywords: 'error faq 429 session expired phantom',
      sections: [
        {
          id: 'common',
          title: 'Common issues',
          body: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symptom</TableHead>
                  <TableHead>Cause and fix</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>“Connect owner wallet” on Approve</TableCell><TableCell>The connected wallet is not the owner. Switch to the wallet you signed in with.</TableCell></TableRow>
                <TableRow><TableCell>Approval rejected</TableCell><TableCell>It expired, or the policy was saved after the request was held. Run the command again.</TableCell></TableRow>
                <TableRow><TableCell>“Session expired”</TableCell><TableCell>Sign in with your wallet again. Switching wallet accounts also ends the session.</TableCell></TableRow>
                <TableRow><TableCell>Requests show <code>[fallback]</code></TableCell><TableCell>No model API keys are configured. The deterministic parser handles simple commands.</TableCell></TableRow>
                <TableRow><TableCell>Execution failed</TableCell><TableCell>The agent balance is too low for the amount plus fees. Fund the agent.</TableCell></TableRow>
              </TableBody>
            </Table>
          ),
        },
        {
          id: 'security',
          title: 'Security boundaries',
          body: (
            <ul>
              <li>Your seed phrase stays in your wallet. The service only sees your public key and signatures.</li>
              <li>The agent wallet holds a small Devnet budget. Compromising the service cannot reach your funds.</li>
              <li>Never paste a private key or seed phrase into a command, an MCP client or this dashboard.</li>
            </ul>
          ),
        },
      ],
    },
  ];
}

function matches(page: DocPage, query: string): boolean {
  const haystack = `${page.title} ${page.summary} ${page.keywords ?? ''} ${page.sections
    .map((section) => section.title)
    .join(' ')}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function DocsPanel(props: { onOpenTab: (tab: DocsLinkTab) => void }) {
  const { dict, lang } = useI18n();
  const [pageId, setPageId] = useState('overview');
  const [query, setQuery] = useState('');
  const articleRef = useRef<HTMLElement | null>(null);

  const pages = useMemo(
    () => (lang === 'vi' ? buildPagesVi : buildPages)({ openTab: props.onOpenTab }, dict),
    [props.onOpenTab, dict, lang],
  );
  const pageIndex = Math.max(0, pages.findIndex((page) => page.id === pageId));
  const page = pages[pageIndex]!;
  const prev = pages[pageIndex - 1];
  const next = pages[pageIndex + 1];

  const visible = query.trim() ? pages.filter((candidate) => matches(candidate, query)) : pages;
  const groups = visible.reduce<Array<{ name: string; pages: DocPage[] }>>((acc, candidate) => {
    const group = acc.find((entry) => entry.name === candidate.group);
    if (group) group.pages.push(candidate);
    else acc.push({ name: candidate.group, pages: [candidate] });
    return acc;
  }, []);

  const openPage = (id: string) => {
    setPageId(id);
    articleRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const sectionAnchor = (sectionId: string) => `docs-${page.id}-${sectionId}`;

  return (
    <div className="grid items-start gap-[18px] md:grid-cols-[180px_minmax(0,1fr)] md:gap-6 lg:grid-cols-[196px_minmax(0,1fr)_168px] lg:gap-8">
      <nav
        className="border-b border-line pb-3 md:sticky md:top-5 md:max-h-[calc(100vh-40px)] md:overflow-y-auto md:border-0 md:pb-0"
        aria-label={dict.docs.navLabel}
      >
        <div className="relative mb-4">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input
            type="search"
            className="h-8 pl-8 text-[13px]"
            aria-label={dict.docs.searchPlaceholder}
            placeholder={dict.docs.searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {groups.length === 0 ? <p className="text-xs text-muted">{dict.docs.empty}</p> : null}
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.name}>
              <p className={NAV_HEADING}>{group.name}</p>
              <ul className="flex flex-row flex-wrap gap-1 md:flex-col md:gap-px">
                {group.pages.map((candidate) => {
                  const active = candidate.id === page.id;
                  return (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className={cn(
                          'cursor-pointer rounded-full border border-line px-2.5 py-1 text-left text-[13px] font-medium text-muted hover:text-ink',
                          'md:w-full md:rounded-none md:border-0 md:border-l-2 md:border-transparent md:py-1.5 md:hover:border-line-strong',
                          active && 'border-accent font-semibold text-accent hover:text-accent md:border-accent md:hover:border-accent',
                        )}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => openPage(candidate.id)}
                      >
                        {candidate.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <article className="min-w-0 scroll-mt-5" ref={articleRef} aria-labelledby="docs-page-title">
        <p className="mb-1 text-xs font-semibold text-accent">{page.group}</p>
        <h2 id="docs-page-title" className="text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
          {page.title}
        </h2>
        <p className="mt-1.5 text-sm text-muted">{page.summary}</p>

        {page.sections.map((section) => (
          <section key={section.id} id={sectionAnchor(section.id)} className={PROSE}>
            <h3 className="mb-2.5 text-[15px] font-semibold tracking-[-0.01em] text-ink">{section.title}</h3>
            {section.body}
          </section>
        ))}

        <footer className="mt-9 grid grid-cols-2 gap-3.5 border-t border-line pt-4">
          {prev ? (
            <button type="button" className={PAGER_LINK} onClick={() => openPage(prev.id)}>
              <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                <ChevronLeft size={14} aria-hidden="true" /> {dict.docs.previous}
              </span>
              <strong className="text-sm font-semibold text-accent">{prev.title}</strong>
            </button>
          ) : (
            <span />
          )}
          {next ? (
            <button type="button" className={cn(PAGER_LINK, 'col-start-2 items-end text-right')} onClick={() => openPage(next.id)}>
              <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                {dict.docs.next} <ChevronRight size={14} aria-hidden="true" />
              </span>
              <strong className="text-sm font-semibold text-accent">{next.title}</strong>
            </button>
          ) : null}
        </footer>
      </article>

      <aside
        className="hidden lg:sticky lg:top-5 lg:block lg:max-h-[calc(100vh-40px)] lg:overflow-y-auto"
        aria-label={dict.docs.onThisPage}
      >
        <p className={NAV_HEADING}>{dict.docs.onThisPage}</p>
        <ul className="flex flex-col gap-px">
          {page.sections.map((section) => (
            <li key={section.id}>
              <button
                type="button"
                className="w-full cursor-pointer border-l-2 border-transparent px-2.5 py-[3px] text-left text-xs font-medium text-muted hover:border-line-strong hover:text-ink"
                onClick={() =>
                  document.getElementById(sectionAnchor(section.id))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                }
              >
                {section.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
