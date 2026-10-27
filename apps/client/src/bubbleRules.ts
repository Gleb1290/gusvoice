/**
 * Пузыри ЛС «как в Telegram» (Р13) — чистые правила вида: какой пузырь рисовать сообщению и насколько крупно.
 *
 * Разметка — `components/MessageBubble.tsx`, стили — блок «ЛС как в Telegram» в `styles.css`. Правила живут
 * отдельно, чтобы их проверял Codex без React и чтобы дизайн-система отдавала их дизайну вместе с деталями.
 *
 * Как у Telegram:
 * - одни эмодзи без текста (до трёх) — крупно и БЕЗ пузыря, время маленькой пилюлей под ними;
 * - одно фото — во всю ширину пузыря без полей; подпись под фото; время поверх фото, если под ним ничего нет. Видео (06.10)
 *   — так же: кадр с ▶ и длительностью, в альбоме — ячейка наравне с фото;
 * - стикер без подписи и ответа — без пузыря (так было и раньше);
 * - несколько пересланных подряд от одного автора оригинала — строка «Переслано от» только у первого (раунд 12,
 *   `showsForwardedFrom`); пересланные стикер и крупные эмодзи — в пузыре, как ответ: строке нужно место;
 * - всё остальное — обычный пузырь с полями.
 */
import {
  attachmentWords,
  convMediaPreview,
  isVoiceMessage,
  parseConvMedia,
  stripFormatting,
  type Message,
  type ConvLastMessage,
  type MessageForwardedFrom,
  type MessageReplyPreview,
} from '@gusvoice/shared';
import { attachmentBox } from './imageSize';

/** До скольких эмодзи без текста рисуем крупно и без пузыря; четыре и больше — обычный пузырь, как у Telegram. */
export const JUMBO_MAX = 3;

/**
 * Пузырь с фото не уже этого: узкая картинка (полоска 30×300) иначе дала бы пузырь в палец шириной, и подпись под
 * ней шла бы по слову в строке. Картинка уже — стоит по центру на подложке.
 */
export const MEDIA_MIN_W = 120;

/**
 * С какой ширины ленты (px) все пузыри встают слева — как «широкая раскладка» Telegram Desktop: на широком экране
 * свои справа и чужие слева разносятся на полэкрана, и глаз бегает через всю ленту. Свои тогда отличаются только
 * цветом пузыря. Ниже (узкое окно) — как на телефоне: свои справа.
 */
export const WIDE_FEED_MIN = 760;

/** Все пузыри слева? Только на компьютере и в широкой ленте; на телефоне — никогда, даже в повёрнутом. */
export function bubblesAllLeft(feedWidth: number, mobile: boolean): boolean {
  return !mobile && feedWidth >= WIDE_FEED_MIN;
}

/** Вид пузыря: обычный с полями; фото во всю ширину; крупные эмодзи и стикер — без пузыря. */
export type BubbleKind = 'text' | 'media' | 'emoji' | 'sticker';

export interface BubbleLook {
  kind: BubbleKind;
  /** Сколько крупных эмодзи (1…`JUMBO_MAX`) у вида `emoji`; у остальных 0. */
  jumbo: number;
  /** Ширина пузыря с фото, px (по размеру из вложения); у остальных видов `null`. */
  mediaWidth: number | null;
  /** Альбом (раунд 10; 09.10 — до 10: 2–4 шаблонами макета, 5–10 плитками `albumGridOf`): число фото, 2…`ALBUM_MAX`, у вида `media`. У одиночного фото и остальных видов поля нет. */
  album?: number;
}

/**
 * Альбом — 2…`ALBUM_MAX` фото и видео одним пузырём (раунд 10; 09.10 — до 10). Больше — обычный пузырь со списком вложений.
 * 10 — столько же, сколько можно приложить к одному сообщению (`attachRules`, у Telegram `MAX_MEDIA_FILES_FOR_ALBUM`).
 * 2…4 — по трём шаблонам одобренного макета (`ALBUM_RATIO`, стили `.attachments.album.n2|n3|n4`, решение владельца 09.10);
 * 5…10 — плитками по строкам «как Telegram» (`albumGrid`), с потолком высоты, как у альбома из четырёх.
 */
