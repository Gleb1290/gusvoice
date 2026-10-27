/**
 * Подписи запросов между инстансами — RFC 9421 (#139, F1, план §5.1).
 *
 * Зачем подпись, если есть HTTPS: TLS доказывает, что мы говорим с ТЕМ ДОМЕНОМ, но связка держится
 * не на домене, а на ключе (§5.1.3). Домен могут перехватить, сертификат перевыпустить, запрос может
 * прийти через прокси соседа — а подпись сменным ключом, выпущенным корневым ключом инстанса,
 * подделать нельзя, не украв сам ключ.
 *
 * Здесь чистые правила: ни сети, ни файлов, ни часов — время приходит параметром, чтобы окно допуска
 * можно было проверить, не дожидаясь его наступления.
 *
 * Реализовано намеренно УЗКОЕ подмножество RFC 9421: одна подпись с меткой `sig1`, фиксированный
 * набор компонентов, алгоритм только `ed25519`. Чем меньше степеней свободы у проверяющего, тем
 * меньше способов проскочить мимо проверки — разнообразие здесь не достоинство, а поверхность атаки.
 */

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

/** Компоненты, которые подписываются. Порядок — часть подписи, менять нельзя. */
const COMPONENTS = ['@method', '@target-uri', 'content-digest'] as const;

/** Сколько живёт подпись. Короткое окно — меньше места для повтора перехваченного запроса. */
export const SIGNATURE_TTL_S = 60;

/** Допуск расхождения часов (план §5.1): дальше — отказ `federation.clock_skew`. */
export const CLOCK_SKEW_TOLERANCE_S = 60;

export type VerifyFailure = 'malformed' | 'unknown-key' | 'bad-signature' | 'clock-skew' | 'expired';

export type VerifyOutcome =
  | { ok: true; keyid: string; /** Срок подписи, с эпохи (аудит ЛС #236, п.15: столько держится отметка от повтора). */ expires?: number }
  | { ok: false; reason: VerifyFailure; skewS?: number };

export interface SignedHeaders {
  'content-digest': string;
  'signature-input': string;
  signature: string;
  /** Заголовки уезжают в `safePeerRequest`, который принимает произвольный набор. */
  [header: string]: string;
}

/** `Content-Digest` по RFC 9530: тело подписывается через хеш, иначе подпись не защищает содержимое. */
export function contentDigest(body: string): string {
  return `sha-256=:${createHash('sha256').update(body, 'utf8').digest('base64')}:`;
}

function signatureParams(keyid: string, created: number, expires: number): string {
  const inner = COMPONENTS.map((c) => `"${c}"`).join(' ');
  return `(${inner});created=${created};expires=${expires};keyid="${keyid}";alg="ed25519"`;
}

/**
 * Строка, которая реально подписывается.
 *
 * ⚠️ Последней строкой обязана идти `@signature-params`: без неё подписаны данные, но не то, КАКИЕ
 * компоненты и с каким сроком подписаны, — их можно было бы подменить, оставив подпись годной.
 */
export function signatureBase(input: {
  method: string;
  targetUri: string;
  contentDigest: string;
  keyid: string;
  created: number;
  expires: number;
}): string {
  return [
    `"@method": ${input.method.toUpperCase()}`,
    `"@target-uri": ${input.targetUri}`,
    `"content-digest": ${input.contentDigest}`,
    `"@signature-params": ${signatureParams(input.keyid, input.created, input.expires)}`,
  ].join('\n');
}

/** Подписать исходящий запрос: отдаёт три заголовка, которые надо поставить. */
export function signRequest(input: {
  method: string;
  targetUri: string;
  body: string;
  keyid: string;
  privateKeyDer: Uint8Array;
  nowS: number;
  ttlS?: number;
}): SignedHeaders {
  const digest = contentDigest(input.body);
  const created = input.nowS;
  const expires = created + (input.ttlS ?? SIGNATURE_TTL_S);
  const base = signatureBase({
    method: input.method,
    targetUri: input.targetUri,
    contentDigest: digest,
    keyid: input.keyid,
    created,
    expires,
  });
  const key = createPrivateKey({ key: Buffer.from(input.privateKeyDer), format: 'der', type: 'pkcs8' });
  return {
    'content-digest': digest,
    'signature-input': `sig1=${signatureParams(input.keyid, created, expires)}`,
    signature: `sig1=:${edSign(null, Buffer.from(base, 'utf8'), key).toString('base64')}:`,
  };
}

