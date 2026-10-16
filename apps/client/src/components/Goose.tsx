/**
 * Gus, the application mascot.
 *
 * Every frame is an individual transparent production asset. Keeping artwork as assets, rather
 * than approximating it in JSX geometry or cropping a shared sprite at runtime, keeps each
 * surface predictable and lets Vite cache only the pose it needs.
 */
export type GoosePose = 'mini' | 'nap' | 'look' | 'wave' | 'honk' | 'peek' | 'head' | 'head-sleepy' | 'admin';

type PoseAsset = { src: string; width: number; height: number };

// ⚠️ Импортом, а не `new URL(…, import.meta.url)`. Вторая форма — спецформа Vite: он её понимает и
// подставляет адрес собранного файла, а любой другой сборщик оставляет её как есть, и картинка
// ищется относительно страницы. Поймано на выгрузке дизайн-системы (esbuild): гусь приехал туда
// восемью битыми рамками. Обычный импорт ассета понимают оба.
import miniPng from '../assets/mascot/mini.png';
import lookPng from '../assets/mascot/look.png';
import wavePng from '../assets/mascot/wave.png';
import honkPng from '../assets/mascot/honk.png';
import napPng from '../assets/mascot/nap.png';
import peekPng from '../assets/mascot/peek.png';
import headPng from '../assets/mascot/head.png';
import headSleepyPng from '../assets/mascot/head-sleepy.png';
// «Гусь-админ» (15.10, Codex R241, выбор владельца): сидит с ноутбуком, подключённым в серверную стойку — заставка обновления.
import adminPng from '../assets/mascot/admin.png';

const POSES: Record<GoosePose, PoseAsset> = {
  mini: { src: miniPng, width: 192, height: 210 },
  look: { src: lookPng, width: 168, height: 210 },
  wave: { src: wavePng, width: 186, height: 250 },
  honk: { src: honkPng, width: 183, height: 220 },
  nap: { src: napPng, width: 220, height: 151 },
  peek: { src: peekPng, width: 164, height: 180 },
  head: { src: headPng, width: 104, height: 104 },
  'head-sleepy': { src: headSleepyPng, width: 220, height: 220 },
  admin: { src: adminPng, width: 380, height: 320 },
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
