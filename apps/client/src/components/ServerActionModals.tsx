import type { Invite } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/** Create a new server (gated to super-admin / can_create_servers). */
export function CreateServerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (serverId: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api.createServer(name.trim());
      onCreated(b.server.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal create-channel" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="admin-head">
          <h2>Новый сервер</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="field">
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Мой сервер" maxLength={80} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? '…' : 'Создать'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Join a server by entering an invite code. */
export function JoinServerModal({ onClose, onJoined }: { onClose: () => void; onJoined: (serverId: string) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api.acceptInvite(c);
      onJoined(b.server.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal create-channel" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="admin-head">
          <h2>Войти по приглашению</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="field">
          Код приглашения
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            placeholder="например, aB3xK9mz"
            spellCheck={false}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={busy || !code.trim()}>
            {busy ? '…' : 'Войти'}
          </button>
        </div>
      </form>
    </div>
  );
}

const INVITE_EXPIRY: { label: string; value: number | null }[] = [
  { label: '30 мин', value: 30 },
  { label: '1 час', value: 60 },
  { label: '1 день', value: 1440 },
  { label: '7 дней', value: 10080 },
  { label: 'Никогда', value: null },
];
const INVITE_USES: { label: string; value: number | null }[] = [
  { label: '1', value: 1 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '∞', value: null },
];

/** Create + manage invites: pick expiry/max-uses, generate a code, and list/revoke active invites. */
export function InviteCodeModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [list, setList] = useState<Invite[]>([]);
  const [expiry, setExpiry] = useState<number | null>(1440);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listInvites(serverId)
      .then((r) => !cancelled && setList(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  async function create() {
    setBusy(true);
    try {
      const inv = await api.createInvite(serverId, { expiresInMinutes: expiry, maxUses });
      setList((l) => [inv, ...l.filter((i) => i.code !== inv.code)]);
      await copy(inv.code);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    try {
      await api.deleteInvite(code);
      setList((l) => l.filter((i) => i.code !== code));
    } catch (e) {
      toastError(e);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      toast('info', 'Код приглашения скопирован');
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 1600);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  }

  const fmtExpiry = (iso: string | null) =>
    iso ? `до ${new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'бессрочно';

  const Seg = ({ value, onChange, opts }: { value: number | null; onChange: (v: number | null) => void; opts: { label: string; value: number | null }[] }) => (
    <div className="seg">
      {opts.map((o) => (
        <button key={o.label} type="button" className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal create-channel" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>Пригласить на сервер</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <label className="settings-row col">
          <span>Срок действия</span>
          <Seg value={expiry} onChange={setExpiry} opts={INVITE_EXPIRY} />
        </label>
        <label className="settings-row col">
          <span>Макс. использований</span>
          <Seg value={maxUses} onChange={setMaxUses} opts={INVITE_USES} />
        </label>
        <button type="button" onClick={() => void create()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? '…' : 'Создать приглашение'}
        </button>

        {list.length > 0 && (
          <>
            <div className="settings-group-label">Активные приглашения</div>
            <ul className="invite-list">
              {list.map((i) => (
                <li key={i.code} className="invite-row">
                  <div className="invite-row-meta">
                    <span className="invite-row-code">{i.code}</span>
                    <span className="invite-row-sub">
                      {fmtExpiry(i.expiresAt)} · {i.uses}/{i.maxUses ?? '∞'}
                    </span>
                  </div>
                  <button type="button" className="invite-copy" title="Скопировать" onClick={() => void copy(i.code)}>
                    <Icon name={copied === i.code ? 'check' : 'copy'} size={16} />
                  </button>
                  <button type="button" className="invite-revoke" onClick={() => void revoke(i.code)}>
                    Отозвать
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
