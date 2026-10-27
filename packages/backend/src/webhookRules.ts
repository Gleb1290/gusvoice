/**
 * Входящие вебхуки каналов (#24) — ЧИСТЫЕ правила: токен, приём тела в духе Discord, сворачивание embeds в текст,
 * `allowed_mentions`. Без базы и `env` — маршруты в `routes/webhooks.ts`.
 *
 * Образец — Discord (`POST /api/webhooks/{id}/{token}`): внешние программы (CI, мониторинг, боты) уже умеют туда писать,
 * и цель — чтобы им хватало поменять адрес.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BROADCAST_MENTIONS, MENTION_LEFT_GUARD, MENTION_NAME_SRC, type MessageEmbed } from '@gusvoice/shared';
import { z } from 'zod';
import { MESSAGE_TEXT_MAX, TEXT_TOO_LONG } from './convRules.js';

/** Длина имени вебхука и подменного `username` (у Discord 1–80). */
export const WEBHOOK_NAME_MAX = 80;
/** Вебхуков на канал (у Discord тоже 15): адрес — это ключ, и плодить их без предела незачем. */
export const WEBHOOK_PER_CHANNEL_MAX = 15;
/** Сообщений на ОДИН вебхук за окно (Discord режет ~30 в минуту на вебхук). */
export const WEBHOOK_RATE_MAX = 30;
export const WEBHOOK_RATE_WINDOW_S = 60;
/**
 * Запросов приёма с одного адреса за окно — ДО похода в базу. Перебор токена бессмыслен (32 случайных байта), но поток
 * мусорных запросов не должен превращаться в поток выборок.
 */
export const WEBHOOK_IP_RATE_MAX = 120;
/** Предел тела приёма: текст 4096 знаков (до 16 КБ в UTF-8) + до 10 embeds с запасом. Больше — 413 от Fastify. */
export const WEBHOOK_BODY_LIMIT = 64 * 1024;
/** Embeds в одном сообщении (как у Discord). */
export const WEBHOOK_EMBEDS_MAX = 10;
/** Сумма текста всех карточек сообщения (Discord: title + description + поля + footer.text + author.name ≤ 6000). */
export const WEBHOOK_EMBEDS_TEXT_MAX = 6000;
/**
 * Файлов в одном сообщении вебхука (`multipart/form-data`, `files[n]`) — как вложений у обычного сообщения канала
 * (`routes/messages.ts`, до 10). Предел размера файла — общий предел вложений (25 МБ, `index.ts`).
 */
export const WEBHOOK_FILES_MAX = 10;
export const WEBHOOK_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Токен: 32 случайных байта в base64url (43 знака). Показывается один раз, в базе — только `hashWebhookToken`. */
export function newWebhookToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Хеш токена для базы. Соль не нужна: токен — 256 случайных бит, словаря под него не бывает; от утёкшей базы защищает
 * сама необратимость.
 */
export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Совпадает ли предъявленный токен с хешем — сравнение за ПОСТОЯННОЕ время (`timingSafeEqual` по хешам равной длины):
 * по времени ответа нельзя подбирать токен по байту.
 */
export function webhookTokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashWebhookToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Форма токена в адресе: отсекаем мусор до хеширования и базы. */
export const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

/** Имя вебхука (окно настроек и подменный `username`): обрезанное, 1–80 знаков. */
export const webhookName = z.string().trim().min(1, 'Имя не может быть пустым').max(WEBHOOK_NAME_MAX, `Имя — не длиннее ${WEBHOOK_NAME_MAX} знаков`);

export const embedSchema = z.object({
  title: z.string().max(256).nullish(),
  description: z.string().max(4096).nullish(),
  url: z.string().max(2048).nullish(),
  /** Цвет полосы слева (0xRRGGBB); вне диапазона — карточка без цвета (`normalizeEmbeds`). */
  color: z.number().int().nullish(),
  /** ISO-время в подвале; непонятная строка молча отбрасывается (`normalizeEmbeds`). */
  timestamp: z.string().max(64).nullish(),
  fields: z
    .array(z.object({ name: z.string().max(256), value: z.string().max(1024), inline: z.boolean().nullish() }))
    .max(25)
    .nullish(),
  author: z
    .object({ name: z.string().max(256), url: z.string().max(2048).nullish(), icon_url: z.string().max(2048).nullish() })
    .nullish(),
  footer: z.object({ text: z.string().max(2048), icon_url: z.string().max(2048).nullish() }).nullish(),
  image: z.object({ url: z.string().max(2048) }).nullish(),
  thumbnail: z.object({ url: z.string().max(2048) }).nullish(),
}).meta({ id: 'InputEmbed' }); // имя схемы в OpenAPI Bot API (этап 5, #233); разбор не меняется
export type WebhookEmbed = z.infer<typeof embedSchema>;

