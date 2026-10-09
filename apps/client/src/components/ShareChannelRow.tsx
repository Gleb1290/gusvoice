import { useRef } from 'react';
import { DM_ROW_HOLD_MS, DM_ROW_HOLD_SLOP } from '../dmListRules';
import { DM_ROW_AVA } from '../dmListView';
import type { ShareChannel } from '../shareInbox';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * Строка текстового канала сервера в окне «Поделиться в…» (09.10): те же классы, что у строки беседы (`.dm-row`, `.dm-ava`,
 * `.dm-name`, `.dm-preview`, галочка `.dm-pick`), поэтому выглядит и работает так же — аватар = значок сервера, имя «# канал»,
 * вторая строка — сервер. Жесты как у `DmRow` в режиме «одна беседа / несколько»: нажатие, пока ничего не отмечено, — «этот
 * канал» (`onOpen`); правый щелчок или удержание пальцем (`DM_ROW_HOLD_MS`) отмечают строку (`onPick`), дальше нажатия
 * переключают галочки (`selecting`).
 */
export function ShareChannelRow({
  ch,
  selecting,
  picked,
  onOpen,
  onPick,
}: {
  ch: ShareChannel;
  selecting: boolean;
  picked: boolean;
  onOpen: (id: string) => void;
  onPick: (id: string) => void;
}) {
  // Удержание — как у `DmRow`: свой таймер без сдвига дальше слопа; сработавшее удержание глотает щелчок отпускания.
  const hold = useRef<{ timer: number | null; x: number; y: number; fired: boolean } | null>(null);
  const holdStop = () => {
    const h = hold.current;
    if (h?.timer != null) window.clearTimeout(h.timer);
    if (h) h.timer = null;
  };
  const holdFire = () => {
    const h = hold.current;
    holdStop();
    if (h) h.fired = true;
    navigator.vibrate?.(8);
    onPick(ch.id);
  };
  return (
    <button
      type="button"
      className={`dm-row share-ch${picked ? ' picked' : ''}`}
      role={selecting ? 'checkbox' : undefined}
      aria-checked={selecting ? picked : undefined}
      aria-label={`#${ch.name}, ${ch.serverName}`}
      onClick={() => {
        if (hold.current?.fired) {
          hold.current = null;
          return;
        }
        if (selecting) return onPick(ch.id);
        onOpen(ch.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (hold.current?.fired) return;
        if (hold.current) return holdFire();
        onPick(ch.id);
      }}
      onTouchStart={(e) => {
        holdStop();
        hold.current = null;
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        const h = { timer: null as number | null, x: t.clientX, y: t.clientY, fired: false };
        hold.current = h;
        h.timer = window.setTimeout(holdFire, DM_ROW_HOLD_MS);
      }}
      onTouchMove={(e) => {
        const h = hold.current;
        const t = e.touches[0];
        if (!h || !t) return;
        if (Math.abs(t.clientX - h.x) > DM_ROW_HOLD_SLOP || Math.abs(t.clientY - h.y) > DM_ROW_HOLD_SLOP) {
          holdStop();
          hold.current = null;
        }
      }}
      onTouchEnd={(e) => {
        holdStop();
        if (hold.current?.fired && e.cancelable) e.preventDefault();
      }}
      onTouchCancel={holdStop}
    >
      <span className="dm-ava">
        <Avatar name={ch.serverName} url={ch.serverIconUrl} size={DM_ROW_AVA} />
        {selecting && picked && (
          <span className="dm-pick">
            <span className="sel-check on">
              <Icon name="check" size={12} stroke={3} />
            </span>
          </span>
        )}
      </span>
      <span className="dm-name">
        <span className="dm-name-text">{`# ${ch.name}`}</span>
      </span>
      <span className="dm-when" />
      <span className="dm-preview">{ch.serverName}</span>
    </button>
  );
}
