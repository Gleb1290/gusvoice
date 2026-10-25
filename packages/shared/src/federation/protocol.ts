/**
 * Протокол федерации `gv-fed` — то, что видят ЧУЖИЕ инстансы и чужие клиенты (#139, F1).
 *
 * 🔴 Правила правок этого файла — `docs/federation-compat.md`, и они не формальность: основной
 * инстанс проекта это dev-стенд, соседи сидят на публичных релизах, отстающих на десятки версий,
 * а десктоп вшивает фронт и обновляется только тегом. Поэтому ВНУТРИ мажорной версии — только
 * добавления: новое необязательное поле, новый тип события, новое значение `features`, новый код
 * отказа. Переименование, смена типа или смысла, «необязательное стало обязательным» = новый мажор
 * рядом со старым.
 *
 * Здесь нет zod: `shared` тянет и Vite для браузера, зависимостей у пакета нет. Разбор ручной и
 * НАМЕРЕННО терпимый — неизвестные поля игнорируются, а не роняют разбор.
 */

import { FED_FIELD_LIMITS, fedDomain, fedHash, fedHttpUrl, fedId, fedOptionalText } from './fieldRules';

/** Версия протокола, которую этот код умеет. `min` — самая старая, с которой ещё говорим. */
export const FED_PROTOCOL = { min: 1, max: 1 } as const;

/**
 * Возможности инстанса. 🔴 Решение «умеет ли сосед X» принимается ТОЛЬКО по этому списку —
 * никогда по версии приложения (она в документе есть, но лишь для диагностики).
 */
