/**
 * Разговор с соседним инстансом (#139, F1): забрать его визитку и отправить подписанный запрос.
 *
 * Поверх `safePeerRequest` из F0 — там уже живёт защита от увода запроса в чужую сеть (проверка
 * адреса в резолвере, запрет приватных диапазонов, отказ вести редиректы, предел размера). Здесь
 * добавляется смысл федерации: проверка ключей в визитке, согласование версии протокола и подпись.
 */

import {
  instanceDocumentOriginProblem,
  negotiateProtocol,
  parseInstanceDocument,
  FED_PROTOCOL,
  type FedInstanceDocument,
  type FedSigningKey,
} from '@gusvoice/shared';
import { safePeerRequest, type PeerRequest, type SafeResponse } from '../safeFetch.js';
import { peerScheme } from './devPeers.js';
import { fingerprintFrom, instanceIdFrom } from './instanceIdentity.js';
import { signRequest } from './httpSignature.js';
import { keyIsCurrent, verifySigningKey } from './signingKeys.js';

export type PeerProblem =
  | 'unreachable'
  | 'not-federated'
  | 'bad-document'
  /** Веб-клиент по домену из визитки не подтвердил, что этот API — его (#197 п. 1, F-11). */
  | 'domain-unproven'
  | 'forged-keys'
  | 'protocol-mismatch';

export interface PeerDocument {
  doc: FedInstanceDocument;
  /** Личность, ВЫВЕДЕННАЯ из корневого ключа документа, а не взятая из поля `instance_id`. */
  instanceId: string;
  fingerprint: string;
  /** Версия протокола, на которой сошлись. */
  protocolVersion: number;
}

export type PeerResult<T> = { ok: true; value: T } | { ok: false; problem: PeerProblem; detail?: string };

/**
 * Забрать визитку соседа и проверить её.
 *
 * 🔴 `instance_id` из тела документа НЕ используется как личность: его сосед пишет сам, а мы обязаны
 * считать личность из корневого ключа. Если поле разошлось с ключом — это подделка или ошибка, и
 * дальше идти нельзя: именно на этой связи держится всё доверие.
 * 🔴 Сменные ключи, не подписанные корневым ключом ИЗ ЭТОГО ЖЕ документа, выбрасываются: иначе
 * подменивший ответ добавил бы свой ключ и подписывал им запросы от имени соседа.
 */
