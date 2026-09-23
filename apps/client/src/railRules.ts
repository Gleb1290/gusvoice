/**
 * Что стоит в рейле, когда инстансов несколько (#139, §5.7) — чистые правила, без стора и хранилища.
 *
 * 🔴 **Серверы всех инстансов показываются ВСЕГДА** — требование по итогам приёмки стенда 17.09, и
 * оно же снимает главную кривизну F4. Раньше рейл рисовал серверы ровно одного инстанса — того, чей
 * шлюз открыт, — и человек, ушедший гостем к соседу, переставал видеть собственные серверы. Их
 * возвращала отдельная кнопка «вернуться в свой инстанс», то есть переход между инстансами был
 * особым действием, а не обычным кликом по серверу. Теперь это обычный клик: рейл один и тот же,
 * где бы человек ни находился.
 *
 * ⚠️ **Порядок групп не зависит от того, где мы сейчас.** Соблазн поставить активный инстанс первым
 * велик, но тогда рейл перестраивается на каждом переходе, и мышечная память ломается ровно у того,
 * кто ходит между инстансами чаще всех. Порядок = порядок реестра, гости — сразу под своим домом.
 *
 * ⚠️ **Счётчики неживых групп приходят от фоновых шлюзов** (`bgGateways.ts`, §5.7) — то есть от
 * ЖИВОГО соединения с тем инстансом, а не из запомненного числа. Различие важное: запомненное число
 * врало бы после того, как сообщения прочли с телефона, и звало бы человека туда, где уже пусто.
 * Нет соединения (нет токена, инстанс лежит) — нет и счётчика: пусто честнее вчерашнего.
 */

import { serverHost, type Instance, type InstanceServer } from './configRules';

/** Строка «где я гость» от ДОМА — ровно те поля, что нужны рейлу (`GuestPlacesView.places[]`). */
export interface RailPlace {
  instanceId: string;
  name: string | null;
  domain: string;
  clientOrigin: string;
  linkState: string;
  servers: { serverId: string; name: string; state: string; reason: string | null }[];
}

export interface RailServerView {
  id: string;
  name: string;
  iconUrl?: string | null;
  /** Закрыт держателем (§5.3.1) — открывать нечего, вместо счётчика замок. */
  closed: boolean;
  /** Непрочитанных сообщений. У живого инстанса — из стора, у остальных — от фонового шлюза. */
  unread: number;
  /** Из них обращений ко мне: красный значок, в отличие от тихого серого. */
  mentions: number;
}

export interface RailGroupView {
  /** Ключ для React: локальный id записи, иначе id инстанса в федерации. */
  key: string;
  /** Локальная запись реестра. `null` — гостевой инстанс, записи о котором на этом устройстве ещё нет. */
  instanceId: string | null;
  title: string;
  /** Группа чужого инстанса — рисуется значком `globe` и подписью. */
  guest: boolean;
  /** Это активная запись: её серверы живые (значки непрочитанного, меню, иконки из стора). */
  live: boolean;
  /** Связка жива. У своих инстансов всегда `true`: состояние связки к ним не относится. */
  reachable: boolean;
  /** Строка «где я гость», если она есть: по ней заводится гостевая сессия при первом клике. */
  place: RailPlace | null;
  servers: RailServerView[];
}