/**
 * Тело приёма — Discord-подмножество. Неизвестные поля (`tts`, `components`, `flags`, `thread_name`…) молча
 * отбрасываются: готовые программы шлют их всегда, и отказ на каждом был бы несовместимостью на ровном месте.
 */
export const webhookExecuteBody = z.object({
  content: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG).nullish(),
  username: z.string().max(WEBHOOK_NAME_MAX * 4).nullish(),
  avatar_url: z.string().max(2048).nullish(),
  embeds: z.array(embedSchema).max(WEBHOOK_EMBEDS_MAX).nullish(),
  allowed_mentions: z
    .object({
      parse: z.array(z.string().max(16)).max(8).nullish(),
      roles: z.array(z.string().max(64)).max(100).nullish(),
      users: z.array(z.string().max(64)).max(100).nullish(),
    })
    .nullish(),
}).superRefine((body, ctx) => {
  if (embedsTextLength(body.embeds) > WEBHOOK_EMBEDS_TEXT_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['embeds'], message: `текст карточек — не больше ${WEBHOOK_EMBEDS_TEXT_MAX} знаков` });
  }
});
export type WebhookExecuteBody = z.infer<typeof webhookExecuteBody>;

/** Сумма текста карточек по правилу Discord: title, description, имена и значения полей, footer.text, author.name. */
export function embedsTextLength(embeds: readonly WebhookEmbed[] | null | undefined): number {
  let n = 0;
  for (const e of embeds ?? []) {
    n += (e.title ?? '').length + (e.description ?? '').length + (e.footer?.text ?? '').length + (e.author?.name ?? '').length;
    for (const f of e.fields ?? []) n += f.name.length + f.value.length;
  }
  return n;
}

/** Ссылка карточки (`url`, `author.url`): только http(s), как у обычных ссылок в тексте. */
function linkUrl(raw: string | null | undefined): string | undefined {
  const u = (raw ?? '').trim();
  return /^https?:\/\/\S+$/i.test(u) ? u : undefined;
}

/** Картинка карточки по правилу «чужое не грузим» (#4): наша — показать, чужая https — ссылкой, прочее — выбросить. */
export type EmbedImageRef = { own: string } | { link: string } | null;

/**
 * Что делать с адресом картинки карточки. `attachment://имя` (Discord) — файл ЭТОГО же запроса (`files[n]`); наша
 * ссылка (`isOwn`) — показывается; чужая https — только ссылкой (браузер читателя на чужой сервер не ходит — пиксель
 * слежения, #4; прокси картинок у нас нет); http, `data:`, `javascript:` и прочее — выбрасывается.
 */
export function embedImageRef(
  raw: string | null | undefined,
  isOwn: (url: string) => boolean,
  files: ReadonlyMap<string, string> = new Map(),
): EmbedImageRef {
  const u = (raw ?? '').trim();
  if (!u) return null;
  if (/^attachment:\/\//i.test(u)) {
    const own = files.get(u.slice('attachment://'.length));
    return own ? { own } : null;
  }
  if (isOwn(u)) return { own: u };
  return /^https:\/\/\S+$/i.test(u) ? { link: u } : null;
}

/**
 * Тело → карточки для хранения и ленты (`Message.embeds`): только то, что клиент умеет показать безопасно. Однострочные
 * поля (заголовок, автор, подвал, имя поля) — в одну строку, пустые карточки и поля выбрасываются, цвет вне
 * 0…0xFFFFFF и непонятное время — тоже. Текст рендерится тем же путём, что у обычного сообщения (наш markdown).
 */
