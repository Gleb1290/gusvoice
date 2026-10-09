/**
 * Клавиши открытой ленты и поля ввода (07.10, G36 и G15 плана «телеграмности», #211). Чистые правила без DOM: что делает
 * клавиша при таком-то состоянии беседы. Подключение — `MessagePane.tsx` (поле ввода и слушатель окна ленты).
 * Источник — Telegram Desktop `history/history_widget.cpp`: `keyPressEvent`, `eventFilter`, `replyToPreviousMessage` /
 * `replyToNextMessage`, `escape`; `history/history_inner_widget.cpp`: `keyPressEvent` → `tryProcessKeyInput`. Одно правило
 * для бесед ЛС и текстовых каналов сервера: у Telegram оно одно для любой беседы.
 */

/** Ctrl+↑ / Ctrl+↓ (без Shift, Alt и ⌘) — ответ на предыдущее / следующее сообщение. `null` — не эта клавиша. */
export function replyNavKey(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): 'prev' | 'next' | null {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return null;
  if (e.key === 'ArrowUp') return 'prev';
  if (e.key === 'ArrowDown') return 'next';
  return null;
}

/**
 * Ctrl+O (без Shift, Alt и ⌘) — «прикрепить файл» (Telegram Desktop: `HistoryWidget::keyPressEvent` и
 * `ComposeControls` → `chooseAttach`, `history_view_list_widget.cpp`: Ctrl+O из ленты тоже). Буква — по физической
 * клавише (`code`), чтобы работало и в русской раскладке, где `key` = «щ».
 */
export function attachKey(e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): boolean {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return false;
  return e.code === 'KeyO' || e.key === 'o' || e.key === 'O';
}

/**
 * Куда ведёт Ctrl+↑ / Ctrl+↓ по ленте `order` (id сообщений сверху вниз), когда ответ сейчас на `current` (или его нет):
 * - `prev`: ответ стоит на сообщении ленты — на сообщение выше (выше нет — `null`, ничего не делаем); ответа нет или его
 *   сообщения в ленте нет — на последнее сообщение ленты;
 * - `next`: на сообщение ниже; ответ уже на последнем — `cancel` (снять ответ и подсветку, как у Telegram); ответа нет или
 *   его сообщения в ленте нет — `null`.
 * Возвращает `{ reply: id }`, `'cancel'` или `null` (клавиша ничего не делает и не перехватывается).
 */
export function replyNavTarget(
  order: readonly string[],
  current: string | null | undefined,
  dir: 'prev' | 'next',
): { reply: string } | 'cancel' | null {
  if (order.length === 0) return null;
  const at = current ? order.indexOf(current) : -1;
  if (dir === 'prev') {
    if (at < 0) return { reply: order[order.length - 1] };
    return at > 0 ? { reply: order[at - 1] } : null;
  }
  if (at < 0) return null;
  return at < order.length - 1 ? { reply: order[at + 1] } : 'cancel';
}

/**
 * Стрелки и PgUp/PgDn в поле ввода (Telegram Desktop: поле не съело клавишу — её получает беседа):
 * - `edit-last` — ↑ в пустом поле без ответа и правки: править своё последнее;
 * - `line-up` / `line-down` — ↑ с кареткой в самом начале поля (↓ — в самом конце) листают ленту на строку: дальше поле
 *   каретку не двинет; пустое поле — то же самое (↑ — когда править нечего);
 * - `page-up` / `page-down` — PgUp / PgDn из поля всегда листают ленту на экран;
 * - `null` — клавиша остаётся полю (двигает каретку) или не наша.
 * Любой модификатор, кроме отсутствия, — не наше (Ctrl+стрелки — ответ, Alt — соседняя беседа, Shift — выделение текста).
 */
export function fieldKeyAction(p: {
  key: string;
  mods: boolean;
  composing: boolean;
  value: string;
  selStart: number;
  selEnd: number;
  replying: boolean;
  editing: boolean;
  hasOwnEditable: boolean;
}): 'edit-last' | 'line-up' | 'line-down' | 'page-up' | 'page-down' | null {
  if (p.mods || p.composing) return null;
  if (p.key === 'PageUp') return 'page-up';
  if (p.key === 'PageDown') return 'page-down';
  const collapsed = p.selStart === p.selEnd;
  if (p.key === 'ArrowUp') {
    if (p.value === '' && !p.replying && !p.editing && p.hasOwnEditable) return 'edit-last';
    return collapsed && p.selStart === 0 ? 'line-up' : null;
  }
  if (p.key === 'ArrowDown') return collapsed && p.selEnd >= p.value.length ? 'line-down' : null;
  return null;
}

/**
 * Печатный знак, набранный мимо поля (фокус в ленте или нигде), уходит в поле ввода (Telegram Desktop
 * `HistoryInner::keyPressEvent` → `HistoryWidget::tryProcessKeyInput`): один знак, без Ctrl / Alt / ⌘ (Shift можно).
 */
export function isTypingKey(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return false;
  return [...e.key].length === 1;
}

/** Слой, который снимает Esc в открытой беседе. */
export type ChatEscape = 'selection' | 'edit' | 'ask-edit' | 'forward' | 'reply' | 'voice' | 'close' | 'none';

/**
 * Порядок Esc в открытой беседе — как `HistoryWidget::escape` Telegram Desktop (меню, окна и подсказки поля закрываются
 * своими обработчиками раньше — у Telegram они перехватывают Esc до беседы):
 * выделение сообщений → правка (текст менялся — вопрос) → черновик пересылки (08.10, `forwarding`; Telegram
 * `cancelForwarding`, текст поля остаётся) → ответ (только при ПУСТОМ поле) → запись голосового (вопрос «Отменить
 * запись?») → закрыть беседу (`canClose`: на ПК в ЛС; иначе ничего). Инлайн-бота и поиска в беседе у нас нет — их шагов нет.
 */
export function chatEscape(p: {
  selecting: boolean;
  editing: boolean;
  draft: string;
  original: string;
  replying: boolean;
  recording: boolean;
  canClose: boolean;
  /** Над полем полоса черновика пересылки (`fwdDrafts`). Нет поля — как `false` (прежние вызовы). */
  forwarding?: boolean;
}): ChatEscape {
  if (p.selecting) return 'selection';
  if (p.editing) return p.draft.trim() === p.original.trim() ? 'edit' : 'ask-edit';
  if (p.forwarding) return 'forward';
  if (p.replying && p.draft.trim() === '') return 'reply';
  if (p.recording) return 'voice';
  return p.canClose ? 'close' : 'none';
}
