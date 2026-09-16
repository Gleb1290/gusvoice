import type { SmtpSettings } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast, toastError } from '../toast';
import { Toggle } from './Toggle';

// SMTP configuration so an operator can set up e-mail from the UI (no .env edit + rebuild). When it's
// unset, registrations wait for manual approval on the Пользователи tab. The stored password is never
// sent back — leaving the field empty on save keeps it.
/**
 * Настройки почты (SMTP) с кнопкой тестового письма. Живёт во вкладке «Почта» админки и в мастере установки (#142).
 * `onSaved(configured)` — после сохранения: мастер по нему понимает, что почта настроена.
 */
export function SmtpForm({
  intro = true,
  testToDefault = '',
  onSaved,
}: {
  intro?: boolean;
  testToDefault?: string;
  onSaved?: (configured: boolean) => void;
}) {
  const [s, setS] = useState<SmtpSettings | null>(null);
  const [pass, setPass] = useState('');
  const [testTo, setTestTo] = useState(testToDefault);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .adminGetSmtp()
      .then(setS)
      .catch((e) => toastError(e));
  }, []);

  function upd(patch: Partial<SmtpSettings>) {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const r = await api.adminSetSmtp({
        host: s.host.trim(),
        port: s.port,
        secure: s.secure,
        user: s.user.trim(),
        pass: pass || undefined,
        from: s.from.trim(),
      });
      setPass('');
      setS(await api.adminGetSmtp());
      toast('success', r.cleared ? 'Почта отключена' : 'Настройки почты сохранены');
      onSaved?.(!r.cleared);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!testTo.trim()) {
      toastError(new Error('Укажите адрес для теста'));
      return;
    }
    setBusy(true);
    try {
      await api.adminTestSmtp(testTo.trim());
      toast('success', 'Тестовое письмо отправлено', `Проверьте ящик ${testTo.trim()}.`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!s)
    return (
      <div className="muted" role="status">
        Загрузка…
      </div>
    );

  return (
    <div className="smtp-form">
      {intro && (
        <p className="muted" style={{ margin: 0 }}>
          Настройте SMTP, чтобы новым пользователям на почту приходил код подтверждения. Пока почта не
          настроена, каждую регистрацию нужно подтверждать вручную во вкладке «Пользователи».
        </p>
      )}
      {s.source === 'env' && (
        <p className="muted" style={{ margin: 0 }}>
          Сейчас берётся из переменных окружения (.env) — сохранение здесь переопределит их.
        </p>
      )}

      <label className="field">
        <span>SMTP-хост</span>
        <input value={s.host} onChange={(e) => upd({ host: e.target.value })} placeholder="mail.example.com" />
      </label>
      <label className="field">
        <span>Порт</span>
        <input type="number" value={s.port} onChange={(e) => upd({ port: Number(e.target.value) || 587 })} />
      </label>
      <label className="field smtp-toggle">
        <Toggle checked={s.secure} onChange={() => upd({ secure: !s.secure })} title="SSL/TLS" />
        <span>SSL/TLS (порт 465). Выключено = STARTTLS (обычно 587).</span>
      </label>
      <label className="field">
        <span>Логин</span>
        <input value={s.user} onChange={(e) => upd({ user: e.target.value })} placeholder="noreply@example.com" />
      </label>
      <label className="field">
        <span>Пароль</span>
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder={s.hasPass ? '•••••• (сохранён — оставьте пустым, чтобы не менять)' : ''}
        />
      </label>
      <label className="field">
        <span>Отправитель (From)</span>
        <input value={s.from} onChange={(e) => upd({ from: e.target.value })} placeholder="GusVoice <noreply@example.com>" />
      </label>

      <div className="smtp-actions">
        <button type="button" className="auth-cta" onClick={save} disabled={busy}>
          {busy ? '…' : 'Сохранить'}
        </button>
        <span className="muted">Пустой хост = отключить почту.</span>
      </div>

      <hr className="smtp-sep" />

      <label className="field">
        <span>Проверка — куда отправить тест</span>
        <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
      </label>
      <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={test} disabled={busy}>
        Отправить тестовое письмо
      </button>
    </div>
  );
}
