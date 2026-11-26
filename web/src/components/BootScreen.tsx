import { useRef, type ReactNode } from 'react';
import { ArrowRight, ShieldCheck, Wallet, X } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { LanguageToggle, ThemeToggle } from './SettingsMenu.js';
import { Mascot } from './Mascot.js';
import { PolicyPlayground } from './PolicyPlayground.js';
import { TransactionFlow } from './TransactionFlow.js';
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

  const sourceRef = useRef<HTMLDivElement>(null);
  const guardRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement>(null);
  const pose = props.offline ? 'sleep' : props.needsSignIn ? 'shield' : 'think';
  const caption = props.offline ? dict.mascot.offline : props.needsSignIn ? dict.mascot.policy : dict.mascot.loading;

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg text-ink">
      <TransactionFlow source={sourceRef} guard={guardRef} target={targetRef} />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-6 sm:px-10 sm:py-8 lg:px-14 lg:py-10">
        <header className="flex items-center justify-between gap-3">
          <div className="flex shrink-0 items-center gap-2.5">
            <img src="/brand/logo.svg" alt="" width={28} height={28} className="h-7 w-7 shrink-0" />
            <span className="text-base font-semibold [font-stretch:112%] text-ink">nexusPay</span>
            <Badge variant="ok">Devnet</Badge>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LanguageToggle />
          </div>
        </header>

        <div className="flex flex-1 flex-col justify-center gap-10 py-10">
          <section className="space-y-4">
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] [font-stretch:115%] text-ink text-balance sm:text-5xl">
              {boot.heroTitle}
            </h1>
            <p className="max-w-md text-base text-muted">{boot.introTagline}</p>
          </section>

          <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_240px_minmax(0,380px)] lg:gap-6">
          <div ref={sourceRef} className="max-w-lg">
            <PolicyPlayground />
          </div>

          {/* pt aligns the shield with the middle of the four request lanes so the wires run nearly straight. */}
          <div className="hidden justify-center pt-[22px] lg:flex">
            <div ref={guardRef} className="inline-flex">
              <Mascot className="animate-float motion-reduce:animate-none [&_img]:h-40 [&_img]:w-40" pose={pose} caption={caption} />
            </div>
          </div>

          <section
            ref={targetRef}
            aria-labelledby="login-title"
            className="w-full space-y-6 rounded-2xl border-[1.5px] border-line-strong bg-panel p-7 shadow-raised sm:p-8"
          >
          <Mascot className="lg:hidden [&_img]:h-16 [&_img]:w-16" pose={pose} caption={caption} />

          <h2 id="login-title" className="text-2xl font-semibold [font-stretch:112%] text-ink">
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
                className="group h-12 w-full justify-between rounded-lg px-4 text-sm font-semibold"
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
                  className="rounded-lg bg-surface-muted p-3"
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
                <p className="rounded-lg bg-surface-muted px-3.5 py-2.5 text-xs text-muted">
                  {boot.installPhantom}
                </p>
              ) : null}

              <p className="flex items-center gap-2 border-t border-line pt-4 text-xs text-muted">
                <ShieldCheck size={14} className="shrink-0 text-accent" aria-hidden="true" />
                <span>{boot.authNote}</span>
              </p>
            </div>
          ) : null}
          </section>
          </div>
        </div>
      </div>
    </main>
  );
}