export const FED_FEATURES = {
  /** Умеет связку: заявки, подтверждение, подписанные запросы. */
  link: 'link',
  /** Отдаёт каталог аккаунтов и серверов (F2). */
  directory: 'directory',
  /** Принимает гостей по ссылке-приглашению (F3). */
  guests: 'guests',
  /**
   * Принимает жалобы держателю на своих людей (F3, §5.11).
   *
   * ⚠️ Отдельно от `guests` намеренно: сосед постарше умеет гостей, но не умеет жалобы, и в окне
   * бана галочка «Пожаловаться» у него должна быть НЕАКТИВНОЙ с подсказкой, а не отправлять
   * событие в пустоту. Сам запрет при этом работает — он целиком на нашей стороне.
   */
  reports: 'reports',
  /**
   * ЛС между инстансами, этап Э1 (#141): принимает `POST /fed/v1/conv/open` и отдаёт журнал бесед `/fed/v1/conv/changes`.
   * Объявляется только при `FEDERATION_DM_ENABLED` (`state.ts`); без признака у соседа «Написать» его людям не открывается
   * (`federation.unsupported`). Следующие возможности — отдельными признаками (`dm2` вложения, `dm3` печатает…).
   */
  dm1: 'dm1',
  /**
   * ЛС между инстансами, этап Э3 (#141): вложения — отдаёт `GET /fed/v1/att/:id` (подписанный запрос, Range) и принимает копии
   * сообщений с файлами (≤ 25 МБ копирует к себе сразу). Без признака у соседа файлы в беседу с его человеком не уходят
   * (`federation.dm_attachments_later`). Объявляется только при `FEDERATION_DM_ENABLED`, вместе с `dm1`.
   */
  dm2: 'dm2',
  /**
   * ЛС между инстансами, этап Э3 часть 3 (#141): «один раз» у голосового и кружка — понимает пометку `once` вложения в
   * копии, после первого прослушивания стирает копию и отдаёт «прослушано» (`listen`) в журнале. Без признака у соседа
   * «один раз» его человеку отказывает (`federation.dm_attachments_later`): старый показал бы такое голосовое обычным
   * навсегда. Объявляется только при `FEDERATION_DM_ENABLED`, вместе с `dm2`.
   */
  dm2once: 'dm2once',
  /**
   * ЛС между инстансами (19.10, #226): одноразовые фото и видео — понимает `once` (и `once_ttl`) у фото/видео в копии,
   * показывает закрытой плиткой, после просмотра стирает копию и отдаёт «потрачено» (`listen` с `spent`). Без признака у
   * соседа одноразовое фото/видео его человеку отказывает (`federation.dm_attachments_later`): старый показал бы его
   * обычным навсегда. Объявляется только при `FEDERATION_DM_ENABLED`, вместе с `dm2once`.
   */
  dm2ttl: 'dm2ttl',
  /**
   * ЛС между инстансами, этап Э4 (#141): мгновенное — принимает `POST /fed/v1/ephemeral` («печатает» и «в сети / был(а)»,
   * провод `federation/ephemeral.ts`), без журнала и очереди. Без признака у соседа ему ничего такого не шлём (тихо).
   * Объявляется только при `FEDERATION_DM_ENABLED`, вместе с `dm1`.
   */
  dm3: 'dm3',
  /**
   * ЛС между инстансами, этап Э5 часть 1 (#141, `docs/dm/FEDERATION.md` §1.5, §4 п. 1 (б)): «мой дом лежит — пишу через инстанс
   * собеседника». Инстанс с признаком принимает по долгой (гостевой) сессии человека соседа сообщения в беседу 1:1 с нашим
   * человеком — копией с пометкой «через» (`ConvMessage.via`), отдаёт их дому автора на сверку (`GET /fed/v1/conv/via`) и
   * принимает решение (`conv.via_verdict`). Без признака у соседа дом своему человеку долгую сессию туда не заводит.
   * Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dm4: 'dm4',
  /**
   * ЛС между инстансами, этап Э6 (#141, `docs/dm/FEDERATION.md` §3.7): звонки 1:1 с людьми соседа. Инстанс с признаком принимает
   * приглашение `POST /fed/v1/call/invite` (дом собеседника будит его устройства) и снимки фазы `call.state`, а у себя отвечает
   * на звонок его человека по гостевой сессии (`/api/calls/:id/answer|decline|hangup|ping`). Без признака у соседа звонок его
   * человеку не заводится (`ConvSummary.fedNoCalls`). Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dmcall1: 'dmcall1',
  /**
   * ЛС между инстансами, этап Э7 часть 1 (#141, `docs/dm/FEDERATION.md` §3.6): группы со смешанным составом. Власть над
   * составом, названием и фото — у дома создателя группы (хост); сообщения идут звездой «дом автора → хост → остальные дома»
   * с подписью дома автора (`federation/convGroup.ts`); участник с другого инстанса меняет состав запросом хосту
   * `POST /fed/v1/conv/group/op`. Позвать в группу можно только человека инстанса с этим признаком.
   * Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dmgroup1: 'dmgroup1',
  /**
   * ЛС между инстансами, Э7 часть 3 (#141): «печатает» и «через» в группах со смешанным составом. Хост группы пересылает
   * «печатает» участника домам остальных (`POST /fed/v1/ephemeral` с человеком третьего инстанса — принимается только от
   * хоста этой группы), а дом участника, чей хост жив, а свой дом лежит, пишет в группу по долгой сессии на хосте (Э5).
   * Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dmgroup2: 'dmgroup2',
  /**
   * ЛС между инстансами, этап Э7 часть 3 (#141, `docs/dm/FEDERATION.md` §3.6): реакции, «прочитано до», закреп «для всех» и
   * «прослушано» в группах со смешанным составом. Те же строки журнала Э2 (`react`/`read`/`pin`/`listen`), той же звездой:
   * дом участника отдаёт хосту действия своих людей, хост отдаёт каждому дому состояние всех, кроме людей этого дома.
   * Строки этих видов в группах пишутся только соседу с этим признаком (старый сосед получает группу, как в Э7 части 1).
   * Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dmgroupmarks1: 'dmgroupmarks1',
  /**
   * ЛС между инстансами, G56 (13.10): правка копии сообщения с МЕНЬШИМ списком вложений — убран один элемент альбома на доме
   * автора (строка журнала `msg` прежняя, `edit_version` больше). Инстанс с признаком убирает из своей копии элементы, которых
   * нет в проводе, и стирает их файлы. Старый сосед меньший список не применяет (фото у него осталось бы), поэтому дом автора
   * «у обоих» по одному элементу в беседе с человеком соседа без признака отказывает (409 `album_item_peer_old`) — удалить
   * можно сообщение целиком или «у меня». Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dmalbum1: 'dmalbum1',
  /**
   * ЛС между инстансами, G69 (14.10): вид сообщения `media` в строке журнала `msg` — геопозиция и карточка контакта
   * (`shared/convMedia.ts`, провод — `FedConvMediaWire`). Поле `media` уходит только соседу с этим признаком; старому — та же
   * строка без него, а запасная фраза в `content` (координаты со ссылкой на карту, «Контакт: имя @ник») у неё уже есть.
   * Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dmmedia1: 'dmmedia1',
  /**
   * ЛС между инстансами (14.10, #218/#141): опрос (`media.kind = 'poll'`, провод — `FedConvPollWire`) в строке журнала `msg` и
   * голоса людей строкой `pollvote` (`FedConvPollVotesWire`, звездой через хост в группе — как реакции). Без признака у соседа —
   * поле `media` опроса снимается (запасной `content` «📊 Опрос: …»), строки `pollvote` ему не уходят, а создать опрос в беседе
   * с его людьми нельзя (403 `conv_poll_federated`). Остановка опроса — правка сообщения автором (`closed`, монотонно).
   * Объявляется только при `FEDERATION_DM_ENABLED`.
   */
  dmpoll1: 'dmpoll1',
} as const;
export type FedFeature = (typeof FED_FEATURES)[keyof typeof FED_FEATURES];

