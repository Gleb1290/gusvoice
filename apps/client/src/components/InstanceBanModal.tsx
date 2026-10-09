import { useEffect, useState } from 'react';
import { adminApi } from '../adminApi';
import { clearEvidence, useEvidence } from '../reportEvidence';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/**
 * «Запретить вход на инстанс» (#139, F4, план §5.11, требование 36).
 *
 * 🔴 Это решение ДЕРЖАТЕЛЯ ИНСТАНСА, а не владельца сервера: бан на сервере закрывает один сервер,
 * а здесь человеку закрывается весь инстанс — все серверы разом и вход по любым будущим ссылкам.
 * Поэтому окно называет последствия прямо, до нажатия: что снимется, что останется.
 *
 * 🔴 Запрет держится за ГЛОБАЛЬНУЮ личность `(instance_id, user_id)`, а не за теневую строку.
 * Отсюда и то, что запретить можно человека ИЗ КАТАЛОГА, который ни разу не заходил, и то, что
 * запрет переживает разрыв связки и перепривязку.
 *
 * ⚠️ Жалоба — отдельная галочка: запрет случится и без неё. Не примет сосед жалобу (старая версия,
 * суточный предел, лежит) — запрет всё равно в силе, и окно скажет об этом словами.
 */
export function InstanceBanModal({
  instanceId,
  instanceName,
  user,
  reports,
  contacts,
  onClose,
  onDone,
}: {
  instanceId: string;
  instanceName: string;
  user: { userId: string; username: string; displayName: string };
  /** Принимает ли инстанс человека жалобы (`reports` в его `features`). */
  reports: boolean;
  /** Контакты держателя ТОГО инстанса — нужны, когда жалобу отправить нельзя. */
  contacts: { kind: string; label: string; value: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [report, setReport] = useState(false);
  const [busy, setBusy] = useState(false);
  const evidence = useEvidence(user.userId);

  // Esc закрывает окно — как и у остальных модалок приложения.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit() {
    setBusy(true);
    try {
      const res = await adminApi().federationBan({
        instanceId,
        userId: user.userId,
        reason: reason.trim() || undefined,
        days,
        report: report || undefined,
        evidence: report && evidence.length ? evidence.map(({ text, at, channel }) => ({ text, at, channel })) : undefined,
      });
      clearEvidence(user.userId);
      toast(
        'success',
        'Вход на инстанс закрыт',
        res.servers > 0 ? `Человек снят с ${res.servers} сервер(ов) и вышел из сессии.` : 'Сессий и членств у него не было.',
      );
      if (report && res.report && !res.report.sent) {
        toast('error', 'Жалоба не ушла', 'Запрет в силе. Жалобу попробуйте отправить позже или напишите держателю сами.');
      }
      onDone();
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  }

  const TERMS: { label: string; value: number | null }[] = [
    { label: 'навсегда', value: null },
    { label: '1 день', value: 1 },
    { label: '7 дней', value: 7 },
    { label: '30 дней', value: 30 },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal create-channel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="admin-head">
          <h2>Запретить вход на инстанс</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="ib-who">
          <span className="ib-who-name">{user.displayName}</span>
          <span className="muted">@{user.username}</span>
          <span className="ib-who-inst">
            <Icon name="globe" size={12} /> с инстанса «{instanceName}»
          </span>
        </div>

        <label className="field">
          Причина
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="например, спам в каналах"
            maxLength={500}
            autoFocus
          />
        </label>

        <div className="settings-row col">
          <span>Срок</span>
          <div className="seg">
            {TERMS.map((t) => (
              <button key={t.label} type="button" className={days === t.value ? 'on' : ''} onClick={() => setDays(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* 🔴 «Что будет» до нажатия, а не после: запрет снимает членства, и вернуть их снятие
            обратно нельзя — прежние серверы не возвращаются даже после снятия запрета (§5.11). */}
        <div className="ib-effect">
          Человека снимет со всех серверов этого инстанса, гостевая сессия погаснет, по ссылкам он больше не войдёт.
          Его сообщения останутся. Снимете запрет — прежние членства не вернутся, входить придётся заново по ссылке.
        </div>

        <label className={`ctx-ban-report${reports ? '' : ' off'}`}>
          <input type="checkbox" checked={report} disabled={!reports} onChange={(e) => setReport(e.target.checked)} />
          <span>
            Пожаловаться держателю «{instanceName}»
            {reports ? (
              <em> — уйдут ник, причина, серверы и время{evidence.length > 0 ? `, а также ${evidence.length} прил. сообщ.` : ''}</em>
            ) : (
              <em> — этот инстанс жалоб пока не принимает</em>
            )}
          </span>
        </label>

        {/* Не принимает жалобы — показываем контакты держателя: написать ему всё равно можно, просто
            руками. Пустая неактивная галочка без этого была бы тупиком. */}
        {!reports && contacts.length > 0 && (
          <div className="inv-contacts">
            <div className="settings-group-label">Связаться с держателем</div>
            <ul>
              {contacts.map((c) => (
                <li key={`${c.kind}:${c.value}`}>
                  <span className="muted">{c.label}</span> {c.value}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report && evidence.length > 0 && (
          <div className="ib-evidence">
            <div className="settings-group-label">Приложенные сообщения</div>
            <ul>
              {evidence.map((e) => (
                <li key={e.messageId}>
                  <span className="muted">
                    {e.channel ? `#${e.channel} · ` : ''}
                    {new Date(e.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="ib-ev-text">{e.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="danger-btn" disabled={busy} onClick={() => void submit()}>
            {busy ? '…' : 'Запретить'}
          </button>
        </div>
      </div>
    </div>
  );
}