export const ALBUM_MAX = 10;
/** Альбомы до этого числа фото — шаблоны макета в CSS (без `style`); дальше — плитки `albumGrid`. */
export const ALBUM_TEMPLATE_MAX = 4;
/**
 * Пропорции сетки альбома 2…4 фото — те же, что в стилях (`.attachments.album.n2|n3|n4`): 2 — рядом (4:3),
 * 3 — крупное слева и два справа (5:4), 4 — крупное сверху и три под ним (1:1).
 */
const ALBUM_RATIO: Record<number, number> = { 2: 4 / 3, 3: 5 / 4, 4: 1 };
/**
 * Строка ниже этого (px, в масштабе потолка альбома) — штраф при выборе разбиения на строки. У Telegram — `minPhotoSize`
 * 100 px (tdesktop `chat.style`), Web A `MIN_ITEM_WIDTH`.
 */
export const ALBUM_TILE_MIN = 100;
/** Больше кадров в одной строке не ставим (у Telegram — до 3, средняя из четырёх — до 4): потолок высоты требует широких строк. */
const ALBUM_ROW_MAX = 4;

/** Какой край альбома у плитки снаружи — битами (по ним CSS не ставит отступ: зазор только между плитками). */
export const ALBUM_EDGE = { top: 1, right: 2, bottom: 4, left: 8 } as const;

/** Плитка альбома в px в масштабе потолка `albumGrid` (на экране сетка ужимается пропорционально). */
export interface AlbumTile {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Внешние края — `ALBUM_EDGE` через `|`. */
  edges: number;
}

/** Раскладка альбома: размер всей сетки и плитки в порядке вложений. */
export interface AlbumGrid {
  width: number;
  height: number;
  tiles: AlbumTile[];
}

/** Пропорция кадра (ширина / высота) для раскладки; размера нет (старое вложение) — квадрат, раскладка от загрузки не прыгает. */
export function albumRatio(a: { width?: number | null; height?: number | null }): number {
  const w = a.width ?? 0;
  const h = a.height ?? 0;
  return w > 0 && h > 0 && Number.isFinite(w / h) ? w / h : 1;
}

/** Все разбиения `n` кадров на `rows` строк по 1…`ALBUM_ROW_MAX` кадров (композиции числа). */
function splitsOf(n: number, rows: number): number[][] {
  if (rows === 1) return n >= 1 && n <= ALBUM_ROW_MAX ? [[n]] : [];
  const out: number[][] = [];
  for (let k = 1; k <= ALBUM_ROW_MAX && k < n; k++) for (const rest of splitsOf(n - k, rows - 1)) out.push([k, ...rest]);
  return out;
}

/**
 * Раскладка альбома 5…10 кадров (чистая): пропорции кадров (`albumRatio`) → плитки в потолке `maxW × maxH`. Строками, как
 * ComplexLayouter у Telegram (tdesktop `ui/grouped_layout.cpp`; Web A `calculateAlbumLayout.ts`), алгоритм пересказан
 * своими словами: пропорции поджимаются (в среднем широкие — в 1…2.75, иначе — в 2/3…1); перебираются разбиения на 1–4
 * строки по 1…4 кадра; высота строки — чтобы её кадры заняли всю ширину; выигрывает разбиение, чья общая высота ближе всего
 * к потолку `maxH`, со штрафом за плитки мельче `minTile` (по глубине) и ×1.5 за строку, где кадров больше, чем в следующей. Не от
 * Telegram: потолок высоты (владелец 09.10) — у Telegram он `maxW × 4/3`; выше `maxH` сетка не растёт — ужимается целиком
 * (уже, пропорции те же). Зазор между плитками в расчёте 0 (его ставит CSS, `albumStyle`). Плитки — целые px, строка ровно
 * во всю ширину, колонки и строки состыкованы без щелей.
 */
