/**
 * id отправки (ЛС этап 2): UUID v4 от клиента, по нему сервер узнаёт повтор (`/api/conv/:id/messages` → 200 и то же
 * сообщение вместо дубля), а клиент — своё сообщение, пришедшее событием раньше ответа.
 *
 * `crypto.randomUUID` есть только в защищённом контексте; оболочки отдают страницу с `http://tauri.localhost` (он
 * считается защищённым, но проверять это на каждом WebView дороже, чем собрать UUID самим). `getRandomValues` есть
 * везде, а сервер проверяет формат (`z.string().uuid()`) — поэтому запасной путь даёт настоящий v4, а не случайную строку.
 */
export function newClientId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* незащищённый контекст — собираем сами */
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
