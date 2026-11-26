import { useEffect, useState } from 'react';
import { Ban, ChartLine, CheckCircle2, CircleQuestionMark, Clock, Cpu, Database, Server, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Slider } from './ui/slider.js';

type Verdict = 'allow' | 'approval' | 'deny';

type Recipient = { name: string; icon: typeof Cpu };

// Illustrative data only; nothing here touches the agent or the chain.
const ALLOWLIST: Recipient[] = [
  { name: 'inference.api', icon: Cpu },
  { name: 'rpc.node', icon: Server },
  { name: 'storage.bucket', icon: Database },
  { name: 'price.feed', icon: ChartLine },
];

type DemoRequest = { recipient: string; amount: number };

const DEMO_REQUESTS: DemoRequest[] = [
  { recipient: 'inference.api', amount: 0.12 },
  { recipient: 'rpc.node', amount: 0.03 },
  { recipient: '9xQe…P4nT', amount: 0.2 },
  { recipient: 'storage.bucket', amount: 0.85 },
  { recipient: 'price.feed', amount: 0.05 },
  { recipient: 'inference.api', amount: 1.4 },
  { recipient: '4Hn2…Zk7c', amount: 0.08 },
  { recipient: 'storage.bucket', amount: 0.36 },
  { recipient: 'rpc.node', amount: 0.6 },
  { recipient: '7Kp1…Wq3e', amount: 0.15 },
  { recipient: 'price.feed', amount: 0.02 },
  { recipient: 'inference.api', amount: 0.45 },
];

function allowlisted(recipient: string): Recipient | undefined {
  return ALLOWLIST.find((entry) => entry.name === recipient);
}

/** Allowlisted: solid emerald tile with a shield seal. Unknown: dashed empty tile with a question mark. */
function RecipientAvatar(props: { recipient: string; highlight?: boolean; size?: 'sm' | 'md' }) {
  const entry = allowlisted(props.recipient);
  const box = props.size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  if (!entry) {
    return (
      <span
        className={cn(box, 'grid shrink-0 place-items-center rounded-lg border-[1.5px] border-dashed border-line-strong text-muted')}
        aria-hidden="true"
      >
        <CircleQuestionMark size={15} />
      </span>
    );
  }
  const Icon = entry.icon;
  return (
    <span
      className={cn(
        box,
        'relative grid shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-strong ring-1 ring-accent-line transition-transform',
        props.highlight && 'scale-110 ring-2 ring-accent',
      )}
      aria-hidden="true"
    >
      <Icon size={15} />
      <span className="absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full bg-accent text-white ring-2 ring-panel">
        <ShieldCheck size={10} strokeWidth={2.5} />
      </span>
    </span>
  );
}

const LANES = 4;
const STEP_MS = 3000; // one step: slide in, then rest at the center
const SLIDE_MS = 900;
const LAUNCH_DELAY_MS = 200; // dots leave this long after the center request starts moving right
// Item offsets from the center slot; -2 and +2 sit fully outside the faded edges so items enter and leave unseen.
const OFFSETS = [-2, -1, 0, 1, 2] as const;

// Each lane walks the whole demo list; lanes start this many entries apart so no request shows twice at once.
const LANE_SHIFT = 3;

/** Request shown on `lane` at conveyor position `n`. */
function requestAt(lane: number, n: number): DemoRequest {
  const len = DEMO_REQUESTS.length;
  return DEMO_REQUESTS[(((n + lane * LANE_SHIFT) % len) + len) % len]!;
}

function decide(request: DemoRequest, limit: number): Verdict {
  if (!allowlisted(request.recipient)) return 'deny';
  return request.amount > limit ? 'approval' : 'allow';
}

const VERDICT_STYLE = {
  allow: { icon: CheckCircle2, tone: 'text-ok', badge: 'ok' },
  approval: { icon: Clock, tone: 'text-warn', badge: 'warn' },
  deny: { icon: Ban, tone: 'text-bad', badge: 'bad' },
} as const;

// Legend next to the allowlist: which rule leads to which verdict, in the order the policy checks them.
const RULES = [
  { verdict: 'deny', label: 'ruleNotAllowlisted' },
  { verdict: 'approval', label: 'ruleOverLimit' },
  { verdict: 'allow', label: 'ruleWithinLimit' },
] as const;

const EDGE_FADE = 'linear-gradient(to right, transparent, black 28px, black calc(100% - 28px), transparent)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Sign-in screen demo. Each lane is a conveyor: requests slide in from the left, rest at the center
 * (the one that counts), then slide out to the right; neighbours peek in and fade toward the edges.
 * All lanes step together. Verdicts re-evaluate live as the per-transaction limit moves.
 */
