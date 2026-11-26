import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Clock } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Slider } from './ui/slider.js';

type Verdict = 'allow' | 'approval' | 'deny';

type DemoRequest = { recipient: string; amount: number; allowlisted: boolean };

// Illustrative requests only; nothing here touches the agent or the chain.
const DEMO_REQUESTS: DemoRequest[] = [
  { recipient: 'inference.api', amount: 0.12, allowlisted: true },
  { recipient: 'rpc.node', amount: 0.03, allowlisted: true },
  { recipient: '9xQe…P4nT', amount: 0.2, allowlisted: false },
  { recipient: 'storage.bucket', amount: 0.85, allowlisted: true },
  { recipient: 'price.feed', amount: 0.05, allowlisted: true },
  { recipient: 'inference.api', amount: 1.4, allowlisted: true },
  { recipient: '4Hn2…Zk7c', amount: 0.08, allowlisted: false },
  { recipient: 'storage.bucket', amount: 0.36, allowlisted: true },
];

const VISIBLE_ROWS = 4;
const TICK_MS = 2200;

function decide(request: DemoRequest, limit: number): Verdict {
  if (!request.allowlisted) return 'deny';
  return request.amount > limit ? 'approval' : 'allow';
}

const VERDICT_STYLE = {
  allow: { icon: CheckCircle2, tone: 'text-ok', badge: 'ok' },
  approval: { icon: Clock, tone: 'text-warn', badge: 'warn' },
  deny: { icon: Ban, tone: 'text-bad', badge: 'bad' },
} as const;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Sign-in screen demo: a simulated request feed that re-evaluates live as the per-transaction limit moves. */
export function PolicyPlayground() {
  const { dict } = useI18n();
  const { boot } = dict;
  const [limit, setLimit] = useState(0.5);
  // `seq` grows forever; row keys derive from it so each new row mounts and plays its entry animation.
  const [seq, setSeq] = useState(VISIBLE_ROWS - 1);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState<number | null>(null);
  const [reducedMotion] = useState(prefersReducedMotion);

  const running = !paused && !reducedMotion;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setSeq((n) => n + 1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  const rows = Array.from({ length: VISIBLE_ROWS }, (_, i) => {
    const n = seq - i;
    return { key: n, request: DEMO_REQUESTS[n % DEMO_REQUESTS.length]! };
  });

  const labels: Record<Verdict, string> = {
    allow: boot.verdictAllow,
    approval: boot.verdictApproval,
    deny: boot.verdictDeny,
  };
  const reasons: Record<Verdict, string> = {
    allow: boot.introAllow,
    approval: boot.introApproval,
    deny: boot.introDeny,
  };

  const explained = rows.find((row) => row.key === focused) ?? rows[0]!;
  const explainedVerdict = decide(explained.request, limit);

  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <span className="text-[15px] font-semibold text-ink">{boot.playgroundTitle}</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span
            className={cn('h-1.5 w-1.5 rounded-full', running ? 'bg-accent animate-pulse' : 'bg-line-strong')}
            aria-hidden="true"
          />
          {running ? boot.playgroundLive : boot.playgroundPaused}
          <Badge variant="neutral" className="ml-1">{boot.playgroundSimulated}</Badge>
        </span>
      </div>

      <div className="px-5 pt-4">
        <div className="flex items-baseline justify-between text-xs">
          <span id="demo-limit-label" className="font-medium text-muted">{boot.perTxLimit}</span>
          <span className="font-mono font-medium text-ink tabular-nums">{limit.toFixed(2)} SOL</span>
        </div>
        <Slider
          className="mt-2"
          min={0.05}
          max={1.5}
          step={0.05}
          value={[limit]}
          onValueChange={(value) => setLimit(value[0] ?? limit)}
          aria-label={boot.perTxLimit}
        />
      </div>

      <ul
        className="mt-3 divide-y divide-line border-t border-line"
        aria-live="off"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => {
          setPaused(false);
          setFocused(null);
        }}
      >
        {rows.map(({ key, request }) => {
          const verdict = decide(request, limit);
          const style = VERDICT_STYLE[verdict];
          const Icon = style.icon;
          return (
            <li
              key={key}
              className={cn(
                'flex items-center gap-3 px-5 py-2.5 transition-colors animate-feed-in motion-reduce:animate-none',
                focused === key && 'bg-surface-muted',
              )}
              onMouseEnter={() => setFocused(key)}
            >
              <Icon size={16} className={cn('shrink-0 transition-colors', style.tone)} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{request.recipient}</span>
              <span className="font-mono text-xs text-muted tabular-nums">{request.amount.toFixed(2)} SOL</span>
              <Badge variant={style.badge} className="w-[104px] justify-center transition-colors">
                {labels[verdict]}
              </Badge>
            </li>
          );
        })}
      </ul>

      <p className="border-t border-line px-5 py-3 text-xs text-muted">
        <span className={cn('font-medium', VERDICT_STYLE[explainedVerdict].tone)}>{labels[explainedVerdict]}</span>
        {' · '}
        {reasons[explainedVerdict]}
      </p>
    </div>
  );
}
