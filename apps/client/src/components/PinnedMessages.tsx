import type { Message } from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { useNameResolver } from '../memberName';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/**
 * Channel-header pinned-messages popover (round-7 P4). Fetches the channel's pins on open;
 * a manager (MANAGE_MESSAGES) can unpin from here. Live message.update events keep the chat
 * in sync separately — this list is fetched fresh each time it opens.
 */
export function PinnedMessages({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const nameOf = useNameResolver();
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<Message[] | null>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setPins(null);
    api
      .listPins(channelId)
      .then(setPins)
      .catch((e) => {
        toastError(e);
        setOpen(false);
      });
  }

  async function unpin(m: Message) {
    try {
      await api.unpinMessage(channelId, m.id);
      setPins((cur) => (cur ?? []).filter((x) => x.id !== m.id));
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="pins">
      <button type="button" className="pins-btn" title="Закреплённые сообщения" onClick={toggle}>
        <Icon name="pin" size={18} />
      </button>
      {open && (
        <>
          <div className="pins-backdrop" onClick={() => setOpen(false)} />
          <div className="pins-pop">
            <div className="pins-head">
              <Icon name="pin" size={18} className="pins-head-icon" />
              <span className="pins-title">Закреплённые</span>
              <span className="pins-count">{pins?.length ?? '…'}</span>
            </div>
            <div className="pins-body">
              {pins == null ? (
                <div className="pins-empty muted">Загрузка…</div>
              ) : pins.length === 0 ? (
                <div className="pins-empty muted">Пока ничего не закреплено</div>
              ) : (
                pins.map((m) => (
                  <div className="pin-item" key={m.id}>
                    <Avatar url={m.author.avatarUrl} name={nameOf(m.author.id, m.author.displayName)} size={34} />
                    <div className="pin-main">
                      <div className="pin-head">
                        <span className="pin-author">{nameOf(m.author.id, m.author.displayName)}</span>
                        <span className="pin-when">{m.pinnedAt ? when(m.pinnedAt) : ''}</span>
                      </div>
                      <div className="pin-text">{m.content || (m.attachments.length ? 'вложение' : '')}</div>
                    </div>
                    {canManage && (
                      <button type="button" className="pin-unpin" title="Открепить" onClick={() => void unpin(m)}>
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
