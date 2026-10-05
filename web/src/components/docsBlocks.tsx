import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, Copy, Info, TriangleAlert } from './icons.js';
import { useI18n } from '../i18n/context.js';

/** Dashboard tabs a docs page can link to. Kept in sync with FEATURE_TABS in App.tsx. */
export type DocsLinkTab = 'wallet' | 'tasks' | 'commands' | 'policy' | 'approvals' | 'audit';

export type DocSection = { id: string; title: string; body: ReactNode };

export type DocPage = {
  id: string;
  group: string;
  title: string;
  summary: string;
  /** Extra search terms that do not appear in the title or summary. */
  keywords?: string;
  sections: DocSection[];
};

export type DocsContext = {
  openTab: (tab: DocsLinkTab) => void;
};

export function CodeBlock(props: { code: string; label?: string }) {
  const { dict } = useI18n();
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
        <span>{props.label ?? dict.docs.code}</span>
        <button type="button" className="docs-code-copy" onClick={() => void copy()} aria-label={dict.docs.copyCode}>
          {copied === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied === 'copied' ? dict.docs.copied : copied === 'failed' ? dict.docs.copyFailed : dict.docs.copy}
        </button>
      </div>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

export function Callout(props: { tone: 'note' | 'warn'; title: string; children: ReactNode }) {
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

export function Steps(props: { children: ReactNode }) {
  return <ol className="docs-steps">{props.children}</ol>;
}

export function TabLink(props: { tab: DocsLinkTab; label: string; ctx: DocsContext }) {
  const { dict, interpolate } = useI18n();
  return (
    <button type="button" className="docs-tab-link" onClick={() => props.ctx.openTab(props.tab)}>
      {interpolate(dict.docs.openTab, { label: props.label })}
      <ArrowUpRight size={13} aria-hidden="true" />
    </button>
  );
}

export function Tabs(props: { items: Array<{ id: string; label: string; body: ReactNode }> }) {
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
