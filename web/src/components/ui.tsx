import type { ReactNode } from 'react';

export function Card(props: {
  title: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${props.className ?? ''}`.trim()}>
      <header className="card-head">
        <h2>{props.title}</h2>
        {props.actions ? <div className="card-actions">{props.actions}</div> : null}
      </header>
      <div className="card-body">{props.children}</div>
    </section>
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
