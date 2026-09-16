import type { BanInfo } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toastError } from '../toast';
import { Avatar } from './Avatar';

/** Server settings → Баны: list of banned users (search by name/reason) with «Разбанить». */
export function BansPanel({ serverId }: { serverId: string }) {
  const [bans, setBans] = useState<BanInfo[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listBans(serverId)
      .then((b) => !cancelled && setBans(b))
      .catch((e) => {
        if (!cancelled) setBans([]);
        toastError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  async function unban(userId: string) {
    setBusy(userId);
    try {
      await api.unbanMember(serverId, userId);
      setBans((bs) => (bs ?? []).filter((b) => b.user.id !== userId));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  const ql = q.trim().toLowerCase();
  const filtered = (bans ?? []).filter(
    (b) =>
      !ql ||
      b.user.displayName.toLowerCase().includes(ql) ||
      b.user.username.toLowerCase().includes(ql) ||
      (b.reason ?? '').toLowerCase().includes(ql),
  );
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="bans-panel">
      <input className="bans-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по имени или причине" />
      {bans === null ? (
        <div className="muted" style={{ padding: 12 }}>
          Загрузка…
        </div>
      ) : filtered.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          {bans.length === 0 ? 'Банов пока нет.' : 'Ничего не найдено.'}
        </div>
      ) : (
        <ul className="bans-list">
          {filtered.map((b) => (
            <li key={b.user.id} className="ban-row">
              <Avatar url={b.user.avatarUrl} name={b.user.displayName} size={32} fallback="icon" />
              <div className="ban-meta">
                <div className="ban-name">
                  {b.user.displayName} <span className="ban-handle">@{b.user.username}</span>
                </div>
                <div className="ban-sub">
                  {b.reason ? b.reason : 'без причины'} · {fmtDate(b.createdAt)}
                </div>
              </div>
              <button type="button" className="ban-unban" onClick={() => void unban(b.user.id)} disabled={busy === b.user.id}>
                Разбанить
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
