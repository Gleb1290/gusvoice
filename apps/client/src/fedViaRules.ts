/**
 * ЛС между инстансами, Э5 (#141, `fedm5`): «мой дом лежит — пишу через инстанс собеседника». ЧИСТЫЕ правила клиента: срок долгой
 * сессии, отпечаток отправленного (тот же, что считает дом, `convRules.payloadHash` бэкенда), очередь отчёта `via-claims`, проба дома.
 * Провод и запросы — `fedVia.ts`; контракт бэкенда — `docs/codemap/server.md` «ЛС между инстансами, этап Э5 часть 1».
 */

/** Долгая сессия на инстансе собеседника (`GET /conv/:id/fallback`); `expiresAt` — мс. */
export interface ViaCreds {
  instanceId: string;
  apiBase: string;
  userId: string;
  token: string;
  expiresAt: number;
}

/** Сессия живёт 8 суток; обновляем, когда до конца меньше суток. */
export const VIA_REFRESH_BEFORE_MS = 24 * 60 * 60 * 1000;
/** Не получилось завести сессию (связка рвалась, у соседа нет `dm4`, сосед молчал) — следующая попытка не раньше. */
export const VIA_RETRY_MS = 10 * 60 * 1000;
/** Проба дома: период и сколько подряд неудач считаются «дом лежит». */
export const HOME_PROBE_MS = 8_000;
export const HOME_PROBE_FAILS = 2;
/** Дом считается лежащим, только если шлюз оборван дольше этого (мс): короткий обрыв сети чинит переподключение. */
export const HOME_LOST_GRACE_MS = 6_000;

/** Сессия ещё действует. */
export function credsUsable(c: ViaCreds | null | undefined, now: number): c is ViaCreds {
  return !!c && !!c.token && !!c.apiBase && c.expiresAt > now;
}

/** Сессию пора обновить (нет, кончается меньше чем через сутки или уже кончилась). */
export function credsStale(c: ViaCreds | null | undefined, now: number): boolean {
  return !credsUsable(c, now) || c.expiresAt - now < VIA_REFRESH_BEFORE_MS;
}

/** Ответ сервера (или запись с диска) → запись для хранения; негодное — `null`. */
export function parseCreds(raw: unknown): ViaCreds | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ok =
    typeof r.instanceId === 'string' &&
    typeof r.apiBase === 'string' &&
    typeof r.userId === 'string' &&
    typeof r.token === 'string' &&
    typeof r.expiresAt === 'number';
  if (!ok || !r.token || !r.apiBase || !Number.isFinite(r.expiresAt)) return null;
  return {
    instanceId: r.instanceId as string,
    apiBase: r.apiBase as string,
    userId: r.userId as string,
    token: r.token as string,
    expiresAt: r.expiresAt as number,
  };
}

/** Нужно ли тянуть долгую сессию на открытии беседы: нет или кончается, и не пробовали недавно. */
export function fallbackDue(c: ViaCreds | null | undefined, lastTry: number | undefined, now: number): boolean {
  return credsStale(c, now) && (lastTry === undefined || now - lastTry >= VIA_RETRY_MS);
}

// ─── Отпечаток отправленного ─────────────────────────────────────────────────────────────────────────────────────────

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const ror = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 строки (UTF-8) в hex — синхронно и без `crypto.subtle` (его нет на небезопасных адресах и в тестовых окружениях). Отчёт
 * `via-claims` обязан совпасть с отпечатком дома байт в байт, поэтому — собственная реализация по FIPS 180-4; сверяется с
 * `node:crypto`.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((len * 8) / 0x100000000));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Отпечаток отправленного в обход дома — РОВНО как `convRules.payloadHash` бэкенда для текста без вложений: sha256 от
 * `JSON.stringify(['p1', беседа, текст без пробелов по краям, [], ответ или null])`. Дом считает свой отпечаток по тексту копии
 * у соседа и сверяет с этим: другой текст у соседа (подделка) — другой отпечаток.
 */
export function viaPayloadHash(conversationId: string, content: string, replyToId: string | null | undefined): string {
  return sha256Hex(JSON.stringify(['p1', conversationId, content.trim(), [], replyToId ?? null]));
}

