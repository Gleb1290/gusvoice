/**
 * Э3 часть 2 (#141, Ф3, docs/dm/FEDERATION.md §3.5): файл вложения ЛС больше 25 МБ — с соседа ПОТОКОМ, без сборки в память
 * (прокси смотрящему и копия в наш бакет кусками S3 multipart, `federation/convAtt.ts`).
 *
 * Защита адреса — та же, что у `safePeerRequest` (`safeFetch.resolvePeerTarget`: список хостов связок, режим стенда, IP-литерал,
 * резолвер без частных сетей), редиректы не ведём. Отдельным модулем: у `safeFetch.ts` и `peerClient.ts` закрытые перечни
 * зависимостей в проверках (R187, R189).
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, type Readable } from 'node:stream';
import { BlockedTargetError, REQUEST_DEADLINE_MS, resolvePeerTarget, type TestLookup } from '../safeFetch.js';
import { signRequest } from './httpSignature.js';
import type { PeerResult } from './peerClient.js';

/** Потолок тела (= `BIGFILE_MAX_BYTES`, наибольший файл ЛС); вызывающий ставит свой `maxBytes` — размер из провода или длину диапазона. */
export const PEER_MAX_STREAM_BYTES = 1024 * 1024 * 1024;
/** Тишина сокета посреди потока (смотрящий поставил видео на паузу — плеер перестаёт читать): дольше — обрыв. */
export const PEER_STREAM_IDLE_MS = 60_000;
/** Общий срок потока: гигабайт по медленной связке — десятки минут. */
export const PEER_STREAM_DEADLINE_MS = 60 * 60_000;
/** Подключение до первого байта ответа (как у `safeFetch`). */
const CONNECT_TIMEOUT_MS = 5000;

export type PeerStream = {
  status: number;
  contentType: string;
  /** `Content-Length` и `Content-Range` ответа соседа как есть (сверяет вызывающий). */
  contentLength: number | null;
  contentRange: string | null;
  /**
   * Тело. 🔴 Больше `maxBytes` — поток рвётся ошибкой «ответ соседа больше предела» (а не обрезается молча): копия не должна
   * лечь куском, смотрящий — получить чужой хвост. Читать до конца или `destroy()` — иначе висит сокет.
   */
  body: Readable;
};

/** GET соседа с телом потоком; `headers` — подпись и `range` (служебные `host`/`content-length` отбрасываются). */
export async function safePeerStream(
  req: { url: string; headers?: Record<string, string>; allowHosts: ReadonlySet<string>; maxBytes: number },
  testLookup?: TestLookup,
): Promise<PeerStream> {
  const { url, lookup } = resolvePeerTarget(req.url, req.allowHosts, testLookup);
  const maxBytes = Math.max(0, Math.min(req.maxBytes, PEER_MAX_STREAM_BYTES));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'content-length' || key === 'transfer-encoding') continue;
    headers[key] = v;
  }
  headers.accept = '*/*';
  headers['user-agent'] = 'GusVoice federation';
  const isHttps = url.protocol === 'https:';
  const r = (isHttps ? httpsRequest : httpRequest)({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'GET',
    headers,
    lookup,
    timeout: CONNECT_TIMEOUT_MS,
  });
  const headDeadline = setTimeout(() => r.destroy(new Error(`срок запроса истёк (${REQUEST_DEADLINE_MS} мс)`)), REQUEST_DEADLINE_MS);
  return await new Promise<PeerStream>((resolve, reject) => {
    r.on('response', (res) => {
      clearTimeout(headDeadline);
      const lenRaw = res.headers['content-length'];
      const contentLength = lenRaw !== undefined && /^\d+$/.test(lenRaw) ? Number(lenRaw) : null;
      if (contentLength !== null && contentLength > maxBytes && (res.statusCode ?? 0) < 300) {
        res.destroy();
        reject(new BlockedTargetError('ответ соседа больше предела'));
        return;
      }
      r.setTimeout(PEER_STREAM_IDLE_MS);
      const total = setTimeout(() => res.destroy(new Error(`срок потока истёк (${PEER_STREAM_DEADLINE_MS} мс)`)), PEER_STREAM_DEADLINE_MS);
      total.unref?.();
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            cb(new BlockedTargetError('ответ соседа больше предела'));
            return;
          }
          cb(null, chunk);
        },
      });
      res.on('error', (e) => limit.destroy(e));
      res.on('aborted', () => limit.destroy(new Error('сосед оборвал ответ')));
      res.on('close', () => {
        clearTimeout(total);
        if (!res.complete && !limit.destroyed) limit.destroy(new Error('сосед оборвал ответ'));
      });
      // Смотрящий ушёл (выдача уничтожила поток) — рвём и сокет к соседу.
      limit.on('close', () => {
        clearTimeout(total);
        if (!res.destroyed) res.destroy();
      });
      res.pipe(limit);
      resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        contentLength,
        contentRange: typeof res.headers['content-range'] === 'string' ? res.headers['content-range'] : null,
        body: limit,
      });
    });
    r.on('timeout', () => r.destroy(new Error('таймаут')));
    r.on('error', (e) => {
      clearTimeout(headDeadline);
      reject(e);
    });
    r.end();
  });
}

/**
 * Э3 часть 2 (#141): подписанный GET соседа с телом ПОТОКОМ (`safePeerStream`) — файл вложения ЛС больше 25 МБ: прокси
 * смотрящему и копия кусками. `range` — заголовок `Range` как есть (вне подписи: подпись покрывает адрес, а диапазон
 * сверяет вызывающий по `Content-Range`). `maxBytes` — сколько тела можно принять (размер из провода или длина диапазона).
 */
export async function streamSignedFromPeer(input: {
  apiBase: string;
  path: string;
  query?: Record<string, string | number | null | undefined>;
  keyid: string;
  privateKeyDer: Uint8Array;
  allowHosts: ReadonlySet<string>;
  now: number;
  maxBytes: number;
  range?: string;
}): Promise<PeerResult<PeerStream>> {
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
    const res = await safePeerStream({
      url,
      headers: input.range ? { ...headers, range: input.range } : headers,
      allowHosts: input.allowHosts,
      maxBytes: input.maxBytes,
    });
    return { ok: true, value: res };
  } catch (err) {
    return { ok: false, problem: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  }
}
