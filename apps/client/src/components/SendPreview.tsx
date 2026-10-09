import { renderMessageText, type EmojiResolver } from '../messageText';
import type { CSSProperties } from 'react';
import { albumClass, albumStyleOf, bubbleLook, emojiOnlyCount, replyQuoteLook } from '../bubbleRules';
import type { Message } from '@gusvoice/shared';
import { MessageBubble, ReplyQuote } from './MessageBubble';
import { localAttachments, OutgoingAttachments } from './OutgoingAttachments';
import { ATT_IMG_MAX_H, ATT_IMG_MAX_W } from './AttachmentView';

const NOOP = () => {};

/**
 * G47: предпросмотр будущего пузыря над меню кнопки «Отправить» (телефон; Telegram Android `MessageSendPreview`,
 * `ChatActivityEnterView.java` — удержание кнопки: над затемнением стоит пузырь с тем, что уйдёт, и меню под ним).
 * Пузырь — тот же `MessageBubble`, что у ленты: текст с форматированием (`renderMessageText`), цитата ответа
 * (`ReplyQuote`), вложения миниатюрами (`OutgoingAttachments` без колец загрузки). Времени у предпросмотра нет
 * (у Telegram `notime`). Не кнопка и не цель касания: `pointer-events: none` в стилях — тап по нему идёт «мимо меню».
 * Кладётся в слот `reactions` у `ContextMenu` (над карточкой, прижат к правому краю).
 */
export function SendPreview({
  text,
  replyTo,
  replyName,
  files,
  onEmoji,
}: {
  text: string;
  replyTo: Message | null;
  /** Имя автора ответа так, как показано в полосе ответа над полем. */
  replyName: string;
  files: readonly File[];
  onEmoji?: EmojiResolver;
}) {
  const content = text.trim();
  const local = files.length > 0 ? localAttachments(files) : null;
  const look = local
    ? bubbleLook(
        { content, attachments: local, replyTo: null, poll: null, sticker: null, forwardedFrom: null } as Pick<
          Message,
          'content' | 'attachments' | 'replyTo' | 'poll' | 'sticker' | 'forwardedFrom'
        >,
        ATT_IMG_MAX_W,
        ATT_IMG_MAX_H,
      )
    : null;
  const media = look?.kind === 'media';
  const jumbo = !files.length && content ? emojiOnlyCount(content) : 0;
  const quote = replyTo ? replyQuoteLook({ content: replyTo.content, deleted: false }, replyTo) : null;
  return (
    <div className="send-preview" aria-hidden="true" data-testid="send-preview">
      <MessageBubble
        side="out"
        tail
        kind={media ? 'media' : jumbo ? 'emoji' : 'text'}
        jumbo={jumbo}
        mediaWidth={media ? look?.mediaWidth : undefined}
        className="outgoing"
      >
        {replyTo && quote && <ReplyQuote author={replyName} text={quote.text} kind={quote.kind} thumb={quote.thumb} />}
        {local && (
          <div
            className={look?.album ? albumClass(look.album) : 'attachments'}
            style={look?.album && local ? (albumStyleOf(local, ATT_IMG_MAX_W, ATT_IMG_MAX_H) as CSSProperties | undefined) : undefined}
          >
            <OutgoingAttachments rowKey="send-preview" files={files} sending={false} fill={!!look?.album} onCancel={NOOP} />
          </div>
        )}
        {content && (
          <div className="message-body">
            {renderMessageText(content, (url, key) => <span key={key}>{url}</span>, onEmoji)}
          </div>
        )}
      </MessageBubble>
    </div>
  );
}
