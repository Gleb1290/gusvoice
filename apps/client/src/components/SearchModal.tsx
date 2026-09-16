import type { Message } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useNameResolver } from '../memberName';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="search-hit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function SearchModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const bootstrap = useStore((s) => s.bootstrap);
  const openChannel = useStore((s) => s.openChannel);
  const nameOf = useNameResolver();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const channelName = (id: string) => bootstrap?.channels.find((c) => c.id === id)?.name ?? 'канал';

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        setResults(await api.searchMessages(serverId, query));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, serverId]);

  function go(m: Message) {
    void openChannel(m.channelId);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-bar">
          <Icon name="search" size={18} />
          <input
            autoFocus
            value={q}
            placeholder="Поиск по сообщениям сервера…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="search-results">
          {error && <div className="error">{error}</div>}
          {loading && <div className="muted center">Ищу…</div>}
          {!loading && results && results.length === 0 && <div className="muted center">Ничего не найдено</div>}
          {!loading && results === null && q.trim().length < 2 && (
            <div className="muted center">Введите минимум 2 символа</div>
          )}
          {results?.map((m) => (
            <button type="button" className="search-row" key={m.id} onClick={() => go(m)}>
              <Avatar url={m.author.avatarUrl} name={nameOf(m.author.id, m.author.displayName)} size={32} />
              <div className="search-body">
                <div className="search-meta">
                  <strong>{nameOf(m.author.id, m.author.displayName)}</strong>
                  <span className="muted">
                    #{channelName(m.channelId)} · {new Date(m.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short' })}
                  </span>
                </div>
                <div className="search-text">{highlight(m.content, q.trim())}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
