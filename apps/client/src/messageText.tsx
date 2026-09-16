import { MENTION_LEFT_GUARD, MENTION_NAME_SRC } from '@gusvoice/shared';
import { useState } from 'react';

/**
 * Message text → React elements. Markdown subset, spoilers, links and mentions.
 *
 * Everything is built as React nodes — no `dangerouslySetInnerHTML` anywhere, so a message CANNOT
 * inject markup no matter what it contains. That's the whole security model here: user text never
 * becomes HTML, it becomes text nodes inside elements we chose.
 *
 * Supported: `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `` `code` ``, ```fenced blocks```,
 * `> quote`, `||spoiler||`, bare http(s) links, @mentions. Deliberately NOT a full Markdown: no
 * images, no raw HTML, no link syntax with a custom label — a label that lies about its destination
 * is the oldest phishing trick there is, and the URL is what we want people to read.
 */

/**
 * Подсветка упоминания идёт по ОБЩЕМУ правилу (`shared/mentions.ts`) — тому же, по которому
 * приходит звук и пуш. Раньше здесь был свой, более широкий набор символов (`\p{L}\p{N}`), и
 * подсветка врала: `@Маша` выглядел упоминанием, хотя имён с кириллицей не бывает и никого он не
 * пингует, а кусок чужой почты `user@super.dev` подсвечивался целиком.
 */
const MENTION_TEST = new RegExp(`^@${MENTION_NAME_SRC}$`);

/** One pass over inline syntax. Order matters: code first (it swallows everything else inside). */
const INLINE = new RegExp(
  [
    '(`[^`\\n]+`)', // 1 code
    '(\\|\\|[\\s\\S]+?\\|\\|)', // 2 spoiler
    '(\\*\\*[^*\\n]+\\*\\*)', // 3 bold
    '(~~[^~\\n]+~~)', // 4 strike
    '(\\*[^*\\n]+\\*)', // 5 italic *
    // 6 italic _ — with word boundaries, so snake_case_names and my_file_name.txt stay literal
    '((?<![\\p{L}\\p{N}])_[^_\\n]+_(?![\\p{L}\\p{N}]))',
    '(https?://[^\\s<>"]+)', // 7 link
    `${MENTION_LEFT_GUARD}(@${MENTION_NAME_SRC})`, // 8 mention
    // 9 кастомное эмодзи сервера `:name:` (#18). Перед двоеточием обязан идти НЕ буквенно-цифровой
    // символ и не двоеточие — иначе `10:30:00` превращается в эмодзи `:30:`, а `host:8080:` в `:8080:`.
    '((?<![\\p{L}\\p{N}_:]):[a-z0-9_]{2,32}:)',
  ].join('|'),
  'gu',
);

/** Trailing punctuation shouldn't be swallowed by a bare URL: "см. https://a.com/x." */
function splitTrailingPunct(url: string): [string, string] {
  const m = url.match(/[.,;:!?)\]]+$/);
  if (!m) return [url, ''];
  // A closing paren only counts as punctuation if it isn't balanced by one inside the URL.
  const tail = m[0];
  const opens = (url.match(/\(/g) ?? []).length;
  const closes = (url.match(/\)/g) ?? []).length;
  const cut = tail === ')' && closes <= opens ? '' : tail;
  return cut ? [url.slice(0, -cut.length), cut] : [url, ''];
}

