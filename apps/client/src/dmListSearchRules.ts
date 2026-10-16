/**
 * Поиск из списка бесед ЛС (G35 темы 14 плейбука, #211, волна 5; признак сервера `gsearch1`) — ЧИСТЫЕ правила.
 *
 * Источники (Telegram): Android `ui/DialogsActivity.java` + `ui/Adapters/DialogsSearchAdapter.java` («Недавние» с очисткой,
 * «Люди» — полоса `ChatHints`, «Сообщения» под найденными беседами), `ui/Adapters/FiltersView.java` (чипы: `FILTER_TYPE_CHAT` —
 * человек/беседа, `FILTER_TYPE_DATE` — дата; подсказки строятся из набранного текста, `getDatesFromQuery`), tdesktop
 * `dialogs/dialogs_widget.cpp` (пустое поле при фокусе — «недавние» и частые; история запросов — `Dialogs::Widget::searchCursorMoved`).
 * Чипы типа (Медиа / Ссылки / Файлы / Голосовые / GIF) — tweb `components/appSearchSuper.ts` (вкладки), telegram-tt `LeftSearch`; на сервере
 * вид считает та же функция, что у «Общих медиа» (`gv_media_count`, параметр `kind` ручки поиска).
 *
 * Хранится на устройстве (`gv_dm_search_recent`): у Telegram история поиска живёт у сервера аккаунта, у нас — как кеш клиента.
 */
import { matchDmName, matchDmUsername } from './dmRowRules';
import { SHARED_MEDIA_KINDS, type ConvFrequentItem, type DmChannel, type SharedMediaKind } from '@gusvoice/shared';
import { SHARED_MEDIA_TITLES } from './sharedMediaRules';

/** Сколько записей держит «Недавние» (Telegram Android: `DialogsSearchAdapter.maxRecents`-порядок — десяток). */
export const RECENT_MAX = 12;
/** Сколько людей в полосе «Люди» (Telegram Desktop: одна строка частых). */
export const PEOPLE_MAX = 10;
/** Пауза набора перед запросом по тексту сообщений. */
export const MESSAGE_SEARCH_DELAY_MS = 300;
/** Порция результатов по сообщениям (сервер: до 50). */
export const MESSAGE_SEARCH_PAGE = 20;

export const RECENT_STORAGE_KEY = 'gv_dm_search_recent';

/** Запись «Недавних»: запрос текстом или беседа с человеком (`convId` — её id в списке). */
export type RecentSearch = { kind: 'query'; text: string } | { kind: 'person'; convId: string };

export function sameRecent(a: RecentSearch, b: RecentSearch): boolean {
  return a.kind === b.kind && (a.kind === 'query' ? a.text.toLowerCase() === (b as { text: string }).text.toLowerCase() : a.convId === (b as { convId: string }).convId);
}

/** Новая запись — наверх, повтор уезжает на своё прежнее место (не двоится), лишнее обрезается. Пустой запрос — не запись. */
export function pushRecent(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
  if (entry.kind === 'query') {
    const text = entry.text.trim();
    if (text.length < 2) return [...list];
    entry = { kind: 'query', text };
  }
  return [entry, ...list.filter((x) => !sameRecent(x, entry))].slice(0, RECENT_MAX);
}

export function removeRecent(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
  return list.filter((x) => !sameRecent(x, entry));
}

/** Разбор сохранённого: мусор и лишние поля отбрасываются, не падаем. */
export function parseRecent(raw: string | null | undefined): RecentSearch[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: RecentSearch[] = [];
    for (const x of v) {
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (o.kind === 'query' && typeof o.text === 'string' && o.text.trim()) out.push({ kind: 'query', text: o.text });
        else if (o.kind === 'person' && typeof o.convId === 'string' && o.convId) out.push({ kind: 'person', convId: o.convId });
      }
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** «Люди»: беседы, в которых писали последними (частота — по свежести, как у `byRecent`); архивные тоже (решение владельца 08.10, как Telegram: top peers не смотрит на архив), без собеседника — мимо. */
export function peopleStrip(dms: readonly DmChannel[], limit: number = PEOPLE_MAX): DmChannel[] {
  return dms
    .filter((d) => !d.otherUser.id.startsWith('gone:'))
    .slice()
    .sort((a, b) => (Date.parse(b.lastMessageAt ?? b.createdAt) || 0) - (Date.parse(a.lastMessageAt ?? a.createdAt) || 0))
    .slice(0, limit);
}

/** Сколько бесед в полосе «Частые» (Telegram Desktop `data/components/top_peers.cpp`: `kLimit` = 64 с «Показать все»; у нас — одна прокручиваемая строка). */
export const FREQUENT_MAX = 15;
/** Сколько «убранных из частых» помним (старейшие забываются). */
export const FREQUENT_HIDDEN_MAX = 100;
export const FREQUENT_HIDDEN_KEY = 'gv_dm_frequent_hidden';

/** Убранные из «Частых»: id беседы → когда убрана (ISO). Аналог `contacts.resetTopPeerRating`: беседа возвращается, когда я снова в неё написал. */
export type FrequentHidden = Record<string, string>;

/** Разбор сохранённого: мусор отбрасывается, не падаем. */
export function parseFrequentHidden(raw: string | null | undefined): FrequentHidden {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: FrequentHidden = {};
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
      if (k && typeof t === 'string' && Number.isFinite(Date.parse(t))) out[k] = t;
    }
    return out;
  } catch {
    return {};
  }
}

