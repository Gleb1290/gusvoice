/**
 * Главное окно ждёт конца заставки, прежде чем вернуть человека в голосовой канал (28.10).
 *
 * 🔴 Жалоба владельца: «Обновить» в канале — приложение перезапустилось, звук входа в канал, ещё перезапуск,
 * ещё звук. Перезапуск ради обновления поднимает ПРЕЖНЮЮ версию: её главное окно грузится скрытым, пока
 * заставка качает и ставит обновление (`splash.rs`), и сразу возвращало в канал (`restoreVoiceSession`). Через
 * секунды установщик убивал процесс, и новая версия заходила в канал второй раз. Теперь вход ждёт, пока заставка
 * закроется; если она ставит обновление, процесс умирает раньше и в канал не заходит вовсе.
 *
 * Пока ждём — App продлевает только заранее допущенный startup-кандидат: после установки новая версия вернёт в канал,
 * только если сессия моложе `GRACE_MS`, а скачивание и установка дольше этого окна.
 *
 * Не Tauri / заставки нет / команда не ответила — сразу дальше, как раньше.
 */
import { updateLog } from './updater';

type Core = { invoke: (c: string, a?: unknown) => Promise<unknown> };
type Listen = (event: string, cb: () => void) => Promise<() => void>;

/** Как часто переспрашивать заставку и освежать сессию (событие могло прийти до подписки). */
export const SPLASH_GATE_POLL_MS = 1000;

export async function afterSplash(keepAlive: () => void = () => {}): Promise<void> {
  const tauri = (window as unknown as { __TAURI__?: { core?: Core; event?: { listen?: Listen } } }).__TAURI__;
  const core = tauri?.core;
  if (!core) return;
  const active = async () => {
    try {
      return (await core.invoke('gv_splash_active')) === true;
    } catch {
      return false;
    }
  };
  if (!(await active())) return;
  updateLog('main', 'voice restore waits for splash');
  await new Promise<void>((resolve) => {
    let finished = false;
    let unlisten: (() => void) | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      unlisten?.();
      resolve();
    };
    const timer = setInterval(() => {
      keepAlive();
      void active().then((a) => {
        if (!a) finish();
      });
    }, SPLASH_GATE_POLL_MS);
    tauri?.event?.listen?.('gv-splash-finished', finish).then(
      (u) => {
        if (finished) u();
        else unlisten = u;
      },
      () => {},
    );
  });
  updateLog('main', 'splash finished, voice restore goes on');
}