export function albumGrid(ratios: readonly number[], maxW: number, maxH: number, minTile = ALBUM_TILE_MIN): AlbumGrid {
  const n = ratios.length;
  if (n === 0) return { width: 0, height: 0, tiles: [] };
  const ok = (r: number) => (Number.isFinite(r) && r > 0 ? r : 1);
  // Начало суммы 1 (не 0) — НАМЕРЕННО, как tdesktop `grouped_layout.cpp` (`_averageRatio(ranges::accumulate(_ratios, 1.) / _count)`):
  // сдвиг среднего на 1/n к «широкой» нормализации у альбомов чуть шире квадрата.
  const avg = ratios.reduce((s, r) => s + ok(r), 1) / n;
  const rs = ratios.map((r) => (avg > 1.1 ? Math.min(Math.max(ok(r), 1), 2.75) : Math.min(Math.max(ok(r), 2 / 3), 1)));
  const rowHeights = (split: number[]): number[] => {
    let at = 0;
    return split.map((k) => {
      const sum = rs.slice(at, at + k).reduce((s, r) => s + r, 0);
      at += k;
      return maxW / sum;
    });
  };
  let splits: number[][] = [];
  for (let rows = 1; rows <= 4; rows++) splits.push(...splitsOf(n, rows));
  // Разбиения не нашлось (кадров больше 16) — запасной путь по четыре в строку: `bubbleLook` до сюда не доходит.
  if (!splits.length) splits = [Array.from({ length: Math.ceil(n / ALBUM_ROW_MAX) }, (_, i) => Math.min(ALBUM_ROW_MAX, n - i * ALBUM_ROW_MAX))];
  let best = splits[0]!;
  let bestScore = Infinity;
  for (const split of splits) {
    const hs = rowHeights(split);
    const total = hs.reduce((s, h) => s + h, 0);
    // Главное — чтобы самая мелкая плитка (короткая сторона, уже с поправкой на ужатие под потолок) вышла как можно
    // крупнее; при равенстве — высота ближе к потолку; строка с большим числом кадров, чем у следующей, — штраф 10 %.
    const fit = Math.min(1, maxH / total);
    let at = 0;
    let smallest = Infinity;
    let lastW = 0;
    split.forEach((cols, row) => {
      const sum = rs.slice(at, at + cols).reduce((s, r) => s + r, 0);
      for (let c = 0; c < cols; c++, at++) {
        const w = (rs[at]! / sum) * maxW;
        smallest = Math.min(smallest, hs[row]!, w);
        if (at === n - 1) lastW = w;
      }
    });
    const shrinking = split.some((k, i) => i > 0 && split[i - 1]! > k) ? 0.9 : 1;
    // Время лежит поверх последней плитки: уже `minTile` ей нельзя — время вылезет на соседку (штраф «почти запрет»).
    const timeFits = lastW * fit >= minTile ? 0 : 1000;
    const score = -smallest * fit * shrinking + (10 * Math.abs(total * fit - maxH)) / maxH + timeFits;
    if (score < bestScore) {
      best = split;
      bestScore = score;
    }
  }
  const hs = rowHeights(best);
  const k = Math.min(1, maxH / hs.reduce((s, h) => s + h, 0));
  const width = Math.round(maxW * k);
  const rects: Omit<AlbumTile, 'edges'>[] = [];
  let at = 0;
  let yAcc = 0;
  best.forEach((cols, row) => {
    const y = Math.round(yAcc);
    yAcc += hs[row]! * k;
    const h = Math.round(yAcc) - y;
    const sum = rs.slice(at, at + cols).reduce((s, r) => s + r, 0);
    let xAcc = 0;
    for (let col = 0; col < cols; col++, at++) {
      const x = Math.round(xAcc);
      xAcc += (rs[at]! / sum) * width;
      rects.push({ x, y, w: Math.round(xAcc) - x, h });
    }
  });
  const height = Math.max(...rects.map((t) => t.y + t.h));
  const tiles = rects.map((t) => ({
    ...t,
    edges:
      (t.y === 0 ? ALBUM_EDGE.top : 0) |
      (t.x + t.w === width ? ALBUM_EDGE.right : 0) |
      (t.y + t.h === height ? ALBUM_EDGE.bottom : 0) |
      (t.x === 0 ? ALBUM_EDGE.left : 0),
  }));
  return { width, height, tiles };
}

