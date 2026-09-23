import type { FederationAuditRow } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toastError } from '../toast';

/**
 * Журнал федерации во вкладке «Федерация» (#139; аудит 19.09, F-25).
 *
 * До этого события связок, первый вход гостя и отказы гостевых сессий жили только в выводе процесса
 * бэкенда — и терялись при пересоздании контейнера. Держатель, разбирая «что случилось со связкой»,
 * оставался без следа. Теперь бэкенд пишет их в `federation_audit`, а здесь они читаются словами.
 *
 * ⚠️ Только чтение: журнал — след, править его нельзя и незачем.
 */

const EVENT_TEXT: Record<string, string> = {
  'federation.code_issued': 'выдан код связки',
  'federation.link_requested': 'отправлена заявка',
  'federation.link_request_received': 'пришла заявка',
  'federation.link_request_rejected': 'сосед отклонил заявку',
  'federation.link_confirmed': 'связка подтверждена вами',
  'federation.link_active': 'сосед подтвердил связку',
  'federation.link_pause': 'связка поставлена на паузу',
  'federation.link_resume': 'пауза снята',
  'federation.link_block': 'связка разорвана',
  'federation.link_rebound': 'связка перепривязана',
  'federation.rebind_rejected': 'сосед отклонил перепривязку',
  'federation.link_domain_unproven': 'домен соседа не подтверждён',
  'federation.link_confirm_refused': 'подтверждение отклонено',
  'federation.link_confirm_resent': 'подтверждение дослано соседу',
  'federation.trust_lost': 'доверие потеряно',
  'federation.guest_first_login': 'первый вход гостя',
  'federation.guest_session_refused': 'гостю отказано во входе',
};

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Подробности одной строкой: только простые значения, без вложенных объектов. */
function detailText(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([k, v]) => k !== 'instanceId' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
}

const PAGE = 50;

export function FederationAudit() {
  const [rows, setRows] = useState<FederationAuditRow[] | null>(null);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    api
      .federationAudit()
      .then((r) => alive && setRows(r.entries))
      .catch((e) => alive && toastError(e));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="fed-links">
      <h3>Журнал</h3>
      {rows === null ? (
        <p className="muted">Загружаем…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Пока ничего не происходило.</p>
      ) : (
        <>
          <ul className="fed-report-ev">
            {rows.slice(0, shown).map((r) => (
              <li key={r.id}>
                <span className="muted">
                  {when(r.at)}
                  {r.instanceId ? ` · ${r.instanceId.slice(0, 8)}…` : ''}
                </span>
                <span>
                  {EVENT_TEXT[r.event] ?? r.event}
                  {detailText(r.detail) ? ` — ${detailText(r.detail)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {rows.length > shown && (
            <div className="fed-link-actions">
              <button type="button" className="link" onClick={() => setShown((n) => n + PAGE)}>
                Показать ещё
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