/** Убрать беседу из «Частых» «сейчас»; запомненных больше `FREQUENT_HIDDEN_MAX` — самые старые забываются. */
export function hideFrequent(hidden: FrequentHidden, convId: string, nowIso: string): FrequentHidden {
  const next = { ...hidden, [convId]: nowIso };
  const keys = Object.keys(next);
  if (keys.length <= FREQUENT_HIDDEN_MAX) return next;
  keys.sort((a, b) => Date.parse(next[b]) - Date.parse(next[a]));
  return Object.fromEntries(keys.slice(0, FREQUENT_HIDDEN_MAX).map((k) => [k, next[k]]));
}

/**
 * «Частые» (G35, `freq1`): порядок и счёт — сервера (`GET /conv/frequent`), отсев — здесь, по меткам, которые есть у клиента:
 * архивные беседы, заблокированные собеседники, «Избранное» (у Telegram top peers себя не содержат) и беседы без собеседника (`gone:`) —
 * мимо. Убранная вручную возвращается, когда мой последний вклад новее момента «убрать» (`lastAt` > `hidden[id]`).
 */
export function frequentStrip(
  items: readonly ConvFrequentItem[],
  dms: readonly DmChannel[],
  hidden: FrequentHidden,
  blockedIds: ReadonlySet<string>,
  limit: number = FREQUENT_MAX,
): DmChannel[] {
  const byId = new Map(dms.map((d) => [d.id, d]));
  const out: DmChannel[] = [];
  for (const it of items) {
    const d = byId.get(it.conversationId);
    if (!d || d.archived === true || d.saved === true) continue;
    if (d.otherUser.id.startsWith('gone:') || blockedIds.has(d.otherUser.id)) continue;
    const h = hidden[d.id];
    if (h !== undefined && !(Date.parse(it.lastAt) > Date.parse(h))) continue;
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

/** Чип «человек»: беседа, в которой ищем (в 1:1 — беседа с этим человеком). */
export interface PersonChip {
  convId: string;
  name: string;
}

/** Чип «дата»: период `[since, until)` и подпись. */
export interface DateChip {
  label: string;
  since: string;
  until: string;
}

/** Чип «тип» (G35): вид вложения — те же пять, что вкладки «Общих медиа» (tweb `appSearchSuper`, telegram-tt `LeftSearch`). */
export type KindChip = SharedMediaKind;

export interface SearchChips {
  person?: PersonChip;
  date?: DateChip;
  kind?: KindChip;
}

export function hasChips(c: SearchChips): boolean {
  return !!c.person || !!c.date || !!c.kind;
}

/** Чипы типа — порядок и подписи вкладок «Общих медиа» (Telegram Android `FiltersView`: Фото / Ссылки / Файлы / Музыка / Голосовые). */
export const KIND_CHIPS: readonly KindChip[] = SHARED_MEDIA_KINDS;

/**
 * Что писать в строке найденного сообщения без текста (фото без подписи, голосовое): подпись выбранного чипа типа, иначе
 * пусто. Без неё выдача по чипу «Медиа» состояла бы из пустых строк.
 */
export function hitKindLabel(content: string, kind: KindChip | undefined): string {
  return content.trim() === '' && kind ? SHARED_MEDIA_TITLES[kind] : '';
}

/**
 * Подсказки чипа «человек» по набранному (Telegram `FiltersView.getUsersFilters`): совпадение по началу слова имени или логина.
 * `nameOf` — подпись из моих контактов (`peerName.ts`, решение владельца 08.10 п.27): ищется и по ней, и по имени (Telegram
 * `data_peer.cpp` кладёт в индекс оба), показывается подпись.
 */
export function personSuggestions(
  dms: readonly DmChannel[],
  query: string,
  max = 3,
  nameOf: (userId: string, fallback: string) => string = (_id, n) => n,
): PersonChip[] {
  const q = query.trim();
  if (q.length < 2) return [];
  return dms
    .filter((d) => !d.otherUser.id.startsWith('gone:') && (matchDmName(nameOf(d.otherUser.id, d.otherUser.displayName), q) ||
          matchDmName(d.otherUser.displayName, q) ||
          matchDmUsername(d.otherUser.username, q)))
    .slice(0, max)
    .map((d) => ({ convId: d.id, name: nameOf(d.otherUser.id, d.otherUser.displayName) }));
}

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function monthIndex(word: string): number {
  // «ма» — май и март/«мая»: слово из трёх знаков и больше, «мар» — март, «май»/«мая» — май.
  if (word.length < 3) return -1;
  if (/^ма[йя]/.test(word)) return 4;
  for (let i = 0; i < MONTHS.length; i++) if (i !== 4 && word.startsWith(MONTHS[i].slice(0, Math.min(MONTHS[i].length, 3)))) return i;
  return -1;
}

function dayStart(y: number, m: number, d: number): Date {
  return new Date(y, m, d, 0, 0, 0, 0);
}

/**
 * Дата из набранного текста (Telegram Android `FiltersView.getDatesFromQuery`): «сегодня», «вчера», «5 марта», «5 марта 2025»,
 * «март», «март 2025», «2025», «05.03.2025», «05.03». Не распознано — `null`. Часы — местные, будущее не предлагаем
 * (месяц без года — самый недавний уже наступивший).
 */
export function parseDateQuery(text: string, now: Date = new Date()): DateChip | null {
  const t = text.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  if (!t) return null;
  const y0 = now.getFullYear();
  const day = (y: number, m: number, d: number, label: string): DateChip | null => {
    const s = dayStart(y, m, d);
    if (s.getMonth() !== m || s.getTime() > now.getTime()) return null;
    return { label, since: s.toISOString(), until: dayStart(y, m, d + 1).toISOString() };
  };
  if (t === 'сегодня') return day(y0, now.getMonth(), now.getDate(), 'Сегодня');
  if (t === 'вчера') {
    const d = new Date(y0, now.getMonth(), now.getDate() - 1);
    return day(d.getFullYear(), d.getMonth(), d.getDate(), 'Вчера');
  }
  let m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/.exec(t);
  if (m) {
    const yy = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : y0;
    const mo = Number(m[2]) - 1;
    const dd = Number(m[1]);
    return mo >= 0 && mo < 12 && dd >= 1 ? day(yy, mo, dd, `${dd} ${MONTH_GEN[mo]} ${yy}`) : null;
  }
  m = /^(\d{4})$/.exec(t);
  if (m) {
    const yy = Number(m[1]);
    if (yy < 2000 || yy > y0) return null;
    return { label: String(yy), since: dayStart(yy, 0, 1).toISOString(), until: dayStart(yy + 1, 0, 1).toISOString() };
  }
  m = /^(?:(\d{1,2}) )?([а-я]+)(?: (\d{4}))?$/.exec(t);
  if (m) {
    const mo = monthIndex(m[2]);
    if (mo < 0) return null;
    const dd = m[1] ? Number(m[1]) : null;
    let yy = m[3] ? Number(m[3]) : y0;
    if (!m[3] && dayStart(yy, mo, dd ?? 1).getTime() > now.getTime()) yy -= 1;
    if (yy < 2000 || yy > y0) return null;
    if (dd !== null) return dd >= 1 ? day(yy, mo, dd, `${dd} ${MONTH_GEN[mo]} ${yy}`) : null;
    if (dayStart(yy, mo, 1).getTime() > now.getTime()) return null;
    return { label: `${MONTH_NOM[mo]} ${yy}`, since: dayStart(yy, mo, 1).toISOString(), until: dayStart(yy, mo + 1, 1).toISOString() };
  }
  return null;
}

/** Нужно ли ходить на сервер: есть текст (от двух знаков) или хоть один чип (поиск «всё от человека / за день»). */
export function messageQuery(q: string, chips: SearchChips): { text: string } | null {
  const text = q.trim();
  if (text.length >= 2 || (text.length > 0 && hasChips(chips))) return { text };
  return hasChips(chips) ? { text: '' } : null;
}

export interface HitSnippet {
  pre: string;
  hit: string;
  post: string;
}

function fold1(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/**
 * Кусок текста вокруг найденного для строки результата: начало с «…», если подрезано слева, совпадение отдельно (для
 * подсветки), хвост до `max` знаков. Переводы строк — пробелы. Совпадения нет (поиск только по чипам) — начало текста.
 */
export function hitSnippet(content: string, query: string, max = 96): HitSnippet {
  const text = content.replace(/\s+/g, ' ').trim();
  const q = query.trim();
  const at = q ? fold1(text).indexOf(fold1(q)) : -1;
  if (at < 0) return { pre: '', hit: '', post: text.length > max ? `${text.slice(0, max - 1)}…` : text };
  const lead = Math.min(at, 24);
  const from = at - lead;
  const hit = text.slice(at, at + q.length);
  const room = Math.max(0, max - lead - hit.length);
  const tail = text.slice(at + q.length);
  return {
    pre: (from > 0 ? '…' : '') + text.slice(from, at),
    hit,
    post: tail.length > room ? `${tail.slice(0, room)}…` : tail,
  };
}

/**
 * Области поиска из списка (G35, `srvsearch1`): «Все / Личные / Серверы». Источник — Telegram Desktop: `dialogs/ui/chat_search_in.cpp`
 * (`ChatSearchIn::tabChanges`, `TabLabel`: полоса вкладок под полем, у каждой вкладки — свой набор результатов) и
 * `dialogs/dialogs_widget.cpp` (`_searchState.tab` решает, что искать); tweb `components/appSearchSuper.ts` — те же вкладки полосой. «Все» у нас —
 * сначала личные, затем несколько найденных на серверах и «Показать все» (как раздел «Глобальный поиск» под своими чатами у Telegram).
 */
export type SearchScope = 'all' | 'dm' | 'servers';

export const SEARCH_SCOPES: readonly { id: SearchScope; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'dm', label: 'Личные' },
  { id: 'servers', label: 'Серверы' },
];

/** Сколько найденного на серверах показывает вкладка «Все» (остальное — вкладка «Серверы»). */
export const SERVER_HITS_IN_ALL = 5;

export interface ScopeView {
  /** Показывать ли полосу вкладок. */
  tabs: boolean;
  /** Беседы по имени и сообщения личных бесед. */
  dm: boolean;
  /** Сообщения каналов серверов. */
  servers: boolean;
  /** Серверы целиком (с «Показать ещё»), а не несколько строк во вкладке «Все». */
  serversFull: boolean;
}

/**
 * Что показывать при выбранной вкладке. Вкладки есть, только когда сервер умеет (`serversOn` = `srvsearch1`), есть текст запроса
 * (от 2 знаков, как у сообщений) и нет чипов: чипы человека, даты и типа касаются только личных бесед. Нет вкладок — как до этого:
 * только личные.
 */
export function scopeView(scope: SearchScope, q: string, chips: SearchChips, serversOn: boolean): ScopeView {
  const tabs = serversOn && !hasChips(chips) && messageQuery(q, chips) !== null;
  if (!tabs) return { tabs: false, dm: true, servers: false, serversFull: false };
  return { tabs: true, dm: scope !== 'servers', servers: scope !== 'dm', serversFull: scope === 'servers' };
}

/**
 * Вкладки поиска с запросом на ТЕЛЕФОНЕ (12.10, #218, решение владельца): как у Telegram Android `Components/SearchViewPager.java`
 * (`ViewPagerAdapter.updateItems`: «Чаты» — `DIALOGS_TYPE`, затем фильтры `Adapters/FiltersView.java` `filters[]`: Медиа / Ссылки /
 * Файлы / Музыка / Голосовые; каждая — `FilteredSearchView`, найденные вложения этого вида по запросу). «Музыки» у нас нет;
 * на её месте — «GIF» (вид есть в поиске и в «Общих медиа»). «Чаты» — беседы, люди, «Глобальный поиск» и сообщения (личные и
 * серверов одним списком). Прежние вкладки «Все / Личные / Серверы» — только на ПК.
 */
export type PhoneSearchTab = 'chats' | SharedMediaKind;

export const PHONE_SEARCH_TABS: readonly PhoneSearchTab[] = ['chats', 'media', 'link', 'file', 'gif', 'voice'];

/** Подпись вкладки: «Чаты» (`SearchAllChatsShort`), у видов — те же, что во вкладках «Общих медиа». */
export function phoneSearchTabLabel(tab: PhoneSearchTab): string {
  return tab === 'chats' ? 'Чаты' : SHARED_MEDIA_TITLES[tab];
}

/**
 * Показывать ли вкладки на телефоне: поиск открыт (`open` — поле в фокусе или есть чип) либо набран текст; как у Telegram
 * (`SearchViewPager`), вкладки видны сразу, при пустом поле тоже: «Чаты» — «Частые» и недавнее, виды — свежие вложения из всех
 * личных бесед. Чип типа на телефоне не ставится (его роль играют вкладки), но если он есть — вкладки не показываем (чип сам
 * сужает выдачу до вида). Чипы человека и даты остаются: они сужают и «Чаты», и вкладки видов.
 */
export function phoneSearchTabsShown(q: string, chips: SearchChips, open = false): boolean {
  return (open || q.trim() !== '') && !chips.kind;
}

/** Один источник найденного для вкладки «Все»:загруженные страницы (новые сверху) и курсор следующей (`null` — больше нет). */
export interface HitSource<T> {
  hits: readonly T[];
  next: string | null;
}

export type MergedHit<A, B> = { from: 'dm'; hit: A } | { from: 'servers'; hit: B };

/**
 * Вкладка «Все» (решение владельца 08.10): личные и серверные сообщения ОДНИМ списком по времени, новые сверху — как общий
 * поиск у Telegram (один поток, без разделов). Два источника листаются каждый своим курсором, поэтому показывать можно только то,
 * что новее «горизонта»: у источника с продолжением всё глубже его последнего загруженного сообщения может оказаться новее
 * уже показанного чужого. `horizon` — самое новое из последних загруженных сообщений тех источников, где есть продолжение
 * (`null` — продолжений нет, показано всё). `more` — какому источнику догружать страницу, чтобы горизонт ушёл глубже.
 */
export function mergeSearchHits<A extends { createdAt: string }, B extends { createdAt: string }>(
  dm: HitSource<A>,
  servers: HitSource<B>,
): { rows: MergedHit<A, B>[]; more: 'dm' | 'servers' | null } {
  const at = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  const tail = (s: HitSource<{ createdAt: string }>): number | null =>
    s.next !== null && s.hits.length > 0 ? at(s.hits[s.hits.length - 1].createdAt) : null;
  const dmTail = tail(dm);
  const srvTail = tail(servers);
  const horizon = dmTail === null ? srvTail : srvTail === null ? dmTail : Math.max(dmTail, srvTail);
  const rows: MergedHit<A, B>[] = [
    ...dm.hits.map((hit): MergedHit<A, B> => ({ from: 'dm', hit })),
    ...servers.hits.map((hit): MergedHit<A, B> => ({ from: 'servers', hit })),
  ]
    .filter((r) => horizon === null || at(r.hit.createdAt) >= horizon)
    .sort((x, y) => at(y.hit.createdAt) - at(x.hit.createdAt));
  const more = horizon === null ? null : dmTail === horizon ? 'dm' : 'servers';
  return { rows, more };
}

/**
 * Поле «Найти беседу» в списке на телефоне (#218) — как Telegram Android 12.x: поле высотой 48 (`SEARCH_FIELD_HEIGHT`,
 * `TA/ui/DialogsActivity.java:295`) лежит над лентой и уезжает вместе с ней, по пути гаснет; погасло — в шапке списка значок
 * поиска (`checkUi_searchFieldVisibility` `:14029-14049`: альфа `1 − clamp(прокрутка / 48)`, кнопка — при альфе ≤ 0.01). Пока идёт
 * поиск — поле видно всегда (`animatorSearchVisible`), в режиме выбора — скрыто (`1 − actionModeVisible`).
 */
export const SEARCH_FIELD_H = 48;
/** Порог «поле погасло»: значок поиска в шапке появляется при альфе ≤ 0.01 (`animatorSearchButtonVisible`). */
export const SEARCH_FIELD_GONE_ALPHA = 0.01;

export function searchFieldAlpha({ scrollTop, searching, selecting }: { scrollTop: number; searching: boolean; selecting: boolean }): number {
  if (selecting) return 0;
  if (searching) return 1;
  return 1 - Math.min(1, Math.max(0, scrollTop / SEARCH_FIELD_H));
}

/** Показывать ли значок поиска в шапке списка: поле погасло от прокрутки (не от режима выбора — там своя шапка). */
export function searchButtonShown({ scrollTop, searching, selecting }: { scrollTop: number; searching: boolean; selecting: boolean }): boolean {
  if (selecting || searching) return false;
  return searchFieldAlpha({ scrollTop, searching, selecting }) <= SEARCH_FIELD_GONE_ALPHA;
}
