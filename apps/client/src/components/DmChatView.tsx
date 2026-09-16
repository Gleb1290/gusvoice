import { useEffect, useState } from 'react';
import type { DmChannel, Message } from '@gusvoice/shared';
import { lastSeenAt, markChannelSeen } from '../channelPrefs';
import { api } from '../api';
import { sendTyping } from '../sockets';
import { useStore } from '../store';
import { toastError } from '../toast';
import { useTyping } from '../typing';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { MessagePane } from './MessagePane';

const EMPTY: Message[] = [];

export function DmChatView({ dm }: { dm: DmChannel }) {
  const messagesRaw = useStore((s) => s.dmMessages[dm.id]);
  const messages = messagesRaw ?? EMPTY;
  const user = useStore((s) => s.user);
  const appendDmMessage = useStore((s) => s.appendDmMessage);
  const updateDmMessage = useStore((s) => s.updateDmMessage);
  const removeDmMessage = useStore((s) => s.removeDmMessage);
  const pushMuted = useStore((s) => s.pushMutedDmUsers.includes(dm.otherUser.id));
  const setPushMuted = useStore((s) => s.setPushMuted);
  const typingUsers = useTyping(dm.id)
    .filter((uid) => uid === dm.otherUser.id)
    .map(() => ({ id: dm.otherUser.id, name: dm.otherUser.displayName }));

  // «Новые сообщения» divider (#15): freeze the last-visit mark on entry, and move it forward on the
  // way out — so the line stays where reading stopped instead of chasing incoming messages.
  const [newSince, setNewSince] = useState<number | null>(null);
  useEffect(() => {
    const id = dm.id;
    setNewSince(lastSeenAt(id));
    return () => markChannelSeen(id);
  }, [dm.id]);

  return (
    <MessagePane
      newSince={newSince}
      title={
        <span className="dm-title">
          <Avatar url={dm.otherUser.avatarUrl} name={dm.otherUser.displayName} size={24} fallback="icon" />
          {dm.otherUser.displayName}
        </span>
      }
      headerActions={
        <button
          type="button"
          className={`topbar-btn ${pushMuted ? 'active' : ''}`}
          title={pushMuted ? 'Пуши от него отключены — включить' : 'Отключить пуши от него'}
          onClick={() => setPushMuted('dm_user', dm.otherUser.id, !pushMuted).catch(toastError)}
        >
          <Icon name={pushMuted ? 'bell-off' : 'bell'} size={18} />
        </button>
      }
      placeholder={`Сообщение для ${dm.otherUser.displayName}`}
      messages={messages}
      loading={messagesRaw === undefined}
      typingUsers={typingUsers}
      onTyping={() => sendTyping({ dmId: dm.id, recipientId: dm.otherUser.id })}
      meId={user?.id}
      onSend={async (content, files, replyToId) => {
        const attachments = await Promise.all(files.map((f) => api.uploadDmAttachment(dm.id, f)));
        const msg = await api.sendDmMessage(dm.id, content, attachments, replyToId);
        appendDmMessage(dm.id, msg);
      }}
      onSendVoice={async (take) => {
        // ЛС голосовые умеют: это не серверная настройка, в отличие от стикеров и ников (#20).
        const att = await api.uploadDmAttachment(dm.id, take.file);
        const msg = await api.sendDmMessage(dm.id, '', [
          { ...att, waveform: take.waveform, durationMs: take.durationMs },
        ]);
        appendDmMessage(dm.id, msg);
      }}
      onEdit={async (m, content) => {
        const updated = await api.editDmMessage(dm.id, m.id, content);
        updateDmMessage(dm.id, updated);
      }}
      onDelete={async (m) => {
        await api.deleteDmMessage(dm.id, m.id);
        removeDmMessage(dm.id, m.id);
      }}
      onReact={(messageId, emoji, op) => {
        // Persist; the gateway echoes dm.reaction back to both participants → store update.
        api.reactDm(dm.id, messageId, emoji, op).catch(toastError);
      }}
    />
  );
}
