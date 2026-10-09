import { emojiForCode } from './emojiShortcodes';

/**
 * Правила ленты сообщений и композера — чистые, БЕЗ React и DOM.
 *
 * Вынуто из `MessagePane.tsx` по просьбе Codex (2026-07-27): жило внутри компонента на 1300 строк,
 * то есть проверялось только набором текста руками. Ошибка в композере ломает ввод молча (список
 * подсказок не открылся, `:code:` не превратился в эмодзи, замена съела соседний символ), а ошибка в
 * ленте рисует разделитель «Новые сообщения» не там, где человек остановился.
 */

// ---- Композер: автодополнение --------------------------------------------------------------

export type AcTrigger = '@' | '#' | ':';

export interface AcToken {
  trigger: AcTrigger;
  query: string;
  /** Индекс символа-триггера в тексте (`:`/`@`/`#`), с него начинается замена. */
  start: number;
  /** G53: подсказка «слово целиком» (без `:`, `acExactAt`): `start` = 0, заменяется само слово, а не `:слово`. */
  exact?: boolean;
}

/**
 * Токен автодополнения под кареткой, либо `null`.
 *
 * ⚠️ `:code` требует минимум ДВУХ символов, иначе список открывался бы на каждом руками набранном
 * смайлике («:)»).
 * ⚠️ Перед триггером обязателен пробел или начало строки — это то, что оставляет в покое `10:30`,
 * `http://host:8080` и почту вида `a@b`.
 * ⚠️ `@`/`#` работают только там, где есть серверный контекст (`serverScoped`): в ЛС ни ролей, ни
 * каналов нет, и подсказка была бы про пустоту.
 */
export function acTokenAt(value: string, caret: number | null, serverScoped: boolean, hashtags = false): AcToken | null {
  if (caret == null) return null;
  const head = value.slice(0, caret);
  const em = /(^|\s):([\p{L}\p{N}_+-]{2,})$/u.exec(head);
  if (em) return { trigger: ':', query: em[2], start: caret - em[2].length - 1 };
  // `hashtags` (G36): в беседах `#` — недавние хэштеги (`hashtagRules.ts`), `@` там по-прежнему только с серверным/групповым контекстом.
  const m = serverScoped || hashtags ? /(^|\s)([@#])([\p{L}\p{N}_.-]*)$/u.exec(head) : null;
  if (m && (serverScoped || m[2] === '#')) return { trigger: m[2] as '@' | '#', query: m[3], start: caret - m[3].length - 1 };
  return null;
}

/**
 * Подсказка эмодзи «слово целиком» (G53; tdesktop `SuggestionsController::getEmojiQuery`, `suggestExactFirstWord`): всё поле —
 * ОДНО слово (буквы, ≥ 2, ≤ `EXACT_WORD_MAX`), каретка в конце. Слово посреди текста, после пробела или с цифрами не берётся —
 * иначе подсказка вставала бы на каждом слове; у Telegram так же только первое слово пустого поля.
 */
export const EXACT_WORD_MAX = 24;
export function acExactAt(value: string, caret: number | null): AcToken | null {
  if (caret == null || caret !== value.length) return null;
  if (value.length < 2 || value.length > EXACT_WORD_MAX || !/^\p{L}+$/u.test(value)) return null;
  return { trigger: ':', query: value, start: 0, exact: true };
}

/**
 * Подставить выбранную подсказку вместо набранного токена. Возвращает новый текст и позицию каретки.
 * ⚠️ Пробел после вставки добавляется намеренно: следующее слово почти всегда идёт сразу, а без него
 * каретка липнет к вставленному имени и следующий символ дописывается внутрь упоминания.
 */
export function applyAc(text: string, ac: AcToken, insert: string): { text: string; caret: number } {
  const before = text.slice(0, ac.start);
  const after = text.slice(ac.start + (ac.exact ? 0 : 1) + ac.query.length);
  const withSpace = `${insert} `;
  return { text: before + withSpace + after, caret: (before + withSpace).length };
}

// ---- Композер: замена `:code:` на эмодзи ----------------------------------------------------

/**
 * `:fire:` → 🔥 в момент, когда набрана закрывающая двоеточие. Возвращает `null`, если заменять
 * нечего.
 *
 * Подсказка из пикера это обещает, а список автодополнения сам по себе не справлялся: закрывающее
 * `:` завершает токен, список закрывается, и текст остаётся буквальным.
 *
 * ⚠️ Требуется пробел (или начало строки) перед открывающим двоеточием И ТОЧНО известный код —
 * именно это оставляет целыми `10:30:` и `http://host:8080:`: ни у одного нет пробела перед
 * подходящим кодом.
 */
export function emojiSubstitution(value: string, caret: number | null): { text: string; caret: number } | null {
  if (caret == null) return null;
  const m = /(^|\s):([\p{L}\p{N}_+-]{2,}):$/u.exec(value.slice(0, caret));
  if (!m) return null;
  const emoji = emojiForCode(m[2]);
  if (!emoji) return null;
  const start = caret - (m[2].length + 2); // ':' + code + ':'
  return { text: value.slice(0, start) + emoji + value.slice(caret), caret: start + emoji.length };
}

// ---- Лента: разделитель непрочитанного и группировка ----------------------------------------

/** Минимум полей сообщения, нужный правилам ленты. */
export interface ListMessage {
  createdAt: string;
  authorId: string;
  /** Есть ли цитата-ответ (такое сообщение всегда начинает новый блок). */
  hasReply?: boolean;
}

/** Подряд идущие сообщения одного автора в пределах этого окна схлопываются в группу. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Первое сообщение новее последнего визита — над ним рисуется «Новые сообщения» (#15).
 *
 * ⚠️ Своё сообщение новостью не считается: человек его сам и написал.
 * ⚠️ Условие `prev <= newSince` — это то, что делает разделитель ЕДИНСТВЕННЫМ: без него он повторился
 * бы над каждым новым сообщением подряд.
 */
export function isFirstUnread(
  m: ListMessage,
  prev: ListMessage | undefined,
  meId: string | undefined,
  newSince: number | null | undefined,
): boolean {
  if (!newSince) return false;
  if (new Date(m.createdAt).getTime() <= newSince) return false;
  if (m.authorId === meId) return false;
  return !prev || new Date(prev.createdAt).getTime() <= newSince;
}

/**
 * Начинается ли с этого сообщения новый КАЛЕНДАРНЫЙ день — над такими рисуется дневная метка.
 *
 * 🔴 **Считаем по местному времени читающего, а не по серверному.** Сервер и люди у нас уже разнесены
 * по часовым поясам, и на этом классе ошибок мы обжигались в подсчёте серий экономики: «сегодня» по
 * московской полуночи для человека из другого пояса наступает не тогда, когда у него сегодня.
 * `toDateString()` берёт именно местную дату браузера — то есть день ровно в том виде, в каком его
 * проживает тот, кто читает.
 *
 * ⚠️ Самое первое сообщение ленты тоже начинает день: без метки над ним непонятно, к какому дню
 * относится верх переписки.
 */
export function isNewDay(m: ListMessage, prev: ListMessage | undefined): boolean {
  const day = new Date(m.createdAt).toDateString();
  if (!prev) return true;
  return new Date(prev.createdAt).toDateString() !== day;
}

/**
 * Подпись дневной метки: «Сегодня», «Вчера» или дата словами.
 *
 * ⚠️ «Сегодня» и «Вчера» считаются от переданного «сейчас», а не берутся из `Date.now()` внутри:
 * иначе функцию нельзя проверить тестом, не переводя часы машины.
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toDateString();
  const day = d.toDateString();
  if (day === today) return 'Сегодня';
  if (day === yesterday) return 'Вчера';
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Часы и минуты подвала меню — тем же форматом, что время в пузыре (`MessagePane.TIME_FMT`): одно время в двух местах. */
const SENT_TIME = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
/** «27 сентября» — число и месяц в родительном падеже; по-русски, как весь интерфейс («Сегодня», «Вчера»). */
const SENT_DAY = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });

/**
 * Когда отправлено — подвал меню сообщения (раунд 12, `docs/design/design-step12/HANDOFF.md` §3): «Сегодня в 21:07»,
 * «Вчера в 14:10», «27 сентября в 18:05», в прошлые годы — «31 декабря 2025 в 23:59». Год — без «г.», в отличие от
 * `dayLabel`: в подвале дата идёт в одной фразе со временем.
 *
 * Дни — календарные, по местному времени читающего (как у `dayLabel` и `isNewDay`); «вчера» — прошлое календарное
 * число, а не «сутки назад» (в день перевода часов сутки короче или длиннее 24 ч). Время из будущего (часы устройства
 * отстают от сервера) — как сегодня. «Сейчас» — параметром: тест не переводит часы машины.
 */
export function sentAtLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = SENT_TIME.format(d);
  const dayOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = dayOf(now);
  const day = dayOf(d);
  if (day >= today) return `Сегодня в ${time}`;
  if (day === dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `Вчера в ${time}`;
  const date = SENT_DAY.format(d);
  return d.getFullYear() === now.getFullYear() ? `${date} в ${time}` : `${date} ${d.getFullYear()} в ${time}`;
}

/** Полная дата для подсказки по времени: «7 октября 2026 г. в 21:07» (по-русски, как весь интерфейс). */
const FULL_DATE = new Intl.DateTimeFormat('ru', { dateStyle: 'long', timeStyle: 'short' });

/** Что нужно знать о сообщении, чтобы подписать даты: отправлено, изменено, время оригинала у пересланного. */
export interface DateSource {
  createdAt: string;
  editedAt?: string | null;
  forwardedFrom?: { at: string } | null;
}

function validIso(iso: string | null | undefined): iso is string {
  return typeof iso === 'string' && iso !== '' && Number.isFinite(new Date(iso).getTime());
}

/**
 * Строки подвала меню сообщения (как у Telegram: дата правки и «Исходное: {дата}» у пересланного): первая — всегда «когда
 * отправлено» (`sentAtLabel`); у правленного — «Изменено: …»; у пересланного — «Исходное: …» (время ОРИГИНАЛА, не
 * пересылки). Дата, которую не разобрать, строку не даёт (в подвале не должно быть «Invalid Date»).
 */
export function menuFootLines(m: DateSource, now: Date = new Date()): string[] {
  // После двоеточия «Сегодня» / «Вчера» — со строчной: «Изменено: сегодня в 14:00».
  const after = (iso: string) => sentAtLabel(iso, now).replace(/^(Сегодня|Вчера)/, (w) => w.toLowerCase());
  // Битая дата отправки — без строки, а не `RangeError` в подвале меню (как у правки и пересылки ниже).
  const lines = validIso(m.createdAt) ? [sentAtLabel(m.createdAt, now)] : [];
  if (validIso(m.editedAt)) lines.push(`Изменено: ${after(m.editedAt)}`);
  if (validIso(m.forwardedFrom?.at)) lines.push(`Исходное: ${after(m.forwardedFrom!.at)}`);
  return lines;
}

