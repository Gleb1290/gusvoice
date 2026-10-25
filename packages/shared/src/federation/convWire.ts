/**
 * ЛС между инстансами (#141, этап Э0): провод беседы, сообщения и журнала изменений на связку.
 *
 * 🔴 Явные сериализаторы протокола, а не строки БД (`docs/federation-compat.md` п. 4): миграции не имеют права менять
 * провод. Разбор — терпимый читатель: незнакомые поля игнорируются, негодная ЗАПИСЬ выбрасывается по одной, негодный
 * КОНВЕРТ — `null` целиком. Исторические примеры — `fixtures/v1/conv-*.json` (append-only, страж `check-protocol`).
 *
 * Модель — `docs/dm/FEDERATION.md` §3: беседа с одинаковым `id` на обоих инстансах, у каждого дома копия; личность —
 * пара `(instance_id, user_id)`, логин и почта никогда не ключ.
 */
import type { ConvMediaMark } from '../convMedia';
import { fedHash, fedHttpUrl, fedId } from './fieldRules';

/** Глобальная личность: инстанс + id человека на его доме. */
export interface FedPersonRef {
  instanceId: string;
  userId: string;
}

/** Пределы провода ЛС. Текст — как у местной отправки (`MESSAGE_TEXT_MAX` бэкенда); выше — сосед шлёт мусор. */
export const FED_CONV_LIMITS = {
  content: 4096,
  title: 128,
  name: 255,
  quote: 1024,
  members: 200,
  attachments: 20,
  waveform: 256,
  page: 200,
} as const;

/**
 * Виды строк журнала на связку (`fed_conv_changes.kind`). Незнакомый вид получатель пропускает молча — сосед новее нас.
 * `msg` — сообщение (создание/правка/надгробие, в ТЕКУЩЕМ виде), `conv` — сама беседа (состав, название), `pin` — закреп
 * «у обоих», `read` — «прочитано до».
 */
export const FED_CONV_CHANGE = {
  msg: 'msg',
  conv: 'conv',
  pin: 'pin',
  read: 'read',
} as const;

/**
 * Ключ пары 1:1 между инстансами: отсортированные глобальные личности `"<inst>:<user>|<inst>:<user>"`
 * (`docs/dm/FEDERATION.md` §3.1). Обе стороны считают его одинаково — один ЛС на пару, `UNIQUE(direct_key)` ловит встречное
 * создание. Местная пара живёт в прежнем формате «меньший:больший» (`convRules.directKey`), её строки не мигрируются.
 */
export function fedDirectKey(a: FedPersonRef, b: FedPersonRef): string {
  const one = `${a.instanceId}:${a.userId}`;
  const two = `${b.instanceId}:${b.userId}`;
  return one < two ? `${one}|${two}` : `${two}|${one}`;
}

/** Участник пары 1:1 для ключа: местный — `homeInstanceId = null`, теневой — его дом и id на доме. */
export interface DirectKeySide {
  id: string;
  homeInstanceId: string | null;
  homeUserId: string | null;
}

/**
 * Ключ беседы 1:1 с учётом пары с человеком другого инстанса (Э0). Местная пара — прежний «меньший:больший» (как
 * `convRules.directKey` бэкенда): строки не мигрируются, поведение не меняется. Пара с теневым — `fedDirectKey` из
 * `(instance_id, user_id)` обоих: на доме собеседника тот же разговор получит ТОТ ЖЕ ключ, хотя местные id там другие.
 * Своего id инстанса нет (федерация выключена) — пары с гостем быть не может (`POST /conv/direct` её не открывает): местный ключ.
 */
export function pairDirectKey(one: DirectKeySide, two: DirectKeySide, selfInstanceId: string | null): string {
  const local = () => (one.id < two.id ? `${one.id}:${two.id}` : `${two.id}:${one.id}`);
  if (one.homeInstanceId === null && two.homeInstanceId === null) return local();
  if (!selfInstanceId) return local();
  const ref = (s: DirectKeySide): FedPersonRef =>
    s.homeInstanceId === null
      ? { instanceId: selfInstanceId, userId: s.id }
      : { instanceId: s.homeInstanceId, userId: s.homeUserId ?? s.id };
  return fedDirectKey(ref(one), ref(two));
}

