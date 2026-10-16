/**
 * Вид сцены голосового канала (#221, 16.10, решения владельца): режимы как в Google Meet — Авто / Сетка /
 * Фокус / Сбоку / Говорящий. Один выбор на человека и устройство, действует во ВСЕХ голосовых каналах
 * (`stageLayoutPrefs.ts`, хранится так же, как «Скрыть участников без видео»). Здесь только чистые правила:
 * какие режимы доступны, во что превращается сохранённый выбор на телефоне, кого и когда показать крупно.
 *
 * - `auto` — как было: сетка «под окно», открыл показ — крупно показ(ы) и полосы снизу.
 * - `grid` — все плитки равные, даже когда показы есть; клик по показу ведёт в «Фокус» на нём.
 * - `focus` — один крупно (выбранный показ/камера) + полосы остальных снизу.
 * - `side` — крупно + колонка остальных справа (широкие мониторы).
 * - `speaker` — крупно тот, кто сейчас говорит (не я); показы по голосу не прыгают.
 */
export const STAGE_LAYOUTS = ['auto', 'grid', 'focus', 'side', 'speaker'] as const;
export type StageLayout = (typeof STAGE_LAYOUTS)[number];

/** На телефоне (узко/мобильно) «Сетка» и «Сбоку» не предлагаются: сетка там своя, колонке справа нет места. */
export const STAGE_PHONE_LAYOUTS: readonly StageLayout[] = ['auto', 'focus', 'speaker'];

export const STAGE_LAYOUT_LABELS: Record<StageLayout, { label: string; sub: string }> = {
  auto: { label: 'Авто', sub: 'Сетка, а открытый показ — крупно' },
  grid: { label: 'Сетка', sub: 'Все плитки одного размера' },
  focus: { label: 'Фокус', sub: 'Один крупно, остальные снизу' },
  side: { label: 'Сбоку', sub: 'Один крупно, остальные справа' },
  speaker: { label: 'Говорящий', sub: 'Крупно тот, кто говорит' },
};

/** Разбор сохранённого значения: чужое/испорченное/из будущей сборки — `auto`. */
export function parseStageLayout(raw: unknown): StageLayout {
  return typeof raw === 'string' && (STAGE_LAYOUTS as readonly string[]).includes(raw) ? (raw as StageLayout) : 'auto';
}

/** Режимы, которые предлагает переключатель. */
export function stageLayoutChoices(phone: boolean): readonly StageLayout[] {
  return phone ? STAGE_PHONE_LAYOUTS : STAGE_LAYOUTS;
}

/** Действующий режим: сохранённый «Сетка»/«Сбоку» на телефоне ведёт себя как «Авто» (сам выбор не трогаем). */
export function effectiveStageLayout(saved: StageLayout, phone: boolean): StageLayout {
  return phone && !STAGE_PHONE_LAYOUTS.includes(saved) ? 'auto' : saved;
}

/** Режимы «один крупно»: открытие показа или камеры заменяет крупное, а не добавляет второе. */
export function isOneBigLayout(layout: StageLayout): boolean {
  return layout === 'focus' || layout === 'side' || layout === 'speaker';
}

/**
 * «Фокус»/«Сбоку» без выбранного: какой показ открыть самим. Первый чужой показ, которого ещё не было
 * на сцене при прошлом автооткрытии или ручном выборе (`seen`): закрыл автооткрытый — он не открывается
 * снова, а начавшийся позже показ откроется, как у Meet новая презентация. Что-то уже открыто или камера в
 * фокусе — ничего. В «Говорящем» и прочих режимах показы сами не открываются.
 */
export function stageAutoOpenStream(
  layout: StageLayout,
  screens: readonly string[],
  watched: readonly string[],
  hasFocusCam: boolean,
  seen: ReadonlySet<string>,
): string | null {
  if (layout !== 'focus' && layout !== 'side') return null;
  if (watched.length > 0 || hasFocusCam) return null;
  return screens.find((id) => !seen.has(id)) ?? null;
}

/** Не чаще одной смены крупного говорящего за это время (гистерезис против дребезга при перебивании). */
export const STAGE_SPEAKER_HOLD_MS = 1500;
/** Новый говорящий должен говорить непрерывно хотя бы столько, чтобы «ага» не выдёргивало его крупно. */
export const STAGE_SPEAKER_MIN_TALK_MS = 600;

export type StageSpeaker = { id: string | null; at: number };

export type StageSpeakerInput = {
  /** Кто сейчас говорит (без меня) → с какого момента говорит непрерывно. */
  speakingSince: ReadonlyMap<string, number>;
  /** Кто есть на сцене (без меня), в порядке плиток — запас, пока никто не заговорил. */
  present: readonly string[];
  now: number;
  holdMs?: number;
  minTalkMs?: number;
};

/** Лучший кандидат: кто говорит непрерывно дольше всех (кроме текущего). */
function speakerCandidate(prev: StageSpeaker, inp: StageSpeakerInput): { id: string; since: number } | null {
  let best: { id: string; since: number } | null = null;
  for (const id of inp.present) {
    const since = inp.speakingSince.get(id);
    if (since === undefined || id === prev.id) continue;
    if (!best || since < best.since) best = { id, since };
  }
  return best;
}

/**
 * Кого показать крупно в «Говорящем» (и в «Фокусе»/«Сбоку», когда показывать больше нечего).
 * - Ушёл крупный — место свободно сразу.
 * - Крупный ещё говорит — держим (перебивающий не выдёргивает его).
 * - Иначе кандидат, говорящий непрерывно ≥ `minTalkMs`, сменяет крупного не раньше `holdMs` от прошлой смены.
 * - Тишина — держим последнего; никто ещё не говорил — первый на сцене (с `at: 0`, его сменит первый же говорящий).
 * - Себя крупно не выводим: меня нет ни в `present`, ни в `speakingSince` (это обязанность вызывающего).
 */
export function nextStageSpeaker(prev: StageSpeaker, inp: StageSpeakerInput): StageSpeaker {
  const hold = inp.holdMs ?? STAGE_SPEAKER_HOLD_MS;
  const minTalk = inp.minTalkMs ?? STAGE_SPEAKER_MIN_TALK_MS;
  const cur: StageSpeaker = prev.id && inp.present.includes(prev.id) ? prev : { id: null, at: 0 };
  if (cur.id && inp.speakingSince.has(cur.id)) return cur;
  const cand = speakerCandidate(cur, inp);
  if (cand && inp.now - cand.since >= minTalk && (cur.id === null || inp.now - cur.at >= hold)) {
    return { id: cand.id, at: inp.now };
  }
  if (cur.id) return cur;
  const first = inp.present[0] ?? null;
  return first === prev.id && prev.at === 0 ? prev : { id: first, at: 0 };
}

/**
 * Через сколько мс пересчитать крупного: смена отложена гистерезисом или кандидат ещё не наговорил
 * `minTalkMs`, а новых событий «говорит» может не прийти (он просто продолжает говорить). `null` — ждать нечего.
 */
export function stageSpeakerRecheckMs(cur: StageSpeaker, inp: StageSpeakerInput): number | null {
  if (cur.id && inp.speakingSince.has(cur.id)) return null;
  const hold = inp.holdMs ?? STAGE_SPEAKER_HOLD_MS;
  const minTalk = inp.minTalkMs ?? STAGE_SPEAKER_MIN_TALK_MS;
  const cand = speakerCandidate(cur, inp);
  if (!cand) return null;
  const at = Math.max(cand.since + minTalk, cur.id === null ? 0 : cur.at + hold);
  return Math.max(0, at - inp.now);
}
