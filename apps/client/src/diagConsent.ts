/**
 * Согласие человека на сбор диагностики (#113).
 *
 * 🔴 Два РАЗНЫХ разрешения, и путать их нельзя:
 *  * **инстанс** — собирает ли этот сервер вообще (`config.diagEnabled`, приезжает из его
 *    `/config.js`); у самохостера выключено, и тогда спрашивать человека не о чем;
 *  * **человек** — согласился ли он лично на своей машине.
 *
 * Сбор идёт, только когда сошлись оба. Умолчание у обоих — «нет»: диагностика полезна нам, а
 * рискует человек, поэтому направление ошибки должно быть в его пользу.
 *
 * ⚠️ «Выключено» означает НЕ СОБИРАЕМ, а не «собираем и не отправляем». Разница не формальная:
 * счётчики читаются через нативные вызовы, и человек, снявший галочку, вправе рассчитывать, что
 * приложение перестанет лазить в его систему, а не просто складывает результаты в стол.
 */

export type DiagConsent = 'unknown' | 'yes' | 'no';

/** Что делать прямо сейчас. `ask` — показать окно согласия, `off` — молчать и не спрашивать. */
export type DiagDecision = 'collect' | 'ask' | 'off';

const KEY = 'gv_diag_consent';

/**
 * Решение по двум разрешениям.
 *
 * ⚠️ Выключенный ИНСТАНС гасит всё, включая вопрос: спрашивать «можно ли собирать», когда собирать
 * всё равно некуда, — значит пугать человека без повода и приучать его отмахиваться от вопросов.
 */
export function diagDecision(instanceEnabled: boolean, consent: DiagConsent): DiagDecision {
  if (!instanceEnabled) return 'off';
  if (consent === 'yes') return 'collect';
  if (consent === 'no') return 'off';
  return 'ask';
}

/** Ответ человека на этой машине. Недоступное хранилище читается как «не спрашивали». */
export function getDiagConsent(): DiagConsent {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'yes' || v === 'no' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function setDiagConsent(v: DiagConsent): void {
  try {
    if (v === 'unknown') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* приватный режим / хранилище недоступно — переживём, просто спросим снова */
  }
}
