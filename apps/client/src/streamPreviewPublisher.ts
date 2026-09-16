import { checkStreamPreview, STREAM_PREVIEW_REFRESH_MS } from '@gusvoice/shared';

/**
 * Отправка своего превью показа на сервер (#115) — цикл «раз в несколько секунд взять кадр и
 * отдать», без единой браузерной зависимости.
 *
 * ⚠️ Цикл крутится всё время, пока человек сидит в голосовом канале, а НЕ включается по началу
 * показа. Так сделано намеренно: «показываю» приходит из двух разных мест (нативный показ публикует
 * отдельный участник, веб — обычный трек), и держать здесь их склейку значило бы завести третье
 * место, которое обязано быть согласовано с теми двумя. Вместо этого источник кадра сам отвечает
 * «сейчас нечего» — и это верно по построению: нет кадра, значит нет и показа.
 */

export interface PreviewPublisherDeps {
  /** Взять свежий кадр. `null` — показа нет либо кадр ещё не готов. */
  grab: () => Promise<string | null>;
  /** Отдать кадр серверу. */
  send: (image: string) => Promise<void>;
  /** Отдавать ли превью вообще — тумблер приватности. Спрашиваем на КАЖДОМ тике: выключить его
   *  посреди показа человек вправе, и подействовать это должно сразу. */
  enabled: () => boolean;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  everyMs?: number;
}

export interface PreviewPublisher {
  start: () => void;
  /** Остановить цикл. Повторный вызов безвреден. */
  stop: () => void;
}

export function createPreviewPublisher(deps: PreviewPublisherDeps): PreviewPublisher {
  const every = deps.everyMs ?? STREAM_PREVIEW_REFRESH_MS;
  let timer: number | null = null;
  let running = false;

  const tick = async () => {
    try {
      if (deps.enabled()) {
        const image = await deps.grab();
        // Проверяем ПЕРЕД отправкой по общему правилу: гонять по сети то, что сервер заведомо
        // отобьёт, незачем.
        if (image && checkStreamPreview(image).ok) await deps.send(image);
      }
    } catch {
      // Единственный разумный ответ на сбой: пропустить такт. Превью — украшение, и ронять из-за
      // него цикл (а значит, и все следующие кадры) нельзя.
    }
    // Планируем следующий такт ТОЛЬКО после завершения этого — иначе медленная отправка накладывалась
    // бы сама на себя и в очереди копились бы устаревшие кадры.
    if (running) timer = deps.setTimer(() => void tick(), every);
  };

  return {
    start() {
      if (running) return; // второй start не заводит второй цикл
      running = true;
      timer = deps.setTimer(() => void tick(), every);
    },
    stop() {
      running = false;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
  };
}