/**
 * Подсказка при наведении на время в пузыре (ПК, как у Telegram): полная дата отправки, ниже — «Изменено: …» и (у
 * пересланного) «Исходное: …», каждая со своей строки (`title` понимает перевод строки). Не разобрать дату отправки —
 * пустая строка (подсказки нет).
 */
export function timeTooltip(m: DateSource): string {
  if (!validIso(m.createdAt)) return '';
  const lines = [FULL_DATE.format(new Date(m.createdAt))];
  if (validIso(m.editedAt)) lines.push(`Изменено: ${FULL_DATE.format(new Date(m.editedAt))}`);
  if (validIso(m.forwardedFrom?.at)) lines.push(`Исходное: ${FULL_DATE.format(new Date(m.forwardedFrom!.at))}`);
  return lines.join('\n');
}

/** Сообщение ленты для «Скопировать» в режиме выделения: id, текст, имя автора (как его зовёт лента), время отправки. */
export interface CopySource {
  id: string;
  content: string;
  author: string;
  createdAt: string;
  /**
   * Метка вложения «[ Фотография ]» (`copyMediaLabel`); нет — вложений нет. Нужна только ПК-виду копирования: у
   * телефонного (как Android у Telegram) копируются одни тексты и подписи.
   */
  label?: string;
  /** Ответ: кому и что цитирует (текст цитаты — уже словами, «Фото» и т. п., как в пузыре). */
  reply?: { author: string; text: string };
}

/** Вид «Скопировать» нескольких: `desktop` — «[дата время] Имя: текст» (Telegram для ПК), `phone` — как Android. */
export interface PickedTextOptions {
  style: 'desktop' | 'phone';
}

/** Метка вложения для копирования («[ Фотография ]», как у Telegram для ПК); пусто — вложений и стикера нет. */
export function copyMediaLabel(m: {
  attachments?: readonly { contentType: string; waveform?: readonly number[] | null }[] | null;
  sticker?: unknown;
}): string {
  if (m.sticker) return '[ Стикер ]';
  const list = m.attachments ?? [];
  if (list.length === 0) return '';
  if (list.length > 1) return '[ Альбом ]';
  const a = list[0];
  if (Array.isArray(a.waveform) && a.waveform.length > 0) return '[ Голосовое сообщение ]';
  if (a.contentType.startsWith('image/')) return '[ Фотография ]';
  if (a.contentType.startsWith('video/')) return '[ Видео ]';
  return '[ Файл ]';
}

/**
 * Что кладёт в буфер «Скопировать» режима выделения (раунд 12, `docs/design/design-step12/HANDOFF.md` §6): по порядку
 * ЛЕНТЫ (`feed`), а не по порядку выбора. Одно сообщение — как есть (текст или подпись), без заголовка; нечего — пусто.
 *
 * Два и больше, `options.style`:
 * - `desktop` (Telegram для ПК, «Копировать выбранное как текст»): каждое с новой строки «[время] Имя: текст»; ответ —
 *   «[время] Имя в ответ Автор:», строка «> цитата» и текст; вложение — меткой «[ Фотография ]» (после заголовка, от
 *   подписи отделена пустой строкой). Сообщение без текста и без метки пропускается. `time` — «[…]» целиком, параметром.
 * - `phone` (Telegram для Android): тексты и подписи через пустую строку; имя автора строкой «Имя:» только когда автор
 *   сменился (и перед первым); времён нет; сообщение без текста пропускается.
 * Без `options` — прежний вид «Имя, 20:58» над каждым (остался для вызовов без стиля). `time` — параметром: тест не
 * зависит от часового пояса машины.
 */
export function pickedText(
  feed: readonly CopySource[],
  picked: ReadonlySet<string>,
  time: (iso: string) => string,
  options?: PickedTextOptions,
): string {
  const chosen = feed.filter((m) => picked.has(m.id));
  if (!options) {
    const list = chosen.filter((m) => m.content.trim());
    if (list.length === 1) return list[0].content;
    return list.map((m) => `${m.author}, ${time(m.createdAt)}\n${m.content}`).join('\n\n');
  }
  if (options.style === 'phone') {
    const list = chosen.filter((m) => m.content.trim());
    if (list.length === 1) return list[0].content;
    let prev: string | null = null;
    return list
      .map((m) => {
        const head = m.author !== prev ? `${m.author}:\n` : '';
        prev = m.author;
        return head + m.content;
      })
      .join('\n\n');
  }
  const list = chosen.filter((m) => m.content.trim() || m.label);
  if (list.length === 1) return list[0].content.trim() ? list[0].content : '';
  return list
    .map((m) => {
      const stamp = `[${time(m.createdAt)}] ${m.author}`;
      const text = m.content.trim() ? m.content : '';
      const body = [m.label, text].filter(Boolean).join('\n\n');
      if (m.reply) {
        const quote = m.reply.text.replace(/\s+/g, ' ').trim();
        return [`${stamp} в ответ ${m.reply.author}:`, quote ? `> ${quote}` : '', body].filter(Boolean).join('\n');
      }
      return m.label ? `${stamp}:\n${body}` : `${stamp}: ${body}`;
    })
    .join('\n');
}

