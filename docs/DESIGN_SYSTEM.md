# nexusPay Frontend Design System & UI Rules

This document defines the mandatory UI, styling, and copy rules for `web/`. Every contributor and coding agent modifying `web/` must follow these conventions.

---

## 1. Product Aesthetic & Anti-AI-Slop Rules

nexusPay is a **Solana Devnet AI agent payment guard and Task Capability Vault** (non-custodial owner wallet, server-custodial agent signer). The interface is a **light, quiet wallet dashboard**: white cards on a cool near-white canvas, one brand color taken from the mascot (Nexus Emerald `#177b65`), and typographic hierarchy instead of decoration.

**Mandatory visual principles:**
- **One light surface system:** canvas `bg-bg`, cards `bg-panel` with a `1px` `border-line` and `rounded-xl`, no drop shadows on cards. The sidebar is a white panel with a right hairline. Do not reintroduce dark split panels or dark hero cards.
- **Hierarchy through type, not chrome:** page titles `text-2xl` and key balances `text-3xl` use Mona Sans at a wider stretch (`[font-stretch:112%]`); body stays at the default width. Labels are sentence case `text-xs font-medium text-muted`.
- **Brand color is scarce:** emerald marks the primary CTA, the selected nav item (`bg-accent-soft` + `text-accent-strong`), success states and the agent balance card. Everything else stays neutral.
- **Tabular numbers:** Every SOL/token balance, spending limit, delta, fee, countdown, and metric cell MUST use `tabular-nums`.
- **Identifiers:** Every Solana address, transaction signature, PDA and request ID stays in Mona Sans and is shortened inline (`shorten(...)`) with a full `title` attribute and one-click copy when actionable. `font-mono` is reserved for code: `<pre>` blocks (raw JSON, MCP config snippets) and endpoint URLs in `<code>`.
- **Weight floor:** body text is `font-weight: 500` (set on `body`); `font-medium` is `580` and `font-semibold` is `660` (`--font-weight-*` in `@theme`) so the hierarchy survives. Do not use `font-light`, `font-thin` or `font-normal`.
- **Dark theme:** `:root[data-theme="dark"]` in `styles.css` redefines the color and shadow tokens: cool charcoal surfaces (`#121417` canvas, `#191c20` cards), no green tint in neutrals, emerald stays the only brand color. Components use tokens only; text on a solid accent/bad fill is `text-white`, text on an inverted surface (`bg-ink`, `bg-accent-strong`) is `text-panel`. `index.html` applies the saved (`nexus.theme`) or system theme before paint; `ThemeToggle` (`SettingsMenu.tsx`) sits next to `LanguageToggle`.
- **Timestamps:** render every date/time through `<DateTime value={...} />` from `web/src/components/ui.tsx`: fixed-width local `YYYY-MM-DD HH:mm:ss`, UTC ISO in `title` and `dateTime`. Do not call `toLocaleString`/`toLocaleTimeString` in components.

- **Motion:** only `animate-float` (BootScreen mascot) from `styles.css`, plus the `PolicyPlayground` conveyor (requests slide in from the left, rest at the center, slide out right; edges fade) and `TransactionFlow`. All motion is disabled under reduced motion (`motion-reduce:*`). Motion must explain state (new item, live demo), never decorate. The BootScreen `PolicyPlayground` runs on static demo data and must not call the API.
- **BootScreen background:** the only animated background is `TransactionFlow`: each `PolicyPlayground` row (`data-flow-row`, `data-verdict`) has its own lane to the shield mascot and emits dots in its verdict color: signed (emerald) run on into the wallet card, needs-approval (apricot) pause at the shield then continue to the wallet, blocked (bad red) stop at the shield. It renders only at `lg` and shows static lanes under reduced motion. No other background patterns.

**Strictly forbidden ("AI slop"):**
- NO uppercase, letter-spaced monospace "telemetry" labels (`SOLANA // ...`, `01 POLICY`, `ACCESS // WALLET`), numbered feature strips, or grid-line background patterns.
- NO purple/neon gradients, glowing shadows, rainbow borders, or decorative glassmorphism (`backdrop-blur` spam). The one exception is Solana's own logomark gradient on the black "Solana Faucet" link (`AgentFundingPanel.tsx`), a third-party brand mark.
- NO marketing pitch boxes, promo banners, external repo links inside the app header, or multi-paragraph onboarding walls inside authenticated workspace tabs.
- NO redundant subtitles or helper paragraphs repeating what a card title or input label already states.
- NO emojis in UI labels, headings, badges, buttons, or toasts.
- **Mascot restraint:** `Mascot` (`web/public/brand/mascot-*.svg`) is restricted to the unauthenticated `BootScreen` (sign-in / offline / loading) as the shield guard between the request feed and the wallet card (`shield` pose, `160px`, `lg` and up; a `64px` copy inside the sign-in card below `lg`), without speech bubbles or box wrappers. Do NOT add mascots to operational cards, sidebars, or tab headers. Keep `MASCOT_POSES` and `i18n.mascot` keys intact so `agent/test/i18n.test.ts` continues to pass.

