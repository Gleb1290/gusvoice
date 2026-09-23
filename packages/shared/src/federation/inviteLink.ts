/**
 * Разбор того, что человек вставил в «Войти по приглашению» (#139, F3, план §4.2).
 *
 * Поле принимает и ссылку, и короткий код — люди присылают то и другое, и заставлять человека
 * вырезать код из ссылки руками значит гарантированно получать его с лишним пробелом.
 *
 * 🔴 Адрес в ссылке говорит, ЧЕЙ это инстанс, и по нему дом ищет связку. Поэтому разбор обязан
 * возвращать именно `origin` (схема + хост + порт), а не голый домен: `https://voice.a.org` и
 * `http://voice.a.org` — разные адреса, и сверять их «по домену» значило бы принимать связку по
 * незащищённому адресу за связку по защищённому.
 *
 * ⚠️ Общий модуль, потому что то же самое разбирает и клиент (окно §4.2.1), и бэкенд (маршрут
 * предпросмотра). Две копии разбора разошлись бы ровно на краю — на ссылке с `?` или с хвостом.
 */

/** Путь приглашения на клиенте инстанса: `https://voice.example.org/i/AbC123`. */
export const INVITE_PATH = '/i/';

export interface ParsedInvite {
  code: string;
  /** Адрес клиента инстанса из ссылки. `null` — человек ввёл короткий код, значит инстанс СВОЙ. */
  origin: string | null;
}

/**
 * Код приглашения: буквы и цифры. Короче четырёх — почти наверняка обрывок, длиннее шестидесяти —
 * не наш код; и то и другое отсекается до похода в сеть.
 */
const CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function parseInviteInput(raw: string): ParsedInvite | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // Короткий код — свой инстанс (старые коды не ломаются, требование совместимости §4.2).
  if (CODE_RE.test(text)) return { code: text, origin: null };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // 🔴 Только http(s): `javascript:` и `data:` в этом поле — это попытка, а не опечатка.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const path = url.pathname;
  const at = path.indexOf(INVITE_PATH);
  if (at === -1) return null;
  // Хвост после кода отбрасываем: ссылку часто пересылают с довеском мессенджера.
  const code = path.slice(at + INVITE_PATH.length).split('/')[0] ?? '';
  if (!CODE_RE.test(code)) return null;
  return { code, origin: url.origin };
}

/** Собрать ссылку-приглашение для показа человеку. */
export function inviteLinkFor(clientOrigin: string, code: string): string {
  return `${clientOrigin.replace(/\/+$/, '')}${INVITE_PATH}${code}`;
}

/**
 * Одинаковые ли это адреса клиента.
 *
 * Сравнение по `origin`, приведённому через `URL`: `https://voice.a.org/` и `https://voice.a.org`
 * это один адрес, а `voice.a.org:8443` — уже другой. Сравнивать строками нельзя — лишний слеш в
 * настройке соседа развалил бы поиск связки, и человек видел бы «федерации с этим инстансом нет».
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}
