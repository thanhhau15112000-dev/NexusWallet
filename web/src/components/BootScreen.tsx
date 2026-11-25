import type { ReactNode } from 'react';
import { ArrowRight, Ban, CheckCircle2, Clock, ShieldCheck, Wallet, X } from 'lucide-react';
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

  const rules = [
    { icon: CheckCircle2, tone: 'text-ok', text: boot.introAllow },
    { icon: Clock, tone: 'text-warn', text: boot.introApproval },
    { icon: Ban, tone: 'text-bad', text: boot.introDeny },
  ];

  return (
    <main className="grid min-h-screen grid-cols-1 bg-bg text-ink lg:grid-cols-[1.15fr_1fr]">
      <section className="flex flex-col justify-between gap-10 px-6 py-6 sm:px-10 sm:py-8 lg:px-14 lg:py-10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex shrink-0 items-center gap-2.5">
            <img src="/brand/logo.svg" alt="" width={28} height={28} className="h-7 w-7 shrink-0" />
            <span className="text-base font-semibold [font-stretch:112%] text-ink">nexusPay</span>
            <Badge variant="ok">Devnet</Badge>
          </div>
          <div className="lg:hidden">
            <LanguageToggle />
          </div>
        </div>

        <div className="max-w-xl space-y-6">
          <h1 className="text-4xl font-semibold leading-[1.1] [font-stretch:115%] text-ink text-balance sm:text-5xl">
            {boot.heroTitle}
          </h1>
          <p className="max-w-md text-base text-muted">{boot.introTagline}</p>
          <ul className="space-y-3 border-t border-line pt-6">
            {rules.map(({ icon: Icon, tone, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-ink">
                <Icon size={18} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="hidden h-6 lg:block" aria-hidden="true" />
      </section>

      <section className="flex flex-col justify-between border-t border-line bg-panel px-6 py-8 sm:px-10 sm:py-10 lg:border-t-0 lg:border-l lg:px-12">
        <div className="hidden justify-end lg:flex">
          <LanguageToggle />
        </div>

        <div className="mx-auto my-auto w-full max-w-[380px] space-y-6">
          <Mascot
            className="shrink-0 [&_img]:h-12 [&_img]:w-12"
            pose={props.offline ? 'sleep' : props.needsSignIn ? 'wave' : 'think'}
            caption={props.offline ? dict.mascot.offline : props.needsSignIn ? dict.mascot.signIn : dict.mascot.loading}
          />

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
                  className="rounded-lg border border-line bg-bg p-3"
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
                <p className="rounded-lg border border-line bg-bg px-3.5 py-2.5 text-xs text-muted">
                  {boot.installPhantom}
                </p>
              ) : null}

              <p className="flex items-center gap-2 border-t border-line pt-4 text-xs text-muted">
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