export function normalizeEmbeds(
  embeds: readonly WebhookEmbed[] | null | undefined,
  isOwn: (url: string) => boolean,
  files: ReadonlyMap<string, string> = new Map(),
): MessageEmbed[] {
  const out: MessageEmbed[] = [];
  const one = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
  for (const e of embeds ?? []) {
    const m: MessageEmbed = {};
    const title = one(e.title);
    if (title) m.title = title;
    const url = linkUrl(e.url);
    if (url) m.url = url;
    const description = (e.description ?? '').trim();
    if (description) m.description = description;
    if (typeof e.color === 'number' && e.color >= 0 && e.color <= 0xffffff) m.color = e.color;
    if (e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t)) m.timestamp = new Date(t).toISOString();
    }
    const authorName = one(e.author?.name);
    if (authorName) {
      const author: NonNullable<MessageEmbed['author']> = { name: authorName };
      const aUrl = linkUrl(e.author?.url);
      if (aUrl) author.url = aUrl;
      const icon = embedImageRef(e.author?.icon_url, isOwn, files);
      if (icon && 'own' in icon) author.iconUrl = icon.own;
      m.author = author;
    }
    const footerText = one(e.footer?.text);
    if (footerText) {
      const footer: NonNullable<MessageEmbed['footer']> = { text: footerText };
      const icon = embedImageRef(e.footer?.icon_url, isOwn, files);
      if (icon && 'own' in icon) footer.iconUrl = icon.own;
      m.footer = footer;
    }
    const fields = (e.fields ?? [])
      .map((f) => ({ name: one(f.name), value: f.value.trim(), inline: f.inline === true }))
      .filter((f) => f.name || f.value)
      .map((f) => (f.inline ? f : { name: f.name, value: f.value }));
    if (fields.length) m.fields = fields;
    const image = embedImageRef(e.image?.url, isOwn, files);
    if (image && 'own' in image) m.image = { url: image.own };
    else if (image) m.imageLink = image.link;
    const thumb = embedImageRef(e.thumbnail?.url, isOwn, files);
    if (thumb && 'own' in thumb) m.thumbnail = { url: thumb.own };
    else if (thumb) m.thumbnailLink = thumb.link;
    if (Object.keys(m).length > 0) out.push(m);
  }
  return out;
}

/**
 * Поле-файл в `multipart/form-data` вебхука: `files[n]` (Discord) и старые `file`/`fileN` (так шлют старые библиотеки
 * Discord). Прочие поля-файлы — отказ, чтобы программа не думала, что файл принят.
 */
export function isWebhookFileField(name: string): boolean {
  return /^files\[\d{1,2}\]$/.test(name) || /^file\d{0,2}$/.test(name);
}

/** Текст сообщения из тела — ТОЛЬКО `content` (как у Discord: карточки хранятся отдельно, `normalizeEmbeds`). */
export function webhookText(body: WebhookExecuteBody): string {
  return (body.content ?? '').trim();
}

