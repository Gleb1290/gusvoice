import { has, Permission } from './permissions';

/**
 * Кого упоминает сообщение — ОДНО правило на всё приложение.
 *
 * 🔴 До этого файла один и тот же вопрос «упомянули ли меня» решался ЧЕТЫРЬМЯ разными способами,
 * и они честно расходились на живых текстах:
 *
 *  1. `client/sockets.ts` — `@имя\b` (звук и бейдж в момент прихода сообщения);
 *  2. `backend/routes/servers.ts` — postgres-регулярка `(@everyone|@here|@имя)\M` (бейдж после
 *     перезагрузки, считается по истории);
 *  3. `backend/push.ts` — `/@([a-z0-9._-]{1,32})/gi` + поиск имени в базе (пуш на телефон);
 *  4. `client/messageText.tsx` — `@[\p{L}\p{N}_.-]+` (подсветка в тексте).
 *
 * Разъезд не теоретический. `пиши на user@super.dev`: (1) давал звук «вас упомянули», (3) искал
 * пользователя `super.dev` и пуш не слал, (4) подсвечивал кусок почты как упоминание. А `@super.`
 * в конце предложения — наоборот: (1) срабатывал, (3) искал имя `super.` и молчал, то есть
 * НАСТОЯЩЕЕ упоминание не доезжало до телефона.
 *
 * Поэтому здесь не «утилита», а источник правды: и сканер, и регулярка для подсветки, и шаблон
 * для SQL собираются из одних и тех же кусков. Разъехаться им больше нечем.
 */

/**
 * Имя в упоминании: буквы/цифры/подчёркивание, между ними допустимы точки и дефисы.
 * Набор символов — ровно тот, что разрешает регистрация (`auth.ts`: `/^[a-zA-Z0-9_.-]+$/`),
 * без юникода: имени с кириллицей не существует, а подсвечивать `@Маша` как упоминание —
 * обещать пинг, которого не будет.
 *
 * ⚠️ Точка и дефис допускаются только ВНУТРИ имени. Иначе `@super.` в конце предложения читается
 * как имя `super.`, а `@super.dev` — правильно как одно целое, а не как `super` плюс мусор.
 */
export const MENTION_NAME_SRC = '[A-Za-z0-9_]+(?:[.-]+[A-Za-z0-9_]+)*';

/**
 * Обращением считается только `@` после НАЧАЛА СТРОКИ, пробела или знака, который в почтовом
 * адресе стоять не может. Всё прочее слева от собаки означает адрес, а не обращение.
 *
 * Это защита от почты: в `user@super.dev` перед собакой стоит буква — значит адрес, звать некого.
 * Без неё чужой e-mail в чате звонит в чужой телефон.
 *
 * 🔴 Правило ПЕРЕВЁРНУТО 2026-08-22 (#110). Раньше здесь перечислялось запрещённое:
 * `(?<![A-Za-z0-9_.@-])`. Такой список обречён быть неполным — в локальной части адреса допустима
 * почти любая азбука мира, и `юзер@super.dev` с `foo+@super.dev` спокойно его обходили, упоминая
 * `super.dev`. Нашёл Codex, воспроизведено. Теперь перечисляем РАЗРЕШЁННОЕ, и новый алфавит дыры
 * не откроет.
 *
 * ⚠️ Состав списка не случаен. Скобка, кавычка, запятая, двоеточие в адресе без кавычек стоять
 * не могут — они безопасны. Знаки разметки `*`, `~`, `` ` `` добавлены вынужденно: без них ломается
 * `**@super**`, а так пишут постоянно (поймал существующий тест).
 *
 * ⚠️ Чего в списке НЕТ и почему: `+` — приписки `имя+тег@домен` обычное дело; апостроф —
 * `o'brien@…` встречается по-настоящему; `_` — от него нет пользы (курсив `_@super_` всё равно
 * съедается именем, подчёркивание в имя входит), а дыру для `ivan_@…` он открывал бы.
 *
 * Цена решения (согласована): обращение вплотную к тире — `—@vasya` — упоминанием не считается.
 */
