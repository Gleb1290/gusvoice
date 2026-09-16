import { type Channel, has, type Message, Permission, permsFromString, type Role } from '@gusvoice/shared';
import { lastSeenAt, markChannelSeen } from '../channelPrefs';
import { useMemo, useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { sendTyping } from '../sockets';
import { useTyping } from '../typing';
import { useNameResolver } from '../memberName';
import { useEmojiById, useEmojiResolver, useServerEmojis } from '../serverEmoji';
import { useStickerPacks } from '../serverStickers';
import { ChannelGlyph } from './Icon';
import { MessagePane } from './MessagePane';
import { PinnedMessages } from './PinnedMessages';

const EMPTY: Message[] = [];
const EMPTY_ROLES: Role[] = [];
const EMPTY_CH: Channel[] = [];

export function ChatView({ channel }: { channel: Channel }) {
  const messagesRaw = useStore((s) => s.messagesByChannel[channel.id]);
  const messages = messagesRaw ?? EMPTY;
  const user = useStore((s) => s.user);
  const perms = useStore((s) => s.bootstrap?.permissions);
  // Нужен ТОЛЬКО ради короны в шапке блока сообщений — см. проп в MessagePane.
  const serverId = useStore((s) => s.bootstrap?.server.id);
  const members = useStore((s) => s.members);
  const onlineUsers = useStore((s) => s.onlineUsers);
  const roles = useStore((s) => s.bootstrap?.roles ?? EMPTY_ROLES);
  const channels = useStore((s) => s.bootstrap?.channels ?? EMPTY_CH);
  const appendMessage = useStore((s) => s.appendMessage);
  const updateMessage = useStore((s) => s.updateMessage);
  const removeMessage = useStore((s) => s.removeMessage);
  const canModerate = has(permsFromString(perms), Permission.MANAGE_MESSAGES);

  const nameOf = useNameResolver();
  // Эмодзи и ники — обе настройки СЕРВЕРНЫЕ, поэтому передаются только отсюда, не из ЛС (#18/#73).
  const onEmoji = useEmojiResolver();
  const customEmojis = useServerEmojis();
  const emojiById = useEmojiById();
  const stickerPacks = useStickerPacks();
  const typingIds = useTyping(channel.id);
  const typingUsers = typingIds
    .filter((uid) => uid !== user?.id)
    .map((uid) => {
      const m = members.find((x) => x.user.id === uid);
      return { id: uid, name: m ? nameOf(uid, m.user.displayName) : 'кто-то' };
    });

  const autocomplete = useMemo(
    () => ({
      users: members.map((m) => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.nickname ?? m.user.displayName,
        avatarUrl: m.user.avatarUrl,
        online: onlineUsers.includes(m.user.id),
      })),
      roles: roles
        .filter((r) => !r.isEveryone && r.mentionable)
        .map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
      channels: channels.filter((c) => c.type === 'text').map((c) => ({ id: c.id, name: c.name })),
    }),
    [members, onlineUsers, roles, channels],
  );

  // «Новые сообщения» divider (#15): freeze the last-visit mark on entry, and move it forward on the
  // way out — so the line stays where reading stopped instead of chasing incoming messages.
  const [newSince, setNewSince] = useState<number | null>(null);
  useEffect(() => {
    const id = channel.id;
    setNewSince(lastSeenAt(id));
    return () => markChannelSeen(id);
  }, [channel.id]);

  return (
    <MessagePane
      serverId={serverId}
      newSince={newSince}
      pollChannelId={channel.id}
      title={
        <>
          <span className="topbar-title">
            <ChannelGlyph c={channel} size={18} />
            <strong>{channel.name}</strong>
            {channel.topic ? <span className="muted topbar-topic">{channel.topic}</span> : null}
          </span>
          <PinnedMessages channelId={channel.id} canManage={canModerate} />
        </>
      }
      placeholder={`Message #${channel.name}`}
      messages={messages}
      loading={messagesRaw === undefined}
      autocomplete={autocomplete}
      // Ники действуют в пределах сервера — поэтому резолвер передаёт КАНАЛ, а ЛС не передают (#73).
      nameOf={nameOf}
      onEmoji={onEmoji}
      customEmojis={customEmojis}
      emojiById={emojiById}
      stickerPacks={stickerPacks}
      onSendSticker={async (stickerId) => {
        const msg = await api.sendMessage(channel.id, '', [], null, stickerId);
        appendMessage(channel.id, msg);
      }}
      onSendVoice={async (take) => {
        // Огибающая и длительность считаются при записи и приклеиваются к вложению — сервер их
        // только валидирует и хранит (#20).
        const att = await api.uploadAttachment(channel.id, take.file);
        const msg = await api.sendMessage(channel.id, '', [
          { ...att, waveform: take.waveform, durationMs: take.durationMs },
        ]);
        appendMessage(channel.id, msg);
      }}
      typingUsers={typingUsers}
      onTyping={() => sendTyping({ serverId: channel.serverId, channelId: channel.id })}
      meId={user?.id}
      onSend={async (content, files, replyToId) => {
        const attachments = await Promise.all(files.map((f) => api.uploadAttachment(channel.id, f)));
        const msg = await api.sendMessage(channel.id, content, attachments, replyToId);
        appendMessage(channel.id, msg);
      }}
      onEdit={async (m, content) => {
        const updated = await api.editMessage(channel.id, m.id, content);
        updateMessage(channel.id, updated);
      }}
      onDelete={async (m) => {
        await api.deleteMessage(channel.id, m.id);
        removeMessage(channel.id, m.id);
      }}
      onReact={(messageId, emoji, op) => {
        // Persist; the gateway echoes message.reaction back to us, which updates the store.
        api.react(channel.id, messageId, emoji, op).catch(toastError);
      }}
      canModerate={canModerate}
      onPin={
        canModerate
          ? (m, pinned) => {
              (pinned ? api.pinMessage(channel.id, m.id) : api.unpinMessage(channel.id, m.id)).catch(toastError);
            }
          : undefined
      }
      onCopyLink={(m) => {
        const base = typeof location !== 'undefined' ? location.origin : '';
        navigator.clipboard
          ?.writeText(`${base}/channels/${channel.serverId}/${channel.id}/${m.id}`)
          .then(() => toast('success', 'Ссылка скопирована'))
          .catch(() => toast('error', 'Не удалось скопировать'));
      }}
    />
  );
}
