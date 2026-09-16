/**
 * Settings for the desktop in-game voice overlay. Writes through overlaySettings.ts, which live-drives
 * the overlay window (see overlay.ts). Rendered desktop-only. Modes: 'desktop' (always) / 'apps' (only
 * over user-picked apps, via the native foreground watcher + gv_list_apps picker).
 */
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { Toggle } from './Toggle';
import { Icon } from './Icon';
import {
  getOverlaySettings,
  onOverlaySettings,
  setOverlaySettings,
  type OverlayContent,
  type OverlayCorner,
  type OverlayMode,
  type OverlaySettings,
} from '../overlaySettings';
import { finishOverlayReposition, startOverlayReposition } from '../overlay';
import { AppPickerModal } from './AppPickerModal';

/** Screen-corner codes read as gibberish to a screen reader ("Угол tl") — spell them out. */
const CORNER_NAMES: Record<OverlayCorner, string> = {
  tl: 'Левый верхний угол',
  tr: 'Правый верхний угол',
  bl: 'Левый нижний угол',
  br: 'Правый нижний угол',
};

export function OverlaySettingsPanel() {
  const [s, setS] = useState<OverlaySettings>(getOverlaySettings());
  const update = (patch: Partial<OverlaySettings>) => setS(setOverlaySettings(patch));
  const [pickerOpen, setPickerOpen] = useState(false);
  // Stay in sync with external settings changes — e.g. the overlay's own «Готово» sets posMode='custom'.
  useEffect(() => onOverlaySettings(setS), []);
  // 🔴 Та же дыра, что нашлась у плашки 05.09: закрыли настройки, не нажав «Готово», — оверлей
  // остаётся в режиме расстановки, ЛОВИТ МЫШЬ и съедает клики. Закрытие = «Готово». Идемпотентно.
  useEffect(
    () => () => {
      void finishOverlayReposition();
    },
    [],
  );

  const modes: { val: OverlayMode; label: string; sub: string }[] = [
    { val: 'desktop', label: 'Весь рабочий стол', sub: 'Поверх всех окон, пока идут условия показа' },
    { val: 'apps', label: 'Только выбранные приложения', sub: 'Показывать поверх выбранных игр/программ' },
  ];
  const contents: { val: OverlayContent; label: string; sub: string }[] = [
    { val: 'list', label: 'Список', sub: 'Аватары, ники, обводка говорящего, значки mute/deafen' },
    { val: 'compact', label: 'Компактно', sub: 'Только кто сейчас говорит' },
  ];
  const corners: { val: OverlayCorner; glyph: string }[] = [
    { val: 'tl', glyph: '↖' },
    { val: 'tr', glyph: '↗' },
    { val: 'bl', glyph: '↙' },
    { val: 'br', glyph: '↘' },
  ];

  // NB: return a Fragment (not a wrapper <div>) so these rows are DIRECT children of `.settings-pane`
  // and inherit its `gap: 10px` — a wrapper div swallows that gap and the toggle rows collapse together.
  return (
    <>
      <div className="settings-group-label" style={{ marginTop: 18 }}>
        Оверлей поверх игр
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Показывает участников голосового канала поверх других окон. Работает поверх оконных и
        полноэкранных <strong>borderless</strong>-игр; игры в <strong>эксклюзивном фуллскрине</strong>{' '}
        перекрыть нельзя — переключи игру в режим «без рамки».
      </div>

      <div className="settings-row">
        <span>Включить оверлей</span>
        <Toggle checked={s.enabled} onChange={(v) => update({ enabled: v })} label="Включить оверлей" />
      </div>

      {s.enabled && (
        <>
          <div className="settings-row">
            <span>Только когда я в голосовом канале</span>
            <Toggle
              checked={s.onlyInVoice}
              onChange={(v) => update({ onlyInVoice: v })}
              label="Показывать только когда я в голосовом канале"
            />
          </div>

          <div className="settings-group-label" style={{ marginTop: 14 }}>
            Когда показывать
          </div>
          {/* display:contents keeps the options DIRECT children of .settings-pane so its gap still
              applies (a real wrapper div would swallow it — see the note above). */}
          <div role="group" aria-label="Когда показывать оверлей" style={{ display: 'contents' }}>
            {modes.map((o) => (
              <button
                key={o.val}
                type="button"
                aria-pressed={s.mode === o.val}
                className={`close-opt ${s.mode === o.val ? 'on' : ''}`}
                onClick={() => update({ mode: o.val })}
              >
                <span className="close-opt-text">
                  <span>{o.label}</span>
                  <span className="close-opt-sub">{o.sub}</span>
                </span>
                {s.mode === o.val && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>

          {s.mode === 'apps' && (
            <div style={{ marginTop: 8 }}>
              {s.apps.length === 0 ? (
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  Приложения не выбраны — оверлей не будет показываться. Выбери хотя бы одно.
                </div>
              ) : (
                <div className="app-chips">
                  {s.apps.map((exe) => (
                    <span key={exe} className="app-chip">
                      {exe}
                      <button
                        type="button"
                        aria-label={`Убрать ${exe}`}
                        onClick={() => update({ apps: s.apps.filter((x) => x !== exe) })}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <button type="button" className="settings-action" onClick={() => setPickerOpen(true)}>
                Выбрать приложения…
              </button>
            </div>
          )}

          <div className="settings-group-label" style={{ marginTop: 14 }}>
            Вид
          </div>
          <div role="group" aria-label="Вид оверлея" style={{ display: 'contents' }}>
            {contents.map((o) => (
              <button
                key={o.val}
                type="button"
                aria-pressed={s.content === o.val}
                className={`close-opt ${s.content === o.val ? 'on' : ''}`}
                onClick={() => update({ content: o.val })}
              >
                <span className="close-opt-text">
                  <span>{o.label}</span>
                  <span className="close-opt-sub">{o.sub}</span>
                </span>
                {s.content === o.val && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>

          <div className="settings-group-label" style={{ marginTop: 14 }}>
            Позиция
          </div>
          {s.posMode === 'custom' ? (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Своя позиция (перетащена мышью). Можно вернуть к углу экрана.
            </div>
          ) : (
            <div
              className="settings-row"
              style={{ gap: 8, justifyContent: 'flex-start', marginBottom: 6 }}
              role="group"
              aria-label="Угол экрана"
            >
              {corners.map((c) => (
                <button
                  key={c.val}
                  type="button"
                  className={`ov-corner ${s.corner === c.val ? 'on' : ''}`}
                  onClick={() => update({ corner: c.val })}
                  aria-pressed={s.corner === c.val}
                  aria-label={CORNER_NAMES[c.val]}
                >
                  {c.glyph}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="settings-action" onClick={() => startOverlayReposition()}>
            Настроить позицию мышью
          </button>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Появится оверлей — перетащи его куда нужно и нажми «Готово» прямо на нём.
          </div>
          {s.posMode === 'custom' && (
            <button
              type="button"
              className="link"
              style={{ marginTop: 6, alignSelf: 'flex-start' }}
              onClick={() => update({ posMode: 'corner' })}
            >
              Вернуть к углу экрана
            </button>
          )}

          {/* The slider shows TRANSPARENCY, the setting stores OPACITY — they're opposites, and the label
              used to print the raw opacity, so "Прозрачность: 100%" meant fully solid. Range 0–70%
              transparent = opacity 1.0–0.3; the floor is what keeps the overlay from vanishing entirely. */}
          <label className="settings-row col" style={{ marginTop: 10 }}>
            <span>Прозрачность: {100 - Math.round(s.opacity * 100)}%</span>
            <input
              type="range"
              min={0}
              max={70}
              value={100 - Math.round(s.opacity * 100)}
              style={{ ['--p']: (100 - Math.round(s.opacity * 100)) / 70 } as CSSProperties}
              onChange={(e) => update({ opacity: (100 - Number(e.target.value)) / 100 })}
            />
          </label>
        </>
      )}

      {pickerOpen && (
        <AppPickerModal
          selected={s.apps}
          onClose={() => setPickerOpen(false)}
          onSave={(exes) => update({ apps: exes })}
        />
      )}
    </>
  );
}