// ⚠️ ДВЕ ловушки разом, обе поймал на себе. Первая: в строке одинарный `\s` — это просто
// буква `s`, класс молча становится «кроме буквы s», и обращение через ПРОБЕЛ перестаёт
// работать; поэтому слеши удвоены. Вторая: обратную кавычку экранировать НЕЛЬЗЯ — это
// правило попадает и в выражение разметки сообщений, а оно строится с юникод-флагом, где
// `\`` запрещено, и весь показ текста падал бы с ошибкой. Внутри класса она и так
// обычный символ. Поймал тест `messageText.test.ts`.
// работать. Наступил на это при правке; проверка на живых примерах поймала.
export const MENTION_LEFT_GUARD = '(?<![^\\s(\\[<"«„,;:*~`])';

/** Обращения ко всему каналу. Обычные имена, просто зарезервированные. */
export const BROADCAST_MENTIONS = ['everyone', 'here'] as const;

/**
 * 🔴 **Хвост `@домен`** (#139, F4, §5.5). Гость приходит со своим ником, и на сервере может
 * оказаться ДВА Васи — свой и с соседнего инстанса. Обратиться ко второму без домена нельзя в
 * принципе: любое правило «кого из них» было бы угадыванием, а упоминание обязано попадать точно.
 *
 * ⚠️ Домен пишется теми же символами, что и имя (`MENTION_NAME_SRC` допускает точки внутри), —
 * отдельного выражения для него не нужно, и одно место остаётся одним.
 *
 * 🔴 **Хвостом-доменом считается только то, что содержит ТОЧКУ.** Иначе `@super@petya` — «Супер,
 * позови Петю», два обращения подряд — превратилось бы в обращение к несуществующему инстансу
 * `petya`, то есть ни к кому: оба человека перестали бы получать упоминание. Этот случай поймал
 * тест (`@super@petya` обязан оставаться обращением к `super`), и решение по нему такое: адреса
 * инстансов — доменные имена, в них точка есть всегда, а ники пишут без точек.
 *
 * ⚠️ Цена: на стенде с адресом без точки (`localhost`) обратиться к гостю по домену нельзя. Для
 * боевых инстансов это не случай, а стенд обходится обычным `@ник`, пока тёзок нет.
 */
const MENTION_RE = new RegExp(`${MENTION_LEFT_GUARD}@(${MENTION_NAME_SRC})(?:@(${MENTION_NAME_SRC}))?`, 'g');

/** Обращение: имя и, для гостя, домен его инстанса. */
export interface MentionHandle {
  name: string;
  /** `null` — обращение к своему человеку. */
  domain: string | null;
}

/**
 * Все обращения текста, в нижнем регистре и без повторов.
 *
 * ⚠️ Возвращает ИМЕННО пары: `@vasya` и `@vasya@voice.friend.org` — два разных человека, и сводить
 * их к одному имени значило бы звонить не тому.
 */
export function mentionedHandles(content: string): MentionHandle[] {
  const seen = new Set<string>();
  const out: MentionHandle[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    const name = m[1].toLowerCase();
    // Точка — признак адреса инстанса (см. шапку `MENTION_RE`); без неё это просто вторая собака.
    const tail = m[2] && m[2].includes('.') ? m[2].toLowerCase() : null;
    const domain = tail;
    const key = domain ? `${name}@${domain}` : name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, domain });
  }
  return out;
}

/**
 * Все имена, упомянутые в тексте, в нижнем регистре и без повторов.
 * `everyone` и `here` попадают сюда наравне с остальными — это просто имена.
 */
export function mentionedNames(content: string): string[] {
  // ⚠️ Только обращения БЕЗ домена: с доменом — это гость, и искать его по одному имени среди
  // своих значит найти тёзку. Их разбирает `mentionedHandles`.
  return mentionedHandles(content)
    .filter((h) => h.domain === null)
    .map((h) => h.name);
}

/**
 * Упомянут ли лично этот человек — по имени, через `@everyone` или `@here`.
 *
 * Специально построено НА `mentionedNames`, а не рядом с ней: пуш ходит в базу по списку имён,
 * а звук считает эту функцию, и если они разойдутся — звук будет без пуша или наоборот.
 * Сравнение регистронезависимое, потому что вход в аккаунт тоже регистронезависимый.
 */
