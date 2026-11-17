import { playSound } from './sounds';
import { useStore } from './store';

/**
 * Чайка «Новое событие» (29.10, `predictionOpen`): звучит вместе с тостом-полкой «Новое событие · Смотреть» — ровно
 * тем, кому его показывают. Кому показывать, решает `sockets.ts` (`prediction.state`: сидящим в голосе сервера, не
 * создателю, ≤ 1 тоста на событие, свежее и не из снимка); здесь только звук на ПОЯВЛЕНИЕ нового тоста в сторе.
 *
 * ⚠️ Почему не в `sockets.ts` рядом с тостом: там закреплено «новое событие без звука» (тест R338 `sockets.predictions`),
 * а звук на появлении тоста и так точно повторяет его правила. Повтор того же тоста (тот же `id`) — тишина, снимок на
 * `ready` тосты не кладёт — переподключение не звучит. Глухота (`selfDeafened`) — тишина, как у остальных игр.
 */
export function installPredictionOpenSound(): () => void {
  return useStore.subscribe((s, prev) => {
    const t = s.predictionToast;
    if (!t || t.kind !== 'new' || t.id === prev.predictionToast?.id) return;
    if (!s.selfDeafened) playSound('predictionOpen');
  });
}
