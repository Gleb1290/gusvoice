import type { StickerFormat } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { unpackTgs } from '../tgs';

/**
 * Отрисовка стикера Telegram (#68). Три формата — три разных способа:
 *
 *  • `webp` — обычная картинка, анимация внутри играется сама браузером;
 *  • `webm` — VP9 с альфой в `<video>`. ⚠️ В Safari прозрачности у VP9 нет, там будет чёрный фон:
 *    это ограничение браузера, обойти его на нашей стороне нечем;
 *  • `tgs`  — gzip'нутый Lottie: распаковываем сами, рисуем `lottie-web` ЛЕНИВО (библиотека
 *    весит больше двухсот килобайт, и грузить её тем, кто стикеры не открывал, незачем).
 *
 * `animate` выключается для тех плиток, которых нет на экране: сотня одновременных Lottie-анимаций
 * в пикере кладёт процессор, и это заметно даже на быстрой машине.
 */
export function StickerView({
  url,
  format,
  emoji,
  size = 160,
  animate = true,
}: {
  url: string;
  format: StickerFormat;
  emoji?: string;
  size?: number;
  animate?: boolean;
}) {
  const style = { width: size, height: size };

  if (format === 'webm') {
    return (
      <video
        className="sticker-media"
        style={style}
        src={url}
        autoPlay={animate}
        loop
        muted
        playsInline
        preload="metadata"
        aria-label={emoji || 'стикер'}
      />
    );
  }
  if (format === 'tgs') return <TgsSticker url={url} emoji={emoji} size={size} animate={animate} />;
  return <img className="sticker-media" style={style} src={url} alt={emoji || 'стикер'} loading="lazy" />;
}

/**
 * Разобранные анимации держим в памяти: в пикере плитка то уезжает за край, то возвращается, и
 * без кэша каждый такой проход означал бы новую загрузку и новый разбор JSON.
 *
 * Кэш ограничен — распакованный Lottie весит куда больше сжатого файла, и держать все сто наборов
 * сразу значит съесть память вкладки.
 */
const tgsCache = new Map<string, Promise<unknown>>();
const TGS_CACHE_MAX = 40;

function loadTgs(url: string): Promise<unknown> {
  const hit = tgsCache.get(url);
  if (hit) return hit;
  const p = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then(unpackTgs)
    .catch((e: unknown) => {
      // Неудачу не кэшируем: разовый сбой сети иначе стал бы вечным.
      tgsCache.delete(url);
      throw e;
    });
  if (tgsCache.size >= TGS_CACHE_MAX) {
    const oldest = tgsCache.keys().next().value;
    if (oldest) tgsCache.delete(oldest);
  }
  tgsCache.set(url, p);
  return p;
}

function TgsSticker({
  url,
  emoji,
  size,
  animate,
}: {
  url: string;
  emoji?: string;
  size: number;
  animate: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    let anim: { destroy: () => void; goToAndStop: (f: number, isFrame: boolean) => void } | null = null;

    void (async () => {
      try {
        const [data, mod] = await Promise.all([loadTgs(url), import('lottie-web')]);
        if (dead || !box.current) return;
        anim = mod.default.loadAnimation({
          container: box.current,
          renderer: 'svg',
          loop: true,
          autoplay: animate,
          animationData: data as object,
        });
        // Не анимируем — показываем первый кадр, а не пустоту: плитка обязана быть узнаваемой.
        if (!animate) anim.goToAndStop(0, true);
      } catch {
        if (!dead) setFailed(true);
      }
    })();

    return () => {
      dead = true;
      anim?.destroy();
    };
  }, [url, animate]);

  if (failed) {
    // Подпись-эмодзи как запасной вариант: она и так у стикера есть, и это лучше пустого места.
    return (
      <span className="sticker-media sticker-fallback" style={{ width: size, height: size }}>
        {emoji || '❔'}
      </span>
    );
  }
  return <div className="sticker-media" style={{ width: size, height: size }} ref={box} aria-label={emoji || 'стикер'} />;
}