export function PolicyPlayground() {
  const { dict, interpolate } = useI18n();
  const { boot } = dict;
  const [limit, setLimit] = useState(0.5);
  const [step, setStep] = useState(0);
  // Step whose slide has finished: drives the explanation line.
  const [settled, setSettled] = useState(0);
  // Step whose dots have launched: the request pushed from the center to the right on that step flies on to the shield.
  const [launched, setLaunched] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focusedLane, setFocusedLane] = useState<number | null>(null);
  const [reducedMotion] = useState(prefersReducedMotion);

  const running = !paused && !reducedMotion;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setStep((n) => n + 1);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const settle = window.setTimeout(() => setSettled(step), reducedMotion ? 0 : SLIDE_MS);
    const launch = window.setTimeout(() => setLaunched(step), reducedMotion ? 0 : LAUNCH_DELAY_MS);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(launch);
    };
  }, [step, reducedMotion]);

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

  const explained = requestAt(focusedLane ?? 0, settled);
  const explainedVerdict = decide(explained, limit);

  return (
    <div className="rounded-2xl border-[1.5px] border-line-strong bg-panel shadow-raised">
      <ul
        className="space-y-1.5 px-2 pt-2"
        aria-live="off"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => {
          setPaused(false);
          setFocusedLane(null);
        }}
      >
        {Array.from({ length: LANES }, (_, lane) => (
          <li
            key={lane}
            // The request pushed from the center to the right slot on this step becomes the dot.
            data-flow-row={`${lane}-${launched - 1}`}
            data-verdict={decide(requestAt(lane, launched - 1), limit)}
            className={cn('relative h-12 rounded-lg transition-colors', focusedLane === lane && 'bg-surface-muted')}
            style={{ maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}
            onMouseEnter={() => setFocusedLane(lane)}
          >
            {OFFSETS.map((offset) => {
              const n = step - offset;
              const request = requestAt(lane, n);
              const verdict = decide(request, limit);
              const style = VERDICT_STYLE[verdict];
              const known = Boolean(allowlisted(request.recipient));
              const center = offset === 0;
              return (
                <div
                  key={n}
                  aria-hidden={!center}
                  className={cn(
                    'absolute top-1 left-1/2 flex h-10 w-[54%] items-center gap-2.5 rounded-lg border-[1.5px] bg-panel px-2.5 ease-out motion-reduce:transition-none',
                    center ? 'border-line-strong' : 'border-line',
                  )}
                  style={{
                    transform: `translateX(calc(-50% + ${offset} * (100% + 12px))) scale(${center ? 1 : 0.94})`,
                    transitionProperty: 'transform, border-color',
                    transitionDuration: `${SLIDE_MS}ms`,
                  }}
                >
                  {/* Verdict leads the item so it stays visible while the item peeks in from the right edge. */}
                  <Badge
                    variant={style.badge}
                    className="h-6 w-6 shrink-0 justify-center rounded-full p-0 transition-colors"
                    title={labels[verdict]}
                  >
                    <style.icon size={13} aria-hidden="true" />
                    <span className="sr-only">{labels[verdict]}</span>
                  </Badge>
                  <RecipientAvatar recipient={request.recipient} size="sm" />
                  <span className={cn('min-w-0 flex-1 truncate text-xs', known ? 'text-ink' : 'text-muted')}>
                    {request.recipient}
                  </span>
                  <span className="text-xs text-muted tabular-nums">{request.amount.toFixed(2)}</span>
                </div>
              );
            })}
          </li>
        ))}
      </ul>

      <p className="mx-2 mt-2 rounded-lg bg-surface-muted px-3 py-2.5 text-xs text-muted">
        <span className={cn('font-medium', VERDICT_STYLE[explainedVerdict].tone)}>{labels[explainedVerdict]}</span>
        {' · '}
        {reasons[explainedVerdict]}
      </p>
      <div className="px-5 pb-5 pt-4">
        <div className="flex items-baseline justify-between text-xs">
          <span id="demo-limit-label" className="font-medium text-muted">{boot.perTxLimit}</span>
          <span className="font-medium text-ink tabular-nums">{limit.toFixed(2)} SOL</span>
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
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div
            role="img"
            aria-label={interpolate(boot.allowlistAria, { names: ALLOWLIST.map((entry) => entry.name).join(', ') })}
            className="flex items-center gap-3"
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-white" aria-hidden="true">
              <ShieldCheck size={15} />
            </span>
            <span className="flex items-center gap-2">
              {ALLOWLIST.map((entry) => (
                <span key={entry.name} title={entry.name}>
                  <RecipientAvatar
                    recipient={entry.name}
                    size="sm"
                    highlight={focusedLane !== null && explained.recipient === entry.name}
                  />
                </span>
              ))}
            </span>
          </div>
          <ul className="space-y-1 text-xs text-muted">
            {RULES.map((rule) => {
              const style = VERDICT_STYLE[rule.verdict];
              return (
                <li key={rule.verdict} className="flex items-center gap-2">
                  <Badge variant={style.badge} className="h-5 w-5 shrink-0 justify-center rounded-full p-0">
                    <style.icon size={11} aria-hidden="true" />
                  </Badge>
                  <span>{boot[rule.label]}</span>
                  <span className="sr-only">: {labels[rule.verdict]}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

    </div>
  );
}
