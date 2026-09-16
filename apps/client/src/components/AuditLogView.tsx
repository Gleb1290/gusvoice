import type { AuditLogEntry } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { describeAudit } from '../auditText';
import { relativeTime } from '../relativeTime';
import { Avatar } from './Avatar';



export function AuditLogView({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function load(before?: string) {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listAudit(serverId, before);
      setEntries((prev) => (before ? [...prev, ...page] : page));
      if (page.length < 50) setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [serverId]);

  return (
    <div className="audit-log">
      {error && <div className="error">{error}</div>}
      {entries.length === 0 && !loading && !error && <div className="muted center">Журнал пуст</div>}
      <ul className="audit-list">
        {entries.map((e) => (
          <li key={e.id} className="audit-row">
            <Avatar url={e.actor?.avatarUrl} name={e.actor?.displayName ?? '?'} size={28} />
            <div className="audit-body">
              <div className="audit-text">
                <strong>{e.actor?.displayName ?? 'неизвестный'}</strong> {describeAudit(e)}
              </div>
              <div className="audit-when">{relativeTime(e.createdAt, Date.now())}</div>
            </div>
          </li>
        ))}
      </ul>
      {!done && entries.length > 0 && (
        <button
          type="button"
          className="link"
          disabled={loading}
          onClick={() => load(entries[entries.length - 1]?.createdAt)}
        >
          {loading ? 'Загрузка…' : 'Ещё'}
        </button>
      )}
      {loading && entries.length === 0 && <div className="muted center">Загрузка…</div>}
    </div>
  );
}
