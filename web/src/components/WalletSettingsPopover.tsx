import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Position = { top: number; left: number };

export function WalletSettingsPopover(props: {
  id: string;
  label: string;
  className: string;
  open: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (!props.open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = document.querySelector<HTMLButtonElement>(`[aria-controls="${props.id}"]`);
      const panel = panelRef.current;
      if (!anchor || !panel) return;

      const anchorRect = anchor.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const edge = 12;
      const gap = 8;
      const maxTop = Math.max(edge, window.innerHeight - panelRect.height - edge);
      let top = anchorRect.bottom + gap;

      if (top > maxTop && anchorRect.top - panelRect.height - gap >= edge) {
        top = anchorRect.top - panelRect.height - gap;
      }
      top = Math.max(edge, Math.min(top, maxTop));

      const maxLeft = Math.max(edge, window.innerWidth - panelRect.width - edge);
      const left = Math.max(edge, Math.min(anchorRect.right - panelRect.width, maxLeft));
      setPosition((current) =>
        current?.top === top && current.left === left ? current : { top, left },
      );
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [props.id, props.open]);

  if (!props.open) return null;

  return createPortal(
    <div
      ref={panelRef}
      id={props.id}
      className={`wallet-settings-panel ${props.className}`}
      role="group"
      aria-label={props.label}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