export function parsePersonRef(raw: unknown): FedPersonRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instanceId = fedId(r.instance_id);
  const userId = fedId(r.user_id);
  return instanceId && userId ? { instanceId, userId } : null;
}

export function serializePersonRef(p: FedPersonRef): Record<string, unknown> {
  return { instance_id: p.instanceId, user_id: p.userId };
}

// ─── Беседа ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FedConvWire {
  id: string;
  kind: 'direct' | 'group';
  /** Инстанс создателя беседы. */
  originInstanceId: string;
  /** Мс эпохи. */
  createdAt: number;
  members: FedPersonRef[];
  /** Название группы; у 1:1 — `null`. */
  title: string | null;
}

export function serializeConvWire(c: FedConvWire): Record<string, unknown> {
  return {
    id: c.id,
    kind: c.kind,
    origin_instance_id: c.originInstanceId,
    created_at: c.createdAt,
    members: c.members.map(serializePersonRef),
    title: c.title,
  };
}

export function parseConvWire(raw: unknown): FedConvWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = fedId(r.id);
  const originInstanceId = fedId(r.origin_instance_id);
  const createdAt = finiteNum(r.created_at);
  // Незнакомый вид беседы — не наша беседа: принимать как «1:1» значило бы перепутать группу с личкой.
  const kind = r.kind === 'direct' || r.kind === 'group' ? r.kind : null;
  if (!id || !originInstanceId || createdAt === null || !kind || !Array.isArray(r.members)) return null;
  const members = r.members
    .slice(0, FED_CONV_LIMITS.members)
    .map(parsePersonRef)
    .filter((m): m is FedPersonRef => m !== null);
  if (members.length === 0) return null;
  return { id, kind, originInstanceId, createdAt, members, title: text(r.title, FED_CONV_LIMITS.title) };
}

// ─── Сообщение ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FedConvAttachmentWire {
  id: string;
  name: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: number[] | null;
  asFile: boolean;
  spoiler: boolean;
  /** Отпечаток содержимого (Э3): копия сверяется с ним. Пока не считается — `null`. */
  sha256: string | null;
  /**
   * Э3 (#141, `dm2`): GIF (`Attachment.gif`) и кружок (`Attachment.round`) — без них копия у соседа рисовалась бы обычным
   * видео. Добавление: в проводе ключи `gif`/`round` есть только со значением `true`; старый сосед их не читает.
   */
  gif?: boolean;
  round?: boolean;
  /**
   * Э3 часть 3 (#141, признак связки `dm2once`): «один раз» (`Attachment.once`, `voice3`) у голосового или кружка. В проводе
   * ключ есть только со значением `true`; такое вложение уходит только соседу с `dm2once` (старый показал бы его обычным
   * навсегда) — после прослушивания получатель стирает копию и шлёт `listen`, автор у себя гасит оригинал.
   */
  once?: boolean;
  /**
   * 19.10 (#226, признак связки `dm2ttl`): таймер одноразового фото/видео, с (1…60), только вместе с `once`. В проводе ключ
   * `once_ttl` есть только у таких; старый сосед его не читает (такое ему и не уходит — `dm2ttl`).
   */
  onceTtl?: number;
}

export interface FedConvForwardWire {
  /** Автор оригинала; `null` — неизвестен или удалён. */
  author: FedPersonRef | null;
  name: string;
  /** Мс эпохи. */
  at: number;
}

export interface FedConvStickerWire {
  id: string;
  emoji: string;
  url: string;
  format: string;
}

/**
 * Вид сообщения в проводе (G69, признак связки `dmmedia1`, `shared/convMedia.ts`): геопозиция как есть; контакт — глобальной
 * личностью `(instance_id, user_id)` и снимком имени и ника (у получателя он может быть незнаком — карточка без перехода).
 * Опрос — ветка `kind: 'poll'` (`dmpoll1`); незнакомый `kind` разбор выбрасывает, сообщение остаётся с запасным `content`.
 */
export type FedConvMediaWire =
  | { kind: 'geo'; lat: number; lon: number; accuracy: number | null }
  | { kind: 'contact'; person: FedPersonRef; username: string; name: string; avatarUrl: string | null }
  | FedConvPollWire;

