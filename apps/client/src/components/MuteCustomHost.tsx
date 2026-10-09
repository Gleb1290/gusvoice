import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { MUTE_CUSTOM_EVENT, MUTE_DUR_DEFAULT, MUTE_DUR_MAX, muteDurationSeconds } from '../dmListRules';
import { usePhoneLayout } from '../phoneLayout';
import { plural } from '../plural';
import { parseTimeField } from '../schedRules';
import { useStore } from '../store';
import { toastError } from '../toast';
import { BottomSheet } from './BottomSheet';
import { SchedDialog, TimeField } from './SchedPick';

const TITLE = 'Выключить уведомления на…';

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * Окно «Свой срок…» у «Без звука» (09.10, `mute3`, решение владельца): выбор ДЛИТЕЛЬНОСТИ — дни, часы, минуты, как у Telegram
 * (Desktop: `menu/menu_mute.cpp` `MuteBox` + `ui/boxes/choose_time.cpp` `ChooseTimeWidget`: три поля, пределы 31 / 23 / 59, по
 * умолчанию 8 часов, заголовок «Mute notifications for...», кнопка «Mute»; Android `AlertsCreator.createMuteForPickerDialog` —
 * один барабан готовых сроков, у нас он уже есть в самом меню). Поля — те же, что у времени в «Отправить позже» (`TimeField`:
 * цифры, ↑ / ↓ по кругу, уход добивает до «08»). Ноль во всех полях — срока нет: кнопка неактивна (у Telegram Desktop это
 * «Включить»). Телефон — лист снизу, ПК — окно по центру (как `SchedPick`).
 */
function MuteDurPick({ onPick, onClose }: { onPick: (seconds: number) => void; onClose: () => void }) {
  const phone = usePhoneLayout();
  const [dd, setDd] = useState(() => two(MUTE_DUR_DEFAULT.days));
  const [hh, setHh] = useState(() => two(MUTE_DUR_DEFAULT.hours));
  const [mm, setMm] = useState(() => two(MUTE_DUR_DEFAULT.minutes));
  const days = parseTimeField(dd, MUTE_DUR_MAX.days);
  const hours = parseTimeField(hh, MUTE_DUR_MAX.hours);
  const minutes = parseTimeField(mm, MUTE_DUR_MAX.minutes);
  const seconds = muteDurationSeconds(days, hours, minutes);
  // Второе нажатие, пока окно ещё не исчезло, второй раз не выключит.
  const done = useRef(false);
  const submit = () => {
    if (seconds === null || done.current) return;
    done.current = true;
    try {
      onPick(seconds);
    } finally {
      onClose();
    }
  };
  const onEnter = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.defaultPrevented) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    submit();
  };
  const pick = (
    <div className="sched-pick" onKeyDown={onEnter}>
      <div className="mute-dur" role="group" aria-label="Срок">
        <label className="mute-dur-f">
          <TimeField label="Дни" value={dd} max={MUTE_DUR_MAX.days} onChange={setDd} />
          <span>{plural(days ?? 0, 'день', 'дня', 'дней')}</span>
        </label>
        <label className="mute-dur-f">
          <TimeField label="Часы" value={hh} max={MUTE_DUR_MAX.hours} onChange={setHh} />
          <span>{plural(hours ?? 0, 'час', 'часа', 'часов')}</span>
        </label>
        <label className="mute-dur-f">
          <TimeField label="Минуты" value={mm} max={MUTE_DUR_MAX.minutes} onChange={setMm} />
          <span>{plural(minutes ?? 0, 'минута', 'минуты', 'минут')}</span>
        </label>
      </div>
      {phone ? (
        <div className="sched-foot">
          <button type="button" className="sched-go" disabled={seconds === null} onClick={submit}>
            Выключить
          </button>
        </div>
      ) : (
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="button" disabled={seconds === null} onClick={submit}>
            Выключить
          </button>
        </div>
      )}
    </div>
  );
  return phone ? (
    <BottomSheet title={TITLE} onClose={onClose}>
      {pick}
    </BottomSheet>
  ) : (
    <SchedDialog title={TITLE} onClose={onClose} onKeyDown={onEnter}>
      {pick}
    </SchedDialog>
  );
}

/**
 * Хозяин окна «Свой срок…» у корня `App`. Открывает его событие окна `MUTE_CUSTOM_EVENT` от пункта меню (меню к этому времени
 * уже закрыто), `detail` — id собеседника. Выбранная длительность уходит секундами (`POST /push/mute`, от минуты до 366
 * суток), а `until` у беседы потом приходит от сервера.
 */
export function MuteCustomHost() {
  const [peerId, setPeerId] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail;
      if (typeof id === 'string' && id) setPeerId(id);
    };
    window.addEventListener(MUTE_CUSTOM_EVENT, on);
    return () => window.removeEventListener(MUTE_CUSTOM_EVENT, on);
  }, []);
  if (!peerId) return null;
  return (
    <MuteDurPick
      onPick={(seconds) => {
        useStore.getState().setPushMuted('dm_user', peerId, true, seconds).catch(toastError);
      }}
      onClose={() => setPeerId(null)}
    />
  );
}