export interface RailInput {
  /** Реестр как есть (`instances()` уже отсортирован по `order`). */
  instances: Instance[];
  activeId: string | null;
  /** Серверы АКТИВНОГО инстанса из стора — свежие, с иконками. */
  liveServers: InstanceServer[];
  /** Серверы, закрытые держателем, на активном инстансе (`store.closedServers`). */
  closedServerIds: string[];
  /** Непрочитанное АКТИВНОГО инстанса из стора: serverId → число. */
  liveUnread: Record<string, number>;
  /** Упоминания активного инстанса из стора: serverId → число. */
  liveMentions: Record<string, number>;
  /**
   * Счётчики ОСТАЛЬНЫХ записей от фоновых шлюзов: локальный id записи → серверы того инстанса.
   *
   * ⚠️ Тип описан структурно, а не импортом из `bgGateways`: правила рейла обязаны оставаться
   * чистыми, а тот модуль держит сокеты и таймеры.
   */
  bgUnread: Record<string, { servers: Record<string, { unread: number; mentions: number }> }>;
  /** «Где я гость» от дома; пусто — групп от индекса просто не будет, снимки остаются. */
  places: RailPlace[];
  /**
   * Дом УЖЕ ОТВЕТИЛ на «где я гость».
   *
   * 🔴 Различать «ещё не спрашивали» и «спросили, мест нет» обязательно, и вот почему. Реестр живёт
   * в браузере и переживает смену учётной записи, а гостевые членства принадлежат ЧЕЛОВЕКУ. Войдя
   * под другим аккаунтом, человек видел группы соседа, заведённые предыдущим, — вместе с названиями
   * серверов, куда этот аккаунт не вхож. На общем компьютере это уже утечка, а не косметика.
   * ⚠️ Прятать по «places пусто» нельзя: на старте они всегда пусты, и группы моргали бы при каждой
   * загрузке.
   */
  placesLoaded: boolean;
}

export interface RailView {
  groups: RailGroupView[];
  /**
   * Показывать ли заголовки групп. Один инстанс = рейл выглядит ровно как до федерации: ни
   * заголовков, ни разделителей. Подпись «Гусик» над единственной группой — это шум, который
   * увидели бы ВСЕ, включая тех, кто про федерацию никогда не узнает.
   *
   * ⚠️ Но когда человек ГОСТИТ, подпись обязательна даже при одной группе: иначе он не видит, у
   * кого находится. Именно это и сломалось 18.09 у того, у кого дома нет своих серверов.
   */
  showHeaders: boolean;
}

/**
 * Реестр в порядке показа: дома по `order`, каждый гость — сразу под своим домом.
 *
 * ⚠️ Гость, чей дом из реестра удалили, не теряется — уходит в конец. Потерять его значило бы
 * спрятать серверы, куда человек ходит, из-за записи, которую он забыл по другому поводу.
 */
export function orderedInstances(instances: Instance[]): Instance[] {
  const byOrder = [...instances].sort((a, b) => a.order - b.order);
  const homes = byOrder.filter((i) => !i.guestOf);
  const guests = byOrder.filter((i) => i.guestOf);
  const out: Instance[] = [];
  for (const home of homes) {
    out.push(home);
    for (const g of guests) if (g.guestOf === home.id) out.push(g);
  }
  for (const g of guests) if (!out.includes(g)) out.push(g);
  return out;
}

/** Название группы: имя из реестра → имя от держателя → домен → хост адреса API. */
export function groupTitle(inst: Instance | null, place: RailPlace | null): string {
  const own = inst?.name?.trim();
  if (own) return own;
  const fromPlace = place?.name?.trim();
  if (fromPlace) return fromPlace;
  const domain = inst?.domain?.trim() || place?.domain?.trim();
  if (domain) return domain;
  return serverHost(inst?.apiUrl ?? '');
}

/**
 * Слить снимок реестра со списком от дома.
 *
 * 🔴 Снимок пишется, когда мы стояли на этом инстансе, а индекс дома знает и то, куда человек вошёл
 * с ДРУГОГО устройства. Порядок именно такой: сначала снимок (его порядок человек видел своими
 * глазами), потом то, чего в снимке не было.
 */
function mergeServers(
  snapshot: InstanceServer[],
  place: RailPlace | null,
  closed: Set<string>,
  counts: Record<string, { unread: number; mentions: number }>,
): RailServerView[] {
  /**
   * 🔴 `removed` в рейл не попадает ВООБЩЕ — ни живым, ни под замком.
   *
   * Такая запись означает, что человека там больше нет: он ушёл сам, его кикнули или ему закрыли
   * вход на инстанс. Замок рядом с ней обещал бы «откроют — вернётесь», как при снятой галочке
   * федеративного доступа, а этого не будет: после запрета входить надо заново по ссылке. Сама
   * запись при этом дому нужна — из неё «Где я гость» пишет, что вход закрыт (§5.11).
   */
  const alive = (place?.servers ?? []).filter((s) => s.state !== 'removed');
  const stateOf = new Map(alive.map((s) => [s.serverId, s.state]));
  const gone = new Set((place?.servers ?? []).filter((s) => s.state === 'removed').map((s) => s.serverId));
  const out: RailServerView[] = snapshot
    .filter((s) => !gone.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      iconUrl: s.iconUrl ?? null,
      closed: closed.has(s.id) || (stateOf.get(s.id) ?? 'active') !== 'active',
      unread: counts[s.id]?.unread ?? 0,
      mentions: counts[s.id]?.mentions ?? 0,
    }));
  const seen = new Set(out.map((s) => s.id));
  for (const s of alive) {
    if (seen.has(s.serverId)) continue;
    out.push({
      id: s.serverId,
      name: s.name,
      iconUrl: null,
      closed: s.state !== 'active',
      unread: counts[s.serverId]?.unread ?? 0,
      mentions: counts[s.serverId]?.mentions ?? 0,
    });
  }
  return out;
}

