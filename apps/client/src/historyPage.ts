import type { Message } from '@gusvoice/shared';

/**
 * Порции истории ленты (каналы и ЛС) — чистые правила, без стора и сети (#212, этап 0 плана ЛС).
 *
 * Здесь собрано то, что раньше жило внутри `store.ts` и ломалось незаметно:
 * - курсор «дай старше» был одним временем, и соседи по миллисекунде на границе порции терялись;
 * - перечитка ленты (открытие, пробуждение) ЗАМЕНЯЛА загруженное последней порцией — подгруженная
 *   прокруткой история пропадала, а сообщение, пришедшее по сокету, пока шёл запрос, исчезало.
 */

/** Размер порции — столько сервер отдаёт без `limit` (`routes/messages.ts`, `routes/dm.ts`). */
export const HISTORY_PAGE = 50;

/**
 * Порядок ленты: время, при равенстве — id. Так же сортирует сервер (с 28.09), поэтому граница
 * порции у обоих одна и та же.
 * ⚠️ Время у клиента — миллисекунды, у базы — микросекунды: два сообщения одной миллисекунды клиент
 * может поставить не в том порядке, что сервер. Для склейки это безопасно — курсор идёт по id, а
 * не по времени, и сервер сам берёт точное время из строки.
 */
export function compareMessages(a: Pick<Message, 'createdAt' | 'id'>, b: Pick<Message, 'createdAt' | 'id'>): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Курсор для следующей порции вглубь: самое старое загруженное. `null` — грузить не от чего. */
export function olderCursor(list: readonly Message[]): { before: string; beforeId: string } | null {
  const oldest = list[0];
  if (!oldest) return null;
  return { before: new Date(oldest.createdAt).toISOString(), beforeId: oldest.id };
}

/** Есть ли смысл просить ещё: неполная порция — дно. */
export function hasMoreOlder(page: readonly Message[]): boolean {
  return page.length >= HISTORY_PAGE;
}

/**
 * Влить более старую порцию в начало ленты.
 * ⚠️ Склейка по id: пока шёл запрос, кто-то мог прислать сообщение, а порция — пересечься с уже
 * загруженным. Дубликат в ленте заметнее, чем лишняя проверка.
 */
export function mergeOlderPage(cur: readonly Message[], older: readonly Message[]): Message[] {
  const have = new Set(cur.map((m) => m.id));
  const fresh = older.filter((m) => !have.has(m.id));
  return [...fresh, ...cur];
}

/**
 * Влить свежую ПОСЛЕДНЮЮ порцию (открытие ленты, пробуждение, переподключение) в то, что уже есть.
 *
 * 🔴 Раньше порция просто заменяла кеш. Итог: прокрутил историю на 300 сообщений назад, ноутбук
 * уснул — после пробуждения осталось 50, а сообщение, долетевшее по сокету, пока шёл запрос,
 * пропадало до следующего открытия.
 *
 * Правило:
 * - кеша нет → порция;
 * - порция неполная → это ВСЯ история: старше в кеше быть нечему (удалённое уйдёт);
 * - кеш заходит в порцию (есть сообщение не старше её начала) → старое из кеша + порция: дыры нет;
 * - кеш целиком старше порции → между ними могла быть дыра (проспал больше порции) — берём только
 *   порцию, старое догрузится прокруткой;
 * - в любом случае сохраняем из кеша то, что НОВЕЕ порции и в ней отсутствует: это пришло по сокету,
 *   пока шёл запрос.
 * Внутри окна порции истина — порция: удалённое пропадает, правка приезжает.
 */
export function mergeLatestPage(cur: readonly Message[] | undefined, page: readonly Message[]): Message[] {
  if (!cur || cur.length === 0) return [...page];
  const first = page[0];
  const last = page[page.length - 1];
  const inPage = new Set(page.map((m) => m.id));
  const newer = last ? cur.filter((m) => !inPage.has(m.id) && compareMessages(m, last) > 0) : [];
  if (!first) return newer;
  if (!hasMoreOlder(page)) return [...page, ...newer];
  const overlaps = cur.some((m) => compareMessages(m, first) >= 0);
  const older = overlaps ? cur.filter((m) => !inPage.has(m.id) && compareMessages(m, first) < 0) : [];
  return [...older, ...page, ...newer];
}
