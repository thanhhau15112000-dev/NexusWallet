import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, Copy, Info, TriangleAlert } from './icons.js';
import { useI18n } from '../i18n/context.js';
import { cn } from '../lib/utils.js';
import { Button } from './ui/button.js';
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.js';

/** Dashboard tabs a docs page can link to. Kept in sync with FEATURE_TABS in App.tsx. */
export type DocsLinkTab = 'wallet' | 'policy' | 'approvals' | 'tasks' | 'history' | 'commands';

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
    <div className="mt-2 mb-3 overflow-hidden rounded-md border border-line bg-surface-muted">
      <div className="flex items-center justify-between border-b border-line py-1 pr-1.5 pl-2.5 font-mono text-[11px] text-muted">
        <span>{props.label ?? dict.docs.code}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 font-sans text-[11px]"
          onClick={() => void copy()}
          aria-label={dict.docs.copyCode}
        >
          {copied === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied === 'copied' ? dict.docs.copied : copied === 'failed' ? dict.docs.copyFailed : dict.docs.copy}
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-xs whitespace-pre text-ink">
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

const CALLOUT_TONE = {
  note: 'border-l-accent bg-panel [&>svg]:text-accent',
  warn: 'border-l-warn bg-warn-soft [&>svg]:text-warn',
} as const;

export function Callout(props: { tone: 'note' | 'warn'; title: string; children: ReactNode }) {
  const Icon = props.tone === 'warn' ? TriangleAlert : Info;
  return (
    <aside
      className={cn(
        'mb-3 flex gap-2.5 rounded-md border border-l-[3px] border-line px-3 py-2.5 text-[13px] [&>svg]:mt-0.5 [&>svg]:shrink-0',
        CALLOUT_TONE[props.tone],
      )}
    >
      <Icon size={16} aria-hidden="true" />
      <div>
        <strong className="mb-0.5 block font-semibold">{props.title}</strong>
        <div>{props.children}</div>
      </div>
    </aside>
  );
}

/** Numbered steps: emerald counter badges instead of list numbers. */
export function Steps(props: { children: ReactNode }) {
  return (
    <ol
      className={cn(
        'list-none! pl-0! [counter-reset:docs-step]',
        '[&>li]:relative [&>li]:pl-8 [&>li]:[counter-increment:docs-step] [&>li+li]:mt-3',
        '[&>li]:before:absolute [&>li]:before:top-px [&>li]:before:left-0 [&>li]:before:grid [&>li]:before:h-[21px] [&>li]:before:w-[21px] [&>li]:before:place-items-center',
        '[&>li]:before:rounded-full [&>li]:before:border [&>li]:before:border-accent-line [&>li]:before:bg-accent-soft',
        '[&>li]:before:text-[11px] [&>li]:before:font-semibold [&>li]:before:text-accent [&>li]:before:content-[counter(docs-step)]',
      )}
    >
      {props.children}
    </ol>
  );
}

export function TabLink(props: { tab: DocsLinkTab; label: string; ctx: DocsContext }) {
  const { dict, interpolate } = useI18n();
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto gap-0.5 p-0 text-[13px] font-semibold"
      onClick={() => props.ctx.openTab(props.tab)}
    >
      {interpolate(dict.docs.openTab, { label: props.label })}
      <ArrowUpRight size={13} aria-hidden="true" />
    </Button>
  );
}

export function Tabs(props: { items: Array<{ id: string; label: string; body: ReactNode }> }) {
  return (
    <UiTabs defaultValue={props.items[0]?.id} className="mt-2.5">
      <TabsList className="max-w-full overflow-x-auto">
        {props.items.map((item) => (
          <TabsTrigger key={item.id} value={item.id}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {props.items.map((item) => (
        <TabsContent key={item.id} value={item.id}>
          {item.body}
        </TabsContent>
      ))}
    </UiTabs>
  );
}