/**
 * Схлопывать ли сообщение с предыдущим (шапка «аватар + имя + время» показывается только у первого).
 * ⚠️ Ответ всегда начинает новый блок, иначе цитата читается как продолжение чужой мысли.
 */
export function isGrouped(m: ListMessage, prev: ListMessage | undefined): boolean {
  if (!prev || prev.authorId !== m.authorId || m.hasReply) return false;
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() <= GROUP_WINDOW_MS;
}

/**
 * Что делает Enter в поле ввода: `true` — отправить, `false` — перенос строки (действие по умолчанию).
 *
 * 🔴 До 28.09 поле было однострочным `<input>` (#212): перенос строки нельзя было ни набрать, ни вставить —
 * многострочное сообщение получалось только через «Изменить». Теперь `<textarea>`, и правила как у Telegram:
 * - Shift+Enter — перенос;
 * - идёт набор через IME (китайский, японский, часть экранных клавиатур) — Enter подтверждает слово, не трогаем;
 * - только сенсор (телефон, в приложении и в браузере) — Enter переносит строку, отправка кнопкой: так ведут
 *   себя Telegram и WhatsApp на телефоне, а слово «отправить» на клавиатуре легко нажать случайно;
 * - иначе — отправить.
 * Режим «Отправка по Ctrl+Enter» (07.10, G36; Telegram Desktop «Настройки чатов → Сообщения», `sendSubmitWay`): Enter и
 * Shift+Enter — перенос, отправляет Ctrl+Enter (⌘+Enter). Ctrl+Shift+Enter отправляет в обоих режимах, как у Telegram.
 * В режиме Enter Ctrl+Enter — ПЕРЕНОС строки, как у Telegram Desktop (решение владельца 07.10; таблица клавиша × режим —
 * `tg-research/02-composer.md` §10.1, LUI `ui/widgets/fields/input_field.cpp` `ShouldSubmit`; Web K
 * `isSendShortcutPressed.ts` в режиме Enter с Ctrl/Shift тоже не отправляет): браузер сам Ctrl+Enter строку не переносит,
 * поэтому вызывающий вставляет её сам — `enterBreaksLine` + `insertLineBreak` (`sendMode.ts`).
 * Режим «Enter»: Enter — отправить, Shift+Enter — перенос, Ctrl+Enter — перенос, Ctrl+Shift+Enter — отправить.
 * Режим «Ctrl+Enter»: Enter — перенос, Shift+Enter — перенос, Ctrl+Enter — отправить, Ctrl+Shift+Enter — отправить.
 * `ctrl` и `mode` необязательны: без них — режим Enter, без Ctrl.
 * «Только сенсор» = ОСНОВНОЙ указатель грубый (`pointer: coarse`): ноутбук с сенсорным экраном отправляет по
 * Enter. ⚠️ Не «нет ни одного точного» (`any-pointer: fine`): у телефона со стилусом (S25 Ultra) он есть, и
 * Enter отправлял — так 28.09 ушло случайное сообщение при проверке на живом телефоне.
 */
export function enterSends(e: {
  shift: boolean;
  composing: boolean;
  touchOnly: boolean;
  ctrl?: boolean;
  mode?: 'enter' | 'ctrl-enter';
}): boolean {
  if (e.composing) return false;
  if (e.ctrl) return e.shift || e.mode === 'ctrl-enter';
  if (e.mode === 'ctrl-enter') return false;
  return !e.shift && !e.touchOnly;
}

/** Ctrl+Enter без Shift в режиме Enter — перенос строки, который браузер сам не делает: вставить его руками. */
export function enterBreaksLine(e: { shift: boolean; composing: boolean; ctrl?: boolean; mode?: 'enter' | 'ctrl-enter' }): boolean {
  return !e.composing && !!e.ctrl && !e.shift && e.mode !== 'ctrl-enter';
}

/**
 * Что делать с «Сохранить» в правке сообщения (06.10, сверка с Telegram):
 * - `close` — текст не изменился (сравниваем обрезанные): выйти из правки БЕЗ запроса. Раньше запрос уходил, сервер ставил
 *   «изм.» на нетронутое сообщение (на телефоне проверка была — `saveComposerEdit`, на ПК — нет);
 * - `ignore` — пусто, а вложений нет: сообщение без текста и без вложений сервер не примет (400), правка остаётся открытой;
 * - `save` — сохранить. Пустой текст у сообщения с вложениями допустим: это «убрать подпись» у фото (сервер так и разрешает —
 *   `editMessage` / `PATCH /channels/…`; клиент раньше такое молча не пускал, подпись убрать было нельзя).
 */
export function editDecision(p: { draft: string; original: string; hasAttachments: boolean }): 'save' | 'close' | 'ignore' {
  const draft = p.draft.trim();
  if (draft === p.original.trim()) return 'close';
  if (!draft && !p.hasAttachments) return 'ignore';
  return 'save';
}

/**
 * Вставка из панели эмодзи в поле ввода (07.10, сверка 02·6.1): на место каретки, поверх выделенного — как у Telegram
 * Desktop (раньше эмодзи дописывался в конец). `start` / `end` — `selectionStart` / `selectionEnd` поля; `null` (поля нет
 * или выделение не сказано) — в конец текста; за пределами текста — прижимаются к краям; перепутанные — меняются местами.
 * Каретка после вставки — сразу за ней (`caret`).
 */
