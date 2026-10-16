/**
 * «Использовать уведомления Windows», положение и число своих всплывающих окон (G38, ND-07) — только десктоп. Как раздел
 * уведомлений Telegram Desktop (`settings/sections/settings_notifications.cpp`): галка `lng_settings_use_windows`, ниже —
 * только при выключенной — «Положение на экране» (`lng_settings_notifications_position`, четыре угла) и «Количество
 * уведомлений» (`lng_settings_notifications_count`, 1…5), выбор экрана при нескольких мониторах. Настройки на устройстве —
 * `notifyPopupPrefs.ts`; стопка на экране перекладывается сразу (`notifyPopupHost.ts`).
 */
import { useEffect, useState } from 'react';
import { Toggle } from './Toggle';
import { Select } from './Select';
import { getNotifyPopupPrefs, setNotifyPopupPrefs, type NotifyPopupPrefs } from '../notifyPopupPrefs';
import { notifyPopupMonitors } from '../notifyPopupHost';
import { POPUP_COUNT_MAX, type PopupCorner } from '../notifyPopupRules';

const CORNERS: { val: PopupCorner; glyph: string; name: string }[] = [
  { val: 'tl', glyph: '↖', name: 'Слева сверху' },
  { val: 'tr', glyph: '↗', name: 'Справа сверху' },
  { val: 'bl', glyph: '↙', name: 'Слева снизу' },
  { val: 'br', glyph: '↘', name: 'Справа снизу' },
];

export function NotifyPopupSetting() {
  const [p, setP] = useState<NotifyPopupPrefs>(getNotifyPopupPrefs);
  const [monitors, setMonitors] = useState<string[]>([]);
  useEffect(() => {
    void notifyPopupMonitors().then(setMonitors);
  }, []);
  const update = (patch: Partial<NotifyPopupPrefs>) => setP(setNotifyPopupPrefs(patch));

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="settings-group-label" id="set-g-notify-popup">
        Всплывающие окна
      </div>
      <div className="settings-row">
        <span id="set-notify-native-label">Использовать уведомления Windows</span>
        <Toggle checked={p.native} onChange={(v) => update({ native: v })} labelledBy="set-notify-native-label" />
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {p.native
          ? 'Уведомления показывает Windows — в Центре уведомлений, с полем ответа.'
          : 'Свои окна GusVoice в углу экрана: поверх игр, не забирают фокус, на наведении — «Ответить».'}
      </div>
      {!p.native && (
        <>
          <div className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 6 }}>
            Положение на экране
          </div>
          <div className="settings-row" style={{ gap: 8, justifyContent: 'flex-start', flexWrap: 'wrap' }} role="group" aria-label="Положение на экране">
            {CORNERS.map((c) => (
              <button
                key={c.val}
                type="button"
                className={`ov-corner ${p.corner === c.val ? 'on' : ''}`}
                onClick={() => update({ corner: c.val })}
                aria-pressed={p.corner === c.val}
                aria-label={c.name}
                title={c.name}
              >
                {c.glyph}
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 6 }} id="set-notify-count-label">
            Сколько окон сразу
          </div>
          <div className="seg" role="group" aria-labelledby="set-notify-count-label">
            {Array.from({ length: POPUP_COUNT_MAX }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={p.count === n}
                className={p.count === n ? 'on' : undefined}
                onClick={() => update({ count: n })}
              >
                {n}
              </button>
            ))}
          </div>
          {monitors.length > 1 && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 6 }}>
                Экран
              </div>
              <Select
                value={monitors.includes(p.monitor) ? p.monitor : ''}
                options={[{ value: '', label: 'Где окно GusVoice' }, ...monitors.map((m) => ({ value: m, label: m }))]}
                onChange={(v) => update({ monitor: v })}
                ariaLabel="Экран для уведомлений"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