/**
 * Опрос (признак связки `dmpoll1`, `shared/convPoll.ts`): ОПРЕДЕЛЕНИЕ без итогов — голоса едут отдельной строкой журнала `pollvote`
 * (`convSync.ts`), вид глазами смотрящего (итоги до голоса скрыты, правильный ответ — проголосовавшему) считает дом смотрящего.
 * Правильный ответ и пояснение викторины идут соседу: его сервер доверенный, как и для самих сообщений. `closed` монотонен —
 * дом автора остановил опрос (как правка сообщения), получатель закрывает копию и обратно не открывает.
 */
export interface FedConvPollWire {
  kind: 'poll';
  question: string;
  options: { id: string; text: string }[];
  anonymous: boolean;
  multi: boolean;
  quiz: boolean;
  closed: boolean;
  /** Викторина: id правильного варианта; не викторина — `null`. */
  correct: string | null;
  solution: string | null;
}

/** Пределы опроса в проводе — как `CONV_POLL_LIMITS` (модуль провода значения из `convPoll` не берёт — закрытый перечень импортов). */
const FED_POLL = { question: 255, option: 100, solution: 200, minOptions: 2, maxOptions: 10, id: 8 } as const;

function parsePollWire(r: Record<string, unknown>): FedConvPollWire | null {
  const question = text(r.question, FED_POLL.question);
  if (!question || !Array.isArray(r.options)) return null;
  const options: FedConvPollWire['options'] = [];
  for (const o of r.options.slice(0, FED_POLL.maxOptions + 1)) {
    if (!o || typeof o !== 'object') return null;
    const x = o as Record<string, unknown>;
    const id = text(x.id, FED_POLL.id);
    const label = text(x.text, FED_POLL.option);
    if (!id || !label) return null;
    options.push({ id, text: label });
  }
  if (options.length < FED_POLL.minOptions || options.length > FED_POLL.maxOptions) return null;
  const ids = new Set(options.map((o) => o.id));
  if (ids.size !== options.length) return null;
  const quiz = r.quiz === true;
  const correct = quiz && typeof r.correct === 'string' && ids.has(r.correct) ? r.correct : null;
  // Викторина без правильного ответа — битая: показать её нечем (кто прав, не узнать) — запасной `content`.
  if (quiz && !correct) return null;
  return {
    kind: 'poll',
    question,
    options,
    anonymous: r.anonymous !== false,
    multi: !quiz && r.multi === true,
    quiz,
    closed: r.closed === true,
    correct,
    solution: quiz ? text(r.solution, FED_POLL.solution) || null : null,
  };
}

export function serializeConvMediaWire(m: FedConvMediaWire): Record<string, unknown> {
  if (m.kind === 'geo') return { kind: 'geo', lat: m.lat, lon: m.lon, accuracy: m.accuracy };
  if (m.kind === 'poll') {
    return {
      kind: 'poll',
      question: m.question,
      options: m.options.map((o) => ({ id: o.id, text: o.text })),
      anonymous: m.anonymous,
      multi: m.multi,
      quiz: m.quiz,
      closed: m.closed,
      ...(m.quiz ? { correct: m.correct, solution: m.solution } : {}),
    };
  }
  return { kind: 'contact', person: serializePersonRef(m.person), username: m.username, name: m.name, avatar_url: m.avatarUrl };
}

export function parseConvMediaWire(raw: unknown): FedConvMediaWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'geo') {
    // Те же правила, что `convMedia.geoMedia` (модуль провода значения из него не берёт — закрытый перечень импортов).
    const { lat, lon, accuracy } = r;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const acc = typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(Math.min(accuracy, 100_000) * 10) / 10 : null;
    return { kind: 'geo', lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, accuracy: acc };
  }
  if (r.kind === 'contact') {
    const person = parsePersonRef(r.person);
    const username = text(r.username, 64);
    const name = text(r.name, FED_CONV_LIMITS.name);
    if (!person || username === null || name === null || (!username && !name)) return null;
    return { kind: 'contact', person, username, name, avatarUrl: fedHttpUrl(r.avatar_url) };
  }
  // `dmpoll1`: опрос; старый сосед ветку не знает — `null`, сообщение остаётся с запасным `content`.
  if (r.kind === 'poll') return parsePollWire(r);
  return null;
}