/**
 * Коды отказов — тоже протокол: по ним клиент показывает человеку причину, поэтому код никогда
 * не переименовывается и не меняет смысл. Новая причина = новый код; клиент, который его не знает,
 * показывает общий текст с исходным сообщением.
 */
export const FED_ERRORS = {
  serverClosed: 'federation.server_closed',
  dmUnavailable: 'federation.dm_unavailable',
  ownerMustBeLocal: 'federation.owner_must_be_local',
  quotaExceeded: 'federation.quota_exceeded',
  paused: 'federation.paused',
  clockSkew: 'federation.clock_skew',
  trustLost: 'federation.trust_lost',
  banned: 'federation.banned',
  // --- F3, гости и ссылки (§4.2.1). Каждый код клиент показывает СВОИМ текстом с подсказкой, что
  // делать дальше, — поэтому «ссылка не годится» разложена на причины, а не свёрнута в одну.
  /** Ссылки с таким кодом нет. */
  inviteInvalid: 'federation.invite_invalid',
  /** Ссылка была, но истекла или исчерпана. */
  inviteExpired: 'federation.invite_expired',
  /** 🔴 Бессрочная ссылка — только для своих (требование 13): гостю нужна ссылка со сроком. */
  inviteNoExpiry: 'federation.invite_no_expiry',
  /** Человек уже на этом сервере — клиент предлагает «Открыть», а не «Войти». */
  alreadyMember: 'federation.already_member',
  /** С инстансом по этому адресу у нас нет связки: звать надо своего держателя, а не чужого. */
  noLink: 'federation.no_link',
  /** Одной из сторон не хватает версии или возможности (`features`). */
  unsupported: 'federation.unsupported',
  /** Токен личности негоден: просрочен, не для нас, предъявлен второй раз или подпись не сошлась. */
  identityInvalid: 'federation.identity_invalid',
  /** Гостю этот путь закрыт в принципе: создание серверов, маршруты аккаунта (§5.8). */
  guestForbidden: 'federation.guest_forbidden',
  // --- Э1 ЛС между инстансами (#141): ответ дома получателя на `conv.open`, причина — поле `reason` (`FED_DM_REFUSAL`).
  /** Дом получателя отказал открыть переписку: `reason` = policy | no_user | hidden | rate. */
  dmRefused: 'federation.dm_refused',
  /** Дом получателя не ответил (Ф10): новую переписку не открываем, уже открытые живут. */
  peerUnreachable: 'federation.peer_unreachable',
  /**
   * Э2 (#141): вложение в беседу с человеком другого инстанса — до Э3 (признак `dm2`) файлы между инстансами не ездят;
   * отказ при загрузке (`POST /conv/:id/attachments`) и при пересылке сообщения с файлами туда. Текст доходит.
   */
  dmAttachmentsLater: 'federation.dm_attachments_later',
  /**
   * Э2 часть Б (#141, Ф7): связка с инстансом собеседника разорвана, на паузе или доверие потеряно (у нас — по состоянию
   * связки и аварийной паузе, у соседа — по его отказу на наш забор). Переписка читается, запись — этот отказ (403);
   * в сводке беседы — `fedLink: 'broken'`.
   */
  dmLinkBroken: 'federation.dm_link_broken',
  /**
   * Э3 (#141): вложение из копии сообщения соседа ещё не скопировано к нам (`attachments.state = 'remote'`) — ссылка
   * `/api/att/...` отвечает 503 с этим кодом; клиент показывает «загружается» (в сообщении `fedState: 'copying'`).
   */
  attPending: 'federation.att_pending',
  /**
   * Э3 часть 2 (#141): копии файла у нас нет, а дом автора недоступен (лежит, связка не рабочая) — `/api/att/...` отвечает 503
   * `{ error, instance? }` (`instance` — как назвать дом автора); клиент: «Файл появится, когда «X» снова будет на связи».
   */
  attUnavailable: 'federation.att_unavailable',
  /**
   * Э5 часть 1 (#141): по долгой сессии на инстансе собеседника («через», дом автора лежит) можно только писать текст и
   * отвечать в беседу 1:1 с его человеком; правка, удаление, реакции, закреп, файлы, пересылка, отложенное — этот отказ (403).
   * Тот же код — человеку соседа, у дома которого нет `dm4`, или вне такой беседы.
   */
  dmViaLimited: 'federation.dm_via_limited',
  /**
   * Э7 часть 1 (#141): дом создателя группы (хост) недоступен — состав, название и фото группы со смешанным составом менять
   * нельзя (403); писать в группу можно (копия у своего дома, доставка остальным — когда хост вернётся).
   */
  dmGroupHostDown: 'federation.dm_group_host_down',
  /** Э7 часть 1 (#141): это действие с группой другого инстанса пока недоступно (фото группы меняет только её дом) — 403. */
  dmGroupHostOnly: 'federation.dm_group_host_only',
} as const;
export type FedErrorCode = (typeof FED_ERRORS)[keyof typeof FED_ERRORS];

