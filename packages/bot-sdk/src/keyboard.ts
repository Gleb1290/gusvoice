/**
 * Кнопки под сообщением — сборщик в стиле grammY: `new InlineKeyboard().text('Статус', 'st').row().url('Сайт', 'https://…')`.
 * Объект САМ является `InlineKeyboardMarkup` (поле `inline_keyboard`) — передаётся в `reply_markup` как есть.
 * Пределы сервера проверяются при добавлении: `callback_data` ≤ 64 БАЙТ UTF-8, ≤ 8 кнопок в ряду, ≤ 100 всего, `url` — http(s).
 */
import type { InlineKeyboardButton, InlineKeyboardMarkup } from './wire.js';

export const CALLBACK_DATA_MAX_BYTES = 64;
export const KEYBOARD_ROW_BUTTONS_MAX = 8;
export const KEYBOARD_BUTTONS_MAX = 100;
export const KEYBOARD_BUTTON_TEXT_MAX = 64;

const utf8 = new TextEncoder();

export class InlineKeyboard implements InlineKeyboardMarkup {
  readonly inline_keyboard: InlineKeyboardButton[][];

  constructor(rows: InlineKeyboardButton[][] = [[]]) {
    this.inline_keyboard = rows.length ? rows.map((r) => [...r]) : [[]];
  }

  /** Кнопка, нажатие которой шлёт боту `callback_query` с `data` (≤ 64 байт; видит нажавший — секретов не класть). */
  text(label: string, data: string): this {
    if (!data || utf8.encode(data).length > CALLBACK_DATA_MAX_BYTES) {
      throw new TypeError(`InlineKeyboard: callback_data "${data}" — нужно 1–${CALLBACK_DATA_MAX_BYTES} байт UTF-8`);
    }
    return this.add({ text: label, callback_data: data });
  }

  /** Кнопка-ссылка (только http/https, без логина в адресе; у человека — подтверждение «Открыть ссылку?»). */
  url(label: string, url: string): this {
    let ok = false;
    try {
      const u = new URL(url);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      ok = false;
    }
    if (!ok) throw new TypeError(`InlineKeyboard: url "${url}" — только http(s) без логина в адресе`);
    return this.add({ text: label, url });
  }

  /** Следующие кнопки — в новый ряд. Пустые ряды при отправке отбрасываются. */
  row(): this {
    const last = this.inline_keyboard[this.inline_keyboard.length - 1];
    if (last && last.length > 0) this.inline_keyboard.push([]);
    return this;
  }

  /** Готовая разметка без пустых рядов (её же отдаёт `JSON.stringify`). */
  build(): InlineKeyboardMarkup {
    return { inline_keyboard: this.inline_keyboard.filter((r) => r.length > 0).map((r) => r.map((b) => ({ ...b }))) };
  }

  toJSON(): InlineKeyboardMarkup {
    return this.build();
  }

  static from(rows: InlineKeyboardButton[][]): InlineKeyboard {
    const kb = new InlineKeyboard([]);
    for (const r of rows) {
      kb.row();
      for (const b of r) kb.add({ ...b });
    }
    return kb;
  }

  private add(b: InlineKeyboardButton): this {
    const label = b.text.trim();
    if (!label || [...label].length > KEYBOARD_BUTTON_TEXT_MAX) {
      throw new TypeError(`InlineKeyboard: текст кнопки — 1–${KEYBOARD_BUTTON_TEXT_MAX} знаков`);
    }
    if ((b.callback_data === undefined) === (b.url === undefined)) throw new TypeError('InlineKeyboard: кнопке нужно ровно одно из callback_data и url');
    const total = this.inline_keyboard.reduce((n, r) => n + r.length, 0);
    if (total >= KEYBOARD_BUTTONS_MAX) throw new TypeError(`InlineKeyboard: не больше ${KEYBOARD_BUTTONS_MAX} кнопок`);
    let last = this.inline_keyboard[this.inline_keyboard.length - 1];
    if (!last) {
      last = [];
      this.inline_keyboard.push(last);
    }
    if (last.length >= KEYBOARD_ROW_BUTTONS_MAX) throw new TypeError(`InlineKeyboard: не больше ${KEYBOARD_ROW_BUTTONS_MAX} кнопок в ряду — вызовите row()`);
    last.push(b);
    return this;
  }
}