export function mentionsMe(
  content: string,
  username?: string | null,
  /** Для ГОСТЯ: его домашний ник и домен его инстанса — по ним к нему и обращаются (§5.5). */
  home?: { username: string; domain: string } | null,
  /**
   * `false` — `@everyone`/`@here` в этом сообщении никого не зовут (автору не хватило `MENTION_EVERYONE`, #76; сервер кладёт
   * это в `Message.mentionEveryone`). По умолчанию зовут: у сообщений без поля (старые, вебхуки, ЛС) правило прежнее.
   */
  broadcast = true,
): boolean {
  const handles = mentionedHandles(content);
  if (broadcast && handles.some((h) => h.domain === null && (BROADCAST_MENTIONS as readonly string[]).includes(h.name))) return true;
  if (home?.username && home.domain) {
    const name = home.username.toLowerCase();
    const domain = home.domain.toLowerCase();
    if (handles.some((h) => h.name === name && h.domain === domain)) return true;
  }
  if (!username) return false;
  const me = username.toLowerCase();
  return handles.some((h) => h.domain === null && h.name === me);
}

/** Экранирование имени для подстановки в регулярку (в имени встречаются `.` и `-`). */
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Шаблон «в тексте упомянут этот человек» для SQL (`content ~* pattern`).
 *
 * Существует потому, что бейдж непрочитанных считается ОДНИМ запросом по истории канала —
 * тянуть тексты в Node, чтобы прогнать их через `mentionsMe`, значит выгрузить всю переписку.
 * Правило то же самое, просто выражено регуляркой целиком: слева страж из `MENTION_LEFT_GUARD`,
 * справа — запрет продолжения имени (иначе `@super` совпало бы внутри `@super.dev`).
 *
 * Postgres понимает те же lookahead/lookbehind (ARE), что и JS.
 */
export function mentionSqlPattern(
  username?: string | null,
  home?: { username: string; domain: string } | null,
  /** `false` — только личные обращения, без `@everyone`/`@here` (их считает `broadcastSqlPattern` с учётом права автора). */
  broadcast = true,
): string {
  const names = [...(broadcast ? BROADCAST_MENTIONS : []), ...(username ? [escapeName(username)] : [])];
  const tail = '(?![A-Za-z0-9_]|[.-]+[A-Za-z0-9_])';
  const plain = names.length ? `@(${names.join('|')})${tail}` : '';
  // 🔴 Гостю нужен ВТОРОЙ вариант: к нему обращаются `@ник@домен`, а его собственный `username` в
  // базе — служебная строка `id@instance`, по которой в тексте никто не пишет (§5.5).
  const guest =
    home?.username && home.domain ? `@${escapeName(home.username)}@${escapeName(home.domain)}${tail}` : '';
  const alts = [plain, guest].filter(Boolean);
  // Нечего искать (нет ни имени, ни гостевого обращения) — шаблон, который не совпадает ни с чем.
  if (alts.length === 0) return '(?!)';
  return `${MENTION_LEFT_GUARD}(?:${alts.join('|')})`;
}

/**
 * Шаблон для SQL «в тексте есть `@everyone` или `@here`» (#76). Считается ОТДЕЛЬНО от личных обращений: зовёт такое
 * обращение только если автору хватило `MENTION_EVERYONE` — SQL сверяет с `messages.mention_everyone`
 * (`IS DISTINCT FROM false`: пусто у старых сообщений и вебхуков = зовёт, как раньше).
 */
export function broadcastSqlPattern(): string {
  // `@` после — доменное обращение `@everyone@сосед` (как `hasBroadcastMention`: не общее), иначе SQL насчитал бы бейдж.
  const tail = '(?![A-Za-z0-9_@]|[.-]+[A-Za-z0-9_])';
  return `${MENTION_LEFT_GUARD}@(${BROADCAST_MENTIONS.join('|')})${tail}`;
}

/** Есть ли в тексте `@everyone`/`@here` (без домена) — тогда при отправке нужно решать, вправе ли автор их звать. */
export function hasBroadcastMention(content: string): boolean {
  return mentionedHandles(content).some((h) => h.domain === null && (BROADCAST_MENTIONS as readonly string[]).includes(h.name));
}

/** Вправе ли автор звать `@everyone`/`@here` и любые роли (#76); администратор проходит через `has`. */
export function canMentionEveryone(authorPerms: bigint): boolean {
  return has(authorPerms, Permission.MENTION_EVERYONE);
}