/** Сменный ключ подписи в документе инстанса: сам ключ + срок + подпись корневым ключом. */
export interface FedSigningKey {
  kid: string;
  /** Публичный ключ, DER SPKI в base64url. */
  publicKey: string;
  /** Не раньше / не позже, миллисекунды эпохи. */
  notBefore: number;
  notAfter: number;
  /** Подпись корневым ключом — ею сосед проверяет, что ключ выпустили мы. */
  sig: string;
}

/** Документ инстанса — визитка, которую отдаёт `GET /api/fed/v1/instance`. */
export interface FedInstanceDocument {
  instanceId: string;
  /** Название и иконка задаются держателем; пусто → интерфейс показывает домен (§5.1.2). */
  name: string | null;
  iconHash: string | null;
  domain: string;
  /** Откуда ходит веб-клиент этого инстанса — нужен соседям для списка CORS (§5.1). */
  clientOrigin: string;
  apiBase: string;
  protocol: { min: number; max: number };
  features: string[];
  /** Только для диагностики. 🔴 Решения по нему не принимаются — см. `docs/federation-compat.md`. */
  appVersion: string | null;
  /** Корневой ключ, DER SPKI в base64url: им проверяются подписи сменных ключей. */
  rootKey: string;
  keys: FedSigningKey[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseSigningKey(raw: unknown): FedSigningKey | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kid = str(r.kid);
  const publicKey = str(r.public_key);
  const sig = str(r.sig);
  const notBefore = num(r.not_before);
  const notAfter = num(r.not_after);
  if (!kid || !publicKey || !sig || notBefore === null || notAfter === null) return null;
  return { kid, publicKey, notBefore, notAfter, sig };
}

/**
 * Разобрать документ соседа.
 *
 * ⚠️ Терпимость здесь односторонняя: неизвестные ПОЛЯ игнорируем молча (сосед новее нас), но
 * негодный обязательный состав — `null`, а не «документ с дырками»: дальше по этому документу
 * проверяются подписи, и половинчатый объект превратился бы в пропуск проверки.
 * ⚠️ Битый ключ в списке выбрасывается, но сам документ остаётся годным: у соседа может быть
 * ключ нового вида, которого мы не понимаем, — это не повод считать его инстанс нерабочим.
 */
export function parseInstanceDocument(raw: unknown): FedInstanceDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  /**
   * 🔴 Адреса и домен — по форме, а не «непустая строка» (аудит 19.09, F-11). `client_origin`
   * подставляется в `href` на странице приглашения, `api_base` — цель наших подписанных запросов;
   * до этой проверки разбор принимал `javascript:` как адрес. Адрес клиента приводится к
   * «схема://хост[:порт]»: пути там быть не должно. Название — по тем же правилам, что у своего
   * (длина и скрытые символы, F-15), негодное считается не заданным, а не роняет визитку.
   */
  const instanceId = fedId(r.instance_id);
  const domain = fedDomain(r.domain);
  const clientOrigin = fedHttpUrl(r.client_origin, { originOnly: true });
  const apiBase = fedHttpUrl(r.api_base);
  const rootKey = str(r.root_key);
  const proto = r.protocol as Record<string, unknown> | undefined;
  const min = num(proto?.min);
  const max = num(proto?.max);
  if (!instanceId || !domain || !clientOrigin || !apiBase || !rootKey || min === null || max === null) return null;
  if (min > max) return null;
  // Ключ — DER SPKI в base64url, это десятки байт; мегабайтная строка здесь может быть только атакой.
  if (rootKey.length > 4096) return null;

