/**
 * Доставка событий на адрес бота: проверка подписи `X-GusVoice-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`
 * (сервер — `webhookSignature` в `packages/backend/src/bots/botRules.ts`) и переходник Web `Request`/`Response` → `node:http`.
 */

/** Заголовок подписи (в `Request.headers` регистр не важен). */
export const SIGNATURE_HEADER = 'x-gusvoice-signature';
/** Окно времени подписи по умолчанию: старше — повтор чужой записи, отказ. */
export const DEFAULT_TOLERANCE_S = 300;

const enc = new TextEncoder();

type Subtle = { importKey: (...a: any[]) => Promise<unknown>; sign: (...a: any[]) => Promise<ArrayBuffer> };

async function subtle(): Promise<Subtle> {
  const c = (globalThis as { crypto?: { subtle?: Subtle } }).crypto;
  if (c?.subtle) return c.subtle;
  // Node 18 без глобального `crypto`.
  const nodeCrypto = (await import('node:crypto')) as unknown as { webcrypto: { subtle: Subtle } };
  return nodeCrypto.webcrypto.subtle;
}

async function hmacHex(secret: string, data: Uint8Array): Promise<string> {
  const s = await subtle();
  const key = await s.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await s.sign('HMAC', key, data));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Сравнение за постоянное время: время не зависит от того, в каком знаке расхождение (длина подписи не секрет). */
function safeEqual(expected: string, got: string): boolean {
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/** Разбор заголовка: `t` и все `v1` (на будущее — несколько подписей при смене секрета). */
export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return Number.isFinite(t) && v1.length > 0 ? { t, v1 } : null;
}

export interface VerifyOptions {
  /** Окно времени, секунд (по умолчанию 300). */
  toleranceS?: number;
  /** «Сейчас», секунды Unix (для проверок). */
  nowS?: number;
}

/**
 * Подпись доставки верна и свежа. `body` — СЫРОЕ тело запроса (строка или байты), до разбора JSON:
 * переразобранный и заново собранный JSON подпись не сохранит.
 */
export async function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string | Uint8Array,
  options: VerifyOptions = {},
): Promise<boolean> {
  const sig = parseSignatureHeader(header);
  if (!sig || !secret) return false;
  const now = options.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - sig.t) > (options.toleranceS ?? DEFAULT_TOLERANCE_S)) return false;
  const bytes = typeof body === 'string' ? enc.encode(body) : body;
  const prefix = enc.encode(`${sig.t}.`);
  const data = new Uint8Array(prefix.length + bytes.length);
  data.set(prefix, 0);
  data.set(bytes, prefix.length);
  const expected = await hmacHex(secret, data);
  let ok = false;
  for (const v of sig.v1) ok = safeEqual(expected, v) || ok;
  return ok;
}

// ─── node:http ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Минимум `IncomingMessage`/`ServerResponse`, чтобы `.d.ts` не требовал `@types/node`. */
interface NodeReq extends AsyncIterable<unknown> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string | Uint8Array): unknown;
}

/** Предел тела доставки в переходнике (одно событие — единицы КБ). */
const NODE_BODY_MAX = 1024 * 1024;

/**
 * Обработчик `(Request) => Promise<Response>` → обработчик `node:http`:
 * `http.createServer(toNodeHandler(bot.webhookHandler({ secret })))`.
 */
export function toNodeHandler(handler: (req: Request) => Promise<Response>): (req: NodeReq, res: NodeRes) => void {
  return (req, res) => {
    void (async () => {
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const c of req) {
          const b = typeof c === 'string' ? enc.encode(c) : (c as Uint8Array);
          size += b.length;
          if (size > NODE_BODY_MAX) {
            res.statusCode = 413;
            res.end('payload too large');
            return;
          }
          chunks.push(b);
        }
        const body = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          body.set(c, at);
          at += c.length;
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
        }
        const method = req.method ?? 'GET';
        const request = new Request(`http://localhost${req.url ?? '/'}`, {
          method,
          headers,
          ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
        });
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(new Uint8Array(await response.arrayBuffer()));
      } catch {
        res.statusCode = 500;
        res.end('internal error');
      }
    })();
  };
}
