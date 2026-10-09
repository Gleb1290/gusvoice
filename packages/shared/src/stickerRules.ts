/**
 * Правила импорта стикеров из Telegram (#68, часть 2) — ЧИСТЫЕ, без сети и без базы.
 *
 * Живут в `shared`, потому что нужны обеим сторонам: клиент разбирает то, что человек вставил в
 * поле, и показывает ошибку до запроса; сервер обязан проверить то же самое сам — имя набора едет
 * в URL к api.telegram.org, и пускать туда произвольную строку нельзя.
 */

/** Форматы, которые отдаёт Telegram. Больше ничего мы не принимаем. */
export type StickerFormat = 'webp' | 'tgs' | 'webm';

/** Сколько наборов разрешено одному серверу. У self-hosters диск не резиновый. */
export const STICKER_PACKS_PER_SERVER = 12;
/** Потолок на набор — столько же, сколько максимум у Telegram. */
export const STICKERS_PER_PACK = 120;
/**
 * Потолок размера одного стикера. Telegram держит `.webm` в пределах 256 КБ, `.tgs` — 64 КБ,
 * `.webp` — 512 КБ; берём самый большой из них с запасом, чтобы не отсекать легальные файлы.
 */
export const STICKER_MAX_BYTES = 768 * 1024;

/**
 * Имя набора у Telegram: латиница, цифры и подчёркивания, начинается с буквы, до 64 символов.
 *
 * Это НЕ косметика: имя подставляется в путь запроса к Bot API. Без якорей и белого списка сюда
 * пролезет что угодно вида `../../`, и наш сервер начнёт ходить по чужим адресам за наш счёт.
 */
const SET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SetNameCheck = { ok: true; name: string } | { ok: false; error: string };

/**
 * Достать имя набора из того, что человек вставил.
 *
 * Принимаем и голое имя, и ссылку — в Telegram «поделиться набором» даёт именно ссылку, и
 * заставлять вырезать из неё имя руками означает гарантированные ошибки при вводе.
 */
export function parseStickerSetName(raw: string): SetNameCheck {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'вставьте ссылку на набор или его имя' };

  // https://t.me/addstickers/NAME · t.me/addstickers/NAME · tg://addstickers?set=NAME
  const fromLink =
    input.match(/(?:t\.me|telegram\.me)\/addstickers\/([^/?#\s]+)/i)?.[1] ??
    input.match(/addstickers\?set=([^&\s]+)/i)?.[1];
  const name = fromLink ?? input;

  if (!SET_NAME_RE.test(name)) {
    // Отдельная подсказка на «похоже на ссылку, но не на набор» — иначе человек будет гадать,
    // почему ссылка на канал не сработала.
    if (/t\.me|telegram\.me|https?:/i.test(input))
      return { ok: false, error: 'это не ссылка на набор стикеров (нужна вида t.me/addstickers/…)' };
    return { ok: false, error: 'имя набора: латиница, цифры и подчёркивание, начиная с буквы' };
  }
  return { ok: true, name };
}

/**
 * Формат стикера по пути файла из Bot API.
 *
 * Определяем по расширению, а не по MIME: `getFile` отдаёт только `file_path`, MIME в ответе нет.
 */
export function stickerFormatFromPath(path: string): StickerFormat | null {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'webp' || ext === 'png') return 'webp';
  if (ext === 'tgs') return 'tgs';
  if (ext === 'webm') return 'webm';
  return null;
}

/** MIME для заливки в бакет — по формату, потому что от Telegram его не приходит. */
export const STICKER_MIME: Record<StickerFormat, string> = {
  // `.tgs` — это gzip'нутый JSON. Отдаём как gzip, чтобы промежуточные прокси его не «помогли» распаковать.
  tgs: 'application/gzip',
  webm: 'video/webm',
  webp: 'image/webp',
};

export type PackCheck = { ok: true } | { ok: false; error: string };

/** Можно ли принять набор такого размера при таком количестве уже импортированных. */
export function checkPackImport(stickerCount: number, existingPacks: number): PackCheck {
  if (stickerCount <= 0) return { ok: false, error: 'в наборе нет стикеров' };
  if (stickerCount > STICKERS_PER_PACK)
    return { ok: false, error: `в наборе больше ${STICKERS_PER_PACK} стикеров` };
  if (existingPacks >= STICKER_PACKS_PER_SERVER)
    return { ok: false, error: `на сервере уже ${STICKER_PACKS_PER_SERVER} наборов — удалите лишние` };
  return { ok: true };
}

// ── Каталог наборов инстанса и «мои наборы» (С2, #211, признак `stickers2`) ─────────────────────────────────────────

/**
 * Сколько наборов один человек может привезти в каталог инстанса (решение владельца, 07.10). Считаются только
 * загруженные им самим: «Добавить» уже лежащего в каталоге набора ничего не качает и предел не тратит.
 */
export const STICKER_PACKS_PER_USER = 40;
/** Сколько наборов может стоять в «моих» — с запасом над Telegram (200), чтобы порядок не стал тяжёлым запросом. */
export const MY_STICKER_PACKS_MAX = 200;

/** Можно ли человеку загрузить в каталог ещё один набор, если он уже загрузил `uploaded`. */
export function checkUserPackQuota(uploaded: number): PackCheck {
  if (uploaded >= STICKER_PACKS_PER_USER)
    return {
      ok: false,
      error: `Вы уже загрузили ${STICKER_PACKS_PER_USER} наборов — больше нельзя. Удалите свой ненужный набор из каталога.`,
    };
  return { ok: true };
}

/**
 * Поиск по каталогу: по названию и по имени набора у Telegram, без учёта регистра и буквы «ё». Пустой запрос — всё.
 */
export function stickerPackMatches(pack: { title: string; name: string }, query: string): boolean {
  const norm = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
  const q = norm(query);
  if (!q) return true;
  return norm(pack.title).includes(q) || norm(pack.name).includes(q);
}

/**
 * Новый порядок «моих наборов»: `requested` обязан быть ПЕРЕСТАНОВКОЙ текущих `current` (ни лишних, ни пропущенных,
 * ни повторов) — иначе `null`. Порядок от клиента, который за это время добавил набор на другом устройстве, отбивается,
 * а не теряет набор молча.
 */
export function reorderStickerPacks(current: readonly string[], requested: readonly string[]): string[] | null {
  if (requested.length !== current.length) return null;
  const have = new Set(current);
  const seen = new Set<string>();
  for (const id of requested) {
    if (!have.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return [...requested];
}

/**
 * Избранные стикеры (С2 порция 2, признак `stickers3`): не больше пяти — как `stickers_faved_limit_default` у Telegram
 * (tdesktop `data_premium_limits.cpp`); шестой вытесняет самый старый (`Stickers::checkFavedLimit`).
 */
export const STICKERS_FAVED_MAX = 5;
/** Недавние стикеры на сервере — столько же, сколько показывает панель Telegram на ПК (`kRecentDisplayLimit` = 20). */
export const STICKERS_RECENT_MAX = 20;

/**
 * Список «новый первым» после добавления `id`: прежняя копия уходит, хвост за `max` отрезается. Возвращает и то, что
 * отрезано (их строки сервер стирает) — чистое правило и для избранных, и для недавних.
 */
export function pushStickerId(list: readonly string[], id: string, max: number): { list: string[]; dropped: string[] } {
  const next = [id, ...list.filter((x) => x !== id)];
  const keep = Math.max(0, max);
  return { list: next.slice(0, keep), dropped: next.slice(keep) };
}
