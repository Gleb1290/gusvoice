import { useEffect, useMemo, useState } from 'react';
import { notifyExceptionLabel, notifyExceptions, notifyExceptionsTitle } from '../notifyExceptionsRules';
import { usePeerName } from '../peerName';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';

/**
 * «Исключения» (G38, `push3`): беседы, у которых уведомления выключены или без звука, — список с переходом в беседу и
 * сбросом («Включить»); с `push4` — и беседы «Уведомления включены» при выключенных «Личных» / группах (сброс — «Сбросить»). Заглушки живут на сервере (`push_mutes`), здесь только вид (`notifyExceptionsRules`).
 */
export function NotifyExceptions({ onOpen }: { onOpen: () => void }) {
  const dms = useStore((s) => s.dms);
  const mutedUsers = useStore((s) => s.pushMutedDmUsers);
  const muteUntil = useStore((s) => s.pushMuteUntil);
  const always = useStore((s) => s.pushAlwaysTargets);
  // Срок вышел — строка уходит сама: перерисовка раз в минуту.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nameOf = usePeerName(); // подпись контакта вместо имени (`peerName.ts`)
  const list = useMemo(
    () => notifyExceptions(dms, mutedUsers, muteUntil, now, nameOf, always),
    [dms, mutedUsers, muteUntil, now, nameOf, always],
  );
  return (
    <>
      <div className="settings-group-label" id="set-g-notify-exceptions" style={{ marginTop: 22 }}>
        {notifyExceptionsTitle(list.length)}
      </div>
      {list.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Нет бесед с отдельной настройкой. Выключить уведомления одной беседы можно в её меню.
        </div>
      ) : (
        <div role="list">
          {list.map((e) => (
            <div key={e.convId} className="dmf-row" role="listitem">
              <button
                type="button"
                className="dmf-row"
                style={{ flex: 1, minWidth: 0 }}
                onClick={() => {
                  void useStore.getState().selectDm(e.convId);
                  onOpen();
                }}
              >
                <Avatar url={e.avatarUrl} name={e.name} size={32} fallback="icon" />
                <span className="dmf-main">
                  <span className="dmf-title">{e.name}</span>
                  <span className="dmf-sub">{notifyExceptionLabel(e)}</span>
                </span>
              </button>
              {e.enabled ? (
                /* «Уведомления включены» (`push4`): сброс — беседа снова по общей настройке (вместе со «Выключить звук»). */
                <button
                  type="button"
                  className="acc-ghost"
                  onClick={() => {
                    const st = useStore.getState();
                    void st.setPushAlways(e.muteTarget, false).catch(toastError);
                    if (e.soundOnly) void st.setPushMuted('dm_user', e.muteTarget, false).catch(toastError);
                  }}
                >
                  Сбросить
                </button>
              ) : (
                <button
                  type="button"
                  className="acc-ghost"
                  onClick={() => void useStore.getState().setPushMuted('dm_user', e.muteTarget, false).catch(toastError)}
                >
                  Включить
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