function Spoiler({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`spoiler ${open ? 'open' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={open ? 'Спойлер раскрыт' : 'Спойлер — нажми, чтобы показать'}
      onClick={() => setOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      {children}
    </span>
  );
}

/**
 * Inline pass. `onLink` renders a URL — the caller decides what clicking it does.
 *
 * 🔴 Идём через `matchAll`, а НЕ через `INLINE.exec` в цикле. Функция рекурсивна (внутренность
 * жирного/курсива/спойлера разбирается ею же), а `INLINE` — один объект на модуль с флагом `g`,
 * то есть с общим `lastIndex`. Вложенный вызов сбрасывал его в 0, внешний цикл после возврата
 * начинал скан заново, снова находил тот же фрагмент — и так до бесконечности. Любое сообщение
 * с `*курсивом*` вешало вкладку и съедало память ВСЕМ, кто его отрисует. `matchAll` работает с
 * внутренней копией регулярки, поэтому рекурсия ей не мешает.
 */
function inline(
  text: string,
  key: string,
  onLink: (url: string, key: string) => React.ReactNode,
  onEmoji?: EmojiResolver,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    const [, code, spoiler, bold, strike, ital1, ital2, link, mention, emoji] = m;
    if (code) {
      out.push(
        <code className="md-code" key={k}>
          {code.slice(1, -1)}
        </code>,
      );
    } else if (spoiler) {
      out.push(<Spoiler key={k}>{inline(spoiler.slice(2, -2), k, onLink, onEmoji)}</Spoiler>);
    } else if (bold) {
      out.push(<strong key={k}>{inline(bold.slice(2, -2), k, onLink, onEmoji)}</strong>);
    } else if (strike) {
      out.push(<s key={k}>{inline(strike.slice(2, -2), k, onLink, onEmoji)}</s>);
    } else if (ital1 || ital2) {
      const raw = (ital1 ?? ital2) as string;
      out.push(<em key={k}>{inline(raw.slice(1, -1), k, onLink, onEmoji)}</em>);
    } else if (link) {
      const [url, punct] = splitTrailingPunct(link);
      out.push(onLink(url, k));
      if (punct) out.push(punct);
    } else if (mention && MENTION_TEST.test(mention)) {
      out.push(
        <span className="mention" key={k}>
          {mention}
        </span>,
      );
    } else if (emoji) {
      // Кастомное эмодзи сервера. Не нашлось (не тот сервер, удалили, ЛС) — показываем `:имя:`
      // как обычный текст: подменять его пустотой значило бы съесть кусок сообщения.
      const url = onEmoji?.(emoji.slice(1, -1));
      out.push(
        url ? (
          <img className="custom-emoji" key={k} src={url} alt={emoji} title={emoji} loading="lazy" />
        ) : (
          emoji
        ),
      );
    } else {
      // Совпало, но ни одна ветка не взяла — отдаём как есть. Без этого расхождение между
      // регуляркой и ветками молча СЪЕЛО БЫ кусок сообщения, и заметить это было бы нечем.
      out.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Имя кастомного эмодзи → URL картинки, либо null.
 *
 * Резолвер ПЕРЕДАЁТСЯ, а не берётся из стора: эмодзи серверные, а `renderMessageText` работает и
 * в личных сообщениях, где сервера нет. Тот же приём, что с никами (#73) — и по той же причине.
 */
export type EmojiResolver = (name: string) => string | null;

/**
 * Block pass: fenced code blocks and `>` quotes, then inline within everything else.
 * Returns React nodes ready to render inside the message body.
 */
export function renderMessageText(
  content: string,
  onLink: (url: string, key: string) => React.ReactNode,
  onEmoji?: EmojiResolver,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Split on fenced blocks first so nothing inside them is interpreted.
  const parts = content.split(/(```[\s\S]*?```)/g);
  parts.forEach((part, pi) => {
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const body = part.slice(3, -3).replace(/^[a-zA-Z0-9]*\n/, ''); // drop an optional language tag
      out.push(
        <pre className="md-pre" key={`p${pi}`}>
          <code>{body.replace(/\n$/, '')}</code>
        </pre>,
      );
      return;
    }
    // Quote lines are grouped so consecutive `>` lines become one block.
    const lines = part.split('\n');
    let quote: string[] = [];
    const flushQuote = (idx: number) => {
      if (!quote.length) return;
      const text = quote.join('\n');
      out.push(
        <blockquote className="md-quote" key={`q${pi}-${idx}`}>
          {inline(text, `q${pi}-${idx}`, onLink, onEmoji)}
        </blockquote>,
      );
      quote = [];
    };
    lines.forEach((line, li) => {
      if (/^\s*>\s?/.test(line)) {
        quote.push(line.replace(/^\s*>\s?/, ''));
        return;
      }
      flushQuote(li);
      out.push(...inline(line, `l${pi}-${li}`, onLink, onEmoji));
      if (li < lines.length - 1) out.push('\n');
    });
    flushQuote(lines.length);
  });
  return out;
}
