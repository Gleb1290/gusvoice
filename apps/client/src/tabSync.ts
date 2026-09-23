/**
 * Согласование между вкладками одного инстанса: прочитал в одной — гаснет во всех.
 *
 * 🔴 **Повод (19.09).** Отметка «прочитано» уходила на сервер и там умирала: ручка пишет строку в
 * базу и возвращает `ok`, никому ничего не рассылая. Клиент, в свою очередь, не слушал ни соседние
 * вкладки, ни другие свои сессии (`BroadcastChannel` в коде не встречался ни разу). Получалось:
 * прочитал канал в одной вкладке — во второй счётчик висит, пока её не перезагрузишь.
 *
 * ⚠️ **Это половина решения, и надо честно сказать какая.** `BroadcastChannel` живёт в пределах
 * одного origin и одного браузера: вкладки согласуются, а телефон и десктоп — нет. Полное лечение
 * требует, чтобы сервер рассылал отметку остальным сессиям человека; до тех пор счётчик на другом
 * УСТРОЙСТВЕ по-прежнему гаснет только при обновлении.
 *
 * ⚠️ Канал именованный, без состояния: пропущенное сообщение (вкладка была закрыта) ничего не
 * ломает — при открытии она всё равно берёт свежие счётчики из загрузки.
 */

const NAME = 'gv_tabs';

export type TabEvent =
  | {
      kind: 'read-channel';
      channelId: string;
      /**
       * Сервер, которому принадлежит канал.
       *
       * 🔴 Нужен потому, что значок сервера в рельсе считается НЕ по каналам: для сервера, который
       * сейчас не открыт, число живёт в отдельном словаре (`unreadServers`), и гашение каналов его
       * не трогает. Первая версия события сервер не несла — и счётчик у соседней вкладки оставался
       * гореть, хотя канал был прочитан (поймано живой проверкой 19.09).
       */
      serverId?: string;
    }
  | { kind: 'read-dm'; dmId: string };

let channel: BroadcastChannel | null = null;

function ensure(): BroadcastChannel | null {
  if (channel) return channel;
  try {
    channel = new BroadcastChannel(NAME);
  } catch {
    // Старый WebView или приватный режим — согласование просто не работает, остальное живёт.
    channel = null;
  }
  return channel;
}

/** Рассказать соседним вкладкам. Свои же сообщения обратно не приходят — это поведение API. */
export function publishTabEvent(e: TabEvent): void {
  try {
    ensure()?.postMessage(e);
  } catch {
    /* закрытый канал — молча, это не повод ломать переход по каналу */
  }
}

export function onTabEvent(fn: (e: TabEvent) => void): () => void {
  const ch = ensure();
  if (!ch) return () => {};
  const handler = (ev: MessageEvent) => {
    const data = ev.data as TabEvent | null;
    if (!data || typeof data !== 'object') return;
    if (data.kind === 'read-channel' && typeof data.channelId === 'string') fn(data);
    if (data.kind === 'read-dm' && typeof data.dmId === 'string') fn(data);
  };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}
