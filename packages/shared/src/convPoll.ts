/**
 * Опрос в ЛС (14.10, признак сервера `convpoll1`) — третий вид сообщения `ConvMessage.media` (`kind: 'poll'`, рядом с
 * геопозицией и контактом, `convMedia.ts`). Правила — чистые, общие для сервера (подсчёт, проверка голоса) и клиента (форма,
 * карточка): форма и сервер обязаны соглашаться до символа (урок опросов каналов, `pollDraft.ts`).
 *
 * Поведение — как у Telegram (код не копируется): создание — Android `PollCreateActivity` / `ChatAttachAlertPollLayout`
 * (вопрос до 255, вариант до 100, пояснение викторины до 200, «Анонимное голосование» включено по умолчанию, «Несколько
 * ответов», «Викторина» — один правильный ответ, с несколькими ответами не сочетается), Desktop `CreatePollBox`; голос и итоги —
 * Android `ChatMessageCell` (опрос), Desktop `history_view_poll.cpp`, Web K `poll.ts`: итоги скрыты до своего голоса (или до
 * закрытия), «Отменить голос» (`Unvote`; у викторины — нет), «Остановить опрос» — только автор, навсегда (`StopPoll`),
 * «Посмотреть голоса» у неанонимного (`PollVotesAlert`).
 *
 * ⚠️ В отличие от опросов каналов (#17, «переголосовать нельзя») — правила Telegram: голос можно отменить и отдать заново.
 *
 * Хранение: определение опроса лежит в `conversation_messages.media` (та же форма с нулевыми итогами, правильным ответом и
 * пояснением); голоса — строками `conv_poll_votes` (миграция 0147). Клиенту уходит ВИД глазами смотрящего (`convPollView`):
 * до своего голоса — нули, без правильного ответа и пояснения; спрятать отданное в клиенте — не тайна.
 */

export const CONV_POLL_LIMITS = { question: 255, option: 100, solution: 200, minOptions: 2, maxOptions: 10 } as const;

/** Вариант: `id` — номер строкой («0»…«9», как байты вариантов Telegram), `votes` — голосов глазами смотрящего (скрыто — 0). */
export interface ConvPollOption {
  id: string;
  text: string;
  votes: number;
}

export interface ConvPollMedia {
  kind: 'poll';
  question: string;
  options: ConvPollOption[];
  anonymous: boolean;
  multi: boolean;
  quiz: boolean;
  /** Автор остановил опрос: голосовать нельзя, итоги открыты всем. */
  closed: boolean;
  /** Сколько ЛЮДЕЙ проголосовало (видно всегда — распределения не раскрывает). */
  voters: number;
  /** Мои варианты; пусто — не голосовал. */
  my: string[];
  /** Итоги открыты смотрящему (проголосовал или опрос закрыт). */
  revealed: boolean;
  /** Викторина: правильный вариант — только когда итоги открыты (в хранимой форме — всегда). */
  correct?: string | null;
  /** Викторина: пояснение — как `correct`. */
  solution?: string | null;
}

/** Тело `media` в отправке опроса (`POST /api/conv/:id/messages`, `convpoll1`). */
export interface ConvPollInput {
  kind: 'poll';
  question: string;
  options: string[];
  anonymous?: boolean;
  multi?: boolean;
  quiz?: boolean;
  /** Викторина: номер правильного варианта в `options` (после выброса пустых — см. `convPollDraft`). */
  correct?: number | null;
  solution?: string | null;
}

export type ConvPollDraftCheck = { ok: true; poll: ConvPollMedia } | { ok: false; error: string };

/**
 * Черновик → хранимый опрос. Пустые варианты выкидываются (форма держит лишнее пустое поле, как Telegram), номер правильного
 * считается по ПРИСЛАННОМУ списку и переносится на оставшиеся. Тексты ошибок общие для формы и сервера.
 */
