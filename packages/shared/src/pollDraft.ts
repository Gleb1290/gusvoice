/**
 * Черновик опроса (#17) — правила, общие для формы и для роута.
 *
 * Раньше «подрезать пробелы, выкинуть пустые варианты, поймать повтор» считалось ДВАЖДЫ: в
 * `PollComposer.tsx` (чтобы не гасить кнопку зря) и в `POST /channels/:id/polls` (чтобы не верить
 * клиенту). Два одинаковых куска, которые обязаны совпадать до символа, — это заявка на то, что
 * форма разрешит отправить, а сервер откажет, и человек потеряет набранное.
 *
 * Теперь считает одна функция. Сервер всё равно проверяет сам — просто той же проверкой.
 */

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_QUESTION = 200;
export const POLL_MAX_OPTION_TEXT = 80;
/** Потолок срока — две недели; дальше опрос всё равно никто не дочитает. */
export const POLL_MAX_HOURS = 24 * 14;

export type PollDraftCheck =
  | { ok: true; question: string; options: string[] }
  | { ok: false; error: string };

/**
 * Привести черновик к тому виду, в котором он ляжет в базу: без крайних пробелов и без пустых
 * вариантов. Пустые выкидываем, а не считаем ошибкой: форма всегда показывает минимум два поля,
 * и человек, заполнивший три из четырёх, имел в виду именно три.
 */
export function normalizePollDraft(
  question: string,
  options: string[],
): { question: string; options: string[] } {
  return {
    question: question.trim(),
    options: options.map((t) => t.trim()).filter((t) => t !== ''),
  };
}

/**
 * Годится ли черновик к отправке. Тексты ошибок — те же, что уходят с сервера, чтобы форма и
 * ответ роута говорили одно и то же.
 */
export function checkPollDraft(question: string, options: string[]): PollDraftCheck {
  const draft = normalizePollDraft(question, options);

  if (!draft.question) return { ok: false, error: 'нужен вопрос' };
  if (draft.question.length > POLL_MAX_QUESTION) return { ok: false, error: 'слишком длинный вопрос' };
  if (draft.options.length < POLL_MIN_OPTIONS) return { ok: false, error: 'нужно минимум два варианта' };
  if (draft.options.length > POLL_MAX_OPTIONS) return { ok: false, error: 'слишком много вариантов' };
  if (draft.options.some((o) => o.length > POLL_MAX_OPTION_TEXT))
    return { ok: false, error: 'слишком длинный вариант' };
  // Одинаковые варианты — не запрет ради запрета, а защита от опечатки: два «Да» делают результат
  // бессмысленным, и автор этого не заметит, пока не станет поздно.
  if (new Set(draft.options.map((o) => o.toLowerCase())).size !== draft.options.length)
    return { ok: false, error: 'варианты повторяются' };

  return { ok: true, ...draft };
}