  const keys = Array.isArray(r.keys)
    ? r.keys.slice(0, 32).map(parseSigningKey).filter((k): k is FedSigningKey => k !== null)
    : [];
  const features = Array.isArray(r.features)
    ? r.features.filter((f): f is string => typeof f === 'string' && f.length <= 64).slice(0, 64)
    : [];

  return {
    instanceId,
    name: fedOptionalText(r.name, FED_FIELD_LIMITS.instanceName),
    iconHash: fedHash(r.icon_hash),
    domain,
    clientOrigin,
    apiBase,
    protocol: { min, max },
    features,
    appVersion: str(r.app_version),
    rootKey,
    keys,
  };
}

export type InstanceDocumentOriginProblem = 'api-base-mismatch';

/**
 * Согласуется ли `api_base` визитки с адресом, откуда её забрали (#195 п. 14; #196 п. 12; #197 п. 2).
 *
 * `fetchedFrom` — адрес API, по которому мы ходили. Хост `api_base` из визитки обязан быть им же —
 * кроме запасного пути кодов прежних версий без `api_base`: там визитку забирают с самого домена
 * (`https://<domain>/api/...`), и тогда `api_base` вправе назвать другой хост (правило совместимости
 * 11). Сравниваются `host`-ы С ПОРТОМ, как их отдаёт `URL` (умолчания `:80`/`:443` она убирает сама):
 * домен тоже хранится как `host` (`domainFromOrigin`), и `voice.example:8443` иначе не проходил бы
 * никогда (#197 п. 2).
 *
 * 🔴 Сам ДОМЕН здесь не проверяется. Угадывать родство имён нельзя (#197 п. 1: на `duckdns.org`,
 * `keenetic.pro`, `github.io` любой сосед по зоне назвался бы чужим именем), а сверка с
 * `client_origin` ничего не доказывает — оба поля пишет сосед. Домен ДОКАЗЫВАЕТСЯ отдельным походом
 * на `https://<domain>/config.json` при заведении связки — `peerClient.proveDomain`.
 */
export function instanceDocumentOriginProblem(
  doc: Pick<FedInstanceDocument, 'domain' | 'apiBase'>,
  fetchedFrom: string,
): InstanceDocumentOriginProblem | null {
  let fetched: string;
  let declared: string;
  try {
    fetched = new URL(fetchedFrom).host.toLowerCase();
    declared = new URL(doc.apiBase).host.toLowerCase();
  } catch {
    return 'api-base-mismatch';
  }
  const viaDomain = fetched === doc.domain.trim().toLowerCase();
  return declared === fetched || viaDomain ? null : 'api-base-mismatch';
}

/** Провод — snake_case, внутри кода — camelCase: сериализатор явный, выгрузки строк БД в провод нет. */
export function serializeInstanceDocument(doc: FedInstanceDocument): Record<string, unknown> {
  return {
    instance_id: doc.instanceId,
    name: doc.name,
    icon_hash: doc.iconHash,
    domain: doc.domain,
    client_origin: doc.clientOrigin,
    api_base: doc.apiBase,
    protocol: { min: doc.protocol.min, max: doc.protocol.max },
    features: doc.features,
    app_version: doc.appVersion,
    root_key: doc.rootKey,
    keys: doc.keys.map((k) => ({
      kid: k.kid,
      public_key: k.publicKey,
      not_before: k.notBefore,
      not_after: k.notAfter,
      sig: k.sig,
    })),
  };
}

