import type { ConvMessage } from '@gusvoice/shared';
import { api, apiVia } from './api';
import { activeInstance, activeInstanceId, config } from './config';
import { gatewayLiveNow, onConnChange } from './connState';
import { bindFedVia, type FedViaHooks } from './convStore';
import { fedViaWanted } from './convSyncRules';
import {
  HOME_LOST_GRACE_MS,
  HOME_PROBE_FAILS,
  HOME_PROBE_MS,
  claimsAdd,
  claimsClear,
  claimsFor,
  credsUsable,
  fallbackDue,
  parseClaims,
  parseCreds,
  viaLocalize,
  viaLocalizeGroup,
  viaPayloadHash,
  VIA_CLAIMS_MAX,
  type ViaClaimRow,
  type ViaCreds,
} from './fedViaRules';
import { useStore } from './store';

/**
 * ЛС между инстансами, Э5 (#141, `fedm5`): «мой дом лежит — пишу через инстанс собеседника». Обвязка клиента; правила — `fedViaRules.ts`
 * и `convSyncRules.ts` (Э5), отправка и история в обход — крючки `convStore.bindFedVia`, плашка и подписи — `DmChatView` по полю стора
 * `fedVia`. Контракт бэкенда — `docs/codemap/server.md` «ЛС между инстансами, этап Э5 часть 1».
 *
 * Что делает:
 * 1. Открыта беседа 1:1 с человеком соседа (`fedViaWanted`) — тихо берёт `GET /conv/:id/fallback` и хранит сессию (`localStorage`, как
 *    основной токен; обновляет, когда до конца меньше суток). Ошибки (связка, сосед без `dm4`, сосед молчит) — тихо, повтор не чаще раза в 10 мин.
 * 2. «Дом лежит»: шлюз оборван и проба дома (`GET /health`) не отвечает дважды подряд, либо отправка в дом не дошла (`isHomeDownError`).
 *    Тогда `fedVia.down` в сторе — плашка над полем; текст уходит по сессии на инстанс собеседника, история подтягивается оттуда же.
 * 3. Дом вернулся (шлюз снова на связи или проба ответила) — отчёт `POST /conv/via-claims` из очереди (пустой — тоже, если дом лежал),
 *    очередь чистится, режим обычный. Дом подтверждает сообщения задним числом сам.
 */

const CREDS_KEY = 'gv_fedvia';
const CLAIMS_KEY = 'gv_fedvia_claims';
const POLL_MS = 6_000;
const REPORT_RETRY_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

type CredsByHome = Record<string, Record<string, ViaCreds>>;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — сессия живёт до перезапуска */
  }
}

const homeKey = (): string => activeInstanceId() ?? '';

function readCreds(): CredsByHome {
  const raw = readJson(CREDS_KEY);
  const out: CredsByHome = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [home, convs] of Object.entries(raw as Record<string, unknown>)) {
    if (!convs || typeof convs !== 'object') continue;
    for (const [convId, c] of Object.entries(convs as Record<string, unknown>)) {
      const parsed = parseCreds(c);
      if (parsed) (out[home] ??= {})[convId] = parsed;
    }
  }
  return out;
}

let credsCache: CredsByHome | null = null;
const allCreds = (): CredsByHome => (credsCache ??= readCreds());

function credsOf(convId: string): ViaCreds | null {
  return allCreds()[homeKey()]?.[convId] ?? null;
}

function saveCreds(convId: string, c: ViaCreds | null): void {
  const all = allCreds();
  const home = homeKey();
  const mine = { ...(all[home] ?? {}) };
  if (c) mine[convId] = c;
  else delete mine[convId];
  if (Object.keys(mine).length) all[home] = mine;
  else delete all[home];
  writeJson(CREDS_KEY, all);
  publish();
}

/** Выход из аккаунта: токены соседей этого дома не хранятся; очередь отчёта остаётся (отчитаемся после следующего входа). */
function forgetCreds(): void {
  const all = allCreds();
  if (!all[homeKey()]) return;
  delete all[homeKey()];
  writeJson(CREDS_KEY, all);
  publish();
}

let claims: ViaClaimRow[] | null = null;
const claimList = (): ViaClaimRow[] => (claims ??= parseClaims(readJson(CLAIMS_KEY)));
function setClaims(next: ViaClaimRow[]): void {
  claims = next;
  writeJson(CLAIMS_KEY, next);
}

let down = false;
/** Дом лежал с последнего отчёта: отчёт нужен и пустой (`docs/dm/FEDERATION.md` §1.5). */
let owed = false;