/** Короткий текст карточек для пуша, когда своего текста у сообщения нет. */
export function embedsPreview(embeds: readonly MessageEmbed[]): string {
  const e = embeds[0];
  if (!e) return '';
  return (e.title ?? e.description ?? e.author?.name ?? e.fields?.[0]?.name ?? e.footer?.text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Подменное имя на одно сообщение: обрезанное и в пределе. Пустое/слишком длинное — `null`, тогда берётся имя вебхука
 * (Discord в этом случае отвечает 400, но молча взять имя вебхука безопаснее для чужих программ, чем терять сообщение).
 */
export function overrideName(username: string | null | undefined): string | null {
  const t = (username ?? '').trim();
  return t.length >= 1 && t.length <= WEBHOOK_NAME_MAX ? t : null;
}

/**
 * Embeds → текст для СТАРЫХ клиентов (с 19.10 новые рисуют карточки из `Message.embeds`, а этот текст кладётся в
 * `content` только у сообщения без своего текста — признак `embedsFallback`). Embed превращается в цитату
 * нашим же markdown-подмножеством: заголовок жирным, ссылка отдельной строкой (подписанных ссылок `[текст](url)` у нас
 * нет намеренно — подпись, врущая про адрес, это фишинг), описание, поля «**имя**: значение», подвал. Цвет теряется.
 * Рендер тот же, что у обычного сообщения: никакой разметки, кроме нашего markdown, сюда не пролезает.
 */
export function flattenEmbeds(embeds: readonly WebhookEmbed[] | null | undefined): string {
  if (!embeds?.length) return '';
  const blocks: string[] = [];
  for (const e of embeds) {
    const lines: string[] = [];
    const one = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    if (e.author?.name && one(e.author.name)) lines.push(one(e.author.name));
    if (e.title && one(e.title)) lines.push(`**${one(e.title)}**`);
    if (e.url && /^https?:\/\//i.test(e.url.trim())) lines.push(e.url.trim());
    if (e.description?.trim()) lines.push(...e.description.trim().split(/\r?\n/));
    for (const f of e.fields ?? []) {
      const name = one(f.name);
      const value = f.value.trim().split(/\r?\n/).join(' ');
      if (name || value) lines.push(name ? `**${name}**: ${value}` : value);
    }
    if (e.footer?.text && one(e.footer.text)) lines.push(one(e.footer.text));
    if (lines.length) blocks.push(lines.map((l) => `> ${l}`).join('\n'));
  }
  return blocks.join('\n\n');
}

/** Текст сообщения из тела: `content` + свёрнутые embeds, в пределе длины обычного сообщения. */
export function webhookContent(body: WebhookExecuteBody): string {
  const parts = [(body.content ?? '').trim(), flattenEmbeds(body.embeds)].filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > MESSAGE_TEXT_MAX ? `${text.slice(0, MESSAGE_TEXT_MAX - 1)}…` : text;
}

/**
 * `content` для СТАРЫХ клиентов у сообщения вебхука без своего текста, только с карточками (`embedsFallback`): цитата
 * `flattenEmbeds` в пределе длины, все упоминания обезврежены — карточки, как у Discord, никого не зовут, а старый
 * клиент решает звук по тексту.
 */
export function embedsFallbackText(embeds: readonly MessageEmbed[]): string {
  const text = neutralizeMentions(flattenEmbeds(embeds), { users: false, everyone: false, roles: false });
  return text.length > MESSAGE_TEXT_MAX ? `${text.slice(0, MESSAGE_TEXT_MAX - 1)}…` : text;
}

/** Что сообщению вебхука разрешено звать. */
export interface WebhookMentionPolicy {
  /** `true` — любых людей по нику; массив — только этих (id из `allowed_mentions.users`); `false` — никого. */
  users: boolean | readonly string[];
  everyone: boolean;
  /** `true` — любые роли «можно упоминать»; массив — только эти id; `false` — никакие. */
  roles: boolean | readonly string[];
}

/**
 * `allowed_mentions` → политика, КАК У DISCORD (решение владельца 19.10): без поля из текста зовутся все — `@everyone`,
 * `@here`, роли и люди (вебхук сам по себе может звать всех). Поле СУЖАЕТ: `parse` — какие виды разбирать из текста
 * (`everyone`, `roles`, `users`), списки `roles`/`users` — только эти id. `parse: []` без списков — никого.
 */
export function mentionPolicy(allowed: WebhookExecuteBody['allowed_mentions']): WebhookMentionPolicy {
  if (!allowed) return { users: true, everyone: true, roles: true };
  const parse = new Set((allowed.parse ?? []).map((p) => p.toLowerCase()));
  return {
    users: parse.has('users') ? true : allowed.users?.length ? [...allowed.users] : false,
    everyone: parse.has('everyone'),
    roles: parse.has('roles') ? true : allowed.roles?.length ? [...allowed.roles] : false,
  };
}

const ZWSP = '​';
const MENTION_AT_RE = new RegExp(`${MENTION_LEFT_GUARD}@(?=(${MENTION_NAME_SRC}))`, 'g');

/**
 * Обезвредить запрещённые упоминания В ТЕКСТЕ: после `@` вставляется пробел нулевой ширины. Звук и значок у людей
 * клиент решает по тексту (`shared/mentions.ts`), поэтому одного «не слать пуш» мало — разбор обязан не увидеть
 * упоминание вовсе. Человек видит тот же `@everyone`, только он никого не зовёт (так делают боты Discord).
 * Имя берётся тем же выражением, что у общего разбора (`MENTION_LEFT_GUARD` + `MENTION_NAME_SRC`): `@everyone-team` —
 * обычный ник, а не `@everyone`. Роли текстом не решаются (их список кладёт сервер в `mentionRoles`) — здесь не трогаются.
 */
export function neutralizeMentions(
  content: string,
  policy: WebhookMentionPolicy,
  keepRoleNames: readonly string[] = [],
  /** Ники людей из списка `allowed_mentions.users` (id → ник решает маршрут). */
  keepUserNames: readonly string[] = [],
): string {
  if (policy.users === true && policy.everyone) return content;
  const keep = keepRoleNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const keepUsers = new Set(keepUserNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return content.replace(MENTION_AT_RE, (at: string, name: string, offset: number) => {
    // Разрешённая роль (`allowedRoleIds`) остаётся текстом как есть: иначе `@Модераторы` подсветка не нашла бы в тексте.
    const tail = content.slice(offset + at.length).toLowerCase();
    if (keep.some((r) => tail.startsWith(r) && !/[\p{L}\p{N}_]/u.test(tail.charAt(r.length)))) return at;
    const broadcast = (BROADCAST_MENTIONS as readonly string[]).includes(name.toLowerCase());
    if (broadcast) return policy.everyone ? at : `@${ZWSP}`;
    if (policy.users === true) return at;
    return Array.isArray(policy.users) && keepUsers.has(name.toLowerCase()) ? at : `@${ZWSP}`;
  });
}

/** Роли, которые сообщение вебхука реально зовёт: из уже разрешённых правом (`resolveRoleMentions`) — по политике. */
export function allowedRoleIds(resolved: readonly string[], policy: WebhookMentionPolicy): string[] {
  if (policy.roles === true) return [...resolved];
  if (policy.roles === false) return [];
  const only = new Set(policy.roles);
  return resolved.filter((r) => only.has(r));
}

/** Служебный логин строки-автора: с `:`, которого нет в логинах людей (`USERNAME_RE`), — столкновение невозможно. */
export function webhookUsername(webhookId: string): string {
  return `webhook:${webhookId}`;
}