export function insertAtCaret(
  text: string,
  piece: string,
  start: number | null,
  end: number | null,
): { text: string; caret: number } {
  const len = text.length;
  const a = Math.min(Math.max(start ?? len, 0), len);
  const b = Math.min(Math.max(end ?? a, 0), len);
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return { text: text.slice(0, from) + piece + text.slice(to), caret: from + piece.length };
}

/** Что делает Esc в поле ввода (`fieldEscape`). */
export type FieldEscape = 'ask' | 'cancel-edit' | 'cancel-reply' | 'none';

/**
 * Esc в поле ввода и в правке на месте (07.10, сверка 02·3.3, как Telegram Desktop):
 * - правка: текст не менялся (сравниваем обрезанные, как `editDecision`) — отмена сразу (`cancel-edit`); менялся — сперва
 *   вопрос «Отменить изменения?» (`ask`);
 * - ответ: снимается Esc только при пустом поле (`cancel-reply`); в поле есть текст — ответ остаётся (`none`);
 * - правка главнее ответа: пока правится, ответа в поле нет (`startComposerEdit` его прячет).
 * `original` — исходный текст правимого сообщения; без правки не нужен.
 */
export function fieldEscape(p: { editing: boolean; replying: boolean; draft: string; original: string }): FieldEscape {
  if (p.editing) return p.draft.trim() === p.original.trim() ? 'cancel-edit' : 'ask';
  if (p.replying) return p.draft.trim() === '' ? 'cancel-reply' : 'none';
  return 'none';
}

// ---- Свайп-ответ на телефоне (раунд 12, порция 6) ------------------------------------------------

/*
 * Палец ведёт пузырь ЛС влево — справа проявляется значок «ответить» и растёт до порога; отпустил за порогом — ответ на
 * это сообщение (HANDOFF §7, кадры `Phone-swipe-*`). Числа — не «по ощущению», а из исходников Telegram (сверка 07.10,
 * `S:/gv-stand/tg-src`, G81):
 * - палец (телефон) — Android `ChatActivity.java` (`onInterceptTouchEvent` списка): жест начинается, когда палец ушёл
 *   влево на 0,4 см (≈ 15 px, `SWIPE_LOCK_PX`) и путь по горизонтали втрое больше пути по вертикали (`|dx| / 3 > dy`) —
 *   точка отсчёта сдвига переносится в эту точку (пузырь стартует с нуля); пузырь идёт за пальцем 1:1 до жёсткого упора
 *   80 dp (`SWIPE_MAX_PX`, без сопротивления); ответ — по отпусканию, если сдвиг ≥ 50 dp (`SWIPE_REPLY_PX`); вибро-отклик
 *   на пороге. Гистерезиса у Android нет — `SWIPE_DISARM_PX` равен порогу; отклик у нас один раз за жест, а не на каждый
 *   заход за порог (иначе дрожь пальца у порога жужжала бы);
 * - тачпад (веб и десктоп-приложение, решение владельца 07.10: одно поведение на ПК) — Telegram Desktop
 *   `ui/controls/swipe_handler.cpp`: порог 50 (`kThresholdWidth`), путь до `kMaxRatio` = 1,5 порога (75), а сдвиг пузыря
 *   за порогом гасится логарифмом `16 · ln(1 + x / 10)` (`DampedOverswipe`) — упор виден как 70 px, ответ по отпусканию
 *   от 50 (`SWIPE_WHEEL`). Web K (`bubbles.ts: createReplySwipeController`: упор 64, ответ от 48, линейно) отличается —
 *   взяты десктопные;
 * - касание в `SWIPE_EDGE_PX` = 32 px от правого края — системный жест «назад» Android (полоса 24 dp + запас на высокую
 *   чувствительность жеста): там свайп не начинаем. Левый край не трогаем: жест влево оттуда некуда вести.
 */
/** Палец ушёл влево на столько px — решаем, свайп это или прокрутка (Android: 0,4 см ≈ 15 css px). */
export const SWIPE_LOCK_PX = 15;
/** Порог ответа — сдвиг пузыря, px (Android: 50 dp). */
export const SWIPE_REPLY_PX = 50;
/** Снять взвод — сдвиг меньше этого; у Android гистерезиса нет — равен порогу. */
export const SWIPE_DISARM_PX = 50;
/** Предел сдвига пузыря — жёсткий упор (Android: 80 dp). */
export const SWIPE_MAX_PX = 80;
/** Полоса у правого края экрана, где касание — системный жест «назад» Android. */
export const SWIPE_EDGE_PX = 32;
/** Вертикальный уход, с которого жест, где вертикаль не меньше горизонтали, — точно прокрутка (45° — граница браузера). */
export const SWIPE_SCROLL_PX = 10;

/** Пределы свайпа-ответа: порог ответа, снятие взвода, упор — свои у пальца и у тачпада. */
export interface SwipeLimits {
  readonly reply: number;
  readonly disarm: number;
  readonly max: number;
  /** За порогом сдвиг гасится логарифмом, а не идёт 1:1 (Telegram Desktop `DampedOverswipe`: 16 · ln(1 + x / 10)). */
  readonly damped?: boolean;
}
/** Палец — Android. */
export const SWIPE_TOUCH: SwipeLimits = { reply: SWIPE_REPLY_PX, disarm: SWIPE_DISARM_PX, max: SWIPE_MAX_PX };
/** Тачпад (ПК) — Telegram Desktop: порог 50, путь до 75, за порогом логарифмическое гашение. */
export const SWIPE_WHEEL: SwipeLimits = { reply: 50, disarm: 50, max: 75, damped: true };

