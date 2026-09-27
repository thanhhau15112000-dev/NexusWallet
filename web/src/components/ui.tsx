import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy } from 'lucide-react';

export function Card(props: {
  title: string;
  titleIcon?: ReactNode;
  titleAction?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${props.className ?? ''}`.trim()}>
      <header className="card-head">
        <h2 className="card-title">
          {props.titleIcon ? (
            <span className="card-title-icon" aria-hidden="true">
              {props.titleIcon}
            </span>
          ) : null}
          {props.title}
          {props.titleAction ? (
            <span className="card-title-action">{props.titleAction}</span>
          ) : null}
        </h2>
        {props.actions ? <div className="card-actions">{props.actions}</div> : null}
      </header>
      <div className="card-body">{props.children}</div>
    </section>
  );
}

export function CopyAddressButton(props: { value: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      setStatus('idle');
      resetTimer.current = null;
    }, 1800);
  };

  return (
    <span className="copy-control">
      <button
        type="button"
        className="icon-button"
        aria-label={props.label}
        title={props.label}
        onClick={() => void copy()}
      >
        <Copy size={15} aria-hidden="true" />
      </button>
      {status !== 'idle' ? (
        <span className={`copy-status${status === 'failed' ? ' is-error' : ''}`} role="status">
          {status === 'copied' ? 'Copied' : 'Copy failed'}
        </span>
      ) : null}
    </span>
  );
}

export function Pill(props: { tone: string; children: ReactNode }) {
  return <span className={`pill pill-${props.tone}`}>{props.children}</span>;
}

export function Mono(props: { children: ReactNode; title?: string }) {
  return (
    <span className="mono" title={props.title}>
      {props.children}
    </span>
  );
}

export function shorten(value: string, size = 4): string {
  return value.length <= size * 2 + 3 ? value : `${value.slice(0, size)}...${value.slice(-size)}`;
}

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}
