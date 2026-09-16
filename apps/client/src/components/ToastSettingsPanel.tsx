/**
 * Настройки всплывающей плашки «кто кого типнул» (десктоп). Пишет через `toastSettings.ts`, которые
 * живьём ведут окно плашки (см. `tipToast.ts`). Рисуется рядом с настройками оверлея-ростера.
 *
 * 🔴 Отдельный блок, а не галочка внутри оверлея: это разные окна с разными позицией, размером и
 * прозрачностью, и человек вправе держать оба сразу — ростер в углу, плашку по центру.
 */
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { Toggle } from './Toggle';
import {
  getToastSettings,
  onToastSettings,
  setToastSettings,
  type ToastCorner,
  type ToastSettings,
} from '../toastSettings';
import { finishToastReposition, startToastReposition } from '../tipToast';

/** Коды углов читаются вслух как бессмыслица («Угол tc») — подписываем словами. */
const CORNER_NAMES: Record<ToastCorner, string> = {
  tl: 'Левый верхний угол',
  tc: 'Сверху по центру',
  tr: 'Правый верхний угол',
  bl: 'Левый нижний угол',
  c: 'По центру экрана',
  br: 'Правый нижний угол',
};

export function ToastSettingsPanel() {
  const [s, setS] = useState<ToastSettings>(getToastSettings());
  const update = (patch: Partial<ToastSettings>) => setS(setToastSettings(patch));
  // Держим строй с внешними правками — «Готово» на самой плашке ставит posMode='custom'.
  useEffect(() => onToastSettings(setS), []);
  /**
   * 🔴 Закрыли настройки, не нажав «Готово» — снимаем режим расстановки САМИ.
   *
   * Без этого образец оставался висеть на экране навсегда, а окно в этом режиме ещё и ЛОВИТ МЫШЬ,
   * то есть съедало клики в своей области — плашка превращалась в невидимую заглушку поверх всего.
   * Закрытие настроек трактуем как «Готово»: человек плашку уже расставил, отменять его работу и
   * возвращать её в угол было бы хуже. Вызов идемпотентен — если расстановку не включали, он
   * ничего не делает и позицию не трогает.
   */
  useEffect(
    () => () => {
      void finishToastReposition();
    },
    [],
  );

  // Порядок кнопок повторяет экран: верхний ряд, потом нижний, центр — между ними.
  const corners: { val: ToastCorner; glyph: string }[] = [
    { val: 'tl', glyph: '↖' },
    { val: 'tc', glyph: '↑' },
    { val: 'tr', glyph: '↗' },
    { val: 'bl', glyph: '↙' },
    { val: 'c', glyph: '◎' },
    { val: 'br', glyph: '↘' },
  ];

  return (
    <>
      <div className="settings-group-label" style={{ marginTop: 18 }}>
        Плашка «кто кого типнул»
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Всплывает поверх игры на несколько секунд, когда кого-то типнули или ущипнули, и сама
        пропадает. Пока ничего не происходит, на экране её нет вовсе — постоянного окна не появляется.
      </div>

      <div className="settings-row">
        <span>Включить плашку</span>
        <Toggle checked={s.enabled} onChange={(v) => update({ enabled: v })} label="Включить плашку" />
      </div>

      {s.enabled && (
        <>
          {/* Роды порознь: кому мешает только щипок, не должен отключать и то, ради чего включал. */}
          <div className="settings-row">
            <span>Показывать типы</span>
            <Toggle checked={s.tips} onChange={(v) => update({ tips: v })} label="Показывать типы" />
          </div>
          <div className="settings-row">
            <span>Показывать щипки</span>
            <Toggle checked={s.pokes} onChange={(v) => update({ pokes: v })} label="Показывать щипки" />
          </div>
          <div className="settings-row">
            <span>Только пока я в голосовом канале</span>
            <Toggle
              checked={s.onlyInVoice}
              onChange={(v) => update({ onlyInVoice: v })}
              label="Только пока я в голосовом канале"
            />
          </div>

          <div className="settings-group-label" style={{ marginTop: 14 }}>
            Позиция
          </div>
          {s.posMode === 'custom' ? (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Своя позиция (перетащена мышью). Можно вернуть к краю экрана.
            </div>
          ) : (
            <div
              className="settings-row"
              style={{ gap: 8, justifyContent: 'flex-start', marginBottom: 6, flexWrap: 'wrap' }}
              role="group"
              aria-label="Положение на экране"
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
          <button type="button" className="settings-action" onClick={() => startToastReposition()}>
            Настроить позицию мышью
          </button>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Появится образец плашки — перетащи его куда нужно и нажми «Готово» прямо на нём.
          </div>
          {s.posMode === 'custom' && (
            <button
              type="button"
              className="link"
              style={{ marginTop: 6, alignSelf: 'flex-start' }}
              onClick={() => update({ posMode: 'corner' })}
            >
              Вернуть к краю экрана
            </button>
          )}

          <label className="settings-row col" style={{ marginTop: 10 }}>
            <span>Размер: {Math.round(s.scale * 100)}%</span>
            <input
              type="range"
              min={70}
              max={200}
              step={5}
              value={Math.round(s.scale * 100)}
              style={{ ['--p']: (Math.round(s.scale * 100) - 70) / 130 } as CSSProperties}
              onChange={(e) => update({ scale: Number(e.target.value) / 100 })}
            />
          </label>

          {/* Ползунок показывает ПРОЗРАЧНОСТЬ, настройка хранит непрозрачность — они противоположны.
              0–70 % прозрачности = непрозрачность 1.0–0.3; нижняя граница не даёт плашке исчезнуть. */}
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
    </>
  );
}