/**
 * Самая высокая версия, на которой сойдёмся с соседом, или `null` — общей нет.
 *
 * `null` обязан приводить к понятному «на стороне X нужна новая версия», а не к попыткам говорить
 * наугад: несовместимый сосед — не авария (`docs/federation-compat.md`, правило 5).
 */
export function negotiateProtocol(
  mine: { min: number; max: number },
  theirs: { min: number; max: number },
): number | null {
  const min = Math.max(mine.min, theirs.min);
  const max = Math.min(mine.max, theirs.max);
  return min <= max ? max : null;
}

/** Объявил ли сосед возможность. Неизвестные нам значения в списке — не ошибка. */
export function hasFeature(doc: Pick<FedInstanceDocument, 'features'>, feature: string): boolean {
  return doc.features.includes(feature);
}

/**
 * Что вкладка «Федерация» показывает держателю (§4.1.1).
 *
 * ⚠️ Это НЕ протокол между инстансами, а наш собственный API для своего же клиента — здесь можно
 * менять свободнее. Лежит рядом с протоколом, потому что описывает те же сущности.
 */
export interface FederationLinkRow {
  instanceId: string;
  domain: string;
  /** Как называть связку в интерфейсе: имя от держателя, иначе имя соседа, иначе домен. */
  name: string | null;
  theirName: string | null;
  state: string;
  protocolVersion: number | null;
  features: string[];
  confirmedAt: string | null;
  /** Когда сосед в последний раз ОТВЕТИЛ (не «когда мы стучались»). */
  lastSeenAt: string | null;
  /** Замеренное расхождение часов: из-за него подписи отказывают, и причина неочевидна. */
  clockSkewMs: number | null;
  /** Сколько событий ждёт доставки этому соседу. */
  queued: number;
  /** Свежесть каталогов — блок «Синхронизация» во вкладке «Федерация» (F2, §5.4). */
  sync?: FederationSyncRow[];
  /**
   * Место, занятое файлами гостей этой связки, и предел (§5.10, требование 30). Байты; `quota: 0`
   * — без предела.
   *
   * 🔴 Появилось 18.09: учёт работал, отказ `federation.quota_exceeded` работал, а держатель не
   * видел ни занятого, ни предела и не мог его изменить — `setQuota`/`resetQuota` не звал никто.
   * Гость упёрся бы в 2 ГБ, а починить это можно было только запросом в базу.
   */
  quota?: { used: number; limit: number };
}

/** Состояние синхронизации одного каталога (люди или серверы) с одним соседом. */
export interface FederationSyncRow {
  kind: 'directory' | 'servers';
  /** Сколько записей лежит в кеше после последней удачи. */
  entries: number;
  lastDeltaAt: string | null;
  lastFullAt: string | null;
  /** Неудачи подряд: по ним видно, что сосед лежит, ещё до того, как кеш устареет заметно. */
  failures: number;
  problem: string | null;
  /** Заказана внеочередная полная сверка (например, после пропуска события). */
  needsFull: boolean;
}

/**
 * Каталоги соседей для вкладок «Пользователи» и «Серверы» (F2, §4.1).
 *
 * ⚠️ Это КЕШ, и интерфейс обязан говорить это вслух: у каждой группы есть `freshness` — «обновлено
 * 3 мин назад» или «недоступен, данные на 14:02». Список без отметки свежести выглядит как правда
 * на сейчас, и держатель принимает по нему решения, которых не принял бы, зная, что данным сутки.
 */
export interface FederationPeerGroup {
  instanceId: string;
  /** Как называть инстанс: имя от держателя, иначе имя соседа, иначе домен. */
  name: string | null;
  domain: string;
  state: string;
  /** Свежесть кеша словами — уже готовая строка, чтобы интерфейс не считал минуты сам. */
  freshness: string;
  reachable: boolean;
  users: {
    userId: string;
    username: string;
    displayName: string;
    avatarHash: string | null;
    /** Наша копия аватара (качается лениво через хост, §5.4) — `null`, пока не скачана. */
    avatarUrl: string | null;
  }[];
  servers: { serverId: string; name: string; iconHash: string | null; members: number }[];
}