/** Раскладка альбома сообщения в потолке пузыря `maxW × maxH` (те же размеры, что у одиночного фото). */
export function albumGridOf(atts: readonly { width?: number | null; height?: number | null }[], maxW: number, maxH: number): AlbumGrid {
  return albumGrid(atts.map(albumRatio), maxW, maxH);
}

/** Класс разметки альбома: `attachments album nN`, у 5…10 ещё `tiled` (плитки по `style`, а не шаблон CSS). */
export function albumClass(n: number): string {
  return `attachments album n${n}${n > ALBUM_TEMPLATE_MAX ? ' tiled' : ''}`;
}

/**
 * Стиль сетки альбома 5…10 для разметки `.attachments.album.tiled`: пропорция всей сетки и `--tN` — `inset` N-й плитки в
 * процентах (на телефоне пузырь уже потолка — сетка ужимается целиком, плитки не вылезают). Зазор — `var(--sp-1)`, как в
 * шаблонах 2–4, только на внутренних краях: внешние углы скругляет сам пузырь (`overflow: hidden`).
 */
export function albumStyle(grid: AlbumGrid): Record<string, string> {
  const { width: W, height: H } = grid;
  const pct = (v: number, of: number) => `${of > 0 ? +((v / of) * 100).toFixed(4) : 0}%`;
  const side = (v: number, of: number, outer: boolean) => (outer ? pct(v, of) : `calc(${pct(v, of)} + var(--sp-1) / 2)`);
  const style: Record<string, string> = { aspectRatio: `${W} / ${H}` };
  grid.tiles.forEach((t, i) => {
    style[`--t${i + 1}`] = [
      side(t.y, H, (t.edges & ALBUM_EDGE.top) !== 0),
      side(W - t.x - t.w, W, (t.edges & ALBUM_EDGE.right) !== 0),
      side(H - t.y - t.h, H, (t.edges & ALBUM_EDGE.bottom) !== 0),
      side(t.x, W, (t.edges & ALBUM_EDGE.left) !== 0),
    ].join(' ');
  });
  return style;
}

/** Стиль сетки альбома сообщения: у 2…4 фото `undefined` (шаблон в CSS), у 5…10 — `albumStyle(albumGridOf(…))`. */
export function albumStyleOf(atts: readonly { width?: number | null; height?: number | null }[], maxW: number, maxH: number): Record<string, string> | undefined {
  return atts.length > ALBUM_TEMPLATE_MAX ? albumStyle(albumGridOf(atts, maxW, maxH)) : undefined;
}


const PICTO = /\p{Extended_Pictographic}/u;
const PRESENTED = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|️|‍/u;
/** Из чего может состоять один эмодзи-символ: картинка, оттенок кожи, склейка ZWJ, FE0F, теги флагов регионов. */
const EMOJI_PARTS = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|[\u{E0020}-\u{E007F}])+$/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;
const SPACE = /^\s+$/u;
/** Самый длинный набор из трёх эмодзи с пробелами (семья через ZWJ, флаг региона) в это укладывается с запасом. */
const MAX_LEN = 64;

let segmenter: Intl.Segmenter | null | undefined;