/* ───────────────────────── Упоминание РОЛИ (#76) ─────────────────────────
 *
 * Роль зовут по её названию в тексте (`@Модераторы`, `@Ночная смена`): названия бывают с пробелами и
 * кириллицей, поэтому общее правило имён (`MENTION_NAME_SRC`, только латиница без пробелов) тут не
 * годится — роли ищутся по СПИСКУ ролей сервера, а не разбором текста.
 *
 * 🔴 Кого реально разбудило — решает СЕРВЕР в момент отправки и кладёт id ролей в сообщение
 * (`Message.mentionRoles`, колонка `messages.mention_roles`), как `mention_roles` у Discord. Клиент и
 * SQL-счётчик не пересчитывают текст: роль могли переименовать, право у автора могли отнять, а бейдж
 * «вас упомянули» не должен ни появляться, ни пропадать задним числом.
 */

/** Роль для разбора упоминания: достаточно id и названия. */
export interface MentionableRole {
  id: string;
  name: string;
}

/** Не часть названия: после `@Роль` не должна идти буква/цифра/подчёркивание (`@Мод` не зовёт `@Модераторы`). */
const ROLE_RIGHT_GUARD = '(?![\\p{L}\\p{N}_])';

function escapeRoleName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Названия по убыванию длины: `@Ночная смена` обязана съесться раньше, чем роль `Ночная`. */
function rolesLongestFirst<T extends MentionableRole>(roles: readonly T[]): T[] {
  return roles
    .filter((r) => r.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
}

/**
 * Кусок регулярки (без групп захвата) «`@` + название одной из ролей» с теми же стражами, что у
 * личных упоминаний. Нужен подсветке в тексте (`messageText.tsx`), чтобы звать роль ровно так же,
 * как её находит сервер. `null` — ролей нет, подсвечивать нечего.
 */
export function roleMentionPatternSrc(names: readonly string[]): string | null {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (list.length === 0) return null;
  return `${MENTION_LEFT_GUARD}@(?:${list.map(caselessRoleName).join('|')})${ROLE_RIGHT_GUARD}`;
}

/**
 * Название роли без учёта регистра ВНУТРИ шаблона: `Модераторы` → `[Мм][Оо]…`. Общий шаблон подсветки
 * (`messageText.tsx` `buildInline`) собран с флагами `gu` — флаг `i` там сломал бы другие группы (эмодзи `:a-z:`),
 * а пинг (`mentionedRoleIds`) регистр не различает: `@модераторы` звал роль, но не подсвечивался (нашёл Codex, R266).
 */
function caselessRoleName(name: string): string {
  return Array.from(name)
    .map((ch) => {
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      if (lo === up || Array.from(lo).length !== 1 || Array.from(up).length !== 1) return escapeRoleName(ch);
      return `[${lo}${up}]`;
    })
    .join('');
}

/**
 * Роли, упомянутые в тексте по названию (регистр не важен), без повторов.
 *
 * Роли перебираются от длинного названия к короткому, а найденное место вырезается: так
 * `@Ночная смена` зовёт ТОЛЬКО роль «Ночная смена», а не заодно и роль «Ночная».
 * Кто из найденных ролей вправе быть позванным — решает `canMentionRole`, не эта функция.
 */
export function mentionedRoleIds(content: string, roles: readonly MentionableRole[]): string[] {
  const out: string[] = [];
  let rest = content;
  for (const r of rolesLongestFirst(roles)) {
    const re = new RegExp(`${MENTION_LEFT_GUARD}@${escapeRoleName(r.name.trim())}${ROLE_RIGHT_GUARD}`, 'giu');
    if (!re.test(rest)) continue;
    // Вырезаем найденное пробелом-«стеной» (`\u0000`): соседний текст не должен склеиться в новое имя.
    rest = rest.replace(re, '\u0000');
    out.push(r.id);
  }
  return out;
}

/**
 * Вправе ли автор позвать эту роль — как в Discord: роль помечена «можно упоминать» (зовёт любой) либо у автора есть
 * право «Упоминать @everyone, @here и все роли» (`MENTION_EVERYONE`, #76; администратор проходит через `has`). Раньше
 * здесь стояло `MANAGE_ROLES`; миграция 0152 выдала новое право тем, у кого оно было.
 */
export function canMentionRole(role: { mentionable: boolean }, authorPerms: bigint): boolean {
  return role.mentionable || canMentionEveryone(authorPerms);
}

/** Упомянута ли сообщением хоть одна из моих ролей (`Message.mentionRoles` ∩ мои роли сервера). */
export function mentionsMyRole(mentionRoles: readonly string[] | null | undefined, myRoleIds: readonly string[] | null | undefined): boolean {
  if (!mentionRoles?.length || !myRoleIds?.length) return false;
  return mentionRoles.some((id) => myRoleIds.includes(id));
}