export interface FederationDirectoryView {
  /** Федерация выключена — вкладки показывают только свой инстанс, без разговоров про соседей. */
  enabled: boolean;
  peers: FederationPeerGroup[];
}

/**
 * Повод для оповещения держателю (§5.10) — то, что видно баннером во вкладке «Федерация».
 *
 * ⚠️ Текст готовит бэкенд: письмо, пуш и баннер обязаны говорить одними словами, а два набора
 * формулировок разошлись бы на первой же правке.
 */
export interface FederationAlertRow {
  kind: string;
  /** Про какую связку. `null` — про нас самих (например, истекает свой ключ подписи). */
  instanceId: string | null;
  title: string;
  body: string;
}

/** Куда слать оповещения и с какого молчания считать связку упавшей (§5.10). */
export interface FederationAlertSettings {
  ntfyTopic: string;
  email: boolean;
  linkDownAfterMinutes: number;
}

/**
 * Тумблеры «Федерация» и «Личные сообщения с другими инстансами» во вкладке админки (#224): `GET`/`PATCH
 * /admin/federation/switch`. Отвечает ВСЕГДА, и при выключенной федерации (тогда `/admin/federation` — 404, как раньше).
 * `source`: `env` — включено в `.env` (`FEDERATION_ENABLED` / `FEDERATION_DM_ENABLED`), из панели не выключается;
 * `panel` — включено тумблером; `off` — выключено. 🔴 Пароля к ключу здесь нет и быть не должно.
 */
export interface FederationSwitchView {
  enabled: boolean;
  source: 'env' | 'panel' | 'off';
  dmEnabled: boolean;
  dmSource: 'env' | 'panel' | 'off';
  status: 'off' | 'key-error' | 'ready';
  problem: string | null;
}

/** Тело `PATCH /admin/federation/switch` — меняется только переданное. */
export interface FederationSwitchPatch {
  enabled?: boolean;
  dmEnabled?: boolean;
}

export interface FederationOverview {
  status: 'off' | 'key-error' | 'ready';
  problem: string | null;
  paused: boolean;
  contacts: { kind: string; label: string; value: string }[];
  /** Что сейчас не так — баннер вверху вкладки. Пусто: всё в порядке. */
  alerts?: FederationAlertRow[];
  /** Настройки оповещений — их же правит держатель тут же, во вкладке. */
  alertSettings?: FederationAlertSettings;
  instance: {
    instanceId: string;
    fingerprint: string;
    domain: string;
    name: string | null;
    iconHash: string | null;
  } | null;
  links: FederationLinkRow[];
}

/**
 * Строка журнала запретов на инстанс (F4, §5.11) — для вкладки «Федерация».
 *
 * ⚠️ Снятие не стирает строку: это ЖУРНАЛ. Держатель обязан видеть, что запрет был и кто его снял,
 * — иначе «почему этот человек снова здесь» остаётся без ответа.
 */
export interface FederationBanRow {
  instanceId: string;
  /** Кого — идентификатор в пространстве ЕГО дома. */
  userId: string;
  /** Ник и имя из кеша каталога соседа; пусто — человека в кеше нет (скрыт, удалён, не синхронизировались). */
  username: string | null;
  displayName: string | null;
  reason: string | null;
  /** ISO; `null` — навсегда. */
  expiresAt: string | null;
  createdAt: string;
  /** Когда сняли и кто (наш человек). `null` — запрет действует. */
  removedAt: string | null;
  removedBy: string | null;
}

/**
 * Жалоба — наша соседу (`out`) или соседа нам (`in`), §5.11.
 *
 * 🔴 Сам человек своей жалобы НЕ видит: этот вид отдаётся только держателю инстанса.
 */
