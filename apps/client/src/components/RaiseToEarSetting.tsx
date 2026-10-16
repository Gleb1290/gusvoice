import { raiseToEarSupported, setRaiseToEarPref, useRaiseToEarPref } from '../nativeRaiseToEar';
import { Toggle } from './Toggle';

/**
 * Настройка «Поднести к уху» (G67; Telegram Android — «Поднести к уху» в настройках чатов, по умолчанию включена). Видна только
 * в приложении Android с датчиком приближения; в остальных местах — ничего.
 */
export function RaiseToEarSetting() {
  const on = useRaiseToEarPref();
  if (!raiseToEarSupported()) return null;
  return (
    <>
      <div className="settings-group-label" id="set-g-raise-to-ear">
        Голосовые сообщения
      </div>
      <div className="settings-row">
        <span id="set-raise-to-ear">Поднести к уху</span>
        <Toggle checked={on} onChange={setRaiseToEarPref} labelledBy="set-raise-to-ear" describedBy="set-raise-to-ear-hint" />
      </div>
      <div className="muted" id="set-raise-to-ear-hint" style={{ fontSize: 12 }}>
        Играет голосовое — поднесите телефон к уху: звук перейдёт в разговорный динамик, экран погаснет. Отвели — снова громко.
      </div>
    </>
  );
}
