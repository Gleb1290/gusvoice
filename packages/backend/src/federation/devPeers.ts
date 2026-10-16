/**
 * Режим стенда для локальных соседей (Ф13, Э0 ЛС между инстансами, `docs/dm/FEDERATION.md` §6 «Стенд из двух инстансов»).
 *
 * Два бэкенда на одной машине (`127.0.0.1:4200` ↔ `127.0.0.1:4300`) не связать штатно: охрана адресов соседа режет loopback
 * и частные сети (`safeFetch.ts` `isBlockedAddress`), а `assertPeerTarget` требует `https`. `FEDERATION_DEV_PEERS` — узкое
 * исключение: `http` и loopback разрешаются ТОЛЬКО для хостов из явного списка.
 *
 * 🔴 Три предохранителя (`devPeersProblem` → отказ старта в `env.ts`):
 * - не при `NODE_ENV=production` (образ коробки ставит его всегда — на проде переменная просто роняет старт);
 * - в списке только `localhost` и IP-литералы местных сетей: публичному адресу послабление не нужно, а `http` к нему — дыра;
 * - не вместе с публичным `PUBLIC_API_URL`: инстанс, видный из интернета, стендом не бывает.
 *
 * Модуль чистый (без `env`): список включает `index.ts` вызовом `configureDevPeers`, проверки зовут `isDevPeerHost`.
 */

/** Разобрать список: `host[:port]` через запятую (схема и путь, если вписаны по привычке, отбрасываются). */
export function parseDevPeers(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    let host = item;
    try {
      if (/^[a-z]+:\/\//i.test(item)) host = new URL(item).host;
    } catch {
      /* не URL — оставляем как есть, проверка ниже его отобьёт */
    }
    out.add(host.toLowerCase());
  }
  return [...out];
}

/** Имя хоста без порта и скобок IPv6. */
function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * Что не так с режимом стенда — или `null`, если можно стартовать. `isLocalIp` — классификатор охраны адресов
 * (`safeFetch.isBlockedAddress`): параметром, чтобы модуль не тянул сетевой код.
 */
export function devPeersProblem(input: {
  hosts: readonly string[];
  nodeEnv: string | undefined;
  publicApiUrl: string;
  isLocalIp: (ip: string) => boolean;
  isIp: (value: string) => boolean;
}): string | null {
  if (input.hosts.length === 0) return null;
  if (input.nodeEnv === 'production') return 'FEDERATION_DEV_PEERS задан при NODE_ENV=production — режим стенда на проде запрещён';
  const isLocalName = (name: string) => name === 'localhost' || (input.isIp(name) && input.isLocalIp(name));
  for (const host of input.hosts) {
    const name = hostnameOf(host);
    if (!name || !isLocalName(name)) return `FEDERATION_DEV_PEERS: «${host}» — не местный адрес (только localhost и IP местных сетей)`;
  }
  if (input.publicApiUrl) {
    let name = '';
    try {
      name = new URL(input.publicApiUrl).hostname.replace(/^\[|\]$/g, '');
    } catch {
      /* кривой адрес — считаем публичным: лучше не стартовать, чем угадать */
    }
    if (!name || !isLocalName(name)) return 'FEDERATION_DEV_PEERS задан вместе с публичным PUBLIC_API_URL — стенд не бывает публичным';
  }
  return null;
}

let active: ReadonlySet<string> = new Set();

/** Включить список (зовёт `index.ts` при старте; проверки уже прошли в `env.ts`). */
export function configureDevPeers(hosts: Iterable<string>): void {
  active = new Set([...hosts].map((h) => h.toLowerCase()));
  if (active.size > 0) console.warn(`[fed] РЕЖИМ СТЕНДА: http и loopback разрешены для ${[...active].join(', ')}`);
}

/** Хост (`host[:port]`) из списка стенда? Вне режима стенда — всегда `false`. */
export function isDevPeerHost(host: string): boolean {
  return active.size > 0 && active.has(host.toLowerCase());
}

/** Схема для адреса соседа, который мы собираем сами (`https://<домен>/config.json`): у хоста стенда — `http`. */
export function peerScheme(host: string): 'http' | 'https' {
  return isDevPeerHost(host) ? 'http' : 'https';
}
