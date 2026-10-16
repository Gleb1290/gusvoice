import { useState } from 'react';
import { effectiveStageLayout, stageLayoutChoices, STAGE_LAYOUT_LABELS, type StageLayout } from '../stageLayoutRules';
import { setStageLayout, useStageLayout } from '../stageLayoutPrefs';
import { ContextMenu } from './ContextMenu';
import { Icon } from './Icon';

/** Сколько клеток у мини-схемы и какая из них крупная (первая). */
const MINI_CELLS: Record<StageLayout, number> = { auto: 4, grid: 6, focus: 4, side: 4, speaker: 4 };

/**
 * Мини-схема вида сцены (#221): прямоугольники из `currentColor` — как пиктограммы раскладок у Meet. Своих иконок
 * раскладки в наборе нет, рисованные картинки у нас идут через отдельный поток, поэтому схема собрана разметкой
 * (`.stage-mini`, `styles.css`). «Авто» — сетка с буквой «А».
 */
export function StageLayoutMini({ layout }: { layout: StageLayout }) {
  const big = layout === 'focus' || layout === 'side' || layout === 'speaker';
  return (
    <span className={`stage-mini ${layout}`} aria-hidden="true">
      {Array.from({ length: MINI_CELLS[layout] }, (_, i) => (
        <span key={i} className={big && i === 0 ? 'big' : undefined} />
      ))}
      {layout === 'auto' && <b>A</b>}
    </span>
  );
}

/**
 * Переключатель вида сцены в шапке голосового канала (#221, 16.10): значок текущего режима + выпадающее меню
 * с мини-схемами — как меню колокольчика в шапке ЛС (`ContextMenu anchor`, на телефоне — выпадающее от кнопки,
 * `drop`). Режим один на всё (`stageLayoutPrefs.ts`); на телефоне только Авто / Фокус / Говорящий.
 */
export function StageLayoutPicker({ phone }: { phone: boolean }) {
  const saved = useStageLayout();
  const current = effectiveStageLayout(saved, phone);
  const [at, setAt] = useState<DOMRect | null>(null);
  const close = () => setAt(null);
  return (
    <>
      <button
        type="button"
        className={`topbar-btn voice-header-tool stage-layout-btn${at ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-label="Вид сцены"
        title={`Вид: ${STAGE_LAYOUT_LABELS[current].label}`}
        onClick={(e) => setAt(at ? null : e.currentTarget.getBoundingClientRect())}
      >
        <StageLayoutMini layout={current} />
      </button>
      {at && (
        <ContextMenu anchor={at} align="end" drop={phone} width={phone ? 288 : 264} fit onClose={close}>
          {stageLayoutChoices(phone).map((l) => (
            <button
              key={l}
              type="button"
              role="menuitemradio"
              aria-checked={l === current}
              className={`ctx-item stage-layout-item ${l === current ? 'active' : ''}`}
              onClick={() => {
                setStageLayout(l);
                close();
              }}
            >
              <span className="ctx-ico">
                <StageLayoutMini layout={l} />
              </span>
              <span className="ctx-label has-sub">
                <span className="ctx-label-main">{STAGE_LAYOUT_LABELS[l].label}</span>
                <span className="ctx-sublabel">{STAGE_LAYOUT_LABELS[l].sub}</span>
              </span>
              {l === current && (
                <span className="ctx-shortcut">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          ))}
        </ContextMenu>
      )}
    </>
  );
}
