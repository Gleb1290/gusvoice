import type { AdminInstanceSettings, RegistrationPolicy } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast, toastError } from '../toast';
import { InstanceUpdateCard } from './InstanceUpdateCard';

/**
 * Настройки инстанса: название, иконка, кто может регистрироваться (#142).
 * Одни и те же куски показывает мастер установки и вкладка «Инстанс» админ-панели.
 */

const POLICY_CARDS: { value: RegistrationPolicy; title: string; text: string; recommended?: boolean }[] = [
  {
    value: 'approval',
    title: 'Все, но с вашим одобрением',
    text: 'Зарегистрироваться может любой, а войти — только после того, как вы одобрите аккаунт в админ-панели.',
    recommended: true,
  },
  {
    value: 'invite',
    title: 'Только по приглашению',
    text: 'Аккаунт создаётся только с кодом приглашения на один из серверов. Без кода регистрация закрыта.',
  },
  {
    value: 'open',
    title: 'Все желающие',
    text: 'Любой, кто откроет сайт, сразу создаёт аккаунт и входит. Подходит, если адрес знают только свои.',
  },
];

export function RegistrationPolicyPicker({
  value,
  onChange,
  smtpConfigured,
}: {
  value: RegistrationPolicy;
  onChange: (p: RegistrationPolicy) => void;
  smtpConfigured: boolean;
}) {
  return (
    <div className="reg-policy" role="radiogroup" aria-label="Кто может регистрироваться">
      {POLICY_CARDS.map((c) => (
        <label key={c.value} className={`reg-card${value === c.value ? ' selected' : ''}`}>
          <input
            type="radio"
            name="registration-policy"
            value={c.value}
            checked={value === c.value}
            onChange={() => onChange(c.value)}
          />
          <span className="reg-card-dot" aria-hidden="true" />
          <span className="reg-card-body">
            <span className="reg-card-title">
              {c.title}
              {c.recommended && <span className="reg-card-chip">рекомендуем</span>}
            </span>
            <span className="reg-card-text">{c.text}</span>
          </span>
        </label>
      ))}
      {!smtpConfigured && (
        <div className="reg-policy-note">
          Почта не настроена, поэтому при любом выборе каждую регистрацию подтверждаете вы — код на почту
          отправить некуда.
        </div>
      )}
    </div>
  );
}

/** Квадрат с иконкой инстанса (или первой буквой названия) и кнопками «Загрузить» / «Убрать». */
export function InstanceIconPicker({
  iconUrl,
  name,
  onChange,
}: {
  iconUrl: string | null;
  name: string;
  onChange: (iconUrl: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      const r = await api.adminUploadInstanceIcon(file);
      onChange(r.iconUrl);
    } catch (e) {
      toastError(e, 'Не удалось загрузить иконку');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.adminDeleteInstanceIcon();
      onChange(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inst-icon-row">
      <div className="inst-icon" aria-hidden="true">
        {iconUrl ? <img src={iconUrl} alt="" /> : <span>{(name.trim()[0] || 'G').toUpperCase()}</span>}
      </div>
      <div className="inst-icon-actions">
        <button type="button" className="settings-action" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Загружаем…' : iconUrl ? 'Заменить иконку' : 'Загрузить иконку'}
        </button>
        {iconUrl && (
          <button type="button" className="link" disabled={busy} onClick={() => void remove()}>
            Убрать
          </button>
        )}
        <span className="muted inst-icon-hint">PNG, JPEG, WebP или GIF, до 2 МБ</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
    </div>
  );
}

/** Вкладка «Инстанс» админ-панели: то же, что шаги мастера, но в любой момент. */
export function InstanceSettingsPanel() {
  const [s, setS] = useState<AdminInstanceSettings | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .adminInstance()
      .then((r) => {
        setS(r);
        setName(r.name ?? '');
      })
      .catch((e) => toastError(e));
  }, []);

  if (!s) {
    return (
      <div className="muted" role="status">
        Загрузка…
      </div>
    );
  }

  async function save(patch: { name?: string | null; registration?: RegistrationPolicy }) {
    setBusy(true);
    try {
      await api.adminSetInstance(patch);
      setS((cur) => (cur ? { ...cur, ...patch } : cur));
      toast('success', 'Сохранено');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="smtp-form">
      <InstanceUpdateCard />
      <label className="field">
        <span>Название инстанса</span>
        <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Например, Гнездо" />
      </label>
      <div className="smtp-actions">
        <button
          type="button"
          className="auth-cta"
          disabled={busy || (name.trim() || null) === s.name}
          onClick={() => void save({ name: name.trim() || null })}
        >
          Сохранить название
        </button>
      </div>
      <InstanceIconPicker iconUrl={s.iconUrl} name={name} onChange={(iconUrl) => setS({ ...s, iconUrl })} />
      <hr className="smtp-sep" />
      <div className="field">
        <span>Кто может регистрироваться</span>
      </div>
      <RegistrationPolicyPicker
        value={s.registration}
        smtpConfigured={s.smtpConfigured}
        onChange={(registration) => void save({ registration })}
      />
    </div>
  );
}
