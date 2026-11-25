import { useEffect } from 'react';
import { cn } from '../lib/utils.js';

export const MASCOT_POSES = [
  'wallet',
  'tasks',
  'command',
  'policy',
  'approved',
  'audit',
  'docs',
  'wave',
  'cheer',
  'think',
  'denied',
  'sleep',
] as const;

export type MascotPose = (typeof MASCOT_POSES)[number];

const poseSrc = (pose: MascotPose) => `/brand/mascot-${pose}.svg`;

/**
 * Brand mascot restricted to the unauthenticated BootScreen.
 * Keeps all 12 poses defined for shared i18n/asset verification.
 */
export function Mascot(props: { pose: MascotPose; caption: string; className?: string }) {
  useEffect(() => {
    for (const pose of MASCOT_POSES) new Image().src = poseSrc(pose);
  }, []);

  return (
    <div className={cn('inline-flex items-center justify-center', props.className)} aria-hidden="true">
      <img
        key={props.pose}
        className="h-12 w-12 select-none object-contain"
        src={poseSrc(props.pose)}
        alt=""
        title={props.caption}
        width={48}
        height={48}
      />
    </div>
  );
}
