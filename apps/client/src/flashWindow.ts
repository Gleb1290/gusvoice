/**
 * «Мигнуть окном» — привлечь внимание, когда GusVoice не в фокусе. Пока нужен одному тыку, но
 * вынесен отдельно: это не про тык, а про способ дозваться, и следующему поводу браться отсюда.
 *
 * На вебе не делает ничего. Прыгать вкладкой в браузере технически можно (менять `document.title`
 * или показывать Notification), но это уже поведение системного уведомления — им и занимается
 * `notifications.ts`, дублировать не надо.
 */
import { isDesktop } from './hotkeys';

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };

function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

/**
 * Мигнуть иконкой в панели задач. Fire-and-forget: провалилось — не беда, звук и модалка уже
 * отработали, а падать из-за не мигнувшего окна незачем.
 *
 * ⚠️ Фокус НЕ забираем — решение принимает Rust-сторона (см. `gv_flash_window`): выдернуть фокус
 * из полноэкранной игры значит уронить игру, а тык зовёт, а не тащит.
 */
export function flashWindow(): void {
  if (!isDesktop()) return;
  void tauriCore()?.invoke('gv_flash_window').catch(() => {});
}
