/**
 * Чистые правила проверки ссылок по списку угроз (gitea #218 п.5, признак сервера `linkthreats1`): разбор скачанного
 * списка, сверка хоста со списком (сам хост и его родители), выбор опасных хостов из текста сообщения. Сети и таймеров
 * здесь нет — состояние и скачивание живут в `linkThreats.ts`.
 */

/** Проверка включена: по умолчанию да, выключает только `LINK_THREATS_ENABLED=false`. Читается и в `env.ts`, и в `instanceFeatures.ts` (там `env` нельзя: он требует DATABASE_URL). */
export function linkThreatsEnabled(raw: string | undefined): boolean {
  return (raw ?? 'true').trim().toLowerCase() !== 'false';
}

/** Предел списка из одного источника: защита памяти от ошибочно огромного ответа. */
export const THREAT_LIST_MAX_HOSTS = 3_000_000;
/** Сколько разных хостов сообщение может пометить (остальные — не помечаются, длинный спам не раздувает DTO). */
export const THREAT_MAX_PER_MESSAGE = 10;
/** Ссылок в тексте, которые разбираем: дальше хвост длинного сообщения не смотрим. */
const MAX_LINKS_SCANNED = 50;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST_CHARS = /^[a-z0-9._-]+$/;
/** Ссылка в тексте — тот же вид, что линкует клиент (`messageText.tsx`). */
const LINK_RE = /https?:\/\/[^\s<>"]+/g;

/** Нормализованный хост списка: нижний регистр, без точки в конце и порта; `null`, если это не хост. */
export function normalizeListedHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith('*.')) h = h.slice(2);
  h = h.replace(/\.+$/, '');
  // «host:port» (IPv6 в списках не встречается — пропускаем всё с несколькими двоеточиями)
  const colon = h.indexOf(':');
  if (colon >= 0) {
    if (h.indexOf(':', colon + 1) >= 0) return null;
    h = h.slice(0, colon);
  }
  if (h.length < 3 || h.length > 253) return null;
  if (!HOST_CHARS.test(h) || !h.includes('.')) return null;
  return h;
}

/**
 * Разбор списка. Понимает три вида строк: «хост» (Phishing.Database), «127.0.0.1<TAB>хост» (hosts-файл, URLhaus) и
 * «https://хост/путь» (OpenPhish). `#`-строки и пустые пропускаются.
 */
export function parseThreatList(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) continue;
    let candidate: string;
    if (t.includes('://')) {
      try {
        candidate = new URL(t).hostname;
      } catch {
        continue;
      }
    } else {
      const parts = t.split(/\s+/);
      candidate = parts.length >= 2 && IPV4.test(parts[0]!) ? parts[1]! : parts[0]!;
    }
    const host = normalizeListedHost(candidate);
    if (!host || host === 'localhost') continue;
    out.add(host);
    if (out.size >= THREAT_LIST_MAX_HOSTS) break;
  }
  return out;
}

/** Хост и его родители: `a.b.evil.com` → `a.b.evil.com`, `b.evil.com`, `evil.com` (меньше двух меток не берём). */
export function hostAncestors(host: string): string[] {
  if (IPV4.test(host)) return [host];
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Есть ли хост (или его родитель) в одном из списков. */
export function isThreatHost(lists: Iterable<ReadonlySet<string>>, host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  const chain = hostAncestors(h);
  for (const list of lists) {
    if (list.size === 0) continue;
    for (const c of chain) if (list.has(c)) return true;
  }
  return false;
}

/** Хост ссылки (`URL.hostname`) или `null`, если это не http(s)-ссылка. */
export function linkHost(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Опасные хосты ссылок в тексте сообщения — в порядке появления, без повторов. Клиент сверяет `URL.hostname` ссылки
 * с этим массивом по точному совпадению, поэтому отдаётся хост ССЫЛКИ, а не запись списка.
 */
export function dangerousHostsIn(content: string, isThreat: (host: string) => boolean): string[] {
  if (!content || content.indexOf('://') < 0) return [];
  const found = content.match(LINK_RE);
  if (!found) return [];
  const out: string[] = [];
  for (const raw of found.slice(0, MAX_LINKS_SCANNED)) {
    const host = linkHost(raw.replace(/[.,;:!?)\]]+$/, ''));
    if (!host || out.includes(host)) continue;
    if (isThreat(host)) {
      out.push(host);
      if (out.length >= THREAT_MAX_PER_MESSAGE) break;
    }
  }
  return out;
}
