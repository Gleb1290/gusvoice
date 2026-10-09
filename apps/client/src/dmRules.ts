import { FEATURE_USERS1 } from '@gusvoice/shared';
import type { User, UserSearchHit } from '@gusvoice/shared';

/**
 * Кому можно написать в личку, а кому — нет, пока личка не переживает падение инстанса (#141, §5.8).
 *
 * 🔴 **Повод — приёмка 18.09.** Правило «личка с гостями выключена» было на бэкенде и в одном месте
 * интерфейса (пункт меню по ПКМ), а интерфейс обещает написать человеку ещё тремя способами: ЛКМ по
 * строке участника, карточка на телефоне и список «кому написать». Все три доходили до отказа —
 * а гость вдобавок читал на пустом экране личек «нажмите на человека, чтобы написать ему», хотя
 * ему нельзя написать НИКОМУ.
 *
 * ⚠️ Запрет ДВУСТОРОННИЙ (`dm.ts`: `other.homeInstanceId !== null || meRow?.home`): закрыта не
 * «личка с гостями», а личка, в которой хоть один — гость. Гостю поэтому нужен свой текст: он про
 * него самого, а не про собеседника.
 */

/** Дом человека, если он гость: пусто — человек этого инстанса. Форма — как в ростере (`User`). */
type Home = User['homeInstance'] | null;

/**
 * Почему личка с этим человеком не откроется. `null` — откроется.
 *
 * ⚠️ Возвращает готовую фразу, а не флаг: в трёх местах из четырёх её показывают как есть, и
 * собирать предложение заново в каждом значило бы получить три разных объяснения одному запрету.
 */
export function dmBlockText(me: Home, target: Home): string | null {
  if (me) return 'Вы здесь гость с другого инстанса — личка отсюда пока не работает. Она появится позже.';
  if (target) return 'Личка с людьми других инстансов появится позже.';
  return null;
}

/** Подпись под пустым списком личек: гостю писать некому вовсе, и звать его в участников незачем. */
export function dmEmptyHint(me: Home): string {
  return me
    ? 'Гостю с другого инстанса личка пока недоступна — она появится позже.'
    : 'Откройте участников сервера и нажмите на человека, чтобы написать ему.';
}

/** Человек в списке «Написать»: ровно то, что нужно строке выбора и проверке `dmBlockText` (у собеседника беседы дома нет). */
export type DmCandidate = Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'homeInstance'>;

/** Сколько людей показывает список «Написать»; больше — ищут по имени. */
export const DM_CANDIDATES_MAX = 50;

/**
 * Кому предложить написать (список «Написать», 04.10). Участников чужих серверов в сторе нет: ростер ОДИН — открытого
 * сервера (`store.members`; `openServer` его обнуляет, так что в сессии, где сервер не открывали, он пуст и лист был
 * «Некому написать»). Поэтому к нему добавлены собеседники существующих бесед: они известны списку и без открытого
 * сервера. Порядок: ростер как есть, затем собеседники, которых в нём нет (в порядке бесед). Один человек — одна строка
 * (и в ростере, и в беседе — запись ростера: у неё есть `homeInstance`) при ЛЮБОМ запросе: id занят ДО поиска (см. `add`).
 * Себя нет. Поиск — подстрока имени или логина победившей записи, без регистра; «@» впереди запроса срезается (05.10:
 * «@bob» не находил даже участника открытого сервера — «@» сравнивался как буква). Не больше `limit`.
 *
 * ⚠️ Стёртый аккаунт беседы (`gone:<id>` без логина — `convSyncRules.summaryToDm`) не предлагается: открыть с ним
 * беседу нечем, а клик по нему дошёл бы до сервера с несуществующим id.
 */
export function dmComposeCandidates(p: {
  /** Ростер открытого сервера (`store.members`). */
  members: readonly { user: DmCandidate }[];
  /** Беседы (`store.dms`): собеседники. */
  dms: readonly { otherUser: DmCandidate }[];
  meId: string | null | undefined;
  query: string;
  limit?: number;
  /** Подпись из моих контактов (`peerName.ts`, решение владельца 08.10 п.27): запрос ищется и по ней. */
  nameOf?: (userId: string, fallback: string) => string;
}): DmCandidate[] {
  const q = p.query.trim().replace(/^@/, '').toLowerCase();
  const limit = p.limit ?? DM_CANDIDATES_MAX;
  const seen = new Set<string>();
  const out: DmCandidate[] = [];
  const add = (u: DmCandidate) => {
    if (out.length >= limit || u.id === p.meId || seen.has(u.id)) return;
    // ⚠️ id занимается ДО поиска: человека представляет первая запись (ростер раньше бесед) при любом запросе. Если
    // занимать после, то по прежнему имени (человек его сменил, а в беседе осталось старое) проходила бы запись беседы
    // вместо записи ростера — в ней нет `homeInstance`, и гостю предложили бы закрытую личку (`dmBlockText`).
    seen.add(u.id);
    const label = p.nameOf ? p.nameOf(u.id, u.displayName) : u.displayName;
    if (q && !u.displayName.toLowerCase().includes(q) && !label.toLowerCase().includes(q) && !u.username.toLowerCase().includes(q)) return;
    out.push(u);
  };
  for (const m of p.members) add(m.user);
  // Группа (07.10, `groups1`: `group:<беседа>`) и «Избранное» (08.10, `saved1`: `saved:<беседа>`) — не люди, «лично» им не написать.
  for (const d of p.dms) if (!d.otherUser.id.startsWith('gone:') && !d.otherUser.id.startsWith('group:') && !d.otherUser.id.startsWith('saved:')) add(d.otherUser);
  return out;
}