/**
 * Чей жест по смещению пальца от касания (Android `ChatActivity`): `swipe` — влево на `SWIPE_LOCK_PX` и `|dx| / 3 > |dy|`
 * (угол к горизонту меньше ≈ 18°); `scroll` — вправо, либо вертикаль уже не меньше горизонтали (≥ `SWIPE_SCROLL_PX`):
 * до конца касания это не свайп (45° — та же граница, по которой браузер под `touch-action: pan-y` ведёт прокрутку);
 * `wait` — всё остальное (палец ещё не дошёл либо идёт в «серой» полосе 18°–45°: Android ждёт, пока dx вырастет).
 */
export function swipeIntent(dx: number, dy: number): 'wait' | 'swipe' | 'scroll' {
  const ady = Math.abs(dy);
  if (dx <= -SWIPE_LOCK_PX && -dx / 3 > ady) return 'swipe';
  if (dx >= SWIPE_LOCK_PX) return 'scroll';
  if (ady >= SWIPE_SCROLL_PX && ady >= Math.abs(dx)) return 'scroll';
  return 'wait';
}

/**
 * Сдвиг пузыря (px, ≥ 0) по пути `pull`: 1:1 до жёсткого упора пути `limits.max`; у `damped` за порогом — логарифмическое
 * гашение (на упоре пути 75 пузырь стоит на 70).
 */
export function swipeOffset(pull: number, limits: SwipeLimits = SWIPE_TOUCH): number {
  if (!(pull > 0)) return 0;
  const p = Math.min(pull, limits.max);
  if (!limits.damped || p <= limits.reply) return p;
  return limits.reply + 16 * Math.log(1 + (p - limits.reply) / 10);
}

/** Доля пути до порога, 0…1 (`--swipe-p`): прозрачность и размер значка. */
export function swipeProgress(offset: number, limits: SwipeLimits = SWIPE_TOUCH): number {
  return Math.min(1, Math.max(0, offset / limits.reply));
}

/** Взведён ли ответ (`.armed`): взводится на пороге, снимается ниже `limits.disarm`. */
export function swipeArmed(offset: number, armed: boolean, limits: SwipeLimits = SWIPE_TOUCH): boolean {
  return offset >= (armed ? limits.disarm : limits.reply);
}

/** Касание начато у правого края экрана — там системный жест «назад» Android, свайп не начинаем. */
export function swipeFromEdge(x: number, viewportWidth: number): boolean {
  return x >= viewportWidth - SWIPE_EDGE_PX;
}

// ---- Свайп-ответ тачпадом в широкой ленте, веб и десктоп (G23, решение владельца 07.10) -----------------------
/*
 * Тачпад шлёт горизонтальный жест колесом (`deltaX`, пиксели). Пороги — Telegram Desktop (`SWIPE_WHEEL`: ответ от 50, путь до
 * 75; у пальца свои, `SWIPE_TOUCH`), функции те же (`swipeOffset`, `swipeArmed`, `swipeProgress` с `SWIPE_WHEEL`): тянем пузырь влево на накопленный путь `pull`.
 * Отличия от пальца — у жеста нет «отпустил», поэтому:
 * - жест кончается тишиной (`WHEEL_SWIPE_IDLE_MS` без событий) ИЛИ спадом: после взвода несколько событий подряд
 *   слабее предыдущего и уже мелкие — пальцы подняты, дальше идёт инерция тачпада (`wheelDecayRun`);
 * - новый жест начинается только после тишины: хвост инерции прошлого (или вертикальной прокрутки) не заводит новый
 *   (у каждой серии событий свой исход, он решается по первым значимым событиям, `wheelBurstIntent`);
 * - одна сторона, как у Telegram (свайп влево по сообщению — ответ; вправо у него «назад», у нас — отдано браузеру): считаем
 *   по ДВИЖЕНИЮ СОДЕРЖИМОГО, а не пальцев. `deltaX` > 0 — содержимое уходит влево (страница «прокручивается вправо»);
 *   настройку «естественной» прокрутки Windows и Mac система уже учла в самом `deltaX` (у Mac и Windows с обратной
 *   прокруткой пальцы идут в разные стороны, а знак у `deltaX` для «пузырь уходит влево» один — плюс). Жест с `deltaX` < 0 — не наш;
 * - одно событие не длиннее `WHEEL_SWIPE_STEP_MAX`: щелчок наклонного колеса мыши (±100) за раз не взводит ответ.
 */
/** Тишина между событиями колеса, мс: серия кончилась (пальцы сняты и инерция прошла) или началась новая. */
export const WHEEL_SWIPE_IDLE_MS = 120;
/** Вклад одного события колеса в путь жеста, px. */
export const WHEEL_SWIPE_STEP_MAX = 48;
/** Сколько событий подряд должно слабеть после взвода, чтобы счесть жест отпущенным. */
export const WHEEL_SWIPE_DECAY_EVENTS = 3;
/** «Мелкое» событие хвоста: слабее этого после взвода и при спаде — отпустили. */
export const WHEEL_SWIPE_TAIL_PX = 20;

/**
 * Что делает серия событий колеса по первому значимому событию: `wait` — мелочь (дрожь пальцев); `swipe` — горизонталь
 * заметно перевешивает вертикаль (в 1,5 раза) И содержимое уходит влево (`dx` > 0); `other` — вертикальная прокрутка, жест в
 * другую сторону (там «назад» браузера — не трогаем), колесо мыши с Shift (браузер сам делает из него `deltaX`), строки и
 * страницы (`deltaMode` ≠ 0 — колесо мыши) — до тишины это не свайп.
 */