export interface FederationReportRow {
  id: string;
  direction: 'in' | 'out';
  instanceId: string;
  /** На кого жалуются: у входящей это НАШ человек, у исходящей — человек соседа. */
  reportedUserId: string;
  reportedName: string | null;
  action: string;
  serverName: string | null;
  reason: string | null;
  evidence: { text: string; at: number; channel: string }[];
  /** `sent` | `delivered` | `read` | `replied` | `closed`. */
  status: string;
  reply: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Где сработает создаваемая ссылка-приглашение (F4, §4.2, требование 13).
 *
 * 🔴 Подсказка под выбором срока обязана называть КОГО именно она пустит. Без неё бессрочная ссылка
 * выглядит как «удобнее», а на деле она не работает для чужих совсем — и человек узнаёт об этом от
 * друга, который не смог войти.
 */
export interface InviteScopeView {
  /** Адрес веб-клиента этого инстанса: из него собирается сама ссылка `/i/<код>`. */
  clientOrigin: string;
  /** Как называется наш инстанс; пусто — интерфейс скажет «этого инстанса». */
  instanceName: string | null;
  /** Стоит ли у сервера галочка федеративного доступа (§5.3). */
  federated: boolean;
  /** Названия доверенных инстансов, которым этот сервер открыт (исключения уже учтены). */
  peers: string[];
}

/**
 * «Где я гость» (F4, §5.7) — ответ СВОЕГО инстанса по его индексу членств.
 *
 * 🔴 Спрашиваем ДОМ, а не хосты. Индекс членств на доме затем и заведён: он отвечает на «куда я
 * вообще вхож», даже когда половина хостов лежит и даже на устройстве, которое видит этот аккаунт
 * впервые. Опроси мы хосты — список был бы неполным ровно тогда, когда он нужнее всего.
 *
 * ⚠️ Имена серверов здесь — снимок на момент последнего события от хоста. Держать их свежими
 * поминутно нечем и незачем: человек узнаёт сервер по имени, под которым в него входил.
 */
export interface GuestPlacesView {
  places: {
    instanceId: string;
    /** Название инстанса от держателя; пусто — интерфейс показывает домен (§5.1.2). */
    name: string | null;
    domain: string;
    /** Адрес веб-клиента хоста: по нему клиент находит его API, когда надо не показать, а сделать. */
    clientOrigin: string;
    /**
     * Состояние связки на СЕЙЧАС (`active` / `paused` / `trust-lost` / …).
     *
     * ⚠️ Членство переживает разрыв связки (§5.6.2, заморозка), поэтому список и состояние — разные
     * вещи: сервер в списке остаётся, но зайти в него нельзя, и окно обязано это сказать словами.
     */
    linkState: string;
    servers: {
      serverId: string;
      name: string;
      /** `active` — можно зайти; `closed_by_host` — держатель закрыл сервер для гостей (§5.3.1). */
      state: string;
      reason: string | null;
    }[];
  }[];
}

/**
 * Что клиент показывает после вставки ссылки (F3, §4.2.1) — ответ СВОЕГО бэкенда, не чужого.
 *
 * 🔴 До нажатия «Войти» клиент к чужому инстансу не ходит: проверку делает дом, поэтому адрес
 * человека не уходит к соседу, а сосед не узнаёт, кто просто посмотрел ссылку.
 */
export interface InvitePreviewView {
  /** `local` — ссылка своего инстанса, дальше обычный путь; `peer` — сервер на другом инстансе. */
  scope: 'local' | 'peer';
  code: string;
  /** Чей инстанс — для карточки и информатора. Пусто у своей ссылки. */
  instance: { instanceId: string; name: string | null; domain: string } | null;
  /** Карточка сервера. Пусто, когда войти нельзя: причина — в `problem`. */
  server: {
    serverId: string;
    name: string;
    iconHash: string | null;
    members: number;
    expiresAt: number | null;
  } | null;
  /**
   * Почему войти нельзя. Стабильный код (`FED_ERRORS`) или наше собственное «сосед не ответил» —
   * клиент по нему подбирает текст и кнопку («Понятно», «Повторить», «Открыть»).
   */
  problem: string | null;
  /** Человек уже на этом сервере — знает ДОМ по своему индексу членств, а не хост. */
  alreadyMember: boolean;
  /** Контакты держателя — своего (нет связки) или чужого (сервер закрыт), по ситуации. */
  contacts: { kind: string; label: string; value: string }[];
}

/** Строка журнала федерации (аудит 19.09, F-25) — для вкладки «Федерация». Только чтение. */
export interface FederationAuditRow {
  id: string;
  /** ISO-время записи. */
  at: string;
  /** `federation.link_requested`, `federation.trust_lost`, `federation.guest_first_login`, … */
  event: string;
  instanceId: string | null;
  actorId: string | null;
  detail: Record<string, unknown>;
}