/** Разбивка на видимые символы. Нет `Intl.Segmenter` (старый движок) — `null`, и крупных эмодзи просто не будет. */
function graphemes(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/**
 * Один видимый символ — эмодзи? Флаги (две буквы-региона), «клавиши» (1️⃣ #️⃣) и картинки с модификаторами.
 * ⚠️ Знаки, которые по умолчанию текст (© ™ ‼ ↔), — эмодзи только с FE0F, как их ставит клавиатура: голое «©»
 * крупным рисовать нельзя, это текст.
 */
function isEmojiGrapheme(g: string): boolean {
  if (FLAG.test(g) || KEYCAP.test(g)) return true;
  return EMOJI_PARTS.test(g) && PICTO.test(g) && PRESENTED.test(g);
}

/**
 * Сколько эмодзи в сообщении, если в нём ТОЛЬКО эмодзи (пробелы и переводы строк между ними не в счёт), и их от
 * одного до `JUMBO_MAX`. Иначе 0: есть буква, цифра, знак, кастомное `:имя:` (это текст, картинкой его делает лента
 * сервера) — или эмодзи больше трёх.
 */
export function emojiOnlyCount(content: string): number {
  const text = content.trim();
  if (!text || text.length > MAX_LEN) return 0;
  const seg = graphemes();
  if (!seg) return 0;
  let n = 0;
  for (const { segment } of seg.segment(text)) {
    if (SPACE.test(segment)) continue;
    if (!isEmojiGrapheme(segment) || ++n > JUMBO_MAX) return 0;
  }
  return n;
}

type BubbleSource = Pick<Message, 'content' | 'attachments' | 'replyTo' | 'poll' | 'sticker' | 'forwardedFrom'>;

/** Обычный пузырь с полями — и на время правки на месте: поле ввода живёт только в нём. */
export const TEXT_BUBBLE: BubbleLook = { kind: 'text', jumbo: 0, mediaWidth: null };
const TEXT = TEXT_BUBBLE;

/** Вложение рисуется кадром во всю ширину пузыря: картинка или видео (06.10), но не голосовое. */
function isFrame(x: { contentType: string; waveform?: number[] | null; asFile?: true }): boolean {
  // `asFile` (G48, «Отправить как файлы»): картинка и видео — карточкой файла, не кадром.
  return (x.contentType.startsWith('image/') || x.contentType.startsWith('video/')) && !isVoiceMessage(x) && !x.asFile;
}

/**
 * Вид пузыря сообщения. `maxW × maxH` — потолок картинки в ленте (тот же, что у вложения), из него ширина пузыря с фото.
 *
 * - `sticker` — стикер без подписи, вложений, ответа и не пересланный;
 * - `emoji` — только эмодзи (1…3), без ответа и вложений: ответ рисуется цитатой внутри пузыря, без пузыря ей негде жить.
 *   Пересланное — так же (раунд 12): над ним строка «Переслано от», и ей тоже нужен пузырь;
 * - `media` — ровно одна картинка или видео (06.10: видео в ленте — кадр с ▶, как фото у Telegram) с известным
 *   размером (подпись, ответ и реакции — можно). Размера нет (старое вложение) — у картинки обычный пузырь: без размера
 *   не понять, какой ширины делать пузырь, пока картинка не скачана; у видео — `media` без ширины (`mediaWidth: null`,
 *   пузырь по содержимому): кадр сам берёт размер из метаданных, а в ЛС сервер размер видео пока не хранит;
 * - `media` + `album` — 2…`ALBUM_MAX` картинок и видео вперемешку (не голосовые; размер не нужен — ячейки сетки режут кадр по
 *   себе). 2…4 — шаблоны макета: ширина — чтобы сетка своей пропорции влезла в тот же потолок `maxW × maxH`, что и
 *   одиночное фото; 5…10 (09.10) — плитки «как Telegram» (`albumGridOf`): размер вложения задаёт пропорцию плитки (без
 *   размера — квадрат), ширина — ширина сетки, высота сетки не выше `maxH`, как у альбома из четырёх;
 * - иначе `text`.
 */
export function bubbleLook(m: BubbleSource, maxW: number, maxH: number): BubbleLook {
  const atts = m.attachments ?? [];
  // Пересланное (раунд 12) — как ответ: строке «Переслано от» нужно место в пузыре.
  const framed = !!m.replyTo || !!m.forwardedFrom;
  if (m.sticker) return { kind: !m.content && !atts.length && !framed ? 'sticker' : 'text', jumbo: 0, mediaWidth: null };
  if (m.poll) return TEXT;
  if (!atts.length) {
    const jumbo = framed ? 0 : emojiOnlyCount(m.content);
    return jumbo ? { kind: 'emoji', jumbo, mediaWidth: null } : TEXT;
  }
  const a = atts[0];
  // Кружок (`circles1`, G68) — без пузыря, как стикер у Telegram: круг сам по себе, время — пилюлей под ним.
  if (atts.length === 1 && a?.round === true && a.contentType.startsWith('video/') && !m.content && !framed) {
    return { kind: 'sticker', jumbo: 0, mediaWidth: null };
  }
  if (atts.length >= 2 && atts.length <= ALBUM_MAX && atts.every(isFrame)) {
    const ratio = ALBUM_RATIO[atts.length];
    const width = Math.max(MEDIA_MIN_W, ratio ? Math.min(maxW, Math.floor(maxH * ratio)) : albumGridOf(atts, maxW, maxH).width);
    return { kind: 'media', jumbo: 0, mediaWidth: width, album: atts.length };
  }
  if (atts.length === 1 && a && isFrame(a)) {
    const box = attachmentBox(a.width, a.height, maxW, maxH);
    if (box) return { kind: 'media', jumbo: 0, mediaWidth: Math.max(MEDIA_MIN_W, box.width) };
    // Видео без размера (06.10: в ЛС сервер хранит подсказку размера только у картинок) — всё равно кадр во всю ширину:
    // размер кадр узнаёт сам из метаданных (`VideoAttachment`), пузырь — по содержимому (`mediaWidth: null`).
    if (a.contentType.startsWith('video/')) return { kind: 'media', jumbo: 0, mediaWidth: null };
  }
  return TEXT;
}

/**
 * Что цитируют (раунд 10): текст, фото, голосовое, файл, стикер — или удалённое сообщение. `video` (06.10) — только для
 * значка цитаты (`ReplyQuote`: камера вместо листка файла): `replyQuoteLook` отдаёт видео видом `file` (текст «Видео»
 * тот же), а значок выбирает `replyQuoteVideo`.
 */
export type ReplyKind = 'text' | 'photo' | 'voice' | 'file' | 'video' | 'sticker' | 'deleted';

export interface ReplyQuoteLook {
  kind: ReplyKind;
  /** Вторая строка цитаты: начало текста или словами, что это («Фото», «Голосовое сообщение», имя файла). */
  text: string;
  /** Миниатюра фото или стикера; нет — значок того же размера. */
  thumb?: string;
  /** Миниатюра под спойлером (`media2`): рисуется размытой. */
  spoiler?: true;
}

/** Поля цитаты, по которым её рисуют: текст, «удалено» и (05.10) вид вложений цитируемого от сервера. */
export type ReplyQuoteSource = Pick<
  MessageReplyPreview,
  | 'content'
  | 'deleted'
  | 'attachments'
  | 'attachmentKind'
  | 'attachmentDurationMs'
  | 'attachmentName'
  | 'attachmentVideo'
  | 'attachmentRound'
  | 'thumb'
  | 'thumbSpoiler'
>;

/**
 * Слова о вложении в цитате — ТЕ ЖЕ, что в строке списка бесед (`attachmentWords` из shared, её же зовёт `dmRowRules.dmAttachmentPreview`; решение владельца 08.10,
 * п.30: как Telegram): «Голосовое сообщение», «Видеосообщение», «Видео» — без длительности, файл — просто имя (нет имени —
 * «Файл»). Цитата одного вложения — число 1, имя не склоняется в «N файлов».
 */
function quoteWords(f: Partial<Pick<ConvLastMessage, 'attachmentKind' | 'attachmentName' | 'attachmentVideo' | 'attachmentRound'>>): string {
  return attachmentWords({ kind: f.attachmentKind === 'voice' ? 'voice' : 'file', video: f.attachmentVideo === true, round: f.attachmentRound === true, name: f.attachmentName });
}

/**
 * Цитата в пузыре (раунд 10). Вид вложения берём из САМОГО цитируемого, если оно есть в загруженной ленте (обычно
 * отвечают на недавнее): у него свежая ссылка на фото. Нет его в ленте — по полям сервера в цитате (05.10:
 * `MessageReplyPreview.attachmentKind` и соседи, `thumb` — миниатюра фото ссылкой смотрящего). Нет и их (старый сервер,
 * цитата на текст) — как раньше: текст или «вложение».
 *
 * - удалённое у обоих — `deleted`, «Сообщение удалено»;
 * - стикер — «Стикер»; миниатюра только у картинки (`webp`): анимированный в `<img>` не нарисовать — будет значок;
 * - голосовое — «Голосовое сообщение» (без длительности, п.30 08.10: слова строки списка бесед);
 * - фото (и альбом) — подпись, если была, иначе «Фото»; миниатюра — первое фото (у закрытого файла ЛС ссылки может ещё
 *   не быть — тогда значок);
 * - видео (`video/*`, 05.10) — «Видео» (кружок — «Видеосообщение»), вид `file`: миниатюры у видео нет; значок в
 *   цитате с 06.10 — камера (`replyQuoteVideo`), а не листок файла;
 * - другой файл — имя файла (нет имени — «Файл»), без «Файл: ».
 */
export function replyQuoteLook(
  reply: ReplyQuoteSource,
  original: (Pick<Message, 'attachments' | 'sticker'> & { media?: unknown }) | undefined,
): ReplyQuoteLook {
  if (reply.deleted) return { kind: 'deleted', text: 'Сообщение удалено' };
  // Геопозиция / контакт (G69, `geocontact1`): «Геопозиция» / «Контакт: Имя», а не запасная фраза со ссылкой.
  const media = original?.media ? parseConvMedia(original.media) : null;
  if (media) return { kind: 'text', text: convMediaPreview(media) };
  // Цитата — одной строкой без маркеров формата (G51), скрытый текст закрыт, как в превью списка.
  const caption = stripFormatting(reply.content).trim();
  if (!original) return quoteFromPreview(reply, caption);
  if (original.sticker) {
    return { kind: 'sticker', text: 'Стикер', thumb: original.sticker.format === 'webp' ? original.sticker.url : undefined };
  }
  const a = original.attachments?.[0];
  if (a) {
    if (isVoiceMessage(a)) {
      return { kind: 'voice', text: quoteWords({ attachmentKind: 'voice' }) };
    }
    if (a.contentType.startsWith('image/')) {
      return { kind: 'photo', text: caption || 'Фото', thumb: a.fedState === 'copying' ? undefined : a.url || undefined, ...(a.spoiler && !a.asFile ? { spoiler: true as const } : {}) };
    }
    if (a.contentType.startsWith('video/')) {
      return { kind: 'file', text: quoteWords({ attachmentKind: 'file', attachmentVideo: true, ...(a.round === true ? { attachmentRound: true as const } : {}) }) };
    }
    return { kind: 'file', text: quoteWords({ attachmentKind: 'file', attachmentName: a.name }) };
  }
  return { kind: 'text', text: caption || 'вложение' };
}

/**
 * Цитата на сообщение вне загруженного окна ленты (05.10) — по полям сервера в самой цитате (форма превью строки списка
 * бесед, `ConvLastMessage`). Незнакомый вид (правило 11) и цитата без полей — как раньше: текст или «вложение».
 */
function quoteFromPreview(reply: ReplyQuoteSource, caption: string): ReplyQuoteLook {
  const thumb = typeof reply.thumb === 'string' && reply.thumb ? reply.thumb : undefined;
  const spoiler = thumb && reply.thumbSpoiler === true ? { spoiler: true as const } : {};
  switch (reply.attachmentKind) {
    case 'sticker':
      return { kind: 'sticker', text: 'Стикер', thumb };
    case 'photo':
      return { kind: 'photo', text: caption || 'Фото', thumb, ...spoiler };
    case 'voice':
      return { kind: 'voice', text: quoteWords({ attachmentKind: 'voice' }) };
    case 'file': {
      if (reply.attachmentVideo === true) {
        return { kind: 'file', text: quoteWords({ attachmentKind: 'file', attachmentVideo: true, ...(reply.attachmentRound === true ? { attachmentRound: true as const } : {}) }) };
      }
      return { kind: 'file', text: quoteWords({ attachmentKind: 'file', attachmentName: reply.attachmentName }) };
    }
    default:
      return { kind: 'text', text: caption || 'вложение' };
  }
}

/**
 * Цитата на ВИДЕО (06.10, приёмка на телефоне: у «Видео · 0:10» в цитате стоял значок файла) — значок камеры вместо листка.
 * Те же признаки, что у текста «Видео» в `replyQuoteLook`: цитируемое в ленте — первое вложение `video/*` (голосовое не в
 * счёт: у него свой вид); вне ленты — признак сервера `attachmentVideo` у вида `file`. Удалённое — не видео.
 */
export function replyQuoteVideo(
  reply: ReplyQuoteSource,
  original: Pick<Message, 'attachments' | 'sticker'> | undefined,
): boolean {
  if (reply.deleted) return false;
  if (!original) return reply.attachmentKind === 'file' && reply.attachmentVideo === true;
  if (original.sticker) return false;
  const a = original.attachments?.[0];
  return !!a && !isVoiceMessage(a) && a.contentType.startsWith('video/');
}

/**
 * ✓✓ у своего сохранённого сообщения (Р6, решение владельца 03.10: всегда, без настройки, только 1:1): собеседник
 * прочитал до него — `sortKey <= peerReadKey` (ключ — `convSyncRules.peerReadKeyOf`). Ключа нет (`null`: сервер до
 * `conv4`, сводка из кеша до его обновления, сравнивать не с кем) или у сообщения нет `sortKey` — нет,
 * остаётся ✓ «отправлено».
 */
export function readByPeer(sortKey: number | undefined, peerReadKey: number | null | undefined): boolean {
  return typeof sortKey === 'number' && typeof peerReadKey === 'number' && sortKey <= peerReadKey;
}

/**
 * Что правило серии читает у сообщения (раунд 12): от кого оно переслано. Нет поля или `null` — не пересланное:
 * сервер (`conv5`) шлёт `forwardedFrom` только у пересланных. Подходит любое сообщение беседы (`Message`).
 */
export interface ForwardedSource {
  forwardedFrom?: Pick<MessageForwardedFrom, 'userId'> | null;
}

/**
 * Рисовать ли над сообщением `m` строку «Переслано от <автор оригинала>» (`ForwardedFrom`, раунд 12, HANDOFF §2.4). Как
 * у Telegram: несколько пересланных подряд от ОДНОГО автора оригинала — одна серия, строка только у первого; сменился
 * автор оригинала — новая серия, и строка снова.
 *
 * - `prev` — сообщение ленты прямо перед `m` (`undefined` — `m` первое);
 * - `grouped` — склеен ли пузырь `m` с предыдущим, то есть то же, что класс `grouped` его строки (тот же пересылающий,
 *   в пределах окна, не ответ). Дневная метка между ними склейку рвёт — тогда передавать `false`.
 *
 * Нет строки в двух случаях: `m` не пересланное — вовсе; `m` пересланное, склеено с `prev`, а `prev` — пересланное от
 * того же автора оригинала. Всё остальное — строка есть: первое в серии, сменился автор оригинала, перед ним обычное
 * сообщение, и ⚠️ не склеено (другой пересылающий, пауза, новый день) — это уже отдельный пузырь, и без строки он читался
 * бы как собственные слова пересылающего.
 *
 * Автор оригинала — по `forwardedFrom.userId`: имя — снимок на момент пересылки (у удалённого аккаунта обезличено),
 * ключом оно не годится. Когда рядом с `userId` встанет инстанс (ЛС между инстансами, этап 6) — сравнивать оба здесь.
 */
export function showsForwardedFrom(m: ForwardedSource, prev: ForwardedSource | undefined, grouped: boolean): boolean {
  const from = m.forwardedFrom;
  if (!from) return false;
  const before = prev?.forwardedFrom;
  if (!grouped || !before) return true;
  return before.userId !== from.userId;
}

/**
 * Можно ли открыть профиль автора оригинала нажатием на имя в «Переслано от» (раунд 12, порция 5): у удалённого аккаунта —
 * нет, имя тогда просто текст (`ForwardedFrom` без `onOpen`): профиля больше нет.
 *
 * Удалённого узнаём по признаку сервера `forwardedFrom.deleted` (05.10), а НЕ по имени «Удалённый пользователь»: так может
 * назваться и живой человек — и его имя перестало бы открывать профиль. Сервер старше признака поля не шлёт — тогда имя
 * кнопкой у любого автора оригинала.
 */
export function forwardedAuthorOpenable(from: Pick<MessageForwardedFrom, 'deleted' | 'unverified'>): boolean {
  // Не подтверждено (аудит ЛС #236, п.2): копия соседа приписала пересланное нашему человеку без оригинала — имя текстом.
  return from.deleted !== true && from.unverified !== true;
}
