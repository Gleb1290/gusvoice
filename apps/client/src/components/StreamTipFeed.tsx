import { useNameResolver } from '../memberName';
import { useStore } from '../store';
import { TIP_HINT_STACK } from '../tipHints';

/**
 * Плашка «кто кого типнул» в углу просмотрщика стрима (запрос 04.09).
 *
 * 🔴 **Зачем отдельная поверхность.** Обычные подсказки висят на строке получателя в списке канала —
 * получателя там задаёт МЕСТО, поэтому в тексте достаточно отправителя. Но при открытом стриме
 * списка на экране нет вовсе, и подсказкам буквально негде появиться: жест происходит, а канал о нём
 * не узнаёт. Здесь места для строки нет, поэтому пишем обоих: «Маша → Петя».
 *
 * ⚠️ Живёт на ТЕХ ЖЕ данных и с тем же временем жизни, что и подсказки в сайдбаре (`store.tipHints`,
 * уборка по `TIP_HINT_MS`). Заводить второй список значило бы завести вторую правду о том же
 * событии — и однажды они разойдутся.
 * ⚠️ Верхний ПРАВЫЙ угол: снизу панель управления показом, сверху слева — название и зрители.
 */
export function StreamTipFeed() {
  const hints = useStore((s) => s.tipHints);
  const nameOf = useNameResolver();
  if (hints.length === 0) return null;
  // Свежие сверху и не больше стопки: полноэкранный показ — не место для башни подписей.
  const shown = hints.slice(-TIP_HINT_STACK).reverse();
  return (
    <div className="stf" aria-live="polite">
      {shown.map((h) => (
        <div className="stf-row" key={h.id}>
          <span className="stf-from">{nameOf(h.fromUserId, h.fromName)}</span>
          <span className="stf-arrow" aria-hidden>
            →
          </span>
          <span className="stf-to">{nameOf(h.toUserId, 'кому-то')}</span>
          <span className="stf-amount">+{h.amount}</span>
        </div>
      ))}
    </div>
  );
}
