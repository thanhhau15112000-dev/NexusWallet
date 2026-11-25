# Agent Guidelines — NexusWallet (`nexusPay`)

## Frontend (`web/`)
- Before modifying any UI, styling, typography, or layout in `web/`, read and strictly follow `docs/DESIGN_SYSTEM.md`.
- Stack: React + Vite + Tailwind CSS v4 + shadcn/ui primitives (`web/src/components/ui/`) + `Mona Sans` (UI) and `JetBrains Mono` (identifiers, numbers) fonts.
- Do not add custom layout/component CSS to `web/src/styles.css`; use Tailwind utilities and shadcn/ui components.
- Avoid AI slop (no neon/purple gradients, no decorative bloat, no promo banners inside tabs, no emojis, mascot restricted to `BootScreen`).
- Preserve bilingual parity (`web/src/i18n/locales/en.ts` and `vi.ts`) and docs parity (`DocsPanel.tsx` and `docsPagesVi.tsx`).

## Verification
- Always run `pnpm build` (`@nexus/web` Vite build + `tsc --noEmit`) and `pnpm test` before pushing or finishing changes.
