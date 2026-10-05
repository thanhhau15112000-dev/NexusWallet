import type { ReactNode } from 'react';
import { ArrowRight, Check, ShieldCheck, Wallet, X } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { LanguageToggle } from './SettingsMenu.js';
import { Mascot } from './Mascot.js';

export function BootScreen(props: {
  needsSignIn: boolean;
  offline: string | null;
  signInError: string | null;
  connecting: boolean;
  hasWallets: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  walletOptions: ReactNode;
  repoUrl: string;
}) {
  const { dict } = useI18n();
  const { boot } = dict;
  return (
    <main className="boot-page">
      <div className="boot-layout">
        <header className="boot-header">
          <div className="boot-brand">
            <img src="/brand/logo.svg" alt="" width={32} height={32} />
            <span>nexusPay</span>
          </div>
          <LanguageToggle />
        </header>

        <div className="boot-main">
          <section className="boot-intro" aria-labelledby="intro-title">
            <p className="boot-eyebrow">
              <img src="/solana-logo-mark.svg" alt="" width={18} height={18} />
              Solana Devnet
            </p>
            <h1 id="intro-title">{boot.heroTitle}</h1>
            <p className="boot-tagline">{boot.introTagline}</p>
            <ul className="boot-points">
              <li><Check size={18} aria-hidden="true" /><span>{boot.introAllow}</span></li>
              <li><ShieldCheck size={18} aria-hidden="true" /><span>{boot.introApproval}</span></li>
              <li><X size={18} aria-hidden="true" /><span>{boot.introDeny}</span></li>
            </ul>
            <a className="boot-docs" href={props.repoUrl} target="_blank" rel="noreferrer">
              {boot.introDocs}<ArrowRight size={16} aria-hidden="true" />
            </a>
          </section>

          <section className="boot" aria-labelledby="login-title">
            <Mascot
              className="boot-mascot"
              pose={props.offline ? 'sleep' : props.needsSignIn ? 'wave' : 'think'}
              caption={props.offline ? dict.mascot.offline : props.needsSignIn ? dict.mascot.signIn : dict.mascot.loading}
            />
            <h2 id="login-title">{props.needsSignIn ? boot.signInRequired : props.offline ? boot.serviceUnavailable : boot.loading}</h2>
            {props.needsSignIn ? <p className="boot-sign-in-desc">{boot.signInDesc}</p> : null}
            {props.offline ? <p role="alert" title={props.offline} className="bad-text boot-error">{boot.connectionHint}</p> : null}
            {props.signInError ? <p role="alert" title={props.signInError} className="bad-text boot-error">{boot.signInFailed}</p> : null}
            {props.needsSignIn ? (
              <>
                <button
                  type="button"
                  className="primary boot-sign-in"
                  aria-expanded={props.pickerOpen}
                  aria-controls="login-wallet-options"
                  disabled={!props.hasWallets || props.connecting}
                  onClick={props.onTogglePicker}
                >
                  <Wallet size={18} aria-hidden="true" />
                  {props.connecting ? boot.connecting : boot.signInBtn}
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
                {props.pickerOpen ? (
                  <div id="login-wallet-options" className="boot-wallet-picker">
                    <div className="boot-picker-head">
                      <span>{dict.walletModal.title}</span>
                      <button type="button" aria-label={dict.walletModal.close} disabled={props.connecting} onClick={props.onTogglePicker}>
                        <X size={16} aria-hidden="true" />
                      </button>
                    </div>
                    {props.walletOptions}
                  </div>
                ) : null}
                {!props.hasWallets ? <p className="wallet-picker-empty boot-wallet-empty">{boot.installPhantom}</p> : null}
                <p className="boot-auth-note"><ShieldCheck size={16} aria-hidden="true" />{boot.authNote}</p>
              </>
            ) : null}
          </section>
        </div>

        <footer className="boot-footer">
          <span className="boot-network">{boot.testFunds}</span>
          <p>{boot.introDevnet}</p>
        </footer>
      </div>
    </main>
  );
}
