/**
 * Ловушка фокуса для модального окна — и возврат фокуса туда, откуда его открыли.
 *
 * 🔴 **Повод (19.09).** Ни в одном окне приложения ловушки не было: Tab из открытого окна уводил
 * на страницу ПОД ним — в список каналов, в ленту, в поле ввода, — при том что окно продолжало
 * висеть сверху и перехватывать клики. Человек, работающий с клавиатуры, оказывался в интерфейсе,
 * которого не видит, и не мог ни подтвердить действие, ни вернуться. Это требование
 * WAI-ARIA Authoring Practices к диалогу: пока он открыт, Tab ходит только внутри него.
 *
 * ⚠️ **Возврат фокуса — половина приёма.** Закрыли окно — фокус обязан вернуться на ту кнопку, с
 * которой всё началось, иначе следующий Tab отправит человека в начало страницы, и он потеряет
 * место. Поэтому запоминаем активный элемент ДО открытия и возвращаем его при размонтировании.
 */
import { useEffect, type RefObject } from 'react';

/** Что вообще может получить фокус. Скрытое отсеиваем: у невидимой кнопки нет `offsetParent`. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const list = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null);

    // Первый фокус внутрь окна: иначе Tab начнёт обход со страницы под ним.
    const first = list()[0];
    if (first && !el.contains(document.activeElement)) first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = list();
      if (items.length === 0) return;
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      const cur = document.activeElement;
      const outside = !el.contains(cur);
      if (e.shiftKey ? cur === head || outside : cur === tail || outside) {
        e.preventDefault();
        (e.shiftKey ? tail : head).focus();
      }
    };

    // Перехват, а не всплытие: внутри окна свои обработчики Tab (списки, автодополнение).
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // ⚠️ Возвращаем фокус, только если он всё ещё внутри закрываемого окна: если человек за это
      // время ушёл мышью в другое место, дёргать его оттуда — грубее, чем ничего не делать.
      if (restoreTo && (!document.activeElement || el.contains(document.activeElement))) restoreTo.focus();
    };
  }, [ref, active]);
}
