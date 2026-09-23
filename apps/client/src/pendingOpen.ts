/**
 * «Открыть вот этот сервер сразу после переключения инстанса» (#139, F4, §5.7).
 *
 * 🔴 Намерение переживает ПЕРЕЗАПУСК приложения — в этом весь смысл. Человек жмёт на сервер чужого
 * инстанса в рейле; пока шлюзы открываются по одному, переход туда это перезапуск (тот же путь, что
 * у переключателя инстансов), и без записанного намерения он попадал бы просто «куда-то в тот
 * инстанс» и искал нужный сервер заново.
 *
 * ⚠️ Хранится ВМЕСТЕ с локальным id записи реестра и проверяется при чтении: намерение, оставленное
 * для одного инстанса, не должно сработать в другом, если человек передумал и переключился руками.
 * ⚠️ Одноразовое: прочитали — стёрли. Иначе оно срабатывало бы при каждом следующем запуске.
 */

const KEY = 'gv_pending_open';

export interface PendingOpen {
  /** Локальный `id` записи реестра, в которой ждут открытия. */
  instanceId: string;
  serverId: string;
  /**
   * Довести до конкретного канала (#139, F5) — так приходит тап по пушу об упоминании на чужом
   * инстансе. Пусто — открыть сервер и остановиться, как при клике в рейле.
   */
  channelId?: string;
}

export function setPendingOpen(p: PendingOpen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* приватный режим — просто откроется главный экран инстанса */
  }
}

/** Забрать намерение, если оно для ЭТОЙ записи реестра. Чужое и негодное — стираем молча. */
export function takePendingOpen(activeInstanceId: string | null): { serverId: string; channelId?: string } | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
    if (raw !== null) localStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingOpen>;
    if (!p || typeof p.serverId !== 'string' || typeof p.instanceId !== 'string') return null;
    if (!activeInstanceId || p.instanceId !== activeInstanceId) return null;
    return { serverId: p.serverId, ...(typeof p.channelId === 'string' ? { channelId: p.channelId } : {}) };
  } catch {
    return null;
  }
}
