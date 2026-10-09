import type { DmReportRow } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { adminApi } from '../adminApi';
import { reportReasonTitle } from '../strangerBarRules';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/**
 * Жалобы из ЛС во вкладке «Жалобы» админки (08.10, #211, С7, Р-10, признак `stranger1`): человек нажал «Пожаловаться» на плашке
 * незнакомца. Видит их только держатель инстанса (супер-админ). Жалоба — причина, комментарий и снимок до пяти последних
 * сообщений собеседника; переписки целиком у держателя нет. Разметка — те же карточки `.fed-report`, что у жалоб федерации.
 */
function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function DmReports() {
  const [rows, setRows] = useState<DmReportRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setRows((await adminApi().dmReports()).reports);
    } catch (e) {
      toastError(e);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function close(id: string) {
    setBusy(true);
    try {
      await adminApi().closeDmReport(id);
      toast('success', 'Жалоба закрыта');
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const fresh = (rows ?? []).filter((r) => r.status === 'new');
  return (
    <section className="fed-links">
      <h3>Жалобы из личных сообщений</h3>
      {fresh.length > 0 && (
        <div className="fed-report-banner">
          <Icon name="megaphone" size={16} />
          <span>{fresh.length === 1 ? 'Новая жалоба — разберитесь, пожалуйста.' : `Новых жалоб: ${fresh.length}. Разберитесь, пожалуйста.`}</span>
        </div>
      )}
      {rows === null ? (
        <p className="muted">Загружаем…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Жалоб из личных сообщений нет.</p>
      ) : (
        rows.map((r) => (
          <article key={r.id} className={`fed-report${r.status === 'closed' ? ' out' : ''}`}>
            <div className="fed-report-head">
              <strong>
                {r.reported.displayName} <span className="muted">@{r.reported.username}</span>
              </strong>
              <span className="muted">
                {reportReasonTitle(r.reason)} · от {r.reporter.displayName} (@{r.reporter.username}) · {when(r.createdAt)}
                {r.status === 'closed' ? ' · закрыта' : ''}
              </span>
            </div>
            {r.comment && <div className="fed-report-reason">{r.comment}</div>}
            {r.evidence.length > 0 && (
              <ul className="fed-report-ev">
                {r.evidence.map((e) => (
                  <li key={e.messageId}>
                    <span className="muted">{when(new Date(e.at).toISOString())}</span>
                    <span>{e.text}</span>
                  </li>
                ))}
              </ul>
            )}
            {r.status === 'new' && (
              <div className="fed-link-actions">
                <button type="button" disabled={busy} onClick={() => void close(r.id)}>
                  Закрыть
                </button>
              </div>
            )}
          </article>
        ))
      )}
    </section>
  );
}