// ─── «Написать» по @имени: поиск людей инстанса (05.10, признак сервера `users1`) ────────────────────────────────────

/**
 * Сервер ищет людей своего инстанса по логину (`GET /users/search`, `users1`) — только тогда «Написать» спрашивает его и
 * учит пустым окном «Введите @имя». Сервер без признака ручки не знает: окно ведёт себя как раньше (свои кандидаты).
 */
export function serverSearchesUsers(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_USERS1);
}

/** Пауза в наборе перед запросом поиска: логин набирают руками, и спрашивать сервер на каждую букву незачем. */
export const USER_SEARCH_DELAY_MS = 300;

/**
 * Что спросить у сервера по набранному в «Написать»: логин без «@» в нижнем регистре или `null` — не спрашивать. То же
 * правило, что у сервера (`backend/src/userSearchRules.ts`, `normalizeUserQuery`): пробелы по краям и один «@» впереди
 * срезаются, логин — 3–32 знака латиницы, цифр и `_ . -`. Кириллица и пробелы внутри — не логин: по имени ищут только
 * среди своих (`dmComposeCandidates`), сервер по отображаемому имени не ищет (решение 05.10).
 */
export function userSearchQuery(raw: string): string | null {
  const q = raw.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_.-]{3,32}$/.test(q) ? q.toLowerCase() : null;
}

/**
 * Найденные на сервере — блоком «На этом инстансе» ПОД своими кандидатами: без тех, кто уже есть выше (один человек —
 * одна строка; запись кандидата главнее — у неё есть дом и онлайн), без меня. Пока ответ на новый запрос в пути, прежние
 * найденные остаются, но только те, чей логин начинается с нового запроса: список не мигает и не держит лишних.
 * `query` — текущий `userSearchQuery`; `null` — найденных не показывать.
 */
export function dmSearchHits(p: {
  hits: readonly UserSearchHit[];
  candidates: readonly { id: string }[];
  meId: string | null | undefined;
  query: string | null;
}): UserSearchHit[] {
  const q = p.query;
  if (!q) return [];
  const taken = new Set(p.candidates.map((c) => c.id));
  return p.hits.filter((h) => h.id !== p.meId && !taken.has(h.id) && h.username.toLowerCase().startsWith(q));
}

/** Поиск в «Написать»: запрос в пути, ответ пришёл, отказ (текст — для человека: 429 — «Слишком много попыток…»). */
export type DmSearchState = { state: 'loading' } | { state: 'done' } | { state: 'error'; error: string };

/**
 * Подпись пустого окна «Написать» (`.sheet-empty`); `null` — строки есть, подписи нет. Сервер без поиска (или я гость) —
 * прежнее «Некому написать…»; набрано не @имя — «Введите @имя» (решение 05.10: пустое окно учит искать, а не звать в
 * сервер); запрос в пути — «Ищем…»; отказ — его текст; никого — «По запросу «@bob» никого нет» (как «… бесед нет» у окна
 * пересылки).
 */
export function dmComposeHint(p: {
  /** Сервер ищет людей (`serverSearchesUsers`) и я не гость. */
  searchOn: boolean;
  /** Сколько строк в окне: свои кандидаты и найденные. */
  shown: number;
  /** Набранное, как есть. */
  query: string;
  /** Поиск по `userSearchQuery`; `null` — не ищем (набрано не @имя или поиск выключен). */
  search: DmSearchState | null;
}): string | null {
  if (p.shown > 0) return null;
  if (!p.searchOn) return 'Некому написать — откройте сервер с участниками.';
  if (!p.search) return 'Введите @имя';
  if (p.search.state === 'loading') return 'Ищем…';
  if (p.search.state === 'error') return p.search.error;
  return `По запросу «${p.query.trim()}» никого нет`;
}