/** В стор: плашка и запрет вложений читают `fedVia` (`DmChatView`). */
function publish(): void {
  const home = homeKey();
  const now = Date.now();
  const ready = Object.entries(allCreds()[home] ?? {})
    .filter(([, c]) => credsUsable(c, now))
    .map(([id]) => id);
  const inst = activeInstance();
  const self = inst?.name?.trim() || inst?.domain || '';
  const cur = useStore.getState().fedVia;
  if (cur && cur.down === down && cur.self === self && cur.ready.length === ready.length && cur.ready.every((x, i) => x === ready[i])) return;
  useStore.setState({ fedVia: { down, self, ready } });
}

// ─── Сессия у собеседника ────────────────────────────────────────────────────────────────────────────────────────────

const lastTry = new Map<string, number>();
const inFlight = new Set<string>();

/** Тихо взять или обновить долгую сессию беседы; отказ — тишина (повтор не раньше `VIA_RETRY_MS`). */
async function ensureFallback(convId: string): Promise<void> {
  const now = Date.now();
  if (inFlight.has(convId) || !fallbackDue(credsOf(convId), lastTry.get(convId), now) || down) return;
  inFlight.add(convId);
  lastTry.set(convId, now);
  const home = homeKey();
  try {
    const c = parseCreds(await api.convFallback(convId));
    if (c && home === homeKey()) saveCreds(convId, c);
  } catch {
    /* 409/503/404 или дом молчит: обход недоступен, обычная беседа */
  } finally {
    inFlight.delete(convId);
  }
}

function wantedFor(convId: string | null): boolean {
  if (!convId) return false;
  const s = useStore.getState();
  const dm = s.dms.find((d) => d.id === convId);
  if (!dm || dm.saved) return false;
  // Э7 часть 3 (#141): группа чужого дома — «через» к её хосту; группа своего дома (хост — мы) в обходе не нуждается.
  if (dm.group) return !!s.conv?.summaries?.[convId]?.fedGroupHost && fedViaWanted(true, s.serverFeatures, s.conv?.summaries?.[convId]);
  return fedViaWanted(!!dm.otherUser?.homeInstance, s.serverFeatures, s.conv?.summaries?.[convId]);
}

function ensureOpen(): void {
  const id = useStore.getState().currentDmId;
  if (wantedFor(id)) void ensureFallback(id as string);
}

// ─── «Дом лежит» ─────────────────────────────────────────────────────────────────────────────────────────────────────

let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeFails = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let lostTimer: ReturnType<typeof setTimeout> | null = null;

const hasAnyCreds = (): boolean => Object.keys(allCreds()[homeKey()] ?? {}).length > 0;
const deviceOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Один запрос к дому: отвечает (любой не-5xx-шлюза) — жив. */
async function probeHome(): Promise<boolean> {
  try {
    const res = await fetch(`${config.apiUrl}/health`, {
      cache: 'no-store',
      ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) } : {}),
    });
    return !(res.status === 502 || res.status === 503 || res.status === 504);
  } catch {
    return false;
  }
}

function stopProbe(): void {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  probeFails = 0;
}

function startProbe(): void {
  if (probeTimer || deviceOffline() || !hasAnyCreds()) return;
  const step = async (): Promise<void> => {
    probeTimer = null;
    if (gatewayLiveNow()) return markHomeUp();
    const alive = await probeHome();
    if (alive) {
      probeFails = 0;
      // Дом отвечает, а шлюз ещё не вернулся: режим «через» закрываем, шлюз переподключится сам.
      if (down) markHomeUp(true);
    } else {
      probeFails++;
      if (probeFails >= HOME_PROBE_FAILS) markHomeDown();
    }
    if (!gatewayLiveNow() && !deviceOffline()) probeTimer = setTimeout(() => void step(), HOME_PROBE_MS);
  };
  probeTimer = setTimeout(() => void step(), 0);
}

function markHomeDown(): void {
  if (down) return;
  down = true;
  owed = true;
  publish();
  startPoll();
  pollNow();
}

function markHomeUp(keepProbing = false): void {
  if (!keepProbing) stopProbe();
  const was = down;
  down = false;
  stopPoll();
  publish();
  if (was || owed || claimList().length > 0) void report(0);
}

function pollNow(): void {
  const id = useStore.getState().currentDmId;
  if (down && id && credsUsable(credsOf(id), Date.now())) void useStore.getState().convViaRefresh?.(id);
}

function startPoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollNow, POLL_MS);
}

