/**
 * Ссылка-приглашение `https://voice.<домен>/?invite=КОД` (мастер установки, #142) — чистые правила, без DOM.
 *
 * Сценарий: админ в мастере создал сервер и скопировал ссылку → друг открывает её → код запоминается →
 * у друга нет аккаунта — код уже вписан в регистрацию; аккаунт есть — после входа он сразу вступает на сервер.
 */

/** Коды приглашений бэкенд делает из латиницы и цифр (`util.ts inviteCode`); всё прочее — не код. */
const INVITE_CODE_RE = /^[A-Za-z0-9]{4,64}$/;

/** Код из строки запроса (`location.search`), или `null`, если его нет или он не похож на код. */
export function parseInviteParam(search: string): string | null {
  const raw = new URLSearchParams(search).get('invite');
  if (!raw) return null;
  const code = raw.trim();
  return INVITE_CODE_RE.test(code) ? code : null;
}

/** Та же строка запроса без `invite` — чтобы код не оставался в адресе и истории. */
export function stripInviteParam(search: string): string {
  const sp = new URLSearchParams(search);
  sp.delete('invite');
  const rest = sp.toString();
  return rest ? `?${rest}` : '';
}

/** Ссылка-приглашение для веб-клиента по адресу `origin` (`https://voice.example.com`). */
export function inviteLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/?invite=${encodeURIComponent(code)}`;
}

/**
 * Код из ПУТИ страницы перехода `/i/<код>` (§4.2.2).
 *
 * ⚠️ Та же проверка, что и для `?invite=`: путь приходит из адресной строки, то есть от кого угодно,
 * и «всё, что после /i/» пускать внутрь нельзя.
 * 🔴 Битый `%`-хвост (`/i/%`, `/i/%E0%A4`) — это `null`, а не исключение (#200). Адрес задаёт тот, кто прислал
 * ссылку, а `decodeURIComponent` на нём бросает `URIError`: разбор шёл прямо в отрисовке `App`, и человек видел экран
 * аварии вместо объяснения.
 */
export function inviteCodeFromPath(pathname: string): string | null {
  const m = /^\/i\/([^/?#]+)/.exec(pathname);
  if (!m) return null;
  let code: string;
  try {
    code = decodeURIComponent(m[1]).trim();
  } catch {
    return null;
  }
  return INVITE_CODE_RE.test(code) ? code : null;
}

/**
 * Адрес — страница перехода `/i/…`, но кода в нём не разобрать (#200): обрывок, лишние знаки, битый `%`.
 *
 * Человек шёл по приглашению, и молча показать ему обычный вход — значит оставить гадать, куда делось приглашение.
 * Ему говорят «ссылка не распознана» (`BROKEN_INVITE_*`), а адрес убирают, чтобы перезагрузка не повторяла того же.
 */
export function isBrokenInvitePath(pathname: string): boolean {
  return pathname.startsWith('/i/') && inviteCodeFromPath(pathname) === null;
}

/** Что сказать на битую ссылку `/i/…` (#200): что случилось и к кому идти — чинит её тот, кто прислал. */
export const BROKEN_INVITE_TITLE = 'Ссылка-приглашение не распознана';
export const BROKEN_INVITE_HINT = 'Похоже, её скопировали не целиком — попросите прислать ссылку ещё раз.';
