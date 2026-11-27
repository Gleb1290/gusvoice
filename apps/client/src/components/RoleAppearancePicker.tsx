import { useId, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import './role-appearance.css';

// Каждый ряд проходит один и тот же спектр: насыщенные тона, приглушённые, пастельные и нейтральные.
const SWATCHES = [
  [0xe0574e, 'Коралл'], [0xe58447, 'Мандарин'], [0xf2b33d, 'Мёд'], [0x3fb97a, 'Изумруд'],
  [0x38b8bb, 'Бирюза'], [0x598be5, 'Василёк'], [0x9a70de, 'Аметист'], [0xdf72ae, 'Орхидея'],
  [0xb64f61, 'Гранат'], [0xbb7659, 'Терракота'], [0xb69a48, 'Латунь'], [0x83a354, 'Олива'],
  [0x5e9c8c, 'Эвкалипт'], [0x3f7fb9, 'Лазурь'], [0xb07ad8, 'Сирень'], [0xc95e8c, 'Малина'],
  [0xf59894, 'Лосось'], [0xf7b38c, 'Персик'], [0xf3da86, 'Ваниль'], [0xaada9b, 'Фисташка'],
  [0x91d8c6, 'Мята'], [0xa1cdf1, 'Небо'], [0xc3b0f0, 'Лаванда'], [0xf0b4ce, 'Сакура'],
  [0x997277, 'Розовый сланец'], [0xaa8d74, 'Какао'], [0xd2bd99, 'Песок'], [0x99a48e, 'Шалфей'],
  [0x83999c, 'Патина'], [0x8899b4, 'Сталь'], [0x9c97a8, 'Дымка'], [0xd0ccd2, 'Жемчуг'],
] as const;

function hex(color: number) {
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0').toUpperCase();
}

export function RoleAppearancePicker({ color, onChange, disabled, roleName }: {
  color: number; onChange: (color: number) => void; disabled: boolean; roleName: string;
}) {
  const group = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const code = color ? hex(color) : '';
  const tone = color ? code : 'var(--muted)';
  const invalid = draft !== null && !/^#?[\da-f]{6}$/i.test(draft);
  return (
    <fieldset className="role-appearance" disabled={disabled}>
      <legend>Цвет роли</legend>
      <div className="role-appearance-preview" style={{ '--role-tone': tone } as CSSProperties}>
        <span className="role-appearance-avatar"><Icon name="user" size={21} /></span>
        <span className="role-appearance-sample">
          <strong style={{ color: color ? code : undefined }}>Ник участника</strong>
          <span className="role-appearance-chip"><i />{roleName.trim() || 'Новая роль'}</span>
        </span>
      </div>
      <div className="role-appearance-grid" role="radiogroup" aria-label="Готовые цвета">
        {SWATCHES.map(([value, label]) => (
          <label key={value} title={label + ' · ' + hex(value)} style={{ '--role-tone': hex(value) } as CSSProperties}>
            <input type="radio" name={group} checked={color === value} aria-label={label}
              onChange={() => { setDraft(null); onChange(value); }} />
            <span>{color === value && <Icon name="check" size={14} />}</span>
          </label>
        ))}
      </div>
      <div className="role-appearance-custom">
        <label className="role-custom-color">Свой цвет
          <input type="color" aria-label="Выбрать свой цвет" value={code || '#9c97a8'}
            onChange={(event) => { setDraft(null); onChange(parseInt(event.target.value.slice(1), 16)); }} />
        </label>
        <input className="role-hex" aria-label="Цвет роли в HEX" aria-invalid={invalid || undefined}
          placeholder="#RRGGBB" maxLength={7} spellCheck={false} autoCapitalize="characters" value={draft ?? code}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            if (/^#?[\da-f]{6}$/i.test(value)) onChange(parseInt(value.replace('#', ''), 16));
          }}
          onBlur={() => setDraft(null)} />
        <button type="button" className="link" disabled={disabled || !color}
          onClick={() => { setDraft(null); onChange(0); }}>Без цвета</button>
      </div>
      {invalid && <small className="muted">Введите шесть цифр или букв от A до F.</small>}
      {draft?.replace('#', '') === '000000' && <small className="muted">#000000 сбрасывает цвет роли.</small>}
    </fieldset>
  );
}