/** Разобрать `Signature-Input`. `null` на всём, что не наш узкий формат. */
export function parseSignatureInput(
  header: string | undefined,
): { keyid: string; created: number; expires: number; components: string[] } | null {
  if (!header) return null;
  const m = /^sig1=\(([^)]*)\);(.*)$/.exec(header.trim());
  if (!m) return null;
  const components = m[1]
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => c.replace(/^"|"$/g, ''));
  const params = m[2];
  const created = Number(/created=(\d+)/.exec(params)?.[1]);
  const expires = Number(/expires=(\d+)/.exec(params)?.[1]);
  const keyid = /keyid="([^"]+)"/.exec(params)?.[1];
  const alg = /alg="([^"]+)"/.exec(params)?.[1];
  if (!keyid || alg !== 'ed25519' || !Number.isFinite(created) || !Number.isFinite(expires)) return null;
  return { keyid, created, expires, components };
}

/**
 * Проверить входящий запрос.
 *
 * `findKey` отдаёт публичный ключ по `keyid` — это дело вызывающего: он смотрит в связки и решает,
 * доверяем ли мы вообще этому инстансу. Здесь только криптография, срок и часы.
 */
export function verifyRequest(input: {
  method: string;
  targetUri: string;
  body: string;
  headers: { 'content-digest'?: string; 'signature-input'?: string; signature?: string };
  findKey(keyid: string): Uint8Array | null;
  nowS: number;
  toleranceS?: number;
}): VerifyOutcome {
  const parsed = parseSignatureInput(input.headers['signature-input']);
  const sigHeader = input.headers.signature;
  const digestHeader = input.headers['content-digest'];
  if (!parsed || !sigHeader || !digestHeader) return { ok: false, reason: 'malformed' };

  // Набор компонентов задан НАМИ, а не берётся из запроса: иначе отправитель подписал бы один лишь
  // метод и объявил это достаточным.
  if (parsed.components.length !== COMPONENTS.length || parsed.components.some((c, i) => c !== COMPONENTS[i])) {
    return { ok: false, reason: 'malformed' };
  }

  // 🔴 Тело сверяется с заголовком ДО проверки подписи: подпись покрывает `content-digest`, а не само
  // тело, так что без этой сверки один подписанный заголовок ездил бы с любым телом.
  if (contentDigest(input.body) !== digestHeader) return { ok: false, reason: 'bad-signature' };

  /**
   * 🔴 Сначала ключ и подпись, потом часы (аудит 19.09, F-12). Раньше просрочка и разъехавшиеся часы
   * отвечали ДО проверки подписи — и посторонний, назвав в запросе id нашего соседа и поставив старую
   * дату, получал `expired` там, где на «нет такой связки» отвечают `unknown`: по разнице ответов он
   * перебором узнавал, с кем мы связаны. Теперь причину, отличную от «неизвестно», получает только
   * тот, чья подпись сошлась, — то есть сам сосед. Цена — одна проверка Ed25519 на просроченный
   * запрос; поток таких запросов упирается в предел по адресу раньше.
   */
  const publicKeyDer = input.findKey(parsed.keyid);
  if (!publicKeyDer) return { ok: false, reason: 'unknown-key' };

  const base = signatureBase({
    method: input.method,
    targetUri: input.targetUri,
    contentDigest: digestHeader,
    keyid: parsed.keyid,
    created: parsed.created,
    expires: parsed.expires,
  });
  const raw = /^sig1=:(.+):$/.exec(sigHeader.trim())?.[1];
  if (!raw) return { ok: false, reason: 'malformed' };
  let genuine = false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyDer), format: 'der', type: 'spki' });
    genuine = edVerify(null, Buffer.from(base, 'utf8'), key, Buffer.from(raw, 'base64'));
  } catch {
    genuine = false;
  }
  if (!genuine) return { ok: false, reason: 'bad-signature' };

  const tolerance = input.toleranceS ?? CLOCK_SKEW_TOLERANCE_S;
  // Запрос из будущего дальше допуска — часы разъехались. Отдельная причина, потому что и лечится
  // отдельно (настроить время на сервере), а не «попробуйте ещё раз».
  if (parsed.created - input.nowS > tolerance) {
    return { ok: false, reason: 'clock-skew', skewS: parsed.created - input.nowS };
  }
  if (input.nowS - parsed.expires > tolerance) {
    // Просрочка больше допуска: либо ушедшие часы, либо запрос пролежал у кого-то в кармане.
    return { ok: false, reason: 'expired', skewS: input.nowS - parsed.expires };
  }
  return { ok: true, keyid: parsed.keyid, expires: parsed.expires };
}
