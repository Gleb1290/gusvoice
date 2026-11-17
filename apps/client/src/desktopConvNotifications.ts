/**
 * Действия в уведомлениях о ЛС и снятие тостов прочитанной беседы из Центра уведомлений.
 * Чтение на любом устройстве обнуляет счётчик беседы в сторе. Изменения группируются за 150 мс.
 */
import { newClientId } from './clientId';
import { isDesktop } from './hotkeys';
import { setConvNotifyActions } from './notifications';
import { useStore } from './store';
import { convsJustRead, unreadByConv } from './convNotificationRules';

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

let started = false;

export function initDesktopConvNotifications(): void {
  if (started) return;
  const core = tauriCore();
  if (!core || !isDesktop()) return;
  started = true;

  // Ответ из тоста беседы (Р1, G17, `notify_conv.rs`): та же очередь отправки, что у поля ввода (строка «в пути»,
  // автоповтор), затем беседа прочитана — как у Telegram после ответа из уведомления. Окно не поднимается.
  setConvNotifyActions({
    reply(convId, text) {
      const s = useStore.getState();
      s.outboxEnqueue(convId, { key: newClientId(), content: text, files: [], replyToId: null });
      void s.markConvRead(convId).catch(() => {});
    },
    read(convId) {
      void useStore.getState().markConvRead(convId).catch(() => {});
    },
  });

  let lastDms: unknown = null;
  let prev: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    timer = null;
    const s = useStore.getState();
    if (s.dms === lastDms) return;
    lastDms = s.dms;
    const cur = unreadByConv(s.dms);
    for (const id of convsJustRead(prev, cur)) core.invoke('gv_notify_remove', { group: id }).catch(() => {});
    prev = cur;
  };

  useStore.subscribe(() => {
    if (timer === null) timer = setTimeout(run, 150);
  });
  run();
}
