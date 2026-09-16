/**
 * Отсрочка закрытия ОКНА ПРОСМОТРА показа, устойчивая к морганию трека.
 *
 * 🔴 Повод тот же, что у [[streamCue]] — самолечение залипшего показа (#111): у стримера
 * пересоздаётся публикация, и на секунду трек пропадает у всех. Мгновенное «снять просмотр» на
 * такое моргание закрывало бы показ КАЖДОМУ зрителю, и всем пришлось бы открывать его заново —
 * то есть лечение у одного человека било бы по всему каналу.
 *
 * Правило простое и не требует отличать наше лечение от настоящего конца показа (другим клиентам
 * этого знать неоткуда): **вернулся внутри грейса — ничего не произошло**.
 *
 * ⚠️ Отсрочка держит только НАМЕРЕНИЕ смотреть. Картинка исчезает сразу и без нас — плитки строятся
 * из живых треков, — поэтому за эти секунды на экране ничего лишнего не висит.
 *
 * Вынесено из `VoiceChannelView.tsx` без браузерных зависимостей: таймеры инъекцией, как в
 * `streamCue.ts`, — чтобы правило проверялось тестом, а не глазами на живом канале.
 */

export interface WatchGraceDeps {
  /** Снять просмотр: показ так и не вернулся. */
  drop: (id: string) => void;
  /** Таймеры инъекцией — тест двигает время сам, ждать по-настоящему нечего. */
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  graceMs: number;
}

export interface WatchGrace {
  /**
   * Сверить намерение смотреть с тем, что реально идёт в канале. Вызывается на каждое изменение
   * любого из двух списков; повторный вызов с теми же данными ничего не меняет.
   *
   * @param watched кого человек открыл (намерение, живёт в сторе)
   * @param live чьи показы сейчас реально публикуются
   */
  reconcile: (watched: readonly string[], live: readonly string[]) => void;
  /** Уход со сцены: снять всё отложенное молча, никого не закрывая. */
  dispose: () => void;
}

export function createWatchGrace(deps: WatchGraceDeps): WatchGrace {
  // Ключ — участник: у одного человека показ ровно один, а разные люди пропадают и возвращаются
  // независимо, и путать их таймеры нельзя.
  const pending = new Map<string, number>();

  const cancel = (id: string) => {
    const t = pending.get(id);
    if (t === undefined) return;
    deps.clearTimer(t);
    pending.delete(id);
  };

  return {
    reconcile(watched, live) {
      const alive = new Set(live);
      for (const id of watched) {
        if (alive.has(id)) {
          cancel(id); // показ вернулся в грейс — отменяем снятие
        } else if (!pending.has(id)) {
          pending.set(
            id,
            deps.setTimer(() => {
              pending.delete(id);
              deps.drop(id);
            }, deps.graceMs),
          );
        }
      }
      // Человек закрыл показ сам — отложенное снятие уже ни к чему. Без этого таймер выстрелил бы
      // по снова открытому показу и закрыл бы его во второй раз.
      const stillWatched = new Set(watched);
      for (const id of [...pending.keys()]) {
        if (!stillWatched.has(id)) cancel(id);
      }
    },
    dispose() {
      for (const t of pending.values()) deps.clearTimer(t);
      pending.clear();
    },
  };
}