/**
 * Вид сообщения → провод соседу (`dmmedia1`). Контакт — глобальной личностью: свой человек — `(мы, id)`, человек соседа —
 * `(его дом, id там)`. Контакт без личности (у нас его нет) в провод не идёт: сосед покажет запасной `content`.
 */
export function convMediaToWire(m: ConvMediaMark, selfInstanceId: string): FedConvMediaWire | null {
  // Опрос (`dmpoll1`): определение без итогов (голоса — строками `pollvote`). Соседу без признака `materialize`
  // (`backend/federation/convChanges.ts`) поле снимает — он видит запасной `content` («📊 Опрос: …» с вариантами).
  if (m.kind === 'poll') {
    return {
      kind: 'poll',
      question: m.question,
      options: m.options.map((o) => ({ id: o.id, text: o.text })),
      anonymous: m.anonymous,
      multi: m.multi,
      quiz: m.quiz,
      closed: m.closed,
      correct: m.quiz ? (m.correct ?? null) : null,
      solution: m.quiz ? (m.solution ?? null) : null,
    };
  }
  // Трансляция геопозиции (14.10, `geolive1`): провода нет — сосед видит запасной `content` с первой точкой; сервер и так не даёт
  // начать её в беседе с людьми других инстансов.
  if (m.kind === 'geolive') return null;
  if (m.kind === 'geo') return { kind: 'geo', lat: m.lat, lon: m.lon, accuracy: m.accuracy };
  const person = m.home ? { instanceId: m.home.instanceId, userId: m.home.userId } : m.userId ? { instanceId: selfInstanceId, userId: m.userId } : null;
  if (!person) return null;
  return { kind: 'contact', person, username: m.username, name: m.displayName, avatarUrl: fedHttpUrl(m.avatarUrl) };
}

export interface FedConvMessageWire {
  id: string;
  conversationId: string;
  author: FedPersonRef;
  clientId: string | null;
  payloadHash: string | null;
  /** Мс эпохи — время на доме автора. */
  createdAt: number;
  /** Ключ порядка на доме автора (`origin_sort_key` у копии); у копии свой местный `sort_key`. */
  originSortKey: number;
  content: string;
  replyToId: string | null;
  forwardedFrom: FedConvForwardWire | null;
  silent: boolean;
  noPreview: boolean;
  captionAbove: boolean;
  replyQuote: { text: string; offset: number; auto?: true } | null;
  sticker: FedConvStickerWire | null;
  /** Служебная строка (`ConvServiceMark`) как есть; незнакомый вид получатель покажет текстом `content`. */
  service: Record<string, unknown> | null;
  attachments: FedConvAttachmentWire[];
  /** +1 на каждую правку (`conversation_messages.edit_version`); побеждает бо́льшая. */
  editVersion: number;
  /** Мс эпохи или `null`. */
  editedAt: number | null;
  /** Надгробие «удалено у обоих»: текст и вложения уже пусты, воскресить нельзя. */
  deleted: boolean;
  /** Вид сообщения (G69, `dmmedia1`): в проводе ключ только у таких — прежние строки и фикстуры без изменений. */
  media?: FedConvMediaWire | null;
}

export function serializeConvAttachmentWire(a: FedConvAttachmentWire): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    content_type: a.contentType,
    size: a.size,
    width: a.width,
    height: a.height,
    duration_ms: a.durationMs,
    waveform: a.waveform,
    as_file: a.asFile,
    spoiler: a.spoiler,
    sha256: a.sha256,
    ...(a.gif ? { gif: true } : {}),
    ...(a.round ? { round: true } : {}),
    ...(a.once ? { once: true } : {}),
    ...(a.once && a.onceTtl ? { once_ttl: a.onceTtl } : {}),
  };
}