// ─── Очередь отчёта ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Строка очереди: `home` — запись реестра дома (очередь у каждого дома своя). */
export interface ViaClaimRow {
  home: string;
  conversationId: string;
  clientId: string;
  payloadHash: string;
}

/** Бэкенд берёт в отчёте не больше 500 строк. */
export const VIA_CLAIMS_MAX = 500;

/** Добавить строку (повтор того же `clientId` дома заменяет); очередь держит последние `VIA_CLAIMS_MAX` строк дома. */
export function claimsAdd(list: readonly ViaClaimRow[], row: ViaClaimRow): ViaClaimRow[] {
  const rest = list.filter((x) => !(x.home === row.home && x.clientId === row.clientId));
  const mine = rest.filter((x) => x.home === row.home);
  const cut = mine.length >= VIA_CLAIMS_MAX ? new Set(mine.slice(0, mine.length - VIA_CLAIMS_MAX + 1)) : null;
  return [...(cut ? rest.filter((x) => !cut.has(x)) : rest), row];
}

/** Что идёт в отчёт дома `home` (без служебного поля). */
export function claimsFor(list: readonly ViaClaimRow[], home: string): { conversationId: string; clientId: string; payloadHash: string }[] {
  return list.filter((x) => x.home === home).map(({ conversationId, clientId, payloadHash }) => ({ conversationId, clientId, payloadHash }));
}

/** После принятого отчёта убрать ушедшие строки; добавленные за время запроса остаются. */
export function claimsClear(list: readonly ViaClaimRow[], home: string, sent: readonly { clientId: string }[]): ViaClaimRow[] {
  const gone = new Set(sent.map((x) => x.clientId));
  return list.filter((x) => !(x.home === home && gone.has(x.clientId)));
}

/** Прочитать очередь с диска: негодное выбрасывается. */
export function parseClaims(raw: unknown): ViaClaimRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ViaClaimRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (typeof x.home === 'string' && typeof x.conversationId === 'string' && typeof x.clientId === 'string' && typeof x.payloadHash === 'string') {
      out.push({ home: x.home, conversationId: x.conversationId, clientId: x.clientId, payloadHash: x.payloadHash });
    }
  }
  return out;
}

/**
 * Сообщение, полученное по сессии «через» (`send`/`history` в `fedVia.ts`), — в id своего дома. На инстансе собеседника я — теневая
 * строка `viaUserId` (`ViaCreds.userId`), собеседник — местный: без перевода своё сообщение встало бы слева чужим, с подписью «через
 * мой дом» (живая проверка 12.10). Перевод — только автора; остальное (реакции, ответы) лента берёт после возврата дома.
 */
export function viaLocalize<M extends { author: { id: string } }>(m: M, viaUserId: string, selfId: string | undefined, peerId: string | undefined): M {
  const from = (m.author as { id: string } | undefined)?.id;
  if (!from) return m;
  const id = from === viaUserId ? selfId : peerId;
  return id && id !== from ? { ...m, author: { ...m.author, id } } : m;
}

/**
 * Э7 часть 3 (#141, `dmgroup2`): то же для группы чужого дома — собеседника нет, авторов много. Я (`viaUserId`) → свой id; остальные
 * (на хосте у них свои id) — участник группы у нас с тем же именем, если он ровно один и среди участников такого id ещё нет;
 * неоднозначное оставляем как пришло (лента покажет автора по его же имени).
 */
export function viaLocalizeGroup<M extends { author: { id: string; displayName?: string } }>(
  m: M,
  viaUserId: string,
  selfId: string | undefined,
  members: readonly { id: string; displayName: string }[],
): M {
  const from = (m.author as { id: string } | undefined)?.id;
  if (!from) return m;
  if (from === viaUserId) return selfId && selfId !== from ? { ...m, author: { ...m.author, id: selfId } } : m;
  if (members.some((x) => x.id === from)) return m;
  const name = m.author.displayName;
  const same = name ? members.filter((x) => x.id !== selfId && x.displayName === name) : [];
  return same.length === 1 ? { ...m, author: { ...m.author, id: same[0].id } } : m;
}
