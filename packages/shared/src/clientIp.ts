/**
 * Настоящий адрес клиента за обратным прокси — ключ для всех ограничений «по IP» (вход, коды, регистрация, сокеты).
 *
 * 🔴 Раньше бралась ПЕРВАЯ запись `X-Forwarded-For`. Её пишет сам клиент: nginx / Nginx Proxy Manager / Traefik
 * ДОПИСЫВАЮТ адрес соединения в конец (`$proxy_add_x_forwarded_for`), а не заменяют заголовок. Проверено на проде
 * 15.09: шестой запрос с одним выдуманным адресом — 429, седьмой с другим выдуманным — снова 202. Так обходились
 * блокировка перебора пароля (ключ ip+логин), попытки кода установки и лимиты регистраций.
 *
 * Теперь адрес читается СПРАВА налево: каждый доверенный прокси дописывает то, что видел сам, поэтому правее первой
 * «чужой» записи подделать ничего нельзя. Доверенными считаются только адреса внутренних сетей — там стоят наши прокси
 * (Caddy в докер-сети, NPM в домашней сети). Соединение пришло не из внутренней сети — заголовок не читается вовсе.
 *
 * Границы, принятые сознательно:
 * - перед прокси ещё один публичный прокси (Cloudflare) — ключом станет его адрес: лимиты грубее, но не обходятся;
 * - клиент из той же внутренней сети, что и прокси, может подставить адрес — это свои люди, не интернет.
 */

/** Адрес без порта, скобок и префикса `::ffff:` у IPv4, записанного как IPv6. */
export function normalizeIp(raw: string): string {
  let ip = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(ip)) ip = ip.slice(7);
  return ip.toLowerCase();
}

function ipv4Octets(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/**
 * Адрес внутренней сети — там, где может стоять наш прокси: loopback, частные сети RFC 1918, link-local, CGNAT
 * (100.64/10 — сюда же попадают сети вроде Tailscale), IPv6 loopback, unique-local и link-local.
 * Нераспознанная строка внутренней не считается.
 */
export function isInternalAddress(raw: string): boolean {
  const ip = normalizeIp(raw);
  const v4 = ipv4Octets(ip);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!ip.includes(':') || !/^[0-9a-f:]+$/.test(ip)) return false;
  if (ip === '::1') return true;
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * Адрес клиента по заголовку `X-Forwarded-For` и адресу соединения `peer`.
 * Соединение не из внутренней сети → `peer`. Иначе — самая правая запись заголовка не из внутренней сети; если все
 * внутренние — самая правая (её дописал ближайший прокси); заголовка нет — `peer`.
 */
export function realClientIp(forwardedFor: string | string[] | undefined, peer: string): string {
  const from = normalizeIp(peer);
  if (!isInternalAddress(from)) return from;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isInternalAddress(hops[i])) return hops[i];
  }
  return hops.length ? hops[hops.length - 1] : from;
}
