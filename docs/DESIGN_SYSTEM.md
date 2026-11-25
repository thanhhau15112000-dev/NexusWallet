# nexusPay Frontend Design System & UI Rules

This document defines the mandatory UI, styling, and copy rules for `web/`. Every contributor and coding agent modifying `web/` must follow these conventions.

---

## 1. Product Aesthetic & Anti-AI-Slop Rules

nexusPay is a **non-custodial Solana AI agent wallet and payment guard**. The interface follows an **editorial cockpit aesthetic**: high-contrast binary framing between **deep pine-obsidian (`#0d1513`)** navigation/hero surfaces and a **warm architectural off-white (`#f4f3ee`)** workspace, anchored by Nexus Emerald (`#177b65`) CTAs and crisp monospace telemetry markers.

**Mandatory visual principles:**
- **Binary contrast & flat geometry:** Rely on `1px` hairline borders (`border-line` / `border-obsidian-line`), dark-vs-warm-light structural split (asymmetric `BootScreen` split, dark sidebar + dark Agent Balance hero card against `#f4f3ee` operational workspace), and a consistent `4px` / `8px` spacing scale.
- **Telemetry metadata over prose:** Prefer compact monospace technical markers (`SOLANA // PAYMENT GUARD`, `01 POLICY`, `PER-TX · 24H`) over multi-line explanatory paragraphs.
- **Tabular numbers:** Every SOL/token balance, spending limit, delta, fee, countdown, and metric cell MUST use `tabular-nums`.
- **Monospace identifiers:** Every Solana address, transaction signature, PDA, request ID, and code snippet MUST use `font-mono` and be shortened inline (`shorten(...)`) with a full `title` attribute and one-click copy when actionable.

**Strictly forbidden ("AI slop"):**
- NO purple/neon gradients, glowing shadows, rainbow borders, or decorative glassmorphism (`backdrop-blur` spam).
- NO marketing pitch boxes, promo banners, external repo links inside the app header, or multi-paragraph onboarding walls inside authenticated workspace tabs.
- NO redundant subtitles or helper paragraphs repeating what a card title or input label already states.
- NO emojis in UI labels, headings, badges, buttons, or toasts.
- **Mascot restraint:** `Mascot` (`web/public/brand/mascot-*.svg`) is restricted to the unauthenticated `BootScreen` (sign-in / offline / loading) as a quiet `40px–44px` figure without speech bubbles or heavy box wrappers. Do NOT add mascots to operational cards, sidebars, or tab headers. Keep `MASCOT_POSES` and `i18n.mascot` keys intact so `agent/test/i18n.test.ts` continues to pass.

---

## 2. Typography & Color Tokens

### Typography
- **Primary UI font:** `Be Vietnam Pro` (`@fontsource/be-vietnam-pro`, weights `400`, `500`, `600`, `700`), imported in `web/src/main.tsx` and configured via `--font-sans` in `web/src/styles.css`.
- **Monospace font:** `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace` (`--font-mono`).
- **Scale & hierarchy:** Editorial statement headings (`text-3xl`/`text-[42px]` on `BootScreen`, `text-3xl` Hero Balance, `text-xl` tab titles), `14px` body (`text-sm`), `13px` compact table/nav cells, `10px–11px` uppercase monospace labels (`tracking-[0.14em]`).

### Semantic Color Palette
Harmonized around Nexus Emerald (`#177b65`) with pine-obsidian dark surfaces and warm off-white light surfaces:
- **Light workspace:**
  - Canvas background: `#f4f3ee` (`--color-bg`)
  - Card / elevated surface: `#ffffff` (`--color-panel`)
  - Muted / disabled surface: `#eae8e1` (`--color-surface-muted`)
  - Hairline border: `#dddad0` (`--color-line`), strong border `#c5c1b5` (`--color-line-strong`)
  - Text: primary `#0d1513` (`--color-ink`), muted `#5c6662` (`--color-muted`)
- **Dark cockpit surfaces (left split panel, sidebar, Hero Balance card):**
  - Surface base: `#0d1513` (`--color-obsidian`), raised `#14201d` (`--color-obsidian-raised`)
  - Border: `#22322e` (`--color-obsidian-line`)
  - Text: primary `#f4f3ee` (`--color-obsidian-ink`), muted `#8fa39c` (`--color-obsidian-muted`)
- **Brand & Telemetry Accent:**
  - Primary CTA & light accent: `#177b65` (`--color-accent`), hover `#126351` (`--color-accent-hover`), soft tint `#e6f4ef` (`--color-accent-soft`), border tint `#bce0d3` (`--color-accent-line`)
  - Dark-surface telemetry signal: `#34d399` (`--color-signal`)
  - Wallet badge ink: `#0d1513` (`--color-wallet-ink`)
- **Status tones (restrained, high-contrast):**
  - `ok` (Confirmed / Active / Allow): text `#177b65`, bg `#e6f4ef`, border `#bce0d3`
  - `warn` (Pending Approval / Held): text `#9a6008`, bg `#fdf4e2`, border `#edd4a1`
  - `bad` (Denied / Frozen / Error): text `#b42318`, bg `#fceceb`, border `#f2c0bc`

---

## 3. Tech Stack & Component Architecture

- **Styling:** **Tailwind CSS v4** (`@tailwindcss/vite`) configured in `web/vite.config.ts` and `web/src/styles.css`.
- **Component primitives:** **shadcn/ui** pattern in `web/src/components/ui/` built on Radix UI primitives + `class-variance-authority` + `cn()` (`web/src/lib/utils.ts`).
  - Available primitives: `Button` (including `darkOutline` for dark surfaces), `Card`, `Badge` (including `signal` and `obsidian` variants), `Input`, `Textarea`, `Dialog`, `Tabs`, `Table`, `Tooltip`.
  - Domain helpers live in `web/src/components/ui.tsx` (`Card`, `CopyAddressButton`, `Mono`, `Pill`, `Empty`, `shorten`).
- **CSS boundary rule:** Do NOT add custom component CSS classes to `web/src/styles.css`. Style all layouts and components directly with Tailwind utilities and shadcn/ui primitives. `styles.css` is reserved solely for `@import "tailwindcss"`, `@theme`/CSS tokens, base element defaults, and minimal scoped formatting for `DocsPanel` prose (`docs-*`).

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