export function wheelBurstIntent(dx: number, dy: number, deltaMode: number, shift: boolean): 'wait' | 'swipe' | 'other' {
  if (deltaMode !== 0 || shift) return 'other';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 3 && ay < 3) return 'wait';
  return dx > 0 && ax > ay * 1.5 && ax >= 3 ? 'swipe' : 'other';
}

/**
 * Путь жеста после события: растёт, пока содержимое идёт влево (`dx` > 0), убывает, когда пальцы идут назад (`dx` < 0,
 * не ниже нуля). Сторона одна, `dir` остаётся в сигнатуре ради зовущего: после первого события он всегда 1. Событие
 * режется до `WHEEL_SWIPE_STEP_MAX`.
 */
export function wheelSwipePull(pull: number, dir: 0 | 1 | -1, dx: number): { pull: number; dir: 0 | 1 | -1 } {
  const d: 0 | 1 | -1 = dir !== 0 ? dir : dx > 0 ? 1 : 0;
  if (d === 0) return { pull, dir: 0 };
  const step = Math.max(-WHEEL_SWIPE_STEP_MAX, Math.min(WHEEL_SWIPE_STEP_MAX, dx));
  return { pull: Math.max(0, pull + step), dir: 1 };
}

/** Счётчик спада: сколько событий подряд слабее предыдущего (по модулю `deltaX`); не слабее — с нуля. */
export function wheelDecayRun(run: number, prev: number, cur: number): number {
  return Math.abs(cur) < Math.abs(prev) ? run + 1 : 0;
}

/** Пальцы подняты: ответ взведён, спад идёт `WHEEL_SWIPE_DECAY_EVENTS` событий подряд и событие уже мелкое. */
export function wheelReleased(armed: boolean, decayRun: number, dx: number): boolean {
  return armed && decayRun >= WHEEL_SWIPE_DECAY_EVENTS && Math.abs(dx) <= WHEEL_SWIPE_TAIL_PX;
}

/**
 * Нажатие сделано пальцем или пером (сенсор), а не мышью, — по САМОМУ событию (05.10, проход владельца по APK на S25 Ultra).
 * Медиазапрос про указатель говорит об устройстве, а не о нажатии: у телефона со стилусом `any-pointer: fine` истинно, у
 * ноутбука с сенсорным экраном основной указатель — мышь, а палец у обоих всё равно палец. `pointerType` есть у
 * `PointerEvent` — в Chromium так приходят и `click`, и `contextmenu` (системное долгое нажатие WebView — `contextmenu` с
 * `touch`); пустой — событие собрано кодом (`el.click()`). Нет его — `sourceCapabilities.firesTouchEvents` (Chromium: событие
 * мыши, собранное из касания). Не сказано ничего — `null`: решает зовущий (прежний медиазапрос).
 */
export function pressByTouch(e: object): boolean | null {
  const { pointerType, sourceCapabilities } = e as { pointerType?: unknown; sourceCapabilities?: unknown };
  if (pointerType === 'touch' || pointerType === 'pen') return true;
  if (typeof pointerType === 'string' && pointerType !== '') return false;
  const caps = sourceCapabilities as { firesTouchEvents?: unknown } | null | undefined;
  return caps && typeof caps.firesTouchEvents === 'boolean' ? caps.firesTouchEvents : null;
}

/** Черновик для записи (шаг 2д). Во время правки в поле лежит текст правки — черновик тот, что был до неё. */
export function draftToSave(p: {
  text: string;
  replyToId: string | null;
  editing: boolean;
  beforeEdit: { text: string; replyToId: string | null } | null;
}): { text: string; replyToId: string | null } {
  if (p.editing) return { text: p.beforeEdit?.text ?? '', replyToId: p.beforeEdit?.replyToId ?? null };
  return { text: p.text, replyToId: p.replyToId };
}

export interface SaverTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

const WINDOW_TIMERS: SaverTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Отложенная запись черновика: каждое изменение переносит запись на `delayMs`; `flush` пишет последнее незаписанное
 * сразу — лента размонтируется (вход в голос, другая беседа), и без этого набранное за последние 300 мс пропало бы.
 * Таймеры — параметром: тест крутит время сам.
 */
export function createDraftSaver<T>(save: (d: T) => void, delayMs = 300, timers: SaverTimers = WINDOW_TIMERS) {
  let pending: { d: T } | null = null;
  let timer: unknown = null;
  const stop = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const write = () => {
    const p = pending;
    pending = null;
    if (p) save(p.d);
  };
  return {
    change(d: T): void {
      pending = { d };
      stop();
      timer = timers.setTimeout(() => {
        timer = null;
        write();
      }, delayMs);
    },
    flush(): void {
      stop();
      write();
    },
    /** Есть набранное, ещё не отданное наружу (последние `delayMs`): человек печатает — пришедшее поле не трогает (Р7). */
    pending(): boolean {
      return pending !== null;
    },
  };
}

// ─── Реакции: быстрая двойным тапом / двойным кликом и «кто поставил» (07.10, ЛС) ─────────────────────────────────

/**
 * Окно двойного тапа, мс (07.10). Ресерч Telegram числа не даёт (Android ловит двойной тап системным детектором жестов) —
 * взят системный порог Android (`ViewConfiguration` DOUBLE_TAP_TIMEOUT, 300 мс): второе касание того же пузыря должно
 * начаться не позже, иначе первый тап — одиночный. На столько же откладывается меню по одиночному тапу, и только там, где
 * быстрая реакция возможна (у Telegram Android так же: задержка есть, лишь когда у строки есть двойной тап).
 */