function stopPoll(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Отправка в дом не дошла: проверить дом сразу (и держать пробу, пока шлюз не вернётся). */
function homeFailed(): void {
  if (!hasAnyCreds() || deviceOffline()) return;
  probeFails = HOME_PROBE_FAILS - 1;
  startProbe();
}

// ─── Отчёт ───────────────────────────────────────────────────────────────────────────────────────────────────────────

let reporting = false;

/** Отчёт `via-claims` дому из очереди (пустой — тоже, если дом лежал); не вышло — повтор, очередь цела. */
async function report(attempt: number): Promise<void> {
  if (reporting || down || !useStore.getState().user) return;
  const home = homeKey();
  const items = claimsFor(claimList(), home).slice(0, VIA_CLAIMS_MAX);
  if (items.length === 0 && !owed) return;
  reporting = true;
  try {
    await api.convViaClaims(items);
    setClaims(claimsClear(claimList(), home, items));
    if (claimsFor(claimList(), home).length === 0) owed = false;
  } catch (e) {
    const status = (e as { status?: number }).status;
    // Отказ дома по существу (4xx кроме 408/429) повтором не лечится: отчёт устарел или вход истёк.
    if (!(status === undefined || status === 408 || status === 429 || status >= 500) || attempt >= 5) return;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(() => void report(attempt + 1), REPORT_RETRY_MS * (attempt + 1));
  } finally {
    reporting = false;
  }
}

// ─── Крючки для стора бесед ──────────────────────────────────────────────────────────────────────────────────────────

/** Автор сообщения с инстанса собеседника — в id своего дома (`viaLocalize`): я — свой id, собеседник — id его строки у нас. */
function localize(convId: string, viaUserId: string, m: ConvMessage): ConvMessage {
  const s = useStore.getState();
  const dm = s.dms.find((d) => d.id === convId);
  // Группа: «собеседника» нет — свой id как в 1:1, остальные авторы — по имени среди участников (`viaLocalizeGroup`).
  if (dm?.group) return viaLocalizeGroup(m, viaUserId, s.user?.id, dm.group.members);
  return viaLocalize(m, viaUserId, s.user?.id, dm?.otherUser.id);
}

const hooks: FedViaHooks = {
  active: (convId) => down && credsUsable(credsOf(convId), Date.now()),
  canTry: (convId) => credsUsable(credsOf(convId), Date.now()),
  homeFailed,
  async send(convId, body, timeoutMs): Promise<ConvMessage> {
    const c = credsOf(convId);
    if (!credsUsable(c, Date.now())) throw Object.assign(new Error('Дом недоступен — а сессии у собеседника нет'), { status: 503 });
    let msg: ConvMessage;
    try {
      msg = localize(convId, c.userId, await apiVia(c).convSend(convId, { ...body, attachments: [] }, timeoutMs));
    } catch (e) {
      // Сессия мертва («выйти везде», срок): забыть — следующее открытие беседы заведёт новую (если дом жив).
      if ((e as { status?: number }).status === 401) saveCreds(convId, null);
      throw e;
    }
    owed = true;
    setClaims(
      claimsAdd(claimList(), {
        home: homeKey(),
        conversationId: convId,
        clientId: body.clientId,
        payloadHash: viaPayloadHash(convId, body.content, body.replyToId),
      }),
    );
    return msg;
  },
  async history(convId): Promise<ConvMessage[]> {
    const c = credsOf(convId);
    if (!credsUsable(c, Date.now())) return [];
    return (await apiVia(c).convHistory(convId, { limit: 40 })).messages.map((m) => localize(convId, c.userId, m));
  },
};

let started = false;

/** Подключить Э5 (`main.tsx`): крючки стора бесед, подписки на стор и связь, пробу при старте. */
export function startFedVia(): void {
  if (started) return;
  started = true;
  bindFedVia(hooks);
  publish();
  useStore.subscribe((s, prev) => {
    if (s.user !== prev.user && !s.user) forgetCreds();
    if (s.currentDmId !== prev.currentDmId || s.serverFeatures !== prev.serverFeatures || s.dms !== prev.dms || s.user !== prev.user) {
      ensureOpen();
      publish();
    }
  });
  onConnChange((state) => {
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = null;
    if (state === 'online') {
      // Шлюз снова на связи: дом жив наверняка.
      markHomeUp();
      ensureOpen();
    } else if (state === 'connecting') {
      // Короткий обрыв чинит переподключение — пробу начинаем, если шлюз не вернулся за `HOME_LOST_GRACE_MS`.
      lostTimer = setTimeout(startProbe, HOME_LOST_GRACE_MS);
    } else {
      // Нет сети у устройства: дом «лежит» не он, а мы — обходить нечем.
      stopProbe();
      if (down) markHomeUp();
    }
  });
  // Старт при лежащем доме: шлюз так и не стал `ready` (connState его не считает потерянным) — проверить дом.
  setTimeout(() => {
    if (!gatewayLiveNow() && useStore.getState().user) startProbe();
  }, 10_000);
  // Очередь отчёта пережила перезапуск — отчитаться, когда войдём.
  setTimeout(() => {
    if (claimList().length > 0 && gatewayLiveNow()) void report(0);
  }, 12_000);
  // Раз в час обновить сессии, которым меньше суток (`fallbackDue` сам решает).
  setInterval(ensureOpen, 60 * 60 * 1000);
}

