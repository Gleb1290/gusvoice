/**
 * «Подсказывать эмодзи» (G53, Telegram Desktop «Настройки чатов → Подсказывать замену эмодзи», `suggestEmoji`; по умолчанию
 * включено): полоса эмодзи над полем ввода — по `:слову` и по слову целиком в начале пустого поля (`messagePaneRules.acExactAt`).
 * Выключено — ни то, ни другое не показывается; `:код:` с закрывающим двоеточием заменяется как раньше (это не подсказка).
 * Настройка этого устройства (localStorage), аккаунт не синкает: у Telegram она тоже локальная. Переключатель — «Настройки →
 * Вид → Подсказки эмодзи» (`UserSettingsModal.tsx`).
 */
const KEY = 'gv_emoji_suggest';

export const EMOJI_SUGGEST_DEFAULT = true;

export function emojiSuggestEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return EMOJI_SUGGEST_DEFAULT;
  }
}

export function setEmojiSuggestEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* хранилище недоступно — остаётся значение по умолчанию */
  }
}