export const DOUBLE_TAP_MS = 300;

/** Первый тап по пузырю, ждущий второго: по какому сообщению, когда (мс), и началось ли уже второе касание. */
export interface PendingTap {
  id: string;
  at: number;
  second: boolean;
}

/**
 * Шаг распознавания двойного тапа на телефоне (07.10; как детектор жестов Android, на котором стоит Telegram):
 * - `down` — палец коснулся пузыря: того же, что ждёт, и в пределах окна — началось второе касание (`second`; меню по
 *   таймеру больше не откроется, пока палец лежит). Любое другое касание первый тап гасит: его меню не будет (у Android
 *   так же — подтверждение одиночного снимается, если следом коснулись не для двойного).
 * - `tap` — тап (click) по пузырю: второе касание того же сообщения — `double` (быстрая реакция, меню нет); иначе это
 *   первый тап — `wait` (меню откроет таймер через `windowMs`, если второго касания не будет). Второе касание дольше
 *   окна долгого нажатия тапом уже не кончится, поэтому срок второго тапа — два окна от первого.
 */
export function doubleTapStep(
  pending: PendingTap | null,
  e: { kind: 'down' | 'tap'; id: string; at: number },
  windowMs = DOUBLE_TAP_MS,
): { pending: PendingTap | null; act: 'none' | 'wait' | 'double' } {
  if (e.kind === 'down') {
    if (pending && !pending.second && pending.id === e.id && e.at - pending.at <= windowMs)
      return { pending: { ...pending, second: true }, act: 'none' };
    return { pending: null, act: 'none' };
  }
  if (pending?.second && pending.id === e.id && e.at - pending.at <= 2 * windowMs) return { pending: null, act: 'double' };
  return { pending: { id: e.id, at: e.at, second: false }, act: 'wait' };
}

/** Быстрая реакция двойным тапом или кликом (07.10): моя такая уже стоит — снять, иначе поставить (переключатель, как у Telegram). */
export function quickReactOp(
  reactions: readonly { emoji: string; me: boolean }[] | null | undefined,
  emoji: string,
): 'add' | 'remove' {
  return reactions?.some((r) => r.emoji === emoji && r.me) ? 'remove' : 'add';
}

/** Сколько аватарок помещается на чип реакции: у Telegram Desktop — до трёх (`kMaxRecentUserpics`). */
export const CHIP_FACES_MAX = 3;

/**
 * Аватарки вместо числа на чипе реакции (07.10, ЛС; Telegram 3.20 / 3.21): кто поставил, по порядку постановки. Только
 * если сервер прислал список (`reactors`, сервер бесед ЛС), список сходится с числом (дельта старого пути или старая
 * копия в кеше могли их развести) и людей не больше `CHIP_FACES_MAX`. Иначе `null` — чип с числом, как было.
 */
export function chipFaces(r: { count: number; reactors?: readonly { userId: string }[] | null }): string[] | null {
  const list = r.reactors;
  if (!list || list.length === 0 || list.length !== r.count || list.length > CHIP_FACES_MAX) return null;
  return list.map((x) => x.userId);
}

/**
 * Аватарки на чипах сообщения целиком (G75, #211; Telegram Desktop `history_view_reactions.cpp`, сборка `reactions` для
 * `InlineList`). Ответ — чип (эмодзи) → кто поставил; чипа в ответе нет — рисуется число.
 *  - ЛС (`dm`): у Telegram «всегда показываем аватарки, вся информация есть» — каждый чип с полным списком (`chipFaces`);
 *  - канал и группа: аватарки на ВСЕХ чипах или ни на одном — только если список есть у каждого чипа, сходится с числом и
 *    поставивших на сообщении в сумме не больше трёх (`kMaxRecentUserpics`). Иначе у всех чипов число: полоса из одних
 *    аватарок и вперемешку с числами не читалась бы.
 */
export function messageChipFaces(
  reactions: readonly { emoji: string; count: number; reactors?: readonly { userId: string }[] | null }[] | null | undefined,
  dm: boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!reactions || reactions.length === 0) return out;
  if (dm) {
    for (const r of reactions) {
      const ids = chipFaces(r);
      if (ids) out.set(r.emoji, ids);
    }
    return out;
  }
  let sum = 0;
  for (const r of reactions) {
    sum += r.count;
    if (sum > CHIP_FACES_MAX || !chipFaces(r)) return out;
  }
  for (const r of reactions) out.set(r.emoji, chipFaces(r)!);
  return out;
}

/**
 * Порядок чипов под сообщением (G75; Telegram: чипы по убыванию числа поставивших): больше людей — левее; поровну — кто
 * поставил раньше (по первому в списке `reactors`, если он есть у всех), иначе как пришло. Исходный массив не меняет.
 */
export function sortReactionChips<T extends { count: number; reactors?: readonly { at: string }[] | null }>(
  reactions: readonly T[] | null | undefined,
): T[] {
  const list = [...(reactions ?? [])];
  const timed = list.every((r) => !!r.reactors?.[0]);
  return list
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        b.r.count - a.r.count ||
        (timed ? a.r.reactors![0].at.localeCompare(b.r.reactors![0].at) : 0) ||
        a.i - b.i,
    )
    .map((x) => x.r);
}
