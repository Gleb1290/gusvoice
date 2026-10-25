/**
 * Чистые правила push-рассылки — БЕЗ env, базы и сети.
 *
 * Вынесено из `push.ts` по просьбе Codex (2026-07-27): тот модуль на импорте читает env и поднимает
 * Pool. `pushEndpointAllowed` — единственный заслон от SSRF: endpoint приходит С УСТРОЙСТВА, и без
 * проверки бэкенд из домашней сети POST'ил бы по любому адресу, который ему назвали.
 */
import { NOTIFY_HIDDEN_BODY, NOTIFY_HIDDEN_TITLE, stripFormatting, type NotifyView } from '@gusvoice/shared';
import { lastAttachmentPreview } from './convRules.js';

/**
 * SSRF guard (P2-5/P3-9): only POST to endpoints on our OWN ntfy gateway. Compare the PARSED origin
 * (scheme+host+port), not a string prefix, and require https. Invalid URL ⇒ rejected.
 *
 * ⚠️ Именно `origin`, а не `startsWith`: `https://ntfy.example.com.evil.com/` начинается с нашей базы,
 * а `https://ntfy.example.com@evil.com/` содержит её как user-info. Оба — чужие хосты.
 * Пустая база (ntfy не настроен) ⇒ не разрешаем ничего.
 */
export function endpointAllowed(endpoint: string, ntfyBase: string): boolean {
  if (!ntfyBase) return false;
  try {
    const ep = new URL(endpoint);
    return ep.protocol === 'https:' && ep.origin === new URL(ntfyBase).origin;
  } catch {
    return false;
  }
}

/**
 * Пуш для устройства БЕЗ ключей шифрования (#213): текст сообщения не отправляем вовсе.
 *
 * Такие устройства — установки до шифрования. Им по-прежнему приходит «кто и где» (заголовок и адрес
 * перехода), но не «что»: ntfy отдаёт тему на чтение без входа, и открытый текст ЛС лежал бы там, пока
 * человек не обновится. Обновится — пришлёт ключи и снова увидит текст в уведомлении.
 */
export function redactPushPayload<P extends { type: 'dm' | 'mention' | 'call'; body: string }>(p: P): P {
  // Звонок (`calls3`): в теле нет текста сообщения — только «Входящий звонок», его и оставляем.
  if (p.type === 'call') return p;
  return { ...p, body: p.type === 'dm' ? 'Новое личное сообщение' : 'Вас упомянули' };
}

/**
 * Trim message content to a short notification preview (or an attachment placeholder).
 * Вложения без текста (05.10) — словами, как в превью строки списка бесед у клиента (`dmRowRules.dmAttachmentPreview`):
 * «Фото» / «3 фото», «Видео» / «2 видео», «Голосовое сообщение» (без длительности, как Telegram, 08.10), просто имя файла / «2 файла». Для этого нужны сами вложения
 * строки (`attachments` — список); одно число (вид неизвестен) — по-старому «📎 Вложение». Меняется только текст пуша.
 */
export function contentPreview(content: string, attachments: number | readonly unknown[]): string {
  // Без маркеров формата (G51): в пуше Telegram не показывает звёздочек, а скрытый текст закрыт знаками.
  const t = stripFormatting(content).trim();
  if (t) return t.length > 140 ? `${t.slice(0, 139)}…` : t;
  if (typeof attachments === 'number') return attachments > 0 ? '📎 Вложение' : '';
  return attachmentWords(attachments);
}

/** Текст пуша о стикере (`stickers2`): «😀 Стикер», как превью строки списка у Telegram; без эмодзи — «Стикер». */
export function stickerPushText(emoji: string | null | undefined): string {
  const e = (emoji ?? '').trim();
  return e ? `${e} Стикер` : 'Стикер';
}

/** Склонение по числу: 1 файл, 2–4 файла, 5–20 файлов, 21 файл (11–14 — как 5) — то же, что `dmRowRules.plural`. */
function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

