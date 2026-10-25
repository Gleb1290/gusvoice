import { useState } from 'react';
import { ONCE_TTL_MAX } from '@gusvoice/shared';
import { MenuItem } from './ContextMenu';
import { DrumPicker } from './DrumPicker';
import { isCustomTtl, ONCE_TTL_CUSTOM_DEFAULT, ONCE_TTL_PRESETS, ONCE_VIEW, secondsLabel } from '../onceMediaRules';

/** Подписи барабана «Своё время»: «1 секунда» … «60 секунд» (tdesktop: `lng_seconds`, значения 1…60). */
const DRUM_ITEMS: readonly string[] = Array.from({ length: ONCE_TTL_MAX }, (_, i) => secondsLabel(i + 1));

/**
 * Пункты «Таймер самоуничтожения» (19.10, #226) — подменю пункта файла в окне отправки (ПК, `SendFilesBox`) и в меню удержания
 * «Отправить» галереи (телефон, `MediaSheet`). Порядок и подписи — tdesktop `send_files_box.cpp` (`lng_ttl_period_once`, 3/10/30
 * секунд, `lng_ttl_period_keep`, `lng_ttl_period_custom`, подсказка `lng_ttl_period_hint`). Своё время — барабан 1…60 с
 * (`DrumPicker`, как `TimePickerBox`: колесо, «Отмена» и «Готово»), на месте пунктов внутри того же меню (окно поверх меню
 * закрыло бы его щелчком «мимо»). `current` — `null` = «Не удалять».
 */
export function OnceTimerItems({
  current,
  onChoose,
  onBack,
}: {
  current: number | null;
  onChoose: (ttl: number | null) => void;
  onBack?: () => void;
}) {
  const [custom, setCustom] = useState<number | null>(null);
  // Выбранная строка барабана (индекс 0 = 1 с); «Готово» и Enter читают её отсюда.
  const [pick, setPick] = useState(ONCE_TTL_CUSTOM_DEFAULT - 1);
  if (custom !== null) {
    const done = () => onChoose(pick + 1);
    return (
      <div className="once-custom" onClick={(e) => e.stopPropagation()}>
        <MenuItem icon="chevron-left" label="Своё время" back onClick={() => setCustom(null)} />
        <DrumPicker items={DRUM_ITEMS} initial={custom - 1} autoFocus onChange={setPick} onSubmit={done} label="Своё время, секунд" />
        <div className="once-custom-actions">
          <button type="button" className="once-btn ghost" onClick={() => setCustom(null)}>
            Отмена
          </button>
          <button type="button" className="once-btn" onClick={done}>
            Готово
          </button>
        </div>
      </div>
    );
  }
  const own = isCustomTtl(current);
  return (
    <>
      {onBack && <MenuItem icon="chevron-left" label="Таймер самоуничтожения" back onClick={onBack} />}
      <MenuItem icon="flame" label="Просмотр один раз" active={current === ONCE_VIEW} onClick={() => onChoose(ONCE_VIEW)} />
      {ONCE_TTL_PRESETS.map((n) => (
        <MenuItem key={n} icon="clock" label={secondsLabel(n)} active={current === n} onClick={() => onChoose(n)} />
      ))}
      <MenuItem icon="close" label="Не удалять" active={current === null} onClick={() => onChoose(null)} />
      <MenuItem
        icon="edit"
        label={own ? `Своё время (${current} с)` : 'Своё время…'}
        active={own}
        onClick={() => {
          const from = own ? current! : ONCE_TTL_CUSTOM_DEFAULT;
          setPick(from - 1);
          setCustom(from);
        }}
      />
      <div className="once-hint">Выберите, как долго медиа будет доступно после открытия.</div>
    </>
  );
}