export function parseConvAttachmentWire(raw: unknown): FedConvAttachmentWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = fedId(r.id);
  const size = finiteNum(r.size);
  const contentType = typeof r.content_type === 'string' && r.content_type.length <= 255 ? r.content_type : null;
  if (!id || size === null || size < 0 || !contentType) return null;
  const waveform = Array.isArray(r.waveform)
    ? r.waveform
        .slice(0, FED_CONV_LIMITS.waveform)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        .map((v) => Math.max(0, Math.min(100, Math.round(v))))
    : null;
  return {
    id,
    name: text(r.name, FED_CONV_LIMITS.name) ?? 'file',
    contentType,
    size,
    width: finiteNum(r.width),
    height: finiteNum(r.height),
    durationMs: finiteNum(r.duration_ms),
    waveform,
    asFile: r.as_file === true,
    spoiler: r.spoiler === true,
    sha256: typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256) ? r.sha256 : null,
    ...(r.gif === true ? { gif: true } : {}),
    ...(r.round === true ? { round: true } : {}),
    ...(r.once === true ? { once: true } : {}),
    ...(r.once === true && typeof r.once_ttl === 'number' && Number.isInteger(r.once_ttl) && r.once_ttl >= 1 && r.once_ttl <= 60
      ? { onceTtl: r.once_ttl }
      : {}),
  };
}

export function serializeConvMessageWire(m: FedConvMessageWire): Record<string, unknown> {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    author: serializePersonRef(m.author),
    client_id: m.clientId,
    payload_hash: m.payloadHash,
    created_at: m.createdAt,
    origin_sort_key: m.originSortKey,
    content: m.content,
    reply_to_id: m.replyToId,
    forwarded_from: m.forwardedFrom
      ? {
          author: m.forwardedFrom.author ? serializePersonRef(m.forwardedFrom.author) : null,
          name: m.forwardedFrom.name,
          at: m.forwardedFrom.at,
        }
      : null,
    silent: m.silent,
    no_preview: m.noPreview,
    caption_above: m.captionAbove,
    reply_quote: m.replyQuote,
    sticker: m.sticker,
    service: m.service,
    attachments: m.attachments.map(serializeConvAttachmentWire),
    edit_version: m.editVersion,
    edited_at: m.editedAt,
    deleted: m.deleted,
    ...(m.media ? { media: serializeConvMediaWire(m.media) } : {}),
  };
}

/**
 * Разобрать сообщение соседа. Обязательны `id`, беседа, автор, время, ключ порядка и текст (у надгробия — пустой);
 * остальное — с умолчаниями. Проверки «автор — человек отправителя, беседа содержит его» — у приёмника (§3.2), не здесь.
 */
export function parseConvMessageWire(raw: unknown): FedConvMessageWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = fedId(r.id);
  const conversationId = fedId(r.conversation_id);
  const author = parsePersonRef(r.author);
  const createdAt = finiteNum(r.created_at);
  const originSortKey = finiteNum(r.origin_sort_key);
  if (!id || !conversationId || !author || createdAt === null || originSortKey === null) return null;
  if (typeof r.content !== 'string' || r.content.length > FED_CONV_LIMITS.content) return null;

  let forwardedFrom: FedConvForwardWire | null = null;
  if (r.forwarded_from && typeof r.forwarded_from === 'object') {
    const f = r.forwarded_from as Record<string, unknown>;
    const at = finiteNum(f.at);
    if (at !== null) forwardedFrom = { author: parsePersonRef(f.author), name: text(f.name, FED_CONV_LIMITS.name) ?? '', at };
  }

  let replyQuote: FedConvMessageWire['replyQuote'] = null;
  if (r.reply_quote && typeof r.reply_quote === 'object') {
    const q = r.reply_quote as Record<string, unknown>;
    const qt = text(q.text, FED_CONV_LIMITS.quote);
    const offset = finiteNum(q.offset);
    if (qt !== null && offset !== null && offset >= 0) replyQuote = q.auto === true ? { text: qt, offset, auto: true } : { text: qt, offset };
  }

  let sticker: FedConvStickerWire | null = null;
  if (r.sticker && typeof r.sticker === 'object') {
    const s = r.sticker as Record<string, unknown>;
    const sid = fedId(s.id);
    const url = fedHttpUrl(s.url);
    if (sid && url && typeof s.emoji === 'string' && s.emoji.length <= 32 && typeof s.format === 'string' && s.format.length <= 16) {
      sticker = { id: sid, emoji: s.emoji, url, format: s.format };
    }
  }

  const service =
    r.service && typeof r.service === 'object' && typeof (r.service as Record<string, unknown>).kind === 'string'
      ? (r.service as Record<string, unknown>)
      : null;

  const attachments = Array.isArray(r.attachments)
    ? r.attachments
        .slice(0, FED_CONV_LIMITS.attachments)
        .map(parseConvAttachmentWire)
        .filter((a): a is FedConvAttachmentWire => a !== null)
    : [];

  const editVersion = finiteNum(r.edit_version);
  // G69 (`dmmedia1`): вид сообщения; битый или незнакомый — нет поля (покажется запасной `content`).
  const media = r.media === undefined || r.media === null ? null : parseConvMediaWire(r.media);
  return {
    id,
    conversationId,
    author,
    clientId: fedId(r.client_id),
    payloadHash: fedHash(r.payload_hash),
    createdAt,
    originSortKey,
    content: r.content,
    replyToId: fedId(r.reply_to_id),
    forwardedFrom,
    silent: r.silent === true,
    noPreview: r.no_preview === true,
    captionAbove: r.caption_above === true,
    replyQuote,
    sticker,
    service,
    attachments,
    editVersion: editVersion !== null && editVersion >= 0 ? Math.floor(editVersion) : 0,
    editedAt: finiteNum(r.edited_at),
    deleted: r.deleted === true,
    ...(media ? { media } : {}),
  };
}