/**
 * Вложения одной строкой — пустой список даёт пусто, незнакомое (мусор в jsonb) — «📎 Вложение». Вид — то же правило,
 * что у сводки беседы (`convRules.lastAttachmentPreview`): голосовое по первому, фото и видео — когда такие ВСЕ, иначе
 * файл.
 */
export function attachmentWords(list: readonly unknown[]): string {
  const n = list.length;
  if (n === 0) return '';
  const p = lastAttachmentPreview(list);
  // GIF — «GIF», как у Telegram (tdesktop `lng_in_dlg_*`, Android `AttachGif`).
  if (p?.attachmentGif) return n === 1 ? 'GIF' : `${n} GIF`;
  switch (p?.attachmentKind) {
    case 'photo':
      // Одноразовое фото (`ttlmedia1`, #226): Telegram `lng_ttl_photo_received` — содержимое в пуше не раскрываем.
      if (p.attachmentOnce && n === 1) return 'Одноразовое фото';
      return n === 1 ? 'Фото' : `${n} фото`;
    case 'voice':
      // tdesktop `lng_in_dlg_voice_message_ttl` — «Одноразовое голосовое сообщение» (длительность у него не пишут).
      if (p.attachmentOnce) return 'Одноразовое голосовое сообщение';
      return 'Голосовое сообщение';
    case 'file':
      // Кружок (`circles1`): tdesktop `lng_in_dlg_video_message` / `lng_in_dlg_video_message_ttl`.
      if (p.attachmentRound && n === 1) return p.attachmentOnce ? 'Одноразовое видеосообщение' : 'Видеосообщение';
      if (p.attachmentVideo && p.attachmentOnce && n === 1) return 'Одноразовое видео';
      if (p.attachmentVideo) return n === 1 ? 'Видео' : `${n} видео`;
      if (n > 1) return `${n} ${plural(n, 'файл', 'файла', 'файлов')}`;
      return p.attachmentName || 'Файл';
    default:
      return '📎 Вложение';
  }
}

/**
 * Текст пуша пересылки (ЛС, `conv5`) — ОДИН пуш на пачку: одно сообщение — его превью с пометкой, несколько — число.
 * Число — подписью «…: N», чтобы не склонять «сообщение/сообщения/сообщений».
 */
export function forwardPreview(
  count: number,
  first: { content: string; attachments: number | readonly unknown[] },
): string {
  if (count > 1) return `↪ Пересланные сообщения: ${count}`;
  const p = contentPreview(first.content, first.attachments);
  return p ? `↪ ${p}` : '↪ Пересланное сообщение';
}

/**
 * Пуш сообщения «без звука» (ЛС, С3, `conv8`): пуш уходит, как обычный, но с `silent: true` в нагрузке — она едет внутри
 * шифра WebPush (#213), и приложение по нему показывает уведомление без звука и вибрации. Поле — ТОЛЬКО у тихого: нагрузка
 * обычного пуша не меняется ни на байт. Приложение, которое поля не знает (APK до своей правки), звенит, как раньше.
 */
export function withSilent<P extends { type: 'dm' | 'mention' | 'call' }>(payload: P, silent: boolean): P | (P & { silent: true }) {
  return silent ? { ...payload, silent: true as const } : payload;
}

/**
 * Источник для окна «один пуш от этого человека за 20 с» (`authGuard.pushDebounced`). У тихого — СВОЁ окно (С3): общее
 * окно отдавало бы его тихий пуш вместо обычного, и обычное сообщение, отправленное следом, пришло бы на телефон без
 * звука (его пуш съело бы окно). Пачка тихих по-прежнему даёт один пуш, пачка обычных — тоже.
 */
export function pushThrottleSource(senderId: string, silent: boolean): string {
  return silent ? `${senderId}:silent` : senderId;
}

/**
 * Не больше стольких ТИХИХ досылок пачки на (получатель, источник) за окно звонкого пуша (`authGuard.PUSH_THROTTLE_S` = 20 с;
 * решение владельца 39). Защита от «бомбёжки» (#5): звенит по-прежнему один пуш за окно, тихих — не больше этого числа, дальше
 * сообщения пачки в шторку не досылаются (видны в приложении). Отправка — не больше 20 сообщений за 10 с (`SEND_MAX`).
 */
