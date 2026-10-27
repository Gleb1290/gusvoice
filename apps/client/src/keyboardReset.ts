/**
 * Сброс состояния клавиатуры телефона после отправки (приёмка 25.10: «Caps Lock остаётся после отправки»).
 *
 * Поле ввода очищается программно (`value = ''`), и экранная клавиатура этого не замечает: Shift и Caps Lock остаются, как
 * были. Telegram Android после отправки отдаёт клавиатуре поле заново (`InputMethodManager.restartInput`) — Gboard
 * сбрасывает Caps Lock и снова ставит заглавную первую букву. В WebView/Chrome то же делает сам браузер, когда у
 * сфокусированного поля меняются флаги ввода (`ImeAdapterImpl.updateState`: другой `autocapitalize` → `restartInput`):
 * переключаем `autocapitalize` на один кадр и возвращаем как было. Клавиатура при этом не закрывается.
 *
 * Только на сенсорных устройствах и только у поля в фокусе: на ПК клавиатуры на экране нет, а без фокуса нечего сбрасывать.
 */

type Field = Pick<HTMLElement, 'getAttribute' | 'setAttribute' | 'removeAttribute'> & { ownerDocument: Document | null };

export function resetKeyboardShift(
  el: Field | null | undefined,
  env: { touch: boolean; nextFrame: (fn: () => void) => void } = {
    touch: typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches,
    nextFrame: (fn) => requestAnimationFrame(() => fn()),
  },
): void {
  if (!el || !env.touch) return;
  if (el.ownerDocument?.activeElement !== (el as unknown)) return;
  const prev = el.getAttribute('autocapitalize');
  el.setAttribute('autocapitalize', prev === 'off' ? 'sentences' : 'off');
  env.nextFrame(() => {
    if (prev === null) el.removeAttribute('autocapitalize');
    else el.setAttribute('autocapitalize', prev);
  });
}
