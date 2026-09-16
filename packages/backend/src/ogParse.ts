/**
 * Разбор `<head>` в карточку. Отдельным модулем БЕЗ импорта базы — иначе тест парсера тянет за собой
 * подключение к Postgres и переменные окружения, то есть не запускается вовсе.
 */
export type ParsedHead = {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
};

const MAX_TITLE = 200;
const MAX_DESC = 400;

/** Мини-декодер сущностей: в OG-тегах живут в основном эти. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};
/**
 * Символ по числовому коду из сущности, с заменой на `�` для всего негодного.
 *
 * ⚠️ Проверять диапазон ОБЯЗАТЕЛЬНО. `String.fromCodePoint` бросает `RangeError` на всём, что
 * больше U+10FFFF, а прежняя страховка `|| 0xfffd` ловила только `NaN` и ноль — то есть
 * `&#99999999;` на чужой странице ронял разбор целиком. Ошибка перехватывалась выше, но карточки
 * предпросмотра страница лишалась навсегда: неудача попадает в кэш.
 *
 * Одиночные суррогаты (D800–DFFF) тоже отсекаем: это не символы, а половинки пары, и в тексте
 * они дают битую строку, которая потом ломает JSON и базу.
 */
function charFromCode(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return String.fromCodePoint(n);
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    const c = code.toLowerCase();
    if (c.startsWith('#x')) return charFromCode(parseInt(c.slice(2), 16));
    if (c.startsWith('#')) return charFromCode(parseInt(c.slice(1), 10));
    return ENTITIES[c] ?? whole;
  });
}

function clean(v: string | null, max: number): string | null {
  if (!v) return null;
  const s = decodeEntities(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Достать значение мета-тега. Порядок атрибутов в разметке произвольный, поэтому ищем тег целиком
 * и разбираем его атрибуты, а не полагаемся на «property идёт раньше content».
 */
function meta(head: string, keys: string[]): string | null {
  // Собираем все мета-теги разом, а потом идём по ключам В ПОРЯДКЕ ПРИОРИТЕТА.
  // Наоборот нельзя: `og:description` обычно стоит в разметке НИЖЕ обычного `description`,
  // и обход по порядку документа отдавал бы худший из двух вариантов.
  const found = new Map<string, string>();
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    const tag = m[0];
    const name = /\b(?:property|name)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!name || found.has(name)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = content?.[1] ?? content?.[2] ?? content?.[3];
    if (v) found.set(name, v);
  }
  for (const k of keys) {
    const v = found.get(k);
    if (v) return v;
  }
  return null;
}

export function parseHead(html: string, baseUrl: string): ParsedHead {
  // Дальше </head> смотреть незачем, а на кривой разметке без </head> хватает первых 64КБ.
  const head = html.split(/<\/head>/i)[0].slice(0, 64 * 1024);
  const title = meta(head, ['og:title', 'twitter:title']) ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? null;
  const description = meta(head, ['og:description', 'twitter:description', 'description']);
  const siteName = meta(head, ['og:site_name']);
  const rawImage = meta(head, ['og:image', 'og:image:url', 'twitter:image']);
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      imageUrl = new URL(decodeEntities(rawImage), baseUrl).toString(); // og:image бывает относительным
    } catch {
      imageUrl = null;
    }
  }
  return {
    title: clean(title, MAX_TITLE),
    description: clean(description, MAX_DESC),
    siteName: clean(siteName, 80),
    imageUrl,
  };
}


/**
 * Описание, дублирующее заголовок, лучше не показывать вовсе.
 *
 * Не придирка: GitHub кладёт в `og:title` строку «GitHub - user/repo: ОПИСАНИЕ», а в
 * `og:description` — «ОПИСАНИЕ - user/repo». В карточке это выглядит как одна и та же фраза,
 * напечатанная дважды. Так делает не только GitHub.
 *
 * Строгого вхождения мало (хвосты у них разные), поэтому сравниваем «скелеты» — только буквы и
 * цифры — и считаем описание лишним, если заметная его часть уже есть в заголовке. Порог с запасом:
 * ошибиться в сторону «показать» дешевле, чем съесть осмысленный текст.
 */
export function isRedundantDescription(title: string | null, description: string | null): boolean {
  if (!title || !description) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const t = norm(title);
  const d = norm(description);
  if (!t || !d) return false;
  if (t.includes(d) || d.includes(t)) return true;
  const probe = d.slice(0, Math.max(20, Math.floor(d.length * 0.6)));
  return probe.length >= 20 && t.includes(probe);
}