---

## 2. Typography & Color Tokens

### Typography
- **UI font:** `Mona Sans` variable (`@fontsource-variable/mona-sans/wdth.css`, weight `200–900`, stretch `75–125%`, includes the Vietnamese subset), imported in `web/src/main.tsx` and exposed as `--font-sans`.
- **Monospace font:** `JetBrains Mono` (`@fontsource/jetbrains-mono`, weights `400`, `500`, Vietnamese subset included) as `--font-mono`, for code blocks only.
- **Scale:** `text-4xl`/`text-5xl` BootScreen headline (`[font-stretch:115%]`), `text-2xl` tab titles and stat values, `text-3xl` agent balance, `15px` card titles, `14px` body (`text-sm`), `12px` labels and table headers.

### Semantic Color Palette
All tokens live in the `@theme` block of `web/src/styles.css`.
- **Neutrals (cool, slightly green-tinted):**
  - Canvas `#f6f7f6` (`--color-bg`), card `#ffffff` (`--color-panel`), muted surface `#eef1ef` (`--color-surface-muted`)
  - Hairline `#e3e7e5` (`--color-line`), strong border `#cdd3d0` (`--color-line-strong`)
  - Text `#111816` (`--color-ink`), muted `#5a6561` (`--color-muted`)
- **Brand (from the mascot SVGs):**
  - Primary `#177b65` (`--color-accent`), hover `#0f5f4e` (`--color-accent-hover`), deep pine `#0b3f35` (`--color-accent-strong`)
  - Soft tint `#e6f4ef` (`--color-accent-soft`), border tint `#bcebdc` (`--color-accent-line`)
- **Companion:** Apricot `#f0a04b` (`--color-apricot`), reserved for things that need the owner's attention (pending approvals badge, needs-approval dots in `TransactionFlow`). Never as a CTA or large fill.
- **Status tones:**
  - `ok` (Confirmed / Active / Allow): text `#177b65`, bg `#e6f4ef`, border `#bcebdc`
  - `warn` (Pending Approval / Held): text `#8a5a12`, bg `#fbf3e4`, border `#ecd6aa`
  - `bad` (Denied / Frozen / Error): text `#b4382a`, bg `#fbeeec`, border `#f0c6bf`

---

## 3. Tech Stack & Component Architecture

- **Styling:** **Tailwind CSS v4** (`@tailwindcss/vite`) configured in `web/vite.config.ts` and `web/src/styles.css`.
- **Component primitives:** **shadcn/ui** pattern in `web/src/components/ui/` built on Radix UI primitives + `class-variance-authority` + `cn()` (`web/src/lib/utils.ts`).
  - Available primitives: `Button`, `Card`, `Badge`, `Input`, `Textarea`, `Dialog`, `Tabs`, `Table`, `Tooltip`, `Slider`.
  - Domain helpers live in `web/src/components/ui.tsx` (`Card`, `CopyAddressButton`, `Mono`, `Pill`, `Empty`, `shorten`, `DateTime`, `formatDateTime`).
- **CSS boundary rule:** Do NOT add custom component CSS classes to `web/src/styles.css`. Style all layouts and components directly with Tailwind utilities and shadcn/ui primitives. `styles.css` is reserved solely for `@import "tailwindcss"`, `@theme`/CSS tokens (including the dark theme overrides) and base element defaults. Docs prose is styled with Tailwind arbitrary variants on the section (`PROSE` in `DocsPanel.tsx`); docs tables, tabs, inputs and buttons use the shadcn primitives.

---

## 4. Field & Copy Minimalism vs. Security Invariants

1. **Trim clutter aggressively:**
   - Remove redundant card descriptions and repetitive page subtitles where controls are self-explanatory.
   - Tuck low-frequency technical metadata (`modelTrace`, `policyVersion`, PDA addresses, raw audit JSON/ciphertext) into collapsed `<details>` disclosures rather than primary card rows.
2. **Never remove security-critical verification fields:**
   - **Owner approvals (`RequestList`):** Must always expose the exact transfer amount, destination address, expiry countdown, and an expandable view of the exact canonical `approval.message` signed by the owner's wallet.
   - **MCP credentials (`McpConnectPanel`):** Must keep plaintext tokens masked on screen (`••••`) while copying the full snippet on click.
   - **Freeze & destructive actions (`OverviewPanel`, `TaskVaultPanel`):** Must retain two-step confirmation or explicit review checkboxes before signing/releasing funds.

---

## 5. Bilingual & Verification Gates

- Every user-visible string in `web/` MUST use `useI18n()` with synchronized keys and `{param}` placeholders in both `web/src/i18n/locales/en.ts` and `web/src/i18n/locales/vi.ts`.
- `DocsPanel.tsx` and `docsPagesVi.tsx` MUST maintain identical section IDs, element structure, code blocks, and tab links.
- After any `web/` change, run:
  - `pnpm build` (Vite production build + `tsc -p tsconfig.json --noEmit`)
  - `pnpm test` (specifically verifying `agent/test/i18n.test.ts` and `agent/test/docs-parity.test.ts`)
