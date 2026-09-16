import type { Category } from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Icon } from './Icon';

export function CreateChannelModal({
  serverId,
  categories,
  onClose,
  defaultCategoryId,
}: {
  serverId: string;
  categories: Category[];
  onClose: () => void;
  /** Preselect a category (e.g. "Создать канал" from a category's context menu). */
  defaultCategoryId?: string | null;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [categoryId, setCategoryId] = useState(defaultCategoryId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.createChannel(serverId, trimmed, type, categoryId || null);
      await useStore.getState().openServer(serverId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal create-channel" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="admin-head">
          <h2>Новый канал</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="type-picker">
          <button type="button" className={type === 'text' ? 'active' : ''} onClick={() => setType('text')}>
            <span className="tp-title">
              <Icon name="hash" size={16} /> Текстовый
            </span>
            <span className="muted">сообщения</span>
          </button>
          <button type="button" className={type === 'voice' ? 'active' : ''} onClick={() => setType('voice')}>
            <span className="tp-title">
              <Icon name="volume" size={16} /> Голосовой
            </span>
            <span className="muted">голос + демонстрация экрана</span>
          </button>
        </div>

        <label className="field">
          Название канала
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'voice' ? 'General' : 'general'}
            autoFocus
          />
        </label>

        {categories.length > 0 && (
          <label className="field">
            Категория
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">— без категории —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? '…' : 'Создать канал'}
          </button>
        </div>
      </form>
    </div>
  );
}
