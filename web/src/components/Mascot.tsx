import { useEffect } from 'react';

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
 * The card-agent mascot. Decorative: the caption repeats state that the page
 * already shows, so the whole figure is hidden from assistive tech.
 */
export function Mascot(props: { pose: MascotPose; caption: string; className?: string }) {
  // Warm the cache so switching tabs swaps the pose without a blank frame.
  useEffect(() => {
    for (const pose of MASCOT_POSES) new Image().src = poseSrc(pose);
  }, []);

  return (
    <div className={props.className ? `mascot ${props.className}` : 'mascot'} aria-hidden="true">
      <p className="mascot-bubble">{props.caption}</p>
      <img key={props.pose} className="mascot-figure" src={poseSrc(props.pose)} alt="" width={112} height={112} />
    </div>
  );
}