export const PUSH_QUIET_MAX = 5;

/**
 * Что делать с пушем сообщения беседы (решение владельца 39, как Telegram Android: `NotificationsController.
 * showOrUpdateNotification(notifyAboutLast)` дописывает MessagingStyle и звенит один раз — `setOnlyAlertOnce`/без звука для
 * обновлений): окно звонкого пуша свободно — `loud`; занято, а тихих досылок за окно меньше `PUSH_QUIET_MAX` — `quiet` (тот же
 * пуш с `silent: true`: приложение дописывает строку в уведомление беседы без звука и вибрации); иначе — `drop`.
 */
export function pushBurstMode(loudTaken: boolean, quietTaken: boolean): 'loud' | 'quiet' | 'drop' {
  if (!loudTaken) return 'loud';
  return quietTaken ? 'drop' : 'quiet';
}

/**
 * «Показывать имя / текст» (08.10, #211, G38, `push2`; tdesktop `notifications_manager.cpp` `hideNameAndPhoto` /
 * `hideMessageText`): тело пуша по настройке получателя (`users.notify_view`). `name` — текст «Новое сообщение», имя
 * остаётся; `nothing` — заголовок «GusVoice», без автора, аватара и названия группы (приложение возьмёт заголовок вместо
 * автора). Беседа, ключ и время остаются — тап открывает беседу, «прочитано» снимает уведомление.
 */
export function maskPushPayload<
  P extends { type?: string; title: string; body: string; author?: string; authorId?: string; avatar?: string; group?: string },
>(p: P, view: NotifyView): P {
  if (view === 'all') return p;
  // Звонок (`calls3`): тело — «Входящий звонок», текста сообщения в нём нет; настройка прячет только имя звонящего.
  const call = p.type === 'call';
  if (view === 'name') return call ? p : { ...p, body: NOTIFY_HIDDEN_BODY };
  const { author: _a, authorId: _i, avatar: _v, group: _g, ...rest } = p;
  return { ...rest, title: NOTIFY_HIDDEN_TITLE, body: call ? p.body : NOTIFY_HIDDEN_BODY } as P;
}

/**
 * Отложенный пуш (G38, `push2`): сколько ждёт пуш на телефон, пока человек за другим устройством. 30 с — как у Telegram
 * (`mtproto_config.h` `notifyCloudDelay = 30000`: столько десктоп держит своё уведомление, пока жив другой клиент).
 */
export const PUSH_DEFER_MS = 30_000;
/**
 * Сколько после последнего признака жизни устройство считается «за ним сидят» (кадр шлюза `active`). 30 с — как
 * у Telegram Desktop (`offlineIdleTimeout = 30000`: без ввода столько — и клиент уже «не в сети»).
 */
export const ACTIVE_WINDOW_MS = 30_000;

/**
 * Откладывать ли пуш: только сообщение беседы с ключом (по ключу потом видно, прочитано ли оно) и только тому, кто
 * прямо сейчас за другим устройством. Упоминание в канале и пуш без ключа (пачка пересылки) — сразу, как было.
 */
export function shouldDeferPush(p: { type: 'dm' | 'mention' | 'call'; dmId?: string; key?: number }, recipientActive: boolean): boolean {
  return recipientActive && p.type === 'dm' && !!p.dmId && typeof p.key === 'number';
}

/** Отложенный пуш больше не нужен: «прочитано до» получателя дошло до этого сообщения. */
export function deferredPushRead(lastReadKey: number | null | undefined, key: number): boolean {
  return typeof lastReadKey === 'number' && lastReadKey >= key;
}

/** «За устройством сидят»: последний `active: true` моложе окна и после него не было `active: false`. */
export function connActive(activeAt: number | null, now: number): boolean {
  return activeAt !== null && now - activeAt < ACTIVE_WINDOW_MS;
}
