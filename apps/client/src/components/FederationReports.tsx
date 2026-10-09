import type { FederationBanRow, FederationReportRow } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { adminApi } from '../adminApi';
import { toast, toastError } from '../toast';
import { confirmAction } from '../confirm';
import { Icon } from './Icon';

/**
 * Жалобы и запреты на инстанс во вкладке «Федерация» (#139, F4, план §5.11).
 *
 * 🔴 Две стороны в одном месте намеренно: ВХОДЯЩАЯ жалоба — это письмо держателю про его
 * собственного человека, и решать по ней ему; ИСХОДЯЩАЯ — то, что он сам отправил, и её судьба
 * (доставлена, прочитана, отвечена) тоже его дело. Разнеси их по разным экранам — и половина
 * разговора всегда будет не на том экране, где человек стоит.
 *
 * 🔴 Сам человек своей жалобы не видит нигде (§5.11) — маршрут только для держателя.
 */

const STATUS_TEXT: Record<string, string> = {
  sent: 'отправлена',
  delivered: 'доставлена',
  read: 'прочитана',
  replied: 'есть ответ',
  closed: 'закрыта',
};

const ACTION_TEXT: Record<string, string> = {
  instance_ban: 'закрыт вход на инстанс',
  server_ban: 'бан на сервере',
};

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function FederationReports() {
  const [reports, setReports] = useState<FederationReportRow[] | null>(null);
  const [bans, setBans] = useState<FederationBanRow[] | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [r, b] = await Promise.all([adminApi().federationReports(), adminApi().federationBans()]);
      setReports(r.reports);
      setBans(b.bans);
    } catch (e) {
      toastError(e);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function sendReply(id: string) {
    if (!replyText.trim()) return;
    setBusy(true);
    try {
      await adminApi().federationReplyReport(id, replyText.trim());
      setReplyTo(null);
      setReplyText('');
      toast('success', 'Ответ отправлен');
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function unban(b: FederationBanRow) {
    const ok = await confirmAction({
      title: `Снять запрет для ${b.displayName ?? b.userId}?`,
      body: 'Прежние членства не вернутся — входить он будет заново по ссылке-приглашению.',
      confirmLabel: 'Снять запрет',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await adminApi().federationUnban(b.instanceId, b.userId);
      toast('success', 'Запрет снят');
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const incoming = (reports ?? []).filter((r) => r.direction === 'in');
  const outgoing = (reports ?? []).filter((r) => r.direction === 'out');
  // Баннер — только про НЕПРОЧИТАННЫЕ входящие: он зовёт держателя разобраться, а не пересчитывает
  // всё, что когда-либо приходило.
  const fresh = incoming.filter((r) => r.status === 'sent' || r.status === 'delivered');
  const active = (bans ?? []).filter((b) => !b.removedAt);
  const lifted = (bans ?? []).filter((b) => b.removedAt);

  return (
    <section className="fed-links">
      <h3>Жалобы и запреты</h3>

      {fresh.length > 0 && (
        <div className="fed-report-banner">
          <Icon name="megaphone" size={16} />
          <span>
            {fresh.length === 1
              ? 'Новая жалоба от соседа на вашего человека — разберитесь, пожалуйста.'
              : `Новых жалоб от соседей: ${fresh.length}. Разберитесь, пожалуйста.`}
          </span>
        </div>
      )}

      {reports === null ? (
        <p className="muted">Загружаем…</p>
      ) : reports.length === 0 ? (
        <p className="muted">Жалоб нет — ни к вам, ни от вас.</p>
      ) : (
        <>
          {incoming.length > 0 && <div className="settings-group-label">На ваших людей</div>}
          {incoming.map((r) => (
            <article key={r.id} className="fed-report">
              <div className="fed-report-head">
                <strong>{r.reportedName ?? r.reportedUserId}</strong>
                <span className="muted">
                  {ACTION_TEXT[r.action] ?? r.action}
                  {r.serverName ? ` · «${r.serverName}»` : ''} · {when(r.createdAt)}
                </span>
              </div>
              {r.reason && <div className="fed-report-reason">{r.reason}</div>}
              {r.evidence.length > 0 && (
                <ul className="fed-report-ev">
                  {r.evidence.map((e, i) => (
                    <li key={i}>
                      <span className="muted">
                        {e.channel ? `#${e.channel} · ` : ''}
                        {when(new Date(e.at).toISOString())}
                      </span>
                      <span>{e.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {r.reply && <div className="fed-report-reply">Ваш ответ: {r.reply}</div>}
              {replyTo === r.id ? (
                <div className="fed-report-form">
                  <input
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Короткий ответ держателю"
                    maxLength={2000}
                    autoFocus
                  />
                  <button type="button" disabled={busy || !replyText.trim()} onClick={() => void sendReply(r.id)}>
                    Отправить
                  </button>
                  <button type="button" className="link" onClick={() => setReplyTo(null)}>
                    Отмена
                  </button>
                </div>
              ) : (
                <div className="fed-link-actions">
                  <button type="button" onClick={() => setReplyTo(r.id)}>
                    Ответить
                  </button>
                </div>
              )}
            </article>
          ))}

          {outgoing.length > 0 && <div className="settings-group-label">Отправленные вами</div>}
          {outgoing.map((r) => (
            <article key={r.id} className="fed-report out">
              <div className="fed-report-head">
                <strong>{r.reportedName ?? r.reportedUserId}</strong>
                <span className="muted">
                  {ACTION_TEXT[r.action] ?? r.action} · {when(r.createdAt)} · {STATUS_TEXT[r.status] ?? r.status}
                </span>
              </div>
              {r.reason && <div className="fed-report-reason">{r.reason}</div>}
              {/* Ответ держателя — то, ради чего жалобу и отправляли: без него она односторонняя. */}
              {r.reply && <div className="fed-report-reply">Ответ держателя: {r.reply}</div>}
            </article>
          ))}
        </>
      )}

      <div className="settings-group-label">Запреты на инстанс</div>
      {bans === null ? (
        <p className="muted">Загружаем…</p>
      ) : active.length === 0 ? (
        <p className="muted">Никому вход не закрыт.</p>
      ) : (
        <ul className="fed-ban-list">
          {active.map((b) => (
            <li key={`${b.instanceId}:${b.userId}`}>
              <span className="fed-ban-who">
                {b.displayName ?? b.userId}
                {b.username && <span className="muted"> @{b.username}</span>}
              </span>
              <span className="muted">
                {b.reason ? `${b.reason} · ` : ''}
                {b.expiresAt ? `до ${when(b.expiresAt)}` : 'навсегда'}
              </span>
              <button type="button" className="link" disabled={busy} onClick={() => void unban(b)}>
                Снять
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Снятые не прячем: это журнал, и «почему он снова здесь» обязано иметь ответ. */}
      {lifted.length > 0 && (
        <details className="fed-ban-lifted">
          <summary>Снятые запреты ({lifted.length})</summary>
          <ul className="fed-ban-list">
            {lifted.map((b) => (
              <li key={`${b.instanceId}:${b.userId}`}>
                <span className="fed-ban-who">{b.displayName ?? b.userId}</span>
                <span className="muted">снят {b.removedAt ? when(b.removedAt) : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
