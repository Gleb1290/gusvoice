import { useEffect, useState } from 'react';
import { isMobile, isTauri } from './hotkeys';

/**
 * Раскладка телефона — та же граница, что у мобильных стилей (`@media (max-width: 760px)` в `styles.css`). Разметка,
 * которая отличается на телефоне (раунд 11: строка беседы 48 / 40 px, поле поиска, «Написать» плавающей кнопкой или в
 * шапке), берёт её отсюда, а не из `isMobile()`: тот истинен только в приложении на телефоне, и узкое окно браузера
 * получало бы разметку компьютера внутри мобильных стилей (ПК-кнопка без стилей, аватар 40 в строке 68).
 */
export const PHONE_LAYOUT_QUERY = '(max-width: 760px)';

/**
 * Закреп телефонной раскладки (19.10): полноэкранный просмотр фото/видео в приложении на телефоне снимает закреп портрета
 * (`viewerRotation.ts`), а в альбомной окно шире 760 px. Без закрепа раскладка под просмотром переключилась бы на
 * компьютерную — другое дерево компонентов, и просмотр вместе с лентой размонтировался бы посреди поворота.
 */
let pinned = false;
const pinWatchers = new Set<() => void>();

/** Держать телефонную раскладку независимо от ширины окна (`true`) или снова следовать ширине (`false`). */
export function setPhoneLayoutPin(on: boolean): void {
  if (pinned === on) return;
  pinned = on;
  for (const watch of Array.from(pinWatchers)) watch();
}

function phoneNow(): boolean {
  return pinned || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_LAYOUT_QUERY).matches);
}

/** Сейчас раскладка телефона? Перерисовывает при смене ширины окна (поворот, окно уже 760 px). */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(phoneNow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_LAYOUT_QUERY);
    const on = () => setPhone(pinned || mq.matches);
    on();
    mq.addEventListener('change', on);
    pinWatchers.add(on);
    return () => {
      mq.removeEventListener('change', on);
      pinWatchers.delete(on);
    };
  }, []);
  return phone;
}

/**
 * Телефонный вид настроек и подписей: приложение на телефоне (`isMobile()`) ИЛИ телефонная раскладка в браузере. Браузер
 * без Tauri — потому что окно настольного приложения, ужатое до 760 px, остаётся компьютером (клавиши, мышь, трей есть),
 * а вот вкладка телефона — нет: там нет ни наведения, ни горячих клавиш, ни «окна не в фокусе» (раньше на ней жили подписи
 * для ПК, потому что `isMobile()` в браузере всегда ложь).
 */
export function isPhoneUiNow(): boolean {
  return isMobile() || (!isTauri() && phoneNow());
}

/** То же, что `isPhoneUiNow`, но перерисовывает при смене ширины окна. */
export function usePhoneUi(): boolean {
  const phone = usePhoneLayout();
  return isMobile() || (!isTauri() && phone);
}