export function convPollDraft(input: ConvPollInput): ConvPollDraftCheck {
  const question = (typeof input.question === 'string' ? input.question : '').trim();
  if (!question) return { ok: false, error: 'нужен вопрос' };
  if (question.length > CONV_POLL_LIMITS.question) return { ok: false, error: 'слишком длинный вопрос' };
  const raw = Array.isArray(input.options) ? input.options : [];
  const kept: { text: string; from: number }[] = [];
  raw.forEach((t, i) => {
    const text = typeof t === 'string' ? t.trim() : '';
    if (text) kept.push({ text, from: i });
  });
  if (kept.length < CONV_POLL_LIMITS.minOptions) return { ok: false, error: 'нужно минимум два варианта' };
  if (kept.length > CONV_POLL_LIMITS.maxOptions) return { ok: false, error: 'слишком много вариантов' };
  if (kept.some((o) => o.text.length > CONV_POLL_LIMITS.option)) return { ok: false, error: 'слишком длинный вариант' };
  if (new Set(kept.map((o) => o.text.toLowerCase())).size !== kept.length) return { ok: false, error: 'варианты повторяются' };
  const quiz = input.quiz === true;
  // Викторина — один правильный ответ: «Несколько ответов» с ней не сочетается (Telegram выключает переключатель).
  const multi = !quiz && input.multi === true;
  let correct: string | null = null;
  let solution: string | null = null;
  if (quiz) {
    const at = typeof input.correct === 'number' ? kept.findIndex((o) => o.from === input.correct) : -1;
    if (at < 0) return { ok: false, error: 'выберите правильный ответ' };
    correct = String(at);
    const s = typeof input.solution === 'string' ? input.solution.trim() : '';
    if (s.length > CONV_POLL_LIMITS.solution) return { ok: false, error: 'слишком длинное пояснение' };
    solution = s || null;
  }
  return {
    ok: true,
    poll: {
      kind: 'poll',
      question,
      options: kept.map((o, i) => ({ id: String(i), text: o.text, votes: 0 })),
      // Анонимное по умолчанию (Telegram `PollAnonymous` включён): раскрытие обратной дороги не имеет.
      anonymous: input.anonymous !== false,
      multi,
      quiz,
      closed: false,
      voters: 0,
      my: [],
      revealed: false,
      ...(quiz ? { correct, solution } : {}),
    },
  };
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Разобрать опрос (строка базы или DTO): битое — `null` (покажется запасной `content`). Итоги и `my` необязательны (в хранимой
 * форме нули), лишнее отбрасывается.
 */
export function parseConvPoll(r: Record<string, unknown>): ConvPollMedia | null {
  const question = str(r.question, CONV_POLL_LIMITS.question);
  if (!question || !Array.isArray(r.options)) return null;
  const options: ConvPollOption[] = [];
  for (const o of r.options as unknown[]) {
    if (!o || typeof o !== 'object') return null;
    const x = o as Record<string, unknown>;
    const id = str(x.id, 8);
    const text = str(x.text, CONV_POLL_LIMITS.option);
    if (!id || !text) return null;
    options.push({ id, text, votes: count(x.votes) });
  }
  if (options.length < CONV_POLL_LIMITS.minOptions || options.length > CONV_POLL_LIMITS.maxOptions) return null;
  const ids = new Set(options.map((o) => o.id));
  if (ids.size !== options.length) return null;
  const quiz = r.quiz === true;
  const correct = typeof r.correct === 'string' && ids.has(r.correct) ? r.correct : null;
  const solution = str(r.solution, CONV_POLL_LIMITS.solution);
  return {
    kind: 'poll',
    question,
    options,
    anonymous: r.anonymous !== false,
    multi: !quiz && r.multi === true,
    quiz,
    closed: r.closed === true,
    voters: count(r.voters),
    my: Array.isArray(r.my) ? (r.my as unknown[]).filter((x): x is string => typeof x === 'string' && ids.has(x)) : [],
    revealed: r.revealed === true,
    ...(quiz && (correct || solution) ? { correct, solution } : {}),
  };
}

/**
 * Опрос глазами смотрящего: голоса считаются здесь (строки `conv_poll_votes`), итоги и правильный ответ — только если открыты
 * (свой голос или опрос закрыт). `voters` — ЛЮДИ, не строки: при нескольких ответах один человек даёт несколько голосов.
 */
export function convPollView(stored: ConvPollMedia, votes: readonly { userId: string; optionId: string }[], viewerId: string): ConvPollMedia {
  const known = new Set(stored.options.map((o) => o.id));
  const valid = votes.filter((v) => known.has(v.optionId));
  const my = stored.options.filter((o) => valid.some((v) => v.userId === viewerId && v.optionId === o.id)).map((o) => o.id);
  const revealed = my.length > 0 || stored.closed;
  const base: ConvPollMedia = {
    kind: 'poll',
    question: stored.question,
    options: stored.options.map((o) => ({ id: o.id, text: o.text, votes: revealed ? valid.filter((v) => v.optionId === o.id).length : 0 })),
    anonymous: stored.anonymous,
    multi: stored.multi,
    quiz: stored.quiz,
    closed: stored.closed,
    voters: new Set(valid.map((v) => v.userId)).size,
    my,
    revealed,
  };
  return stored.quiz && revealed ? { ...base, correct: stored.correct ?? null, solution: stored.solution ?? null } : base;
}

export type ConvPollVoteCheck = { ok: true } | { ok: false; error: string; code: 400 | 403 };

/**
 * Можно ли принять голос (`optionIds`) или его отмену (пустой список). Как у Telegram: закрытый — нельзя; повтор голоса без
 * отмены — нельзя (сначала «Отменить голос»); у викторины ответ окончательный — отменить нельзя.
 */
export function checkConvPollVote(poll: Pick<ConvPollMedia, 'options' | 'multi' | 'quiz' | 'closed'>, mine: readonly string[], optionIds: readonly string[]): ConvPollVoteCheck {
  if (poll.closed) return { ok: false, error: 'опрос закрыт', code: 403 };
  if (optionIds.length === 0) {
    if (mine.length === 0) return { ok: false, error: 'вы ещё не голосовали', code: 400 };
    if (poll.quiz) return { ok: false, error: 'ответ в викторине отменить нельзя', code: 403 };
    return { ok: true };
  }
  if (mine.length > 0) return { ok: false, error: 'вы уже проголосовали', code: 400 };
  if (new Set(optionIds).size !== optionIds.length) return { ok: false, error: 'вариант повторяется', code: 400 };
  if (!poll.multi && optionIds.length > 1) return { ok: false, error: 'в этом опросе можно выбрать только один вариант', code: 400 };
  const known = new Set(poll.options.map((o) => o.id));
  if (optionIds.some((id) => !known.has(id))) return { ok: false, error: 'нет такого варианта', code: 400 };
  return { ok: true };
}

/** Доля варианта в процентах от ГОЛОСОВ (сумма — 100 и при нескольких ответах), округление как у Telegram — до целого. */
export function convPollPercents(options: readonly ConvPollOption[]): number[] {
  const total = options.reduce((s, o) => s + o.votes, 0);
  if (total === 0) return options.map(() => 0);
  // Наибольшие остатки: сумма ровно 100 (Telegram `MessageObject` / Web K `poll.ts` выравнивают так же).
  const exact = options.map((o) => (o.votes * 100) / total);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (const { i } of order) {
    if (left <= 0) break;
    if (options[i]!.votes === 0) continue;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** «Опрос: вопрос» — подпись в списке бесед, цитате, закрепе и пуше (Telegram «📊 Poll: …» / Web K `messageMediaPoll`). */
export function convPollPreview(p: Pick<ConvPollMedia, 'question' | 'quiz'>): string {
  return `${p.quiz ? 'Викторина' : 'Опрос'}: ${p.question}`;
}

/** Запасной текст (`content`) для клиента и соседа без опросов: вопрос и варианты списком. */
export function convPollFallback(p: Pick<ConvPollMedia, 'question' | 'quiz' | 'options'>): string {
  return [`📊 ${convPollPreview(p)}`, ...p.options.map((o) => `— ${o.text}`)].join('\n');
}

/** «Нет голосов» / «1 голос» / «5 голосов» (у викторины — «ответ/ответа/ответов»). */
export function convPollVotersText(n: number, quiz: boolean): string {
  if (n === 0) return quiz ? 'Нет ответов' : 'Нет голосов';
  const m10 = n % 10;
  const m100 = n % 100;
  const form = m10 === 1 && m100 !== 11 ? 0 : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 1 : 2;
  const words = quiz ? ['ответ', 'ответа', 'ответов'] : ['голос', 'голоса', 'голосов'];
  return `${n} ${words[form]}`;
}

/** Ответ `GET /api/conv/:id/messages/:mid/poll/voters` (`convpoll1`): по вариантам — кто голосовал, по порядку голосования. */
export interface ConvPollVotersResponse {
  options: { optionId: string; voters: { id: string; displayName: string; username: string; avatarUrl: string | null }[] }[];
}