// ─── Журнал изменений на связку (`GET /fed/v1/conv/changes?since=`) ─────────────────────────────────────────────────

export interface FedConvChange {
  seq: number;
  kind: string;
  conversationId: string;
  /** id сущности (сообщение для `msg`, `null` для `conv`/`pin`); сама сущность — в `entity`, если отдающий её приложил. */
  entityId: string | null;
  entity: Record<string, unknown> | null;
}

export type FedConvChangesPage =
  | { instanceId: string; seq: number; more: boolean; items: FedConvChange[] }
  /**
   * Журнал обрезан дальше `since` — получатель делает полный проход по общим беседам (`GET /fed/v1/conv/:id/export`).
   * `seq` (Э2 часть Б, добавление) — голова журнала для получателя на момент ответа: после прохода курсор встаёт на неё.
   */
  | { instanceId: string; reset: true; seq?: number };

export function serializeConvChangesPage(p: FedConvChangesPage): Record<string, unknown> {
  if ('reset' in p) return { instance_id: p.instanceId, reset: true, ...(p.seq !== undefined ? { seq: p.seq } : {}) };
  return {
    instance_id: p.instanceId,
    seq: p.seq,
    more: p.more,
    items: p.items.map((i) => ({
      seq: i.seq,
      kind: i.kind,
      conversation_id: i.conversationId,
      entity_id: i.entityId,
      entity: i.entity,
    })),
  };
}

export function parseConvChangesPage(raw: unknown): FedConvChangesPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instanceId = fedId(r.instance_id);
  if (!instanceId) return null;
  const seq = finiteNum(r.seq);
  if (r.reset === true) return seq !== null && seq >= 0 ? { instanceId, reset: true, seq } : { instanceId, reset: true };
  if (seq === null || seq < 0 || !Array.isArray(r.items)) return null;
  const items: FedConvChange[] = [];
  for (const it of r.items.slice(0, FED_CONV_LIMITS.page)) {
    if (!it || typeof it !== 'object') continue;
    const i = it as Record<string, unknown>;
    const iseq = finiteNum(i.seq);
    const conversationId = fedId(i.conversation_id);
    const kind = typeof i.kind === 'string' && i.kind.length > 0 && i.kind.length <= 32 ? i.kind : null;
    if (iseq === null || !conversationId || !kind) continue;
    items.push({
      seq: iseq,
      kind,
      conversationId,
      entityId: fedId(i.entity_id),
      entity: i.entity && typeof i.entity === 'object' ? (i.entity as Record<string, unknown>) : null,
    });
  }
  return { instanceId, seq, more: r.more === true, items };
}

// ─── Мелочи ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}
