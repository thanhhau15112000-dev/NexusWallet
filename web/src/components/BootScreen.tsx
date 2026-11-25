import type { ReactNode } from 'react';
import { ArrowRight, ShieldCheck, Wallet, X } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { LanguageToggle } from './SettingsMenu.js';
import { Mascot } from './Mascot.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

export function BootScreen(props: {
  needsSignIn: boolean;
  offline: string | null;
  signInError: string | null;
  connecting: boolean;
  hasWallets: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  walletOptions: ReactNode;
}) {
  const { dict } = useI18n();
  const { boot } = dict;

  return (
    <main className="grid min-h-screen grid-cols-1 bg-bg text-ink lg:grid-cols-[1.2fr_1fr]">
      {/* Left Panel: Dark Obsidian Editorial Cockpit */}
      <section className="relative flex flex-col justify-between border-b border-obsidian-line bg-obsidian px-6 py-6 text-obsidian-ink bg-[linear-gradient(to_right,rgba(244,243,238,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(244,243,238,0.04)_1px,transparent_1px)] [background-size:48px_48px] sm:px-10 sm:py-8 lg:border-b-0 lg:border-r lg:px-12 lg:py-10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex shrink-0 items-center gap-2.5">
            <img src="/brand/logo.svg" alt="" width={26} height={26} className="h-6.5 w-6.5 shrink-0" />
            <span className="text-[15px] font-semibold tracking-tight text-obsidian-ink">nexusPay</span>
            <Badge variant="signal" className="font-mono text-[10px] uppercase tracking-wider">
              Devnet
            </Badge>
          </div>
          <div className="lg:hidden">
            <LanguageToggle dark />
          </div>
        </div>

        <div className="my-10 max-w-xl space-y-4 lg:my-auto">
          <p className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-signal">
            <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden="true" />
            SOLANA // PAYMENT GUARD
          </p>
          <h1 className="text-3xl font-semibold leading-[1.08] tracking-[-0.03em] text-obsidian-ink text-balance sm:text-4xl lg:text-[42px]">
            {boot.heroTitle}
          </h1>
        </div>

        <div className="grid grid-cols-3 gap-4 border-t border-obsidian-line pt-5 font-mono">
          <div className="space-y-0.5">
            <span className="block text-[10px] text-signal">01</span>
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-obsidian-ink">POLICY</span>
            <span className="hidden text-[10px] text-obsidian-muted sm:block">PER-TX · 24H</span>
          </div>
          <div className="space-y-0.5">
            <span className="block text-[10px] text-signal">02</span>
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-obsidian-ink">APPROVAL</span>
            <span className="hidden text-[10px] text-obsidian-muted sm:block">ED25519 OWNER</span>
          </div>
          <div className="space-y-0.5">
            <span className="block text-[10px] text-signal">03</span>
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-obsidian-ink">RAILS</span>
            <span className="hidden text-[10px] text-obsidian-muted sm:block">MCP · X402</span>
          </div>
        </div>
      </section>

      {/* Right Panel: Warm Off-White Action Dock */}
      <section className="flex flex-col justify-between bg-bg px-6 py-8 sm:px-10 sm:py-10 lg:px-12">
        <div className="hidden justify-end lg:flex">
          <LanguageToggle />
        </div>

        <div className="mx-auto my-auto w-full max-w-[380px] space-y-6">
          <div className="flex items-center justify-between gap-3">
            <Mascot
              className="shrink-0 [&_img]:h-11 [&_img]:w-11"
              pose={props.offline ? 'sleep' : props.needsSignIn ? 'wave' : 'think'}
              caption={props.offline ? dict.mascot.offline : props.needsSignIn ? dict.mascot.signIn : dict.mascot.loading}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              ACCESS // WALLET
            </span>
          </div>

          <h2 id="login-title" className="text-xl font-semibold tracking-tight text-ink">
            {props.needsSignIn ? boot.signInRequired : props.offline ? boot.serviceUnavailable : boot.loading}
          </h2>

          {props.offline ? (
            <p
              role="alert"
              title={props.offline}
              className="rounded-md border border-bad-line bg-bad-soft px-3.5 py-2.5 text-xs font-medium text-bad"
            >
              {boot.connectionHint}
            </p>
          ) : null}

          {props.signInError ? (
            <p
              role="alert"
              title={props.signInError}
              className="rounded-md border border-bad-line bg-bad-soft px-3.5 py-2.5 text-xs font-medium text-bad"
            >
              {boot.signInFailed}
            </p>
          ) : null}

          {props.needsSignIn ? (
            <div className="space-y-3.5">
              <Button
                type="button"
                variant="default"
                size="lg"
                className="group h-12 w-full justify-between px-4 text-sm font-semibold"
                aria-expanded={props.pickerOpen}
                aria-controls="login-wallet-options"
                disabled={!props.hasWallets || props.connecting}
                onClick={props.onTogglePicker}
              >
                <span className="inline-flex items-center gap-2">
                  <Wallet size={16} aria-hidden="true" />
                  {props.connecting ? boot.connecting : boot.signInBtn}
                </span>
                <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Button>

              {props.pickerOpen ? (
                <div
                  id="login-wallet-options"
                  className="rounded-md border border-line bg-panel p-3 shadow-2xs"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink">{dict.walletModal.title}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={dict.walletModal.close}
                      disabled={props.connecting}
                      onClick={props.onTogglePicker}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </div>
                  {props.walletOptions}
                </div>
              ) : null}

              {!props.hasWallets ? (
                <p className="rounded-md border border-line bg-panel px-3.5 py-2.5 text-xs text-muted">
                  {boot.installPhantom}
                </p>
              ) : null}

              <p className="flex items-center gap-2 border-t border-line pt-4 text-[11px] text-muted">
                <ShieldCheck size={14} className="shrink-0 text-accent" aria-hidden="true" />
                <span>{boot.authNote}</span>
              </p>
            </div>
          ) : null}
        </div>

        <div className="hidden h-8 lg:block" aria-hidden="true" />
      </section>
    </main>
  );
}
