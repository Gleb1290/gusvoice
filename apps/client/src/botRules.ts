/**
 * Боты (#229, этап 1 `docs/bots-plan.md`) — чистые правила клиента: без React, стора и сети.
 *
 * Бот — обычный пользователь с пометкой `bot: true` (поле добавлением, у людей и на старых серверах его нет). Здесь — как
 * понять, что перед нами бот, что писать про доставку событий, почему нельзя создать бота, и что значит ответ старого
 * сервера без ботов.
 */
import { botsEnabled, type BotInfo, type MyBotsResponse } from '@gusvoice/shared';

/** Подпись значка у имени бота — в ленте, шапке беседы, карточке профиля и поиске. */
export const BOT_TAG_TEXT = 'БОТ';
export const BOT_TAG_TITLE = 'Это бот: им управляет программа его владельца';

/** Что отправляет кнопка «Старт» в пустой беседе с ботом — обычным сообщением, как в Telegram. */
export const BOT_START_COMMAND = '/start';

/**
 * Инструкция для людей, пишущих бота (план §6) — `docs/bots.ru.md` в открытом репозитории (уходит туда по
 * `.gitea/sanitize/public-paths.txt`). Пустая строка = ссылку не показываем.
 */
export const BOT_DOCS_URL = 'https://github.com/Gleb1290/gusvoice/blob/main/docs/bots.ru.md';

/** Ошибка доставки для людей: сервер хранит «ответ 502» — пишем, кто ответил. Остальное — как прислал сервер. */
export function botHookErrorText(stored: string): string {
  const m = /^ответ (\d{3})$/.exec(stored);
  return m ? `адрес бота ответил кодом ${m[1]}` : stored;
}

/** Длинный адрес — с многоточием ПОСЕРЕДИНЕ (видны и хост, и хвост пути); полный — во всплывающей подсказке. */
export function middleEllipsis(text: string, max = 48): string {
  if (text.length <= max) return text;
  const keep = Math.max(2, max - 1);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** Строка «Доставки событий» в карточке бота: подпись, значение, полный текст для подсказки, тон. */
export interface BotDeliveryRow {
  label: string;
  value: string;
  title?: string;
  tone?: BotStateTone;
}

/**
 * Состояние доставки событий для карточки бота (26.10): адрес (обрезан посередине), последняя ошибка со временем, «выключена
 * после сбоев» с подсказкой, как включить. Без адреса — бот забирает события сам (опрос `getUpdates` или WebSocket).
 * Тексты ошибок хранит сервер по-русски (в проводе Bot API они по-английски); `fmt` — как писать время (по умолчанию —
 * день, месяц и время по-русски).
 */
export function botDeliveryRows(
  w: BotInfo['webhook'],
  fmt: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
): BotDeliveryRow[] {
  if (!w) return [{ label: 'Способ', value: 'Опрос или WebSocket — программа бота забирает события сама, адреса доставки нет' }];
  const rows: BotDeliveryRow[] = [{ label: 'Адрес', value: middleEllipsis(w.url), title: w.url }];
  if (w.disabledAt) {
    rows.push({
      label: 'Состояние',
      value: `Выключена после ${w.failures} сбоев подряд. Включится снова, когда программа бота заново вызовет setWebhook.`,
      tone: 'off',
    });
  } else {
    rows.push(w.lastError ? { label: 'Состояние', value: 'Есть сбои — сервер повторяет доставку', tone: 'warn' } : { label: 'Состояние', value: 'Работает', tone: 'ok' });
  }
  if (w.lastError) {
    const at = w.lastErrorAt ? ` · ${fmt(w.lastErrorAt)}` : '';
    rows.push({ label: 'Последняя ошибка', value: `${botHookErrorText(w.lastError)}${at}`, tone: 'warn' });
  }
  return rows;
}

/**
 * Бот ли это. Принимает любой объект: в DTO бесед (`DmChannel.otherUser`, `ConvSummary.otherUser`) поля `bot` в типе пока
 * нет, а сервер может его прислать — тогда значок появится и там.
 */
export function isBotUser(u: unknown): boolean {
  return !!u && typeof u === 'object' && (u as { bot?: unknown }).bot === true;
}

/** Старый сервер без ботов: ручки `/api/bots*` нет → 404. Тогда раздел честно говорит «не поддерживает», а не падает. */
export function botsUnsupported(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { status?: unknown }).status === 404;
}

/** Боты выключены на всём сервере (владелец 26.10: по умолчанию выкл, включает админ в админ-панели). */
export const BOTS_OFF_TEXT = 'Боты на этом сервере выключены. Их включает администратор сервера.';

/**
 * Почему сейчас нельзя создать бота — текст вместо кнопки «Создать бота»; `null` — можно.
 * Сначала — боты выключены на сервере (`enabled: false`; нет поля — старый сервер, как включено); `canCreate=false` — так
 * решил админ инстанса (кто создаёт ботов); иначе — исчерпан лимит на человека.
 */
export function botCreateBlock(r: Pick<MyBotsResponse, 'bots' | 'canCreate' | 'limit' | 'enabled'>): string | null {
  if (!botsEnabled(r)) return BOTS_OFF_TEXT;
  if (!r.canCreate) return 'Создавать ботов на этом сервере может не каждый — так решил его администратор. Если бот нужен, напишите ему.';
  if (r.bots.length >= r.limit) return `У вас уже ${r.bots.length} из ${r.limit} возможных ботов. Удалите ненужного, чтобы создать нового.`;
  return null;
}

export type BotStateTone = 'ok' | 'warn' | 'off';

/**
 * Состояние бота одной строкой для списка и карточки. Порядок важен: выключенный админом бот не работает вовсе (пометка
 * переживает и общий выключатель — она останется, когда ботов включат); затем боты выключены на всём сервере
 * (`instanceOn=false`) — не работает ни один; затем доставка, которую сервер сам выключил после серии сбоев; затем последняя ошибка доставки.
 * Без адреса доставки (`webhook: null`) бот забирает события сам — это нормально, писать нечего.
 */
export function botStateLine(b: Pick<BotInfo, 'disabledAt' | 'webhook'>, instanceOn = true): { text: string; tone: BotStateTone } | null {
  if (b.disabledAt) return { text: 'Выключен администратором — бот не может работать', tone: 'off' };
  if (!instanceOn) return { text: 'Сейчас не работает: боты на этом сервере выключены', tone: 'off' };
  const w = b.webhook;
  if (!w) return null;
  if (w.disabledAt) return { text: 'Доставка выключена после сбоев — бот должен заново указать свой адрес', tone: 'off' };
  if (w.lastError) return { text: `Доставка не удалась: ${botHookErrorText(w.lastError)}`, tone: 'warn' };
  return { text: 'Доставка работает', tone: 'ok' };
}

/** Видимость бота словами: кто может ему писать. */
export function botAccessLabel(isPublic: boolean): string {
  return isPublic ? 'Для всех' : 'Приватный';
}
