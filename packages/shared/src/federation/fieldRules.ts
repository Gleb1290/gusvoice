/**
 * Границы полей, которые приходят от СОСЕДА и ложатся в нашу базу и в интерфейс наших людей
 * (аудит федерации 19.09, F-06 и F-15; подтверждено заходом run-1 20.09).
 *
 * До этого разбор провода требовал от `sub`, ника, имени и отпечатка аватара одного — «непустая
 * строка». Сосед мог прислать `sub` с `../` (он уходит в ключ объекта хранилища и в служебный логин),
 * имя в сотни килобайт (оно едет каждому участнику в ростере и в каждом сообщении гостя) или имя с
 * невидимыми метками направления письма. Здесь — одни правила на токен личности, записи каталога и
 * визитку, чтобы три разбора не разошлись.
 *
 * ⚠️ Показываемый текст с нарушением НЕ роняет разбор целиком, а заменяется запасным вариантом (ник
 * вместо имени, пусто вместо названия): честный человек с редким символом в имени должен войти, а не
 * получить «личность негодна». Идентификаторы, наоборот, строгие: подменять их нечем.
 */

import { hasHiddenChars } from './textGuards';

export const FED_FIELD_LIMITS = {
  /** Идентификаторы людей, серверов, инстансов и отпечатков: уходят в ключи хранилища, Redis и URL. */
  id: 64,
  /** Ник — как у местной регистрации (`registerBody`): латиница, цифры и `._-`, до 32 знаков. */
  username: 32,
  /** Отображаемое имя — как у `PATCH /users/me`. */
  displayName: 64,
  /** Название сервера соседа в каталоге — как у нашего сервера. */
  serverName: 100,
  /** Название инстанса в визитке — как у своего (`INSTANCE_NAME_MAX`). */
  instanceName: 40,
  /** Одноразовая метка токена. */
  jti: 128,
  /** Домен по RFC 1035 плюс порт. */
  domain: 253,
} as const;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const JTI_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DOMAIN_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** Идентификатор: безопасный набор знаков и предел длины. `null` — не годится. */
export function fedId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

/** Ник — по правилам местной регистрации. */
export function fedUsername(v: unknown): string | null {
  return typeof v === 'string' && USERNAME_RE.test(v) ? v : null;
}

/** Отпечаток картинки: тот же набор знаков, что у идентификатора (наш — hex, но сосед может считать иначе). */
export function fedHash(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

export function fedJti(v: unknown): string | null {
  return typeof v === 'string' && JTI_RE.test(v) ? v : null;
}

/** Домен визитки: хост с необязательным портом, без схемы и пути. */
export function fedDomain(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > FED_FIELD_LIMITS.domain) return null;
  return DOMAIN_RE.test(v) ? v : null;
}

/**
 * Показываемый текст с запасным вариантом: пустое, слишком длинное или со скрытыми символами —
 * отдаём `fallback`, а не отказ (см. шапку).
 */
export function fedDisplayText(v: unknown, max: number, fallback: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || hasHiddenChars(v)) return fallback;
  return v;
}

/** То же для необязательного текста: негодное → `null` («не задано»). */
export function fedOptionalText(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || hasHiddenChars(v)) return null;
  return v;
}

/**
 * Адрес `http(s)://…` из визитки соседа (аудит 19.09, F-11).
 *
 * 🔴 Только `http:`/`https:` и без учётных данных: `client_origin` подставляется в `href` на странице
 * приглашения, и до этой проверки разбор принимал `javascript:`-строку как адрес. Два соседних
 * разборщика (`inviteLink.ts`, `configRules.ts`) уже прямо называют это попыткой атаки.
 *
 * `originOnly` — свести к «схема://хост[:порт]»: у адреса клиента пути быть не должно, а если сосед
 * его прислал, ссылки строились бы на путь, а не на его приложение.
 */
export function fedHttpUrl(v: unknown, opts: { originOnly?: boolean } = {}): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (opts.originOnly) return url.origin;
  if (url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}
