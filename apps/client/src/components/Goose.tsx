/**
 * Gus, the application mascot.
 *
 * Every frame is an individual transparent production asset. Keeping artwork as assets, rather
 * than approximating it in JSX geometry or cropping a shared sprite at runtime, keeps each
 * surface predictable and lets Vite cache only the pose it needs.
 */
export type GoosePose = 'mini' | 'nap' | 'look' | 'wave' | 'honk' | 'peek' | 'head' | 'head-sleepy';

type PoseAsset = { src: string; width: number; height: number };

const POSES: Record<GoosePose, PoseAsset> = {
  mini: { src: new URL('../assets/mascot/mini.png', import.meta.url).href, width: 192, height: 210 },
  look: { src: new URL('../assets/mascot/look.png', import.meta.url).href, width: 168, height: 210 },
  wave: { src: new URL('../assets/mascot/wave.png', import.meta.url).href, width: 186, height: 250 },
  honk: { src: new URL('../assets/mascot/honk.png', import.meta.url).href, width: 183, height: 220 },
  nap: { src: new URL('../assets/mascot/nap.png', import.meta.url).href, width: 220, height: 151 },
  peek: { src: new URL('../assets/mascot/peek.png', import.meta.url).href, width: 164, height: 180 },
  head: { src: new URL('../assets/mascot/head.png', import.meta.url).href, width: 104, height: 104 },
  'head-sleepy': { src: new URL('../assets/mascot/head-sleepy.png', import.meta.url).href, width: 220, height: 220 },
};

export function Goose({ pose = 'mini', size = 96, className }: { pose?: GoosePose; size?: number; className?: string }) {
  const asset = POSES[pose];
  return (
    <img
      src={asset.src}
      width={size}
      height={Math.round(size * (asset.height / asset.width))}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
