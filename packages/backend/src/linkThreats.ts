import { readFile } from 'node:fs/promises';
import { env } from './env.js';
import { dangerousHostsIn, isThreatHost, parseThreatList } from './linkThreatsRules.js';

/**
 * Опасные ссылки (#218 п.5, признак `linkthreats1`). Сервер раз в сутки скачивает открытый список доменов угроз и держит
 * его в памяти как набор хостов; ссылки сообщений сверяются с ним ЛОКАЛЬНО — адреса из сообщений наружу не уходят
 * (наружу идёт только запрос самого списка, одинаковый для всех инстансов). Пометка считается при отдаче сообщения
 * (`serialize.ts`), а не хранится в нём: список обновляется, и флаг в базе врал бы.
 *
 * Источник по умолчанию — Phishing.Database (MIT): `phishing-domains-ACTIVE.txt`, ~400 тыс. доменов, ~11 МБ (~75 МБ кучи).
 * Другие списки — `LINK_THREATS_URLS` (через запятую; понимаются «хост», hosts-файл и «URL в строке»). `LINK_THREATS_FILE` —
 * локальные файлы вместо скачивания (стенд и коробка без интернета). Нет интернета или источник упал — прежний список
 * остаётся, повтор через час; без единого списка проверка просто молчит (сообщения уходят как обычно).
 */
const DEFAULT_URLS = ['https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt'];
const FIRST_DELAY_MS = 20_000;
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
const FETCH_TIMEOUT_MS = 120_000;
/** Предел ответа одного источника: список больше — скорее всего не тот файл. */
const MAX_BYTES = 64 * 1024 * 1024;

/** Источник → набор хостов. Упавший источник не стирает свой прежний набор. */
const lists = new Map<string, Set<string>>();
let loadedAt: number | null = null;

export function linkThreatsActive(): boolean {
  return env.linkThreats.enabled;
}

/** Хост ссылки (или его родитель) есть в списке угроз. Пока списка нет — всегда `false`. */
export function isThreatHostNow(host: string): boolean {
  if (!env.linkThreats.enabled || lists.size === 0) return false;
  return isThreatHost(lists.values(), host);
}

/** Опасные хосты ссылок текста (для `Message.dangerousLinks`); пусто — когда проверка выключена или списка нет. */
export function dangerousLinksOf(content: string): string[] {
  if (!env.linkThreats.enabled || lists.size === 0) return [];
  return dangerousHostsIn(content, isThreatHostNow);
}

/** Для стенда и тестов: подменить списки напрямую. */
export function setThreatListsForTest(sets: Record<string, Iterable<string>>): void {
  lists.clear();
  for (const [k, v] of Object.entries(sets)) lists.set(k, new Set(v));
  loadedAt = Date.now();
}

export function linkThreatsStatus(): { sources: number; hosts: number; loadedAt: number | null } {
  let hosts = 0;
  for (const s of lists.values()) hosts += s.size;
  return { sources: lists.size, hosts, loadedAt };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'gusvoice-link-threats' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`слишком большой ответ: ${len} байт`);
  if (!res.body) throw new Error('пустой ответ');
  // Читаем потоком и рвём на пределе: без Content-Length (или с ложным) arrayBuffer() занял бы память раньше проверки.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`слишком большой ответ: больше ${MAX_BYTES} байт`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function label(src: string, fromFile: boolean): string {
  if (fromFile) return src;
  try {
    return new URL(src).host;
  } catch {
    return src;
  }
}

/** Один проход обновления. Возвращает, получилось ли обновить ВСЕ источники. */
export async function refreshLinkThreats(): Promise<boolean> {
  const cfg = env.linkThreats;
  const fromFile = cfg.files.length > 0;
  const sources = fromFile ? cfg.files : cfg.urls.length ? cfg.urls : DEFAULT_URLS;
  let okAny = false;
  let allOk = true;
  for (const src of sources) {
    const t0 = Date.now();
    try {
      const text = fromFile ? await readFile(src, 'utf8') : await fetchText(src);
      const set = parseThreatList(text);
      lists.set(src, set);
      okAny = true;
      console.log(`[link-threats] ${label(src, fromFile)}: ${set.size} хостов, ${(text.length / 1048576).toFixed(1)} МБ, ${Date.now() - t0} мс`);
    } catch (e) {
      allOk = false;
      console.warn('[link-threats] не удалось обновить', label(src, fromFile), '—', (e as Error).message);
    }
  }
  if (okAny) loadedAt = Date.now();
  // Источники, убранные из настроек, из памяти уходят.
  for (const k of [...lists.keys()]) if (!sources.includes(k)) lists.delete(k);
  return allOk;
}

/** Фоновая задача: через 20 с после старта, потом раз в сутки; неудача — повтор через час. */
export function startLinkThreatsWorker(): void {
  if (!env.linkThreats.enabled) {
    console.log('[link-threats] выключено (LINK_THREATS_ENABLED=false)');
    return;
  }
  const tick = async (): Promise<void> => {
    let next = REFRESH_MS;
    try {
      if (!(await refreshLinkThreats())) next = RETRY_MS;
    } catch (e) {
      console.warn('[link-threats] сбой обновления —', (e as Error).message);
      next = RETRY_MS;
    }
    setTimeout(() => void tick(), next).unref();
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS).unref();
}
