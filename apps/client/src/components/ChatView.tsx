import { type Channel, canMentionEveryone, canMentionRole, has, type Message, Permission, permsFromString, type Role } from '@gusvoice/shared';
import { useChannelVisit } from '../channelVisit';
import { useMemo, useEffect, useState } from 'react';
import { api } from '../api';
import { hasMoreOlder, olderCursor } from '../historyPage';
import { setUploadDone, setUploadProgress, uploadAborted, uploadSignal } from '../uploadProgress';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { isMobile } from '../hotkeys';
import { sendTyping } from '../sockets';
import { useTyping } from '../typing';
import { useNameResolver } from '../memberName';
import { useEmojiById, useEmojiResolver, useServerEmojis } from '../serverEmoji';
import { useStickerPacks } from '../serverStickers';
import { FeedLoadError } from './FeedLoadError';
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
  const loadOlderMessages = useStore((s) => s.loadOlderMessages);
  const openChannel = useStore((s) => s.openChannel);
  const failed = useStore((s) => s.historyFailed.includes(channel.id));
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
  const permsBits = useMemo(() => permsFromString(perms), [perms]);
  const canModerate = has(permsBits, Permission.MANAGE_MESSAGES);

  const nameOf = useNameResolver();
  // Эмодзи и ники — обе настройки СЕРВЕРНЫЕ, поэтому передаются только отсюда, не из ЛС (#18/#73).
  const onEmoji = useEmojiResolver();
  const customEmojis = useServerEmojis();
  const emojiById = useEmojiById();
  const stickerPacks = useStickerPacks();
  const typingIds = useTyping(channel.id);
  /* Черновик канала (06.10, сверка с Telegram): лента пересоздаётся при смене канала (`key` в `MainLayout`), и набранное
     терялось. Читается ОДИН раз при создании ленты (подписка на него перерисовывала бы канал на каждую букву); пишет его сама
     лента — с задержкой и сразу при размонтировании. Только в памяти (`store.channelDrafts`): у каналов нет серверных черновиков. */
  const [initialDraft] = useState(() => useStore.getState().channelDrafts[channel.id]);
  const typingUsers = typingIds
    .filter((uid) => uid !== user?.id)
    .map((uid) => {
      const m = members.find((x) => x.user.id === uid);
      return { id: uid, name: m ? nameOf(uid, m.user.displayName) : 'кто-то' };
    });

  /* Поставивший реакцию (G75, #211): аватарки на чипах и окно «кто поставил» в канале — имя (ник на сервере, если есть) и аватар
     из участников сервера. Не участник (вышел) — `null`: чип тогда с числом. Ссылка новая, когда меняется состав участников. */
  const reactorOf = useMemo(() => {
    const byId = new Map(members.map((x) => [x.user.id, x]));
    return (id: string) => {
      const x = byId.get(id);
      return x ? { name: x.nickname ?? x.user.displayName, avatarUrl: x.user.avatarUrl ?? null } : null;
    };
  }, [members]);

  const autocomplete = useMemo(
    () => ({
      users: members.map((m) => ({
        id: m.user.id,
        /**
         * 🔴 Гостя вставляем как `ник@домен` (#139, F4, §5.5): без домена обращение уйдёт местному
         * тёзке, а к гостю не попадёт вовсе. Человек домен не печатает — его подставляет подсказка.
         */
        username: m.user.homeInstance?.domain ? `${m.user.username}@${m.user.homeInstance.domain}` : m.user.username,
        displayName: m.nickname ?? m.user.displayName,
        avatarUrl: m.user.avatarUrl,
        online: onlineUsers.includes(m.user.id),
      })),
      // Роль в подсказке — только та, что автор вправе позвать (#76): «можно упоминать» либо у него право `MENTION_EVERYONE`
      // (`canMentionRole`, то же правило проверяет сервер при отправке).
      roles: roles
        .filter((r) => !r.isEveryone && canMentionRole(r, permsBits))
        .map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
      channels: channels.filter((c) => c.type === 'text').map((c) => ({ id: c.id, name: c.name })),
    }),
    [members, onlineUsers, roles, channels, permsBits],
  );
  // `@everyone`/`@here` в подсказке — только с правом «Упоминать @everyone, @here и все роли» (#76); без него сервер текст
  // оставит, но никого не позовёт, так что и предлагать нечего. Отдельно от `autocomplete`: ссылка меняется лишь со сменой права.
  const noBroadcast = !canMentionEveryone(permsBits);
  const autocompleteWithRights = useMemo(() => ({ ...autocomplete, noBroadcast }), [autocomplete, noBroadcast]);

  /* «Новые сообщения» divider (#15): метка визита замирает на входе и двигается вперёд на выходе —
     черта стоит там, где человек перестал читать, а не убегает за новыми сообщениями. Что считать
     входом и выходом на телефоне (там лента не размонтируется) — в `channelVisit.ts`. */
  const { newSince, visitKey } = useChannelVisit(channel.id, 'channel');

  /**
   * На телефоне имя канала в подсказке обрезалось на полуслове, а канал и так написан в шапке прямо
   * над лентой. ⚠️ И сама подпись КОРОТКАЯ: замер на живом устройстве (411 px) дал полю ровно 128 px —
   * остальное съели четыре кнопки и отправка. «Написать сообщение» в них не влезало и обрывалось
   * многоточием, а обрезанная подсказка читается хуже короткой.
   */
  const placeholder = isMobile() ? 'Сообщение' : `Написать в #${channel.name}`;

  return (
    <MessagePane
      reactorOf={reactorOf}
      serverId={serverId}
      newSince={newSince}
      scrollKey={visitKey}
      feedId={channel.id}
      // Медиатека канала для просмотра (G11): порции старше окна ленты; лента канала всегда у хвоста — новее нечего.
      loadMediaPage={async (dir, edge) => {
        const cursor = dir < 0 ? olderCursor([edge]) : null;
        if (!cursor) return { messages: [], more: false };
        const page = await api.listMessages(channel.id, cursor);
        return { messages: page, more: hasMoreOlder(page) };
      }}
      onLoadOlder={() => loadOlderMessages(channel.id)}
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
      placeholder={placeholder}
      messages={messages}
      loading={messagesRaw === undefined && !failed}
      // Сбой при пустом кеше — ошибка с повтором, а не вечные скелетоны (#212, Б5).
      emptyState={failed ? <FeedLoadError onRetry={() => void openChannel(channel.id)} /> : undefined}
      autocomplete={autocompleteWithRights}
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
      draft={initialDraft}
      onDraftChange={(text, replyToId) => useStore.getState().setChannelDraft(channel.id, text, replyToId)}
      typingUsers={typingUsers}
      // Каналы серверов показывают только «печатает» (G21 — виды действия у ЛС): запись и загрузку не рассылаем.
      onTyping={(action) => {
        if (!action || action === 'typing') sendTyping({ serverId: channel.serverId, channelId: channel.id });
      }}
      meId={user?.id}
      onSend={async (content, files, replyToId, sendKey) => {
        const signal = uploadSignal(sendKey);
        // Прогресс файлов — кольцам строки «в пути», отмена — обрыв загрузки (07.10, `uploadProgress`).
        const attachments = await Promise.all(
          files.map((f, i) =>
            api
              .uploadAttachment(channel.id, f, {
                signal,
                onProgress: (loaded, total) => setUploadProgress(sendKey, i, loaded, total),
              })
              .then((a) => {
                setUploadDone(sendKey, i);
                return a;
              }),
          ),
        );
        if (signal?.aborted) throw uploadAborted();
        const msg = await api.sendMessage(channel.id, content, attachments, replyToId);
        // «Отменить отправку», пока летел сам запрос: сообщение уже есть — убрать, как просили.
        if (signal?.aborted) {
          await api.deleteMessage(channel.id, msg.id).catch(() => appendMessage(channel.id, msg));
          throw uploadAborted();
        }
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
