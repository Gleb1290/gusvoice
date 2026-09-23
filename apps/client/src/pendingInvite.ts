import { parseInviteParam, stripInviteParam } from './inviteLinkRules';

/**
 * Код приглашения, пришедший ссылкой `?invite=КОД`, — живёт до вступления на сервер (#142).
 *
 * ⚠️ В localStorage, а не в памяти: между открытием ссылки и первым входом бывает письмо с кодом
 * подтверждения или ожидание одобрения админом — человек закрывает вкладку и возвращается позже.
 */
const KEY = 'gv.pendingInvite';

/** Забрать код из адреса (если есть), запомнить и убрать из адресной строки. */
export function captureInviteFromUrl(): void {
  const code = parseInviteParam(window.location.search);
  if (!code) return;
  try {
    localStorage.setItem(KEY, code);
  } catch {
    /* приватный режим — код просто не переживёт перезагрузку */
  }
  window.history.replaceState({}, '', window.location.pathname + stripInviteParam(window.location.search) + window.location.hash);
}

/**
 * Запомнить код, пришедший НЕ строкой запроса, — например, с адреса `/i/<код>` (§4.2.2).
 *
 * ⚠️ Тот же ключ и тот же срок жизни, что у `?invite=`: два хранилища для одного и того же кода
 * однажды разошлись бы, и «вступить после входа» срабатывало бы через раз.
 */
export function rememberInvite(code: string): void {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    /* приватный режим — код не переживёт перезагрузку */
  }
}

export function pendingInvite(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* нечего чистить */
  }
}
