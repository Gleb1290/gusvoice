/**
 * Разметка текста сообщения без разметки — для превью в списке бесед, пуша и уведомлений (G51, #211).
 *
 * Сообщение хранит формат ВНУТРИ текста, маркерами (`**жирный**`, `__курсив__`, `<u>подчёркнутый</u>`, `~~зачёркнутый~~`,
 * `` `код` ``, ```` ```блок``` ````, `||скрытый||`, строки `> цитаты`). Рисует их `messageText.tsx` клиента; здесь — та же
 * грамматика, но в обратную сторону: снять маркеры и оставить слова. Как у Telegram: в списке чатов и в уведомлении формат
 * не виден, а звёздочек нет.
 *
 * Маркеры markdown — как у Telegram при отправке (02·4.6; `telegram-tt util/parseHtmlAsFormattedText.ts`, `parseMarkdown`:
 * `**`, `__`, `~~`, `||`, `` ` ``, ```` ``` ````); у подчёркнутого маркера нет — берём тег HTML-разметки Telegram `<u>`.
 *
 * ⚠️ Грамматика обязана совпадать с `messageText.tsx` (`INLINE`): маркер, который рисуется форматом, здесь снимается, и
 * наоборот — то, что рендер оставляет буквами (`snake_case`, `2*3`), здесь тоже остаётся.
 */

/** Маркеры строчных форматов: открывающий и закрывающий. Подчёркнутый — как в HTML-разметке Telegram (`<u>`). */
export const FORMAT_MARKERS = {
  bold: ['**', '**'],
  italic: ['__', '__'],
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
  spoiler: ['||', '||'],
  mono: ['`', '`'],
} as const;

export type InlineFormat = keyof typeof FORMAT_MARKERS;

/** Строчные форматы одним проходом. Порядок важен: код первым (внутри него ничего не разбирается). */
const STRIP = new RegExp(
  [
    '(`[^`\\n]+`)', // 1 code
    '(\\|\\|[\\s\\S]+?\\|\\|)', // 2 spoiler
    '(\\*\\*[^*\\n]+\\*\\*)', // 3 bold
    '(~~[^~\\n]+~~)', // 4 strike
    '(<u>[^\\n]+?</u>)', // 5 underline
    '((?<![\\p{L}\\p{N}_])__[^\\n]+?__(?![\\p{L}\\p{N}_]))', // 6 italic __ (Telegram)
    '(\\*[^*\\n]+\\*)', // 7 italic *
    '((?<![\\p{L}\\p{N}])_[^_\\n]+_(?![\\p{L}\\p{N}]))', // 8 italic _
    '(https?://[^\\s<>"]+)', // 9 ссылка целиком — `_` внутри адреса не курсив
  ].join('|'),
  'gu',
);

export interface StripOptions {
  /** Скрытый текст: `hide` — заменить знаками (превью, пуш: спойлер не должен читаться), `keep` — оставить слова. */
  spoiler?: 'hide' | 'keep';
}

/**
 * Чем закрыт скрытый текст в превью и пуше — знак `▚` (U+259A) на каждую букву, как в уведомлениях Telegram Desktop
 * (`tdesktop window/notifications_manager.cpp`, `TextWithPermanentSpoiler`). Web A ставит случайные знаки Брайля той же
 * длины (`telegram-tt global/helpers/messageSummary.ts`, `generateBrailleSpoiler`) — берём ПК-вариант: он детерминирован.
 */
export const SPOILER_MASK = '▚';

function stripInline(text: string, o: Required<StripOptions>): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(STRIP)) {
    out += text.slice(last, m.index);
    const [all, code, spoiler, bold, strike, under, ital2, ital1, ital0, link] = m;
    if (code) out += code.slice(1, -1);
    else if (spoiler) {
      const inner = stripInline(spoiler.slice(2, -2), o);
      out += o.spoiler === 'keep' ? inner : SPOILER_MASK.repeat([...inner].length);
    } else if (bold) out += stripInline(bold.slice(2, -2), o);
    else if (strike) out += stripInline(strike.slice(2, -2), o);
    else if (under) out += stripInline(under.slice(3, -4), o);
    else if (ital2) out += stripInline(ital2.slice(2, -2), o);
    else if (ital1 || ital0) out += stripInline((ital1 ?? ital0)!.slice(1, -1), o);
    else if (link) out += link;
    else out += all;
    last = m.index + all.length;
  }
  return out + text.slice(last);
}

/**
 * Текст сообщения без маркеров формата: блоки кода — их содержимым (без строки языка), `> ` в начале строк снят, строчные
 * форматы — словами, скрытый — знаками `▚` (или словами при `spoiler: 'keep'`). Ссылки, упоминания и `:эмодзи:` — как есть.
 */
export function stripFormatting(text: string, opts: StripOptions = {}): string {
  const o: Required<StripOptions> = { spoiler: opts.spoiler ?? 'hide' };
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
        return part.slice(3, -3).replace(/^[a-zA-Z0-9]*\n/, '').replace(/\n$/, '');
      }
      return part
        .split('\n')
        .map((line) => stripInline(line.replace(/^\s*>\s?/, ''), o))
        .join('\n');
    })
    .join('');
}
