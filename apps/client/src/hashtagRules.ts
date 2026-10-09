/**
 * Подсказка `#` в поле ввода бесед (08.10, #211, G36; Telegram Desktop `chat_helpers/field_autocomplete.cpp` `Type::Hashtags`,
 * `storage/localstorage.cpp: incrementRecentHashtag`, `storage_account.cpp: saveRecentHashtags`).
 *
 * У Telegram `#` в поле показывает НЕДАВНО ПИСАННЫЕ тобой хэштеги (не каналы и не поиск по серверу): они копятся из отправленных
 * сообщений, список — пары «тег, сколько раз», не длиннее 64, по убыванию счётчика, а при равных свежий впереди. Фильтр —
 * по началу слова без учёта регистра; тег, равный набранному целиком, не предлагается. Пусто после `#` — весь список.
 * Правила — чистые; хранилище — localStorage устройства (у Telegram список тоже локальный).
 */

export interface RecentHashtag {
  tag: string;
  count: number;
}

export const RECENT_HASHTAGS_MAX = 64;
/** Счётчик выше этого — все счётчики делятся пополам (у Telegram `0x4000`), чтобы старые давнишние лидеры не застывали. */
const COUNT_CEIL = 0x4000;
const KEY = 'gv.recentHashtags';

/**
 * Ключ списка на устройстве. У каждого аккаунта на одном устройстве свой список (решение владельца 08.10: чужие теги чужого
 * аккаунта не подсказываются) — к ключу добавляется id пользователя; без id (нет входа) — прежний общий ключ.
 */
export function recentHashtagsKey(userId?: string | null): string {
  return userId ? `${KEY}.${userId}` : KEY;
}

/** Хэштеги текста (без `#`): после начала строки или разделителя, 2–64 букв/цифр/`_`; одни цифры — не хэштег (`#1`, `#12`). */
export function extractHashtags(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s.,:;!?()[\]{}"'<>|\/=+*~-])#([\p{L}\p{N}_]{2,64})(?![\p{L}\p{N}_#])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (/^\d+$/.test(m[2])) continue;
    out.push(m[2]);
  }
  return out;
}

/** Один тег записан ещё раз (`incrementRecentHashtag`): счётчик растёт, тег всплывает над теми, у кого счётчик не больше. */
export function incrementHashtag(recent: readonly RecentHashtag[], tag: string): RecentHashtag[] {
  const list = recent.map((r) => ({ ...r }));
  let i = list.findIndex((r) => r.tag === tag);
  if (i >= 0) {
    list[i].count++;
    if (list[i].count > COUNT_CEIL) for (const r of list) r.count = r.count > 1 ? Math.floor(r.count / 2) : r.count > 0 ? 1 : 0;
  } else {
    while (list.length >= RECENT_HASHTAGS_MAX) list.pop();
    list.push({ tag, count: 1 });
    i = list.length - 1;
  }
  for (; i > 0; i--) {
    if (list[i - 1].count > list[i].count) break;
    [list[i], list[i - 1]] = [list[i - 1], list[i]];
  }
  return list;
}

/** Хэштеги отправленного текста — в список недавних. */
export function recordHashtags(recent: readonly RecentHashtag[], text: string): RecentHashtag[] {
  return extractHashtags(text).reduce<RecentHashtag[]>((acc, t) => incrementHashtag(acc, t), [...recent]);
}

/** Подсказки по набранному после `#` (`query` без решётки): началу без учёта регистра; равный целиком — пропускается; не больше `limit`. */
export function matchHashtags(recent: readonly RecentHashtag[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  return recent
    .map((r) => r.tag)
    .filter((t) => !q || (t.length !== q.length && t.toLowerCase().startsWith(q)))
    .slice(0, limit);
}

/** Убрать тег из списка (у Telegram — крестик в строке подсказки). */
export function forgetHashtag(recent: readonly RecentHashtag[], tag: string): RecentHashtag[] {
  return recent.filter((r) => r.tag !== tag);
}

export function loadRecentHashtags(userId?: string | null): RecentHashtag[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentHashtagsKey(userId)) || '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((r) => r && typeof r.tag === 'string' && typeof r.count === 'number')
      .map((r) => ({ tag: r.tag as string, count: r.count as number }))
      .slice(0, RECENT_HASHTAGS_MAX);
  } catch {
    return [];
  }
}

export function saveRecentHashtags(list: readonly RecentHashtag[], userId?: string | null): void {
  try {
    localStorage.setItem(recentHashtagsKey(userId), JSON.stringify(list));
  } catch {
    /* хранилище недоступно — подсказка просто не накопится */
  }
}

/** Прочитать список, учесть отправленный текст, записать обратно. */
export function rememberSentHashtags(text: string, userId?: string | null): void {
  if (!text.includes('#')) return;
  const before = loadRecentHashtags(userId);
  const after = recordHashtags(before, text);
  if (after.length !== before.length || after.some((r, i) => r.tag !== before[i]?.tag || r.count !== before[i]?.count)) saveRecentHashtags(after, userId);
}
