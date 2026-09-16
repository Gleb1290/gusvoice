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
