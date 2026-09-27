import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Info,
  Search,
  TriangleAlert,
} from 'lucide-react';

/** Dashboard tabs a docs page can link to. Kept in sync with FEATURE_TABS in App.tsx. */
export type DocsLinkTab = 'wallet' | 'tasks' | 'commands' | 'policy' | 'approvals' | 'audit';

type DocSection = { id: string; title: string; body: ReactNode };

type DocPage = {
  id: string;
  group: string;
  title: string;
  summary: string;
  /** Extra search terms that do not appear in the title or summary. */
  keywords?: string;
  sections: DocSection[];
};

type DocsContext = {
  openTab: (tab: DocsLinkTab) => void;
};

function CodeBlock(props: { code: string; label?: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied('idle'), 1800);
  };

  return (
    <div className="docs-code">
      <div className="docs-code-head">
        <span>{props.label ?? 'Code'}</span>
        <button type="button" className="docs-code-copy" onClick={() => void copy()} aria-label="Copy code">
          {copied === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

function Callout(props: { tone: 'note' | 'warn'; title: string; children: ReactNode }) {
  const Icon = props.tone === 'warn' ? TriangleAlert : Info;
  return (
    <aside className={`docs-callout docs-callout-${props.tone}`}>
      <Icon size={16} aria-hidden="true" />
      <div>
        <strong>{props.title}</strong>
        <div>{props.children}</div>
      </div>
    </aside>
  );
}

function Steps(props: { children: ReactNode }) {
  return <ol className="docs-steps">{props.children}</ol>;
}

function TabLink(props: { tab: DocsLinkTab; label: string; ctx: DocsContext }) {
  return (
    <button type="button" className="docs-tab-link" onClick={() => props.ctx.openTab(props.tab)}>
      Open {props.label}
      <ArrowUpRight size={13} aria-hidden="true" />
    </button>
  );
}

function Tabs(props: { items: Array<{ id: string; label: string; body: ReactNode }> }) {
  const [active, setActive] = useState(props.items[0]?.id ?? '');
  const current = props.items.find((item) => item.id === active) ?? props.items[0];
  return (
    <div className="docs-tabs">
      <div className="docs-tabs-list" role="tablist">
        {props.items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === current?.id}
            className={item.id === current?.id ? 'is-active' : ''}
            onClick={() => setActive(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{current?.body}</div>
    </div>
  );
}

function buildPages(ctx: DocsContext): DocPage[] {
  return [
    {
      id: 'overview',
      group: 'Get started',
      title: 'Overview',
      summary: 'What nexusPay does and how a request moves from text to a Devnet transaction.',
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
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Tab</th>
                  <th>Use it to</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Wallet</td><td>See the agent wallet, connect the owner wallet, fund the agent.</td></tr>
                <tr><td>Task Vault</td><td>Lock a task budget on-chain and pay workers through escrow.</td></tr>
                <tr><td>Commands</td><td>Ask the agent to check its balance or send SOL in plain text.</td></tr>
                <tr><td>Policy</td><td>Set the per-transaction limit and the recipient allowlist.</td></tr>
                <tr><td>Approvals</td><td>Review every request and approve held transfers.</td></tr>
                <tr><td>Audit</td><td>Read the append-only log of decisions and executions.</td></tr>
              </tbody>
            </table>
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
                <TabLink tab="wallet" label="Wallet" ctx={ctx} />
              </li>
              <li>
                <strong>Run a command.</strong> <code>Send 0.05 SOL to my-wallet</code> is inside the limit, so the
                agent signs it and an Explorer link appears.{' '}
                <TabLink tab="commands" label="Commands" ctx={ctx} />
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
              written to the Audit log with the policy version it was made under.{' '}
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
      keywords: 'airdrop faucet seed deposit balance owner',
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
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Button</th>
                    <th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td>Claim 0.1 SOL seed</td><td>One-time transfer from the service funder. Available once per agent.</td></tr>
                  <tr><td>Deposit 0.1 SOL</td><td>Your wallet sends 0.1 SOL to the agent. Your wallet asks you to confirm.</td></tr>
                  <tr><td>Airdrop 1 SOL</td><td>Requests SOL from the public Devnet faucet. Often rate-limited.</td></tr>
                  <tr><td>Official Faucet</td><td>Opens faucet.solana.com with the agent address filled in.</td></tr>
                </tbody>
              </table>
              <Callout tone="note" title="Zero balance is fine for policy checks">
                The policy decision does not depend on the balance. Only the on-chain transfer needs funds.
              </Callout>
              <TabLink tab="wallet" label="Wallet" ctx={ctx} />
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
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Verdict</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Recipient not on the allowlist</td><td><code>deny</code></td><td>Nothing is signed. No approval is offered.</td></tr>
                <tr><td>Amount is zero or invalid</td><td><code>deny</code></td><td>Nothing is signed.</td></tr>
                <tr><td>Amount above the limit</td><td><code>require_approval</code></td><td>Held until the owner approves.</td></tr>
                <tr><td>Allowlisted and within the limit</td><td><code>allow</code></td><td>The agent signs and submits.</td></tr>
                <tr><td>Balance check</td><td><code>allow</code></td><td>Read-only, always allowed.</td></tr>
              </tbody>
            </table>
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
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Example command</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>get_balance</code></td><td>What is my balance?</td></tr>
                  <tr><td><code>transfer_sol</code></td><td>Send 0.05 SOL to my-wallet</td></tr>
                  <tr><td><code>transfer_spl</code></td><td>Send 5 USDC to my-wallet (only if that mint is allowlisted; none are by default)</td></tr>
                  <tr><td><code>request_manual_approval</code></td><td>Used when the request is unclear; nothing is executed.</td></tr>
                </tbody>
              </table>
            </>
          ),
        },
        {
          id: 'presets',
          title: 'Presets',
          body: (
            <p>
              Once a recipient is allowlisted, the Commands tab shows three presets: one under the limit (Auto), one
              above it (Approval), and one to an address that is never allowlisted (Denied). They are the fastest way
              to see all three verdicts. <TabLink tab="commands" label="Commands" ctx={ctx} />
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
              from the task vault into escrow, and escrow is released to the worker only with a valid receipt.
            </p>
          ),
        },
        {
          id: 'lifecycle',
          title: 'Lifecycle',
          body: (
            <Steps>
              <li>
                <strong>Fund.</strong> Enter a task ID, total budget, per-payment cap and expiry (1–168 hours). Tick
                {' '}<em>Broadcast on-chain</em> to create it on Devnet through your wallet; otherwise it is simulated.
              </li>
              <li>
                <strong>Execute payment.</strong> Move an amount into escrow for a worker. The worker and service must
                match the task limits, and the amount must fit the cap and the remaining budget.
              </li>
              <li>
                <strong>Settle with receipt.</strong> The worker returns a signed receipt; escrow is released to it.
              </li>
              <li>
                <strong>Close.</strong> <em>Revoke Task</em> stops new payments. <em>Refund &amp; Close</em> returns the
                unspent budget to the owner once no escrow is still held.
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
                On-chain tasks show a <em>Devnet Tx</em> badge and link to Explorer. Simulated tasks keep the same state
                machine off-chain and are labelled <em>Simulated</em>.
              </p>
              <Callout tone="note" title="On-chain actions need your wallet">
                Creating, revoking and closing an on-chain task are signed by the owner wallet. Phantom must be
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
                AES-256-GCM at rest; toggle <em>Ciphertext</em> to see the stored form.
              </p>
              <TabLink tab="audit" label="Audit" ctx={ctx} />
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
                The nexusPay MCP server is a small local process that your AI client starts over stdio. Your client
                is the planner: it calls a tool with a structured transfer, and the agent service runs it through the
                same policy as a dashboard command. Inside the policy the agent signs; above the limit the request
                waits for your approval here; off-allowlist recipients are denied.
              </p>
              <p>
                The server authenticates with a per-owner MCP token that the agent service creates when you sign in to
                this dashboard. It finds the token on its own, so there is nothing secret to copy into a client config.
              </p>
              <Callout tone="warn" title="Local only">
                The MCP server talks to an agent service on your own machine (<code>127.0.0.1</code>). It does not
                connect to a hosted dashboard; hosted access is not implemented.
              </Callout>
            </>
          ),
        },
        {
          id: 'tools',
          title: 'Tools',
          body: (
            <>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>What it does</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>nexuspay_get_status</code></td><td>Agent address, SOL balance, per-transaction limit, allowlist labels.</td></tr>
                  <tr><td><code>nexuspay_list_requests</code></td><td>Recent requests with verdicts and outcomes. Optional status filter.</td></tr>
                  <tr><td><code>nexuspay_get_request</code></td><td>One request, for example to see whether you approved it.</td></tr>
                  <tr><td><code>nexuspay_transfer_sol</code></td><td>Propose a SOL transfer. The policy decides.</td></tr>
                  <tr><td><code>nexuspay_transfer_spl</code></td><td>Propose an SPL token transfer. Recipient and mint must be allowlisted.</td></tr>
                </tbody>
              </table>
              <p>
                There is no tool to change the policy, bind an owner or approve a request. The MCP token only reaches
                wallet status, the request list, one request, and new transfer proposals. Policy, approvals, funding
                and Task Vault actions still need your wallet session in this dashboard.
              </p>
            </>
          ),
        },
        {
          id: 'setup',
          title: 'Set up',
          body: (
            <>
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
                          <p className="docs-muted">
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
                          <p className="docs-muted">
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
                            <p className="docs-muted">
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
                            <p className="docs-muted">
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
                            <p className="docs-muted">
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
                Fallback: copy the entry from <em>Connect an AI agent (MCP)</em> on the agent card, or run
                {' '}<code>pnpm mcp:config</code>. <TabLink tab="wallet" label="Wallet" ctx={ctx} />
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
                Stored in <code>agent/data/users/&lt;owner&gt;/mcp-token</code> and sent as a bearer token. The MCP
                server reads it from the agent&apos;s data directory.
              </li>
              <li>
                <em>Rotate token</em> on the agent card replaces it. When the agent rejects the old token, the MCP
                server reads the file again and retries, so no restart is needed. A token pinned with
                {' '}<code>NEXUS_AGENT_TOKEN</code> is not re-read and must be updated by hand.
              </li>
              <li>
                The file is plaintext on disk, inside the same trust boundary as the agent keystore. On Windows,
                access depends on the folder&apos;s ACLs.
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
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Default</th>
                    <th>When to set it</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>NEXUS_OWNER_PUBKEY</code></td><td>auto</td><td>More than one owner has signed in on this machine.</td></tr>
                  <tr><td><code>NEXUS_AGENT_DATA_DIR</code></td><td>auto</td><td>The agent service uses a non-default data directory.</td></tr>
                  <tr><td><code>NEXUS_AGENT_TOKEN</code></td><td>auto</td><td>Use a specific token instead of the one on disk.</td></tr>
                  <tr><td><code>NEXUS_API_URL</code></td><td><code>http://127.0.0.1:8787</code></td><td>The agent runs on another port. Loopback only.</td></tr>
                  <tr><td><code>NEXUS_DASHBOARD_URL</code></td><td><code>http://localhost:5173</code></td><td>Shown in approval hints. Loopback only.</td></tr>
                  <tr><td><code>NEXUS_TIMEOUT_MS</code></td><td><code>45000</code></td><td>Kept below the 60 s default tool timeout in Codex.</td></tr>
                </tbody>
              </table>
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
                Reusing a key for a different transfer returns <code>idempotency_conflict</code>. Two calls with
                different keys are two transfers, limited only by the policy.
              </li>
            </ul>
          ),
        },
        {
          id: 'mcp-troubleshooting',
          title: 'Troubleshooting',
          body: (
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Symptom</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                <tr><td><code>mcp_setup_required</code>: no MCP token found</td><td>Sign in to this dashboard with your wallet once on this machine. The next tool call picks the token up; no client restart.</td></tr>
                <tr><td><code>mcp_setup_required</code>: multiple owners</td><td>Set <code>NEXUS_OWNER_PUBKEY</code> to your wallet address in the client env.</td></tr>
                <tr><td><code>mcp_token_rejected</code></td><td>The token was rotated or the agent uses another data directory. Check <code>NEXUS_AGENT_DATA_DIR</code>, or sign in again.</td></tr>
                <tr><td><code>agent_unreachable</code></td><td>Run <code>pnpm dev</code> from the repository root; check <code>NEXUS_API_URL</code>.</td></tr>
                <tr><td>Server fails to start from <code>.mcp.json</code></td><td>The client was opened in a subfolder, so the relative bundle path does not resolve. Open it in the repository root, or register an absolute path: <code>claude mcp add -s user nexuspay -- node &lt;path from pnpm mcp:config&gt;</code> for Claude Code, or the <code>pnpm mcp:config</code> JSON in <code>~/.cursor/mcp.json</code> for Cursor. <code>pnpm mcp:install</code> covers Codex, Claude Desktop and Antigravity only.</td></tr>
                <tr><td><code>Cannot find module .../nexuspay-mcp.mjs</code></td><td>Run <code>pnpm mcp:build</code> and check <code>dist/mcp/nexuspay-mcp.mjs</code>.</td></tr>
                <tr><td><code>node</code> not found</td><td>Install Node.js 22+, or put the absolute path of <code>node</code> in <code>command</code>.</td></tr>
                <tr><td>Codex cuts the call at 60 s</td><td>Keep <code>tool_timeout_sec = 90</code> in the Codex entry.</td></tr>
                <tr><td>Antigravity rejects the tool schema</td><td>Run <code>pnpm mcp:build</code> and restart Antigravity.</td></tr>
              </tbody>
            </table>
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
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Status</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Queued</td><td><code>planned</code></td><td>Planned, not yet decided.</td></tr>
                <tr><td>Auto</td><td><code>auto_approved</code></td><td>Allowed by policy; the agent is signing.</td></tr>
                <tr><td>Approval</td><td><code>pending_approval</code></td><td>Above the limit; waiting for the owner.</td></tr>
                <tr><td>Approved</td><td><code>approved</code></td><td>Owner approved; the agent is submitting.</td></tr>
                <tr><td>Confirmed</td><td><code>confirmed</code></td><td>Confirmed on Devnet. Explorer link available.</td></tr>
                <tr><td>Denied</td><td><code>denied</code></td><td>Rejected by policy. Nothing was signed.</td></tr>
                <tr><td>Expired</td><td><code>expired</code></td><td>The approval window closed.</td></tr>
                <tr><td>Failed</td><td><code>failed</code></td><td>Submission failed, for example low balance.</td></tr>
              </tbody>
            </table>
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
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Symptom</th>
                  <th>Cause and fix</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Airdrop fails with 429</td><td>The public faucet is rate-limited. Deposit from your wallet or use the Official Faucet link.</td></tr>
                <tr><td>“Connect owner wallet” on Approve</td><td>The connected wallet is not the owner. Switch to the wallet you signed in with.</td></tr>
                <tr><td>Approval rejected</td><td>It expired, or the policy was saved after the request was held. Run the command again.</td></tr>
                <tr><td>“Session expired”</td><td>Sign in with your wallet again. Switching wallet accounts also ends the session.</td></tr>
                <tr><td>Requests show <code>[fallback]</code></td><td>No model API keys are configured. The deterministic parser handles simple commands.</td></tr>
                <tr><td>Execution failed</td><td>The agent balance is too low for the amount plus fees. Fund the agent.</td></tr>
              </tbody>
            </table>
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
  const [pageId, setPageId] = useState('overview');
  const [query, setQuery] = useState('');
  const articleRef = useRef<HTMLElement | null>(null);

  const pages = useMemo(
    () => buildPages({ openTab: props.onOpenTab }),
    [props.onOpenTab],
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
    <div className="docs">
      <nav className="docs-sidebar" aria-label="Documentation">
        <label className="docs-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search docs"
            placeholder="Search docs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {groups.length === 0 ? <p className="empty">No matching pages</p> : null}
        {groups.map((group) => (
          <div key={group.name} className="docs-nav-group">
            <p className="docs-nav-heading">{group.name}</p>
            <ul>
              {group.pages.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className={`docs-nav-link${candidate.id === page.id ? ' is-active' : ''}`}
                    aria-current={candidate.id === page.id ? 'page' : undefined}
                    onClick={() => openPage(candidate.id)}
                  >
                    {candidate.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <article className="docs-article" ref={articleRef} aria-labelledby="docs-page-title">
        <p className="docs-eyebrow">{page.group}</p>
        <h2 id="docs-page-title" className="docs-title">{page.title}</h2>
        <p className="docs-lead">{page.summary}</p>

        {page.sections.map((section) => (
          <section key={section.id} id={sectionAnchor(section.id)} className="docs-section">
            <h3>{section.title}</h3>
            {section.body}
          </section>
        ))}

        <footer className="docs-pager">
          {prev ? (
            <button type="button" className="docs-pager-link" onClick={() => openPage(prev.id)}>
              <span>
                <ChevronLeft size={14} aria-hidden="true" /> Previous
              </span>
              <strong>{prev.title}</strong>
            </button>
          ) : (
            <span />
          )}
          {next ? (
            <button type="button" className="docs-pager-link is-next" onClick={() => openPage(next.id)}>
              <span>
                Next <ChevronRight size={14} aria-hidden="true" />
              </span>
              <strong>{next.title}</strong>
            </button>
          ) : null}
        </footer>
      </article>

      <aside className="docs-toc" aria-label="On this page">
        <p className="docs-nav-heading">On this page</p>
        <ul>
          {page.sections.map((section) => (
            <li key={section.id}>
              <button
                type="button"
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