export async function fetchPeerDocument(input: {
  apiBase: string;
  allowHosts: ReadonlySet<string>;
  now: number;
  /** Свой срок — шагам связывания, где у соседа на всё про всё 20 с (#198 п. 3). */
  deadlineMs?: number;
}): Promise<PeerResult<PeerDocument>> {
  let res;
  try {
    res = await safePeerRequest({
      method: 'GET',
      url: `${input.apiBase.replace(/\/+$/, '')}/api/fed/v1/instance`,
      allowHosts: input.allowHosts,
      deadlineMs: input.deadlineMs,
    });
  } catch (err) {
    return { ok: false, problem: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  }
  // 404 — обычный GusVoice без федерации либо вовсе другой сайт: это не поломка, а «нам тут не рады».
  if (res.status === 404) return { ok: false, problem: 'not-federated' };
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, problem: 'unreachable', detail: `ответ ${res.status}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(res.body);
  } catch {
    return { ok: false, problem: 'bad-document', detail: 'ответ не JSON' };
  }
  const doc = parseInstanceDocument(raw);
  if (!doc) return { ok: false, problem: 'bad-document' };
  /**
   * 🔴 Хост `api_base` — тот, откуда визитка реально забрана (#195 п. 14; запасной путь кодов прежних
   * версий — #196 п. 12; порт — #197 п. 2): `instanceDocumentOriginProblem`, чистая, в shared. Адрес
   * клиента обязан совпадать с доменом: свой документ мы строим ровно так (`domainFromOrigin`).
   * Сам домен визитка НЕ доказывает — ни сверкой с `client_origin` (#195 п. 14: оба поля пишет
   * сосед), ни родством имён (#196 п. 1 → #197 п. 1: на общей зоне любой назвался бы чужим именем).
   * Доказательство — `proveDomain`, отдельный поход при заведении связки.
   */
  const clientHost = (() => {
    try {
      return new URL(doc.clientOrigin).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (doc.domain.toLowerCase() !== clientHost) {
    return { ok: false, problem: 'bad-document', detail: 'домен не совпадает с адресом клиента' };
  }
  if (instanceDocumentOriginProblem(doc, input.apiBase)) {
    return { ok: false, problem: 'bad-document', detail: 'api_base не совпадает с адресом, откуда взята визитка' };
  }

  let rootKeyDer: Buffer;
  try {
    rootKeyDer = Buffer.from(doc.rootKey, 'base64url');
  } catch {
    return { ok: false, problem: 'bad-document', detail: 'корневой ключ не разобрался' };
  }
  const instanceId = instanceIdFrom(rootKeyDer);
  if (instanceId !== doc.instanceId) {
    return { ok: false, problem: 'forged-keys', detail: 'идентификатор не выводится из корневого ключа' };
  }
  const genuine = doc.keys.filter((k) => verifySigningKey(rootKeyDer, k));
  if (doc.keys.length > 0 && genuine.length === 0) {
    return { ok: false, problem: 'forged-keys', detail: 'ни один ключ подписи не подтверждён корневым' };
  }

  const protocolVersion = negotiateProtocol(FED_PROTOCOL, doc.protocol);
  if (protocolVersion === null) {
    return {
      ok: false,
      problem: 'protocol-mismatch',
      detail: `у нас ${FED_PROTOCOL.min}–${FED_PROTOCOL.max}, у соседа ${doc.protocol.min}–${doc.protocol.max}`,
    };
  }

  return {
    ok: true,
    value: {
      doc: { ...doc, keys: genuine },
      instanceId,
      fingerprint: fingerprintFrom(rootKeyDer),
      protocolVersion,
    },
  };
}

/**
 * Срок на один шаг связывания — визитку и `config.json` (#198 п. 3): у соседа на всю заявку 20 с
 * (`REQUEST_DEADLINE_MS`), и два похода по 20 с внутри неё превращали честный отказ в «недоступен».
 */
export const LINK_STEP_DEADLINE_MS = 6_000;

/**
 * Доказать домен визитки (#197 п. 1; F-11).
 *
 * Домен — хост веб-клиента, и веб-клиент по этому адресу отдаёт `/config.json` со своим `apiUrl`
 * (пишет `docker-entrypoint` образа клиента с 04.07 — есть у всех версий с федерацией). Если владелец
 * домена сам называет своим API тот же хост, что и `api_base` визитки, — домен его. Так не нужен
 * список публичных зон, и честно проходят все раскладки «веб и API на разных хостах», включая API на
 * голом домене (#197 п. 3).
 *
 * ⚠️ `apiUrl` у веба (`VITE_API_URL`) и `api_base` у визитки (`FEDERATION_API_BASE`) — две разные
 * настройки (#198 п. 1). Разошлись — доказательство второе: по адресу, который назвал веб, должна
 * отвечать ТА ЖЕ личность (тот же корневой ключ), что и в визитке. Пустой или относительный `apiUrl`
 * («API на том же адресе») читается относительно самого `config.json`.
 *
 * 🔴 Это исходящие запросы по адресам, которые назвал сосед: тот же `safePeerRequest` — запрет частных
 * адресов, без редиректов, предел размера и короткий срок (`LINK_STEP_DEADLINE_MS`). Зовётся ТОЛЬКО
 * при заведении, подтверждении и перепривязке связки (`linkService`), а не на каждом чтении визитки:
 * домен связки после этого хранится у нас, из свежих визиток он не перечитывается.
 *
 * Отказ — свой код `domain-unproven` с причиной словами: держатель должен увидеть, что на
 * `https://<домен>/config.json` никто не отвечает или там назван другой API, а не безликий отказ.
 * `request` подменяется в проверках.
 */
export async function proveDomain(
  doc: Pick<FedInstanceDocument, 'domain' | 'apiBase' | 'rootKey'>,
  request: (req: PeerRequest) => Promise<SafeResponse> = safePeerRequest,
): Promise<PeerResult<true>> {
  const domain = doc.domain.trim().toLowerCase();
  let apiHost: string;
  try {
    apiHost = new URL(doc.apiBase).host.toLowerCase();
  } catch {
    return { ok: false, problem: 'bad-document', detail: 'api_base не разбирается' };
  }
  // Режим стенда (Ф13): у хоста из `FEDERATION_DEV_PEERS` — `http`, остальным по-прежнему только `https`.
  const url = `${peerScheme(domain)}://${domain}/config.json`;
  const refuse = (why: string): PeerResult<true> => ({ ok: false, problem: 'domain-unproven', detail: `${url}: ${why}` });
  let res: SafeResponse;
  try {
    res = await request({ method: 'GET', url, allowHosts: new Set([domain]), deadlineMs: LINK_STEP_DEADLINE_MS });
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  if (res.status < 200 || res.status >= 300) return refuse(`ответ ${res.status}`);
  let apiUrl: unknown;
  try {
    const parsed: unknown = JSON.parse(res.body);
    apiUrl = parsed && typeof parsed === 'object' ? (parsed as { apiUrl?: unknown }).apiUrl : undefined;
  } catch {
    return refuse('не JSON');
  }
  if (typeof apiUrl !== 'string') return refuse('нет apiUrl');
  let declared: URL;
  try {
    // Пусто — «API на том же адресе», относительный путь — тоже (#198 п. 1).
    declared = new URL(apiUrl.trim() === '' ? '/' : apiUrl, url);
  } catch {
    return refuse('apiUrl не разбирается');
  }
  if (declared.host.toLowerCase() === apiHost) return { ok: true, value: true };

  // Адреса разошлись — спрашиваем личность у того API, который назвал веб (#198 п. 1).
  const named = `${declared.origin}${declared.pathname.replace(/\/+$/, '')}`;
  let peer: SafeResponse;
  try {
    peer = await request({
      method: 'GET',
      url: `${named}/api/fed/v1/instance`,
      allowHosts: new Set([declared.host.toLowerCase()]),
      deadlineMs: LINK_STEP_DEADLINE_MS,
    });
  } catch (err) {
    return refuse(`веб называет своим API ${declared.host}, а он не отвечает: ${err instanceof Error ? err.message : String(err)}`);
  }
  let theirs: FedInstanceDocument | null = null;
  try {
    theirs = peer.status >= 200 && peer.status < 300 ? parseInstanceDocument(JSON.parse(peer.body)) : null;
  } catch {
    theirs = null;
  }
  if (!theirs) return refuse(`веб называет своим API ${declared.host}, а визитки там нет (ответ ${peer.status})`);
  let same = false;
  try {
    same = instanceIdFrom(Buffer.from(theirs.rootKey, 'base64url')) === instanceIdFrom(Buffer.from(doc.rootKey, 'base64url'));
  } catch {
    same = false;
  }
  if (!same) return refuse(`веб называет своим API ${declared.host}, а там другая личность`);
  /**
   * 🔴 Совпадения ключа мало (#199 п. 1): корневой ключ ПУБЛИЧЕН, скопировать его в свою визитку может
   * кто угодно. Визитка по адресу из веба обязана называть ТОТ ЖЕ `api_base` и тот же домен, что и
   * визитка, пришедшая с заявкой: у честного сервера с двумя адресами API (`FEDERATION_API_BASE` ≠
   * `VITE_API_URL`) на обоих отдаётся один документ, а у самозванца по адресу из веба лежит визитка
   * настоящего владельца со своим `api_base`.
   */
  const theirApiHost = (() => {
    try {
      return new URL(theirs.apiBase).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (theirApiHost !== apiHost || theirs.domain.trim().toLowerCase() !== domain) {
    return refuse(`веб называет своим API ${declared.host}, а визитка там указывает на ${theirApiHost || 'другой адрес'}`);
  }
  return { ok: true, value: true };
}

/**
 * Найти в визитке ключ, которым подписан пришедший к нам запрос.
 *
 * Проверяются три вещи, и все обязательны: ключ есть в документе, он подписан корневым ключом того
 * же документа, и он действует сейчас. Просроченный ключ отличается от неизвестного намеренно —
 * первое значит «у соседа несвежая визитка», второе «подпись чужая», и в аудите это разные записи.
 */
export function findPeerKey(
  doc: FedInstanceDocument,
  kid: string,
  now: number,
): { key: FedSigningKey; expired: boolean } | null {
  const key = doc.keys.find((k) => k.kid === kid);
  if (!key) return null;
  let rootKeyDer: Buffer;
  try {
    rootKeyDer = Buffer.from(doc.rootKey, 'base64url');
  } catch {
    return null;
  }
  if (!verifySigningKey(rootKeyDer, key)) return null;
  return { key, expired: !keyIsCurrent(key, now) };
}

/**
 * Забрать у соседа подписанный GET (каталог и список серверов, F2).
 *
 * 🔴 Строка запроса (`since`, `cursor`) входит в подписываемый адрес: иначе посредник подменил бы
 * `since` на «с начала времён» или увёл бы курсор, и синхронизация ходила бы по кругу, выглядя
 * снаружи работающей.
 * ⚠️ Тела у GET нет, и подписывается отпечаток ПУСТОЙ строки — так же, как его посчитает
 * проверяющая сторона. Пустое тело это тоже тело: подпись покрывает его наравне с остальным.
 */
export async function getSignedFromPeer(input: {
  apiBase: string;
  path: string;
  query?: Record<string, string | number | null | undefined>;
  keyid: string;
  privateKeyDer: Uint8Array;
  allowHosts: ReadonlySet<string>;
  now: number;
  /** Ответ — файл (аватар соседа): байты приезжают отдельно, `body` остаётся пустым. */
  binary?: boolean;
  maxBytes?: number;
  /** Э3: файл вложения ЛС (`safePeerRequest.attachment`) — свой потолок и срок. */
  attachment?: boolean;
}): Promise<PeerResult<{ status: number; body: string; bytes?: Buffer; contentType: string; retryAfter?: number }>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  const url = `${input.apiBase.replace(/\/+$/, '')}${input.path}${suffix ? `?${suffix}` : ''}`;
  const headers = signRequest({
    method: 'GET',
    targetUri: url,
    body: '',
    keyid: input.keyid,
    privateKeyDer: input.privateKeyDer,
    nowS: Math.floor(input.now / 1000),
  });
  try {
    const res = await safePeerRequest({
      method: 'GET',
      url,
      headers,
      allowHosts: input.allowHosts,
      binary: input.binary,
      maxBytes: input.maxBytes,
      ...(input.attachment ? { attachment: true } : {}),
    });
    return {
      ok: true,
      value: {
        status: res.status,
        body: res.body,
        bytes: res.bytes,
        contentType: res.contentType,
        // Исправления ревью ЛС 12.10, п. 1: 429 соседа — забор журнала ждёт `retry-after`.
        ...(res.retryAfter !== undefined ? { retryAfter: res.retryAfter } : {}),
      },
    };
  } catch (err) {
    return { ok: false, problem: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Отправить соседу подписанный POST. Тело сериализуется здесь: подпись считается по тем же байтам. */
export async function postSignedToPeer(input: {
  apiBase: string;
  path: string;
  payload: unknown;
  keyid: string;
  privateKeyDer: Uint8Array;
  allowHosts: ReadonlySet<string>;
  now: number;
}): Promise<PeerResult<{ status: number; body: string }>> {
  const url = `${input.apiBase.replace(/\/+$/, '')}${input.path}`;
  const body = JSON.stringify(input.payload);
  const headers = signRequest({
    method: 'POST',
    // ⚠️ Подписывается ТОТ ЖЕ адрес, по которому уходит запрос: подпись привязана к цели, иначе её
    // можно было бы переадресовать на другой маршрут соседа.
    targetUri: url,
    body,
    keyid: input.keyid,
    privateKeyDer: input.privateKeyDer,
    nowS: Math.floor(input.now / 1000),
  });
  try {
    const res = await safePeerRequest({ method: 'POST', url, body, headers, allowHosts: input.allowHosts });
    return { ok: true, value: { status: res.status, body: res.body } };
  } catch (err) {
    return { ok: false, problem: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  }
}