export function buildRail(input: RailInput): RailView {
  const { instances, activeId, liveServers, closedServerIds, places, placesLoaded } = input;
  const { liveUnread, liveMentions, bgUnread } = input;
  const closed = new Set(closedServerIds);
  const placeByFedId = new Map(places.map((p) => [p.instanceId, p]));
  /**
   * Запасные способы сопоставить строку «где я гость» с записью реестра — ПО ДОМЕНУ и ПО ХОСТУ API.
   *
   * 🔴 Основной ключ — `federationInstanceId`, но у записей, заведённых до его появления (или не тем
   * путём), поля просто нет. Нет у них часто и `domain`. Тогда `place` к записи не подставлялся, а
   * без него неоткуда взять гостевую сессию: клик по серверу соседа упирался в «гостевой доступ не
   * подтверждён», хотя дом это членство исправно отдаёт.
   *
   * ⚠️ **Хост адреса API есть у ЛЮБОЙ записи всегда** — это единственное поле, без которого запись
   * не существует. `serverHost` срезает `api.`, и `https://api.voice.example.org` превращается ровно
   * в тот `domain`, который присылает дом. Поэтому третий ключ надёжнее первых двух, и добавлять
   * четвёртый уже некуда.
   */
  const placeByDomain = new Map(places.map((p) => [p.domain, p]));
  const placeByHost = new Map(places.map((p) => [serverHost(`https://${p.domain}`), p]));
  const usedPlaces = new Set<string>();
  const groups: RailGroupView[] = [];
  /**
   * Дом той записи, в которой мы сейчас гостим. `null` — мы у себя.
   *
   * 🔴 Нужен ради двух правил ниже, и оба про одно: **человек в гостях обязан видеть, что он в
   * гостях, и иметь дорогу назад.** Первая же проверка на стенде 18.09 показала цену их отсутствия:
   * у человека дома НЕ БЫЛО своих серверов, он ушёл гостем — и домашняя группа, пустая и неживая,
   * вылетела по правилу «пустую не показываем». Осталась одна группа: подписи исчезли (видеть, у
   * кого ты в гостях, стало негде), а вместе с ними и единственный путь домой.
   */
  const homeOfActive = instances.find((i) => i.id === activeId)?.guestOf ?? null;

  const placeOf = (inst: Instance): RailPlace | null =>
    (inst.federationInstanceId ? placeByFedId.get(inst.federationInstanceId) : null) ??
    (inst.domain ? placeByDomain.get(inst.domain) : null) ??
    placeByHost.get(serverHost(inst.apiUrl)) ??
    null;
  /**
   * 🔴 Одному соседу — одна гостевая группа (прогон F-20 на стенде 23.09). До починки
   * `findGuestEntry` перепривязка хоста к новому ключу заводила ВТОРУЮ запись, и обе вставали в
   * рейл: живая и мёртвая с погашенной сессией. Такие записи уже лежат в браузерах — прячем лишнюю
   * здесь. Остаётся та, где стоим; иначе знающая нынешнюю личность соседа; иначе более новая.
   * ⚠️ Ключ — место от дома, а без него (стоим гостем: дом тогда не спрашивается, `places` пуст)
   * — дом записи + домен хоста. Первая версия смотрела только на место, и гостем дубль оставался.
   */
  const dupKeyOf = (inst: Instance): string => {
    const place = placeOf(inst);
    if (place) return `place:${place.instanceId}`;
    return `host:${inst.guestOf}|${(inst.domain || serverHost(inst.apiUrl)).trim().toLowerCase()}`;
  };
  const keepScore = (i: Instance): number => {
    const place = placeOf(i);
    return (i.id === activeId ? 2 : 0) + (place && i.federationInstanceId === place.instanceId ? 1 : 0);
  };
  const keeperOf = new Map<string, Instance>();
  for (const inst of orderedInstances(instances)) {
    if (!inst.guestOf) continue;
    const key = dupKeyOf(inst);
    const cur = keeperOf.get(key);
    const better = !cur || keepScore(inst) > keepScore(cur) || (keepScore(inst) === keepScore(cur) && inst.order > cur.order);
    if (better) keeperOf.set(key, inst);
  }

  for (const inst of orderedInstances(instances)) {
    const live = inst.id === activeId;
    const place = placeOf(inst);
    if (inst.guestOf && keeperOf.get(dupKeyOf(inst))?.id !== inst.id) continue;
    if (place) usedPlaces.add(place.instanceId);
    // У живой записи серверы берём из стора: там и свежие иконки, и только что созданный сервер.
    const servers = live
      ? liveServers.map((s) => ({
          id: s.id,
          name: s.name,
          iconUrl: s.iconUrl ?? null,
          closed: closed.has(s.id),
          unread: liveUnread[s.id] ?? 0,
          mentions: liveMentions[s.id] ?? 0,
        }))
      : mergeServers(inst.servers ?? [], place, closed, bgUnread[inst.id]?.servers ?? {});
    /**
     * Гостевая запись, которую дом НЕ подтвердил, — чужая: её завёл другой человек за этим же
     * браузером, либо членство сняли. Не показываем (если мы в ней не стоим прямо сейчас).
     * ⚠️ Только когда ответ дома уже получен — иначе группы моргали бы на каждой загрузке.
     */
    if (inst.guestOf && !live && placesLoaded && !place) continue;
    // Пустая группа не нужна: заголовок инстанса без единого сервера читается как поломка. Два
    // исключения: ЖИВАЯ (человек только что вошёл и вот-вот создаст первый сервер) и ДОМ, из
    // которого мы ушли гостить, — без него из гостей некуда возвращаться.
    if (servers.length === 0 && !live && inst.id !== homeOfActive) continue;
    groups.push({
      key: inst.id,
      instanceId: inst.id,
      title: groupTitle(inst, place),
      guest: !!inst.guestOf,
      live,
      reachable: !inst.guestOf || !place || place.linkState === 'active',
      place,
      servers,
    });
  }

  // Инстансы, куда человек вошёл с другого устройства: записи на этом ещё нет, но серверы показать
  // надо — клик по ним заведёт сессию (ручается дом, а не запомненный токен).
  for (const place of places) {
    if (usedPlaces.has(place.instanceId)) continue;
    if (place.servers.length === 0) continue;
    groups.push({
      key: `fed:${place.instanceId}`,
      instanceId: null,
      title: groupTitle(null, place),
      guest: true,
      live: false,
      reachable: place.linkState === 'active',
      place,
      // ⚠️ Счётчиков здесь не бывает по построению: записи на этом устройстве нет, токена нет,
      // соединиться с тем инстансом нечем. Первый же клик заводит запись — и она получает свои.
      servers: place.servers.map((s) => ({
        id: s.serverId,
        name: s.name,
        iconUrl: null,
        closed: s.state !== 'active',
        unread: 0,
        mentions: 0,
      })),
    });
  }

  return {
    groups,
    // Стоя в гостях, подпись нужна даже при одной группе: без неё человек не видит, у кого он.
    showHeaders: groups.length > 1 || homeOfActive !== null,
  };
}

/**
 * Подпись к кнопке сервера. Она же единственное место, где человеку объясняют, почему сервер не
 * открывается, — других слов у кнопки в рейле нет.
 */
export function serverTitle(group: RailGroupView, server: RailServerView): string {
  if (server.closed) return `${server.name} — закрыт держателем`;
  if (!group.reachable) return `${server.name} — «${group.title}» сейчас недоступен`;
  if (group.live) return server.name;
  return `${server.name} · ${group.title}`;
}
