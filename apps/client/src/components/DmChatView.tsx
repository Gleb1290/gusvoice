import { useEffect, useState } from 'react';
import type { DmChannel, Message } from '@gusvoice/shared';
import { useChannelVisit } from '../channelVisit';
import { isMobile } from '../hotkeys';
import { api } from '../api';
import { confirmAction } from '../confirm';
import { sendTyping } from '../sockets';
import { useStore } from '../store';
import { toastError } from '../toast';
import { useTyping } from '../typing';
import { Avatar } from './Avatar';
import { FeedLoadError } from './FeedLoadError';
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
  const loadOlderDmMessages = useStore((s) => s.loadOlderDmMessages);
  const refreshDmHistory = useStore((s) => s.refreshDmHistory);
  const failed = useStore((s) => s.historyFailed.includes(dm.id));
  const blocked = useStore((s) => s.blockedUsers.some((u) => u.id === dm.otherUser.id));
  const setBlocked = useStore((s) => s.setBlocked);
  const other = {
    id: dm.otherUser.id,
    username: dm.otherUser.username,
    displayName: dm.otherUser.displayName,
    avatarUrl: dm.otherUser.avatarUrl,
  };
  /* Чёрный список (#212, «как в Telegram»): собеседник не узнает, его новые сообщения сюда не дойдут. */
  const switchBlock = async () => {
    if (!blocked) {
      const ok = await confirmAction({
        title: `Заблокировать ${dm.otherUser.displayName}?`,
        body: `${dm.otherUser.displayName} не узнает об этом. Новые сообщения и «печатает» из этой беседы до вас не дойдут — даже после разблокировки. Чтобы написать самим, разблокируйте.`,
        tone: 'danger',
        confirmLabel: 'Заблокировать',
      });
      if (!ok) return;
    }
    await setBlocked(other, !blocked).catch(toastError);
  };
  const typingUsers = useTyping(dm.id)
    .filter((uid) => uid === dm.otherUser.id)
    .map(() => ({ id: dm.otherUser.id, name: dm.otherUser.displayName }));

  /* Та же метка визита, что и в канале сервера (#15) — правила и телефонная ловушка описаны в
     `channelVisit.ts`. */
  const { newSince, visitKey } = useChannelVisit(dm.id, 'dm');

  return (
    <MessagePane
      newSince={newSince}
      scrollKey={visitKey}
      feedId={dm.id}
      title={
        <span className="dm-title">
          {/* На телефоне крупнее: шапка там 56 px с кнопками 48, и аватар 24 терялся между ними (#212). */}
          <Avatar
            url={dm.otherUser.avatarUrl}
            name={dm.otherUser.displayName}
            size={isMobile() ? 36 : 24}
            fallback="icon"
          />
          {dm.otherUser.displayName}
        </span>
      }
      headerActions={
        <>
          <button
            type="button"
            className={`topbar-btn ${pushMuted ? 'active' : ''}`}
            title={pushMuted ? 'Пуши от него отключены — включить' : 'Отключить пуши от него'}
            onClick={() => setPushMuted('dm_user', dm.otherUser.id, !pushMuted).catch(toastError)}
          >
            <Icon name={pushMuted ? 'bell-off' : 'bell'} size={18} />
          </button>
          <button
            type="button"
            className={`topbar-btn ${blocked ? 'active' : ''}`}
            title={blocked ? 'Разблокировать' : 'Заблокировать'}
            onClick={() => void switchBlock()}
          >
            <Icon name="ban" size={18} />
          </button>
        </>
      }
      composerReplacement={
        blocked ? (
          <div className="composer-blocked">
            <span className="muted">Вы заблокировали {dm.otherUser.displayName}.</span>
            <button type="button" className="link" onClick={() => void switchBlock()}>
              Разблокировать
            </button>
          </div>
        ) : undefined
      }
      placeholder={`Сообщение для ${dm.otherUser.displayName}`}
      messages={messages}
      loading={messagesRaw === undefined && !failed}
      emptyState={failed ? <FeedLoadError onRetry={() => void refreshDmHistory(dm.id)} /> : undefined}
      // История глубже одной порции (#212): сервер отдавал её с первого дня, лента не просила.
      onLoadOlder={() => loadOlderDmMessages(dm.id)}
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
      deletePeerName={dm.otherUser.displayName}
      onDelete={async (m, scope) => {
        await api.deleteDmMessage(dm.id, m.id, scope);
        // Строку ленты убираем сразу; время беседы и число поправит событие `dm.delete` следом.
        removeDmMessage(dm.id, m.id);
      }}
      onReact={(messageId, emoji, op) => {
        // Persist; the gateway echoes dm.reaction back to both participants → store update.
        api.reactDm(dm.id, messageId, emoji, op).catch(toastError);
      }}
    />
  );
}
