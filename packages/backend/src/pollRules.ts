import type { Poll } from '@gusvoice/shared';

/**
 * Правила опросов — чистые, БЕЗ импорта базы.
 *
 * Отдельным файлом уже по привычке: это третий случай подряд (после `ogParse.ts` и `afkRules.ts`
 * на клиенте), когда логика, замешанная в модуле с `db`, оказывается непроверяемой — тест падает
 * на «Missing required env var: DATABASE_URL» ещё до первой проверки.
 *
 * Правило: считает — значит живёт отдельно от того, что ходит в базу.
 */

// Лимиты и правила ЧЕРНОВИКА (длины, пустые и повторяющиеся варианты) живут в
// `@gusvoice/shared` → `pollDraft.ts`: их считает и форма создания опроса, и этот роут, и
// расходиться им нельзя. Здесь остаётся то, что нужно только серверу: подсчёт и приём голоса.

export function pollClosed(closesAt: Date | null): boolean {
  return closesAt !== null && closesAt.getTime() <= Date.now();
}

/**
 * Видны ли результаты. Скрыты до собственного голоса ВСЕГДА — иначе первые голоса тянут за собой
 * остальные («трое выбрали второй, ну и я»). После закрытия открываем всем, включая не
 * голосовавших: скрывать итог завершённого опроса незачем.
 *
 * ⚠️ Решается на СЕРВЕРЕ, а не рисованием в клиенте: спрятанные, но отданные числа — не тайна.
 */
export function resultsVisible(hasVoted: boolean, closed: boolean): boolean {
  return hasVoted || closed;
}

/**
 * Свести варианты и голоса в то, что уходит клиенту.
 *
 * `voters` считает ЛЮДЕЙ, а не строки: при мультивыборе один человек даёт несколько голосов, и
 * «проголосовало 7» при пяти участниках выглядело бы как ошибка. Общее число не скрываем даже до
 * голоса — оно не раскрывает, кто что выбрал.
 *
 * Когда результаты скрыты, счётчики уходят НУЛЯМИ: клиент их получать не должен вовсе.
 */
export function tally(
  poll: {
    question: string;
    options: { id: string; text: string }[];
    multi: boolean;
    anonymous: boolean;
    closesAt: Date | null;
  },
  votes: { userId: string; optionId: string }[],
  viewerId: string,
): Poll {
  const myVotes = votes.filter((v) => v.userId === viewerId).map((v) => v.optionId);
  const closed = pollClosed(poll.closesAt);
  const revealed = resultsVisible(myVotes.length > 0, closed);
  return {
    question: poll.question,
    options: poll.options.map((o) => ({
      id: o.id,
      text: o.text,
      votes: revealed ? votes.filter((v) => v.optionId === o.id).length : 0,
    })),
    multi: poll.multi,
    anonymous: poll.anonymous,
    closesAt: poll.closesAt ? poll.closesAt.toISOString() : null,
    myVotes,
    voters: new Set(votes.map((v) => v.userId)).size,
    revealed,
    closed,
  };
}

export type VoteCheck = { ok: true } | { ok: false; error: string };

/**
 * Можно ли принять этот голос.
 *
 * **Переголосовать нельзя** — намеренно: опрос, в котором можно передумать, превращается в гонку
 * «кто нажал последним», а в маленьком чате ещё и в способ подогнать итог. Первый голос
 * окончательный, и человека предупреждают об этом ДО нажатия.
 */
export function checkVote(
  poll: { options: { id: string }[]; multi: boolean; closesAt: Date | null },
  alreadyVoted: boolean,
  optionIds: string[],
): VoteCheck {
  if (pollClosed(poll.closesAt)) return { ok: false, error: 'опрос уже закрыт' };
  if (alreadyVoted) return { ok: false, error: 'вы уже проголосовали, переголосовать нельзя' };
  if (optionIds.length === 0) return { ok: false, error: 'нужно выбрать вариант' };
  if (new Set(optionIds).size !== optionIds.length) return { ok: false, error: 'вариант повторяется' };
  if (!poll.multi && optionIds.length > 1)
    return { ok: false, error: 'в этом опросе можно выбрать только один вариант' };
  const known = new Set(poll.options.map((o) => o.id));
  if (optionIds.some((id) => !known.has(id))) return { ok: false, error: 'нет такого варианта' };
  return { ok: true };
}
