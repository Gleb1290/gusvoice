import { useState } from 'react';
import { useFirstFrame } from '../firstFrame';
import { avatarShowsStill, useLiteMode } from '../liteMode';
import { useWindowMotion } from '../windowCovered';

/**
 * Renders an avatar image when available, otherwise a fallback:
 *  - `fallback="letter"` (default): a coloured initial circle.
 *  - `fallback="icon"`: a grey person silhouette (matches the voice stage placeholder).
 *
 * 🔴 **Анимация (#117) показывается ВСЕГДА и всем, кому её передали (решение 01.09).**
 * Первая версия крутила её только по наведению — из осторожности к слабым машинам. Решение
 * развернули, и по сути верно: человек, купивший движущийся аватар, покупал его чтобы его видели,
 * а не чтобы на него наводили мышь.
 *
 * ⚠️ Решение «показывать ли» принимается НЕ здесь, а у вызывающего: `animatedUrl` приходит из
 * `useAnimatedAvatarUrl`, и при выключенной у зрителя настройке он просто `undefined` — то есть
 * компонент даже не узнаёт про ссылку и не грузит её. Выключатель обязан экономить трафик, а не
 * только прятать движение.
 *
 * ⚠️ В ОВЕРЛЕЕ анимации нет: он висит поверх чужой игры, и движущаяся аватарка там — помеха
 * человеку в бою. Граница держится структурно — оверлей просто не передаёт `animatedUrl`.
 *
 * 🔴 **Первый кадр вместо анимации (27.09, #207)** — решение 01.09 это не отменяет, смотрящий на
 * приложение анимацию видит как раньше:
 * - в НАКРЫТОМ окне — всегда: его никто не видит, а GIF крутился — декодер картинки CSS-паузе не
 *   подчиняется. Трейс: 14 аватарок держали перерисовку ~150 раз в секунду;
 * - в оптимизированном режиме (`liteMode.ts`) — везде, оживает по наведению; под игрой замирает
 *   совсем (окно может быть видно на втором мониторе — поэтому только по выбору человека).
 * Кадр не готов или не снялся (CORS) — оставляем анимацию: лучше потратить процессор, чем показать
 * человека не собой.
 */
export function Avatar({
  url,
  animatedUrl,
  name,
  size = 38,
  fallback = 'letter',
}: {
  url?: string | null;
  /** Анимация. Не передана — обычное поведение, как и было. */
  animatedUrl?: string | null;
  name: string;
  size?: number;
  fallback?: 'letter' | 'icon';
}) {
  const motion = useWindowMotion();
  const lite = useLiteMode();
  const [hover, setHover] = useState(false);
  const still = avatarShowsStill({ hasAnimation: !!animatedUrl, covered: motion.covered, gameFg: motion.gameFg, lite, hover });
  const frame = useFirstFrame(still ? animatedUrl : null);
  const style: React.CSSProperties = { width: size, height: size, borderRadius: size / 2, flex: '0 0 auto' };
  // Анимация ПОВЕРХ обычной: если её не окажется (файл удалён, сеть отвалилась), браузер покажет
  // сломанную картинку — поэтому `url` остаётся запасным на случай, когда анимации нет вовсе.
  const src = (still && frame) || animatedUrl || url;
  if (src) {
    // Наведение нужно только в оптимизированном режиме: там анимация оживает по нему.
    const hoverable = lite && !!animatedUrl;
    return (
      <img
        className="avatar-img"
        style={style}
        src={src}
        alt={name}
        onMouseEnter={hoverable ? () => setHover(true) : undefined}
        onMouseLeave={hoverable ? () => setHover(false) : undefined}
      />
    );
  }
  if (fallback === 'icon') {
    return (
      <span className="avatar-icon" style={style} role="img" aria-label={name}>
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="9" r="4" />
          <path d="M4 20c0-3.6 3.6-5.6 8-5.6s8 2 8 5.6z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="avatar-letter" style={{ ...style, fontSize: Math.round(size * 0.42) }}>
      {name[0]?.toUpperCase()}
    </span>
  );
}
