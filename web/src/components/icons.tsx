import type { CSSProperties, ReactNode } from 'react';

// nexusPay icon set. Drop-in for the lucide-react names the app used: 24px grid,
// rounded 1.9 stroke in currentColor, plus a soft duotone fill on the main shape
// so icons match the card-agent logo and mascot.

export type IconProps = {
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean | 'true' | 'false';
};

const tint = { fill: 'currentColor', fillOpacity: 0.16, stroke: 'none' } as const;

function icon(name: string, body: ReactNode) {
  function Icon({ size = 24, className, style, 'aria-hidden': ariaHidden = true }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `nx-icon ${className}` : 'nx-icon'}
        style={style}
        aria-hidden={ariaHidden}
        focusable="false"
      >
        {body}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

const shieldPath = 'M12 3l7 2.8v5.4c0 4.6-3 8-7 9.8-4-1.8-7-5.2-7-9.8V5.8Z';
const trianglePath = 'M10.3 4.2 2.9 17.3a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z';

// Brand and navigation

/** The card-agent from the logo: a card with antenna and eyes. */
export const Bot = icon('Bot', (
  <>
    <rect x="3.5" y="8" width="17" height="11.5" rx="3" {...tint} />
    <rect x="3.5" y="8" width="17" height="11.5" rx="3" />
    <path d="M12 8V5.6" />
    <circle cx="12" cy="4" r="1.7" fill="currentColor" stroke="none" />
    <path d="M9.5 12.2v2M14.5 12.2v2" strokeWidth={2.3} />
  </>
));

/** Payment card with the logo's chip. */
export const WalletCards = icon('WalletCards', (
  <>
    <rect x="2.5" y="5.5" width="19" height="13" rx="3" />
    <rect x="6" y="9" width="5" height="4" rx="1.2" {...tint} fillOpacity={0.3} />
    <rect x="6" y="9" width="5" height="4" rx="1.2" strokeWidth={1.5} />
    <path d="M6 15.5h3M14.5 15.5h3.5" />
  </>
));

/** Stacked task cards, the front one checked. */
export const Layers = icon('Layers', (
  <>
    <path d="M7 7.5v-1A2.5 2.5 0 0 1 9.5 4h9A2.5 2.5 0 0 1 21 6.5v6a2.5 2.5 0 0 1-2.5 2.5H17" />
    <rect x="3" y="7.5" width="14" height="12.5" rx="2.5" {...tint} />
    <rect x="3" y="7.5" width="14" height="12.5" rx="2.5" />
    <path d="M7 13.8l2 2 3.8-4" />
  </>
));

/** Terminal prompt window. */
export const Command = icon('Command', (
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="3" {...tint} />
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <path d="M7.5 10l3 2.5-3 2.5M13 15.5h4" />
  </>
));

export const ShieldCheck = icon('ShieldCheck', (
  <>
    <path d={shieldPath} {...tint} />
    <path d={shieldPath} />
    <path d="M9 12l2.2 2.2 4-4.4" />
  </>
));

export const Shield = icon('Shield', (
  <>
    <path d={shieldPath} {...tint} />
    <path d={shieldPath} />
  </>
));

export const CheckCircle2 = icon('CheckCircle2', (
  <>
    <circle cx="12" cy="12" r="9" {...tint} />
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.2l2.4 2.4 4.6-5" />
  </>
));

export const ClipboardList = icon('ClipboardList', (
  <>
    <rect x="5" y="4.5" width="14" height="16" rx="3" />
    <rect x="9" y="3" width="6" height="3.5" rx="1.2" {...tint} fillOpacity={0.3} />
    <rect x="9" y="3" width="6" height="3.5" rx="1.2" />
    <path d="M9 11h6M9 14.5h6M9 18h3" />
  </>
));

export const BookOpen = icon('BookOpen', (
  <>
    <path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5Z" {...tint} />
    <path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5Z" />
    <path d="M12 6.5v13" />
  </>
));

// Money

export const Wallet = icon('Wallet', (
  <>
    <path d="M4 8A2.5 2.5 0 0 1 6.5 5.5H17V8" />
    <rect x="3.5" y="8" width="17" height="11.5" rx="2.5" {...tint} />
    <rect x="3.5" y="8" width="17" height="11.5" rx="2.5" />
    <path d="M20.5 12h-3.8a1.75 1.75 0 0 0 0 3.5h3.8" />
  </>
));

export const Coins = icon('Coins', (
  <>
    <circle cx="9" cy="9" r="6" {...tint} />
    <circle cx="9" cy="9" r="6" />
    <path d="M14.8 9.4a6 6 0 1 1-5.4 5.4" />
    <path d="M9 6.5v5" />
  </>
));

export const Zap = icon('Zap', (
  <>
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z" {...tint} />
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z" />
  </>
));

export const Send = icon('Send', (
  <>
    <path d="M21 3 14.5 21 10 14 3 9.5Z" {...tint} />
    <path d="M21 3 14.5 21 10 14 3 9.5Z" />
    <path d="M21 3 10 14" />
  </>
));

export const ArrowDownToLine = icon('ArrowDownToLine', <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />);

// Status

export const Activity = icon('Activity', <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />);

export const Clock = icon('Clock', (
  <>
    <circle cx="12" cy="12" r="9" {...tint} />
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 2" />
  </>
));

export const Info = icon('Info', (
  <>
    <circle cx="12" cy="12" r="9" {...tint} />
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
  </>
));

export const TriangleAlert = icon('TriangleAlert', (
  <>
    <path d={trianglePath} {...tint} />
    <path d={trianglePath} />
    <path d="M12 9.5v4.5" />
    <circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none" />
  </>
));

export const AlertTriangle = TriangleAlert;

export const XCircle = icon('XCircle', (
  <>
    <circle cx="12" cy="12" r="9" {...tint} />
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </>
));

// Connections and settings

export const Plug = icon('Plug', (
  <>
    <path d="M9 3v5M15 3v5M12 17v4" />
    <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0Z" {...tint} />
    <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0Z" />
  </>
));

export const Unplug = icon('Unplug', (
  <>
    <path d="M9 3v5M15 3v5M12 17v4" />
    <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0Z" />
    <path d="M3.5 3.5l17 17" />
  </>
));

export const Settings = icon('Settings', (
  <>
    <path
      d="M12 3.4v2.4M12 18.2v2.4M3.4 12h2.4M18.2 12h2.4M5.9 5.9l1.7 1.7M16.4 16.4l1.7 1.7M5.9 18.1l1.7-1.7M16.4 7.6l1.7-1.7"
      strokeWidth={2.8}
    />
    <circle cx="12" cy="12" r="6.2" {...tint} />
    <circle cx="12" cy="12" r="6.2" />
    <circle cx="12" cy="12" r="2.4" />
  </>
));

export const Globe = icon('Globe', (
  <>
    <circle cx="12" cy="12" r="9" {...tint} />
    <circle cx="12" cy="12" r="9" />
    <ellipse cx="12" cy="12" rx="3.8" ry="9" />
    <path d="M3 12h18" />
  </>
));

/** Language switch: a 文 glyph behind an "A" tile. */
export const Languages = icon('Languages', (
  <>
    <path d="M3 5.5h8M7 3.5v2M4.6 5.5c.9 3.2 3.2 5.5 6 6.5M9.4 5.5c-.9 3.2-2.9 5.4-5.9 6.5" />
    <rect x="10.5" y="10" width="10.5" height="10.5" rx="2.6" {...tint} />
    <rect x="10.5" y="10" width="10.5" height="10.5" rx="2.6" />
    <path d="M13.2 18.2l2.55-5.7 2.55 5.7M14.1 16.4h3.3" strokeWidth={1.7} />
  </>
));

export const LogOut = icon('LogOut', <path d="M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" />);

export const Copy = icon('Copy', (
  <>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" {...tint} />
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 5.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h.5" />
  </>
));

export const RefreshCw = icon('RefreshCw', (
  <path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5M4 4v4.5h4.5M4 12.5a8 8 0 0 0 13.7 5.2l2.3-2.2M20 20v-4.5h-4.5" />
));

export const Play = icon('Play', (
  <>
    <path d="M7.5 5.2v13.6a1 1 0 0 0 1.5.9l10.6-6.8a1 1 0 0 0 0-1.7L9 4.3a1 1 0 0 0-1.5.9Z" {...tint} />
    <path d="M7.5 5.2v13.6a1 1 0 0 0 1.5.9l10.6-6.8a1 1 0 0 0 0-1.7L9 4.3a1 1 0 0 0-1.5.9Z" />
  </>
));

// Plain glyphs

export const Check = icon('Check', <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const X = icon('X', <path d="M6 6l12 12M18 6 6 18" />);
export const Plus = icon('Plus', <path d="M12 5v14M5 12h14" />);
export const Search = icon('Search', (
  <>
    <circle cx="11" cy="11" r="6.5" {...tint} />
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>
));
export const ChevronDown = icon('ChevronDown', <path d="M6 9.5l6 6 6-6" />);
export const ChevronLeft = icon('ChevronLeft', <path d="M14.5 6l-6 6 6 6" />);
export const ChevronRight = icon('ChevronRight', <path d="M9.5 6l6 6-6 6" />);
export const ArrowRight = icon('ArrowRight', <path d="M4.5 12h15M13.5 6l6 6-6 6" />);
export const ArrowUpRight = icon('ArrowUpRight', <path d="M7 17 17 7M8.5 7H17v8.5" />);
export const ExternalLink = icon('ExternalLink', (
  <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
));
