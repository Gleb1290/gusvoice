/**
 * Кнопки «@» и «♥» над «вниз» (G24 темы 14 плейбука, #211, волна 5; признак сервера `reactunread1`) — ЧИСТЫЕ правила.
 *
 * Источники (Telegram): tdesktop `history/view/history_view_corner_buttons.cpp` (`CornerButtons`: «вниз», упоминания,
 * реакции — колонка справа, порядок снизу вверх: вниз → «@» → «♥»; кнопка видна, пока счётчик больше нуля; клик по «♥» —
 * к самому старому непрочитанному `unreadReactions().minLoaded()`; ПКМ — «Прочитать все реакции», `SendMenu::SetupUnreadReactionsMenu`),
 * `history/history_item.cpp` (`markReactionsRead`: реакция читается, когда сообщение показано на экране при активном окне),
 * `dialogs/ui/dialogs_layout.cpp` (строка списка: значок реакции / упоминания в кружке акцентного цвета рядом со счётчиком),
 * Web A `components/middle/FloatingActionButtons.tsx`, Android `ui/ChatActivity.java` (`mentiondownButton`,
 * `reactionsMentiondownButton`). Упоминания «@» в беседе 1:1 у Telegram НЕ работают (`trackMentions` — только группы и каналы):
 * у нас счётчик зарезервирован под групповые беседы (`ConvSummary.unreadMentions`), для 1:1 кнопка не рисуется.
 */

/** Сколько показываем в кружке, больше — «999+» (Telegram `Ui::UnreadBadge` режет по тысяче). */
export const CORNER_COUNT_MAX = 999;
/** Сообщение с непрочитанной реакцией читается, когда пробыло на экране столько (дребезг прокрутки не читает). */
export const REACTION_SEEN_DELAY_MS = 600;
/** Доля сообщения на экране, с которой оно считается показанным. */
export const REACTION_SEEN_RATIO = 0.6;

export type CornerKind = 'mentions' | 'reactions';

export interface CornerButtonView {
  kind: CornerKind;
  count: number;
  /** Текст на кружке. */
  label: string;
  /** Подпись для скринридера и подсказка. */
  title: string;
}

export function cornerCountLabel(n: number): string {
  return n > CORNER_COUNT_MAX ? `${CORNER_COUNT_MAX}+` : String(n);
}

/**
 * Какие кнопки рисовать, СНИЗУ ВВЕРХ (первая — ближе к «вниз»): «@», потом «♥». Нулевые и нечисловые счётчики — нет кнопки.
 * `reactions` — число сообщений с непрочитанными реакциями (`ConvSummary.unreadReactions`).
 */
export function cornerButtons(counts: { mentions?: number; reactions?: number }): CornerButtonView[] {
  const out: CornerButtonView[] = [];
  const m = counts.mentions;
  if (typeof m === 'number' && m > 0)
    out.push({ kind: 'mentions', count: m, label: cornerCountLabel(m), title: `Непрочитанные упоминания: ${m}` });
  const r = counts.reactions;
  if (typeof r === 'number' && r > 0)
    out.push({ kind: 'reactions', count: r, label: cornerCountLabel(r), title: `Непрочитанные реакции: ${r}` });
  return out;
}

/** Значки строки списка: упоминание и реакция (Telegram: кружки слева от счётчика). */
export function rowMarks(d: { unreadReactions?: number; unreadMentions?: number }): { mentions: boolean; reactions: boolean } {
  return { mentions: (d.unreadMentions ?? 0) > 0, reactions: (d.unreadReactions ?? 0) > 0 };
}

/**
 * Какие из показанных сообщений гасить: те, что сейчас видны (`visible`) и у которых реакция ещё непрочитана (`unread`).
 * Порядок — как в ленте (`unread`), повторов нет.
 */
export function reactionsToMark(unread: readonly string[], visible: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of unread) {
    if (visible.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
