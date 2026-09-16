import { useEffect, useState } from 'react';

/**
 * Первый кадр анимированной картинки — статичным изображением (запрос 05.09).
 *
 * 🔴 **Зачем.** В оверлее поверх игры движущийся аватар — помеха человеку в бою, и анимации там нет
 * намеренно. Но у купившего её обычный и анимированный аватар это РАЗНЫЕ файлы, и в оверлее
 * оставалась прежняя картинка — то есть человек выглядел не собой. Первый кадр решает обе задачи
 * разом: лицо нынешнее, движения нет.
 *
 * 🔴 **Снимаем ЗДЕСЬ, в окне оверлея, а не шлём готовую картинку из главного.** Кадр в виде
 * `data:`-ссылки весит десятки килобайт, а состояние оверлея пушится на каждое изменение ростера —
 * то есть до десятка раз в секунду, пока люди говорят. По проводу едет ССЫЛКА, тяжёлое остаётся на
 * месте и считается один раз на процесс.
 *
 * ⚠️ Холст «портится» кросс-доменной картинкой, и `toDataURL` тогда бросает. Поэтому `crossOrigin`,
 * а MinIO отдаёт `Access-Control-Allow-Origin` (проверено запросом 05.09). Не вышло — возвращаем
 * `null`, и вызывающий рисует обычный аватар, как рисовал раньше.
 */

/** Кадр кэшируется на ПРОЦЕСС: один и тот же аватар встречается в списке многократно. */
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** Больше не нужно: в оверлее аватар 30 px, с запасом на плотность экрана. */
const FRAME_PX = 64;

function extract(url: string): Promise<string | null> {
  const done = pending.get(url);
  if (done) return done;
  const task = new Promise<string | null>((resolve) => {
    const img = new Image();
    // ⚠️ ДО `src`: иначе браузер начнёт загрузку без запроса CORS и холст всё равно испортится.
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const side = Math.max(1, Math.min(FRAME_PX, Math.max(img.naturalWidth, img.naturalHeight)));
        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, side, side);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        // Испорченный холст (нет CORS) — не беда: покажем обычный аватар.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  }).then((v) => {
    cache.set(url, v);
    pending.delete(url);
    return v;
  });
  pending.set(url, task);
  return task;
}

/** Первый кадр для этой ссылки. `null` — ещё не готов или не получилось. */
export function useFirstFrame(url: string | null | undefined): string | null {
  const [frame, setFrame] = useState<string | null>(() => (url ? (cache.get(url) ?? null) : null));
  useEffect(() => {
    if (!url) {
      setFrame(null);
      return;
    }
    const known = cache.get(url);
    if (known !== undefined) {
      setFrame(known);
      return;
    }
    let alive = true;
    void extract(url).then((v) => alive && setFrame(v));
    return () => {
      alive = false;
    };
  }, [url]);
  return frame;
}
