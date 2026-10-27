import { RecordCircle } from './RecordBlob';
import { MessageKeyboard, linkBotCommands } from './MessageKeyboard';
import { refreshBotCommands, refreshChannelBots, useBotCommands, useChannelBots } from '../botCommands';
import {
  botCommandFromMessage,
  channelCommandInsert,
  channelCommandList,
  filterBotCommands,
  filterChannelCommands,
  onlyCommandInField,
} from '../botKeyboardRules';
import {
  BROADCAST_MENTIONS,
  customReactionId,
  customReactionKey,
  formatDuration,
  VOICE_MAX_MS,
  ROUND_MAX_MS,
  type Attachment,
  type ConvPin,
  type ConvReader,
  type InlineKeyboard,
  type Message,
  type MessageReplyPreview,
  type ReactionGroup,
  type ServerEmoji,
  type Sticker,
  type StickerPack,
  type TypingAction,
  typingActionRank,
  uploadTypingAction,
  callServiceMark,
  callServiceTitle,
  REPLY_QUOTE_MAX,
  ALBUM_ITEM_PEER_OLD_ERROR,
} from '@gusvoice/shared';
import type { CSSProperties, ReactNode } from 'react';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSelBarFit } from '../useSelBarFit';
import { api } from '../api';
import { callRecordStatus } from '../callView';
import { isDesktop, isMobile, isTauri } from '../hotkeys';
import { attachFeedPinch } from '../feedPinch';
import { useStore, type FwdDraft } from '../store';
import { fwdSenders } from '../fwdDraftRules';
import { useDmStickers } from '../dmStickers';
import { serverDmStickers } from '../dmStickerRules';
import { exactEmojiEntries, primaryCode, searchEmoji } from '../emojiShortcodes';
import { emojiSuggestEnabled } from '../emojiSuggest';
import { hoverPanelsAvailable, useHoverPanel } from '../hoverPanel';
import { useExprDock } from '../exprDock';
import {
  acExactAt,
  acTokenAt,
  commandTokenAt,
  applyAc,
  dayLabel,
  DOUBLE_TAP_MS,
  doubleTapStep,
  emojiSubstitution,
  messageChipFaces,
  sortReactionChips,
  createDraftSaver,
  draftToSave,
  editDecision,
  enterBreaksLine,
  enterSends,
  fieldEscape,
  insertAtCaret,
  isFirstUnread,
  isGrouped,
  isNewDay,
  pickedText,
  pressByTouch,
  quickReactOp,
  sentAtLabel,
  menuFootLines,
  timeTooltip,
  bubbleTimeLabel,
  viaCaption,
  copyMediaLabel,
  swipeArmed,
  swipeFromEdge,
  swipeIntent,
  swipeOffset,
  swipeProgress,
  SWIPE_TOUCH,
  SWIPE_WHEEL,
  wheelBurstIntent,
  wheelDecayRun,
  wheelReleased,
  wheelSwipePull,
  WHEEL_SWIPE_IDLE_MS,
  type AcToken,
  type ListMessage,
  type PendingTap,
  type SwipeLimits,
} from '../messagePaneRules';
import { loadRecentHashtags, matchHashtags, rememberSentHashtags } from '../hashtagRules';
import { attachKey, chatEscape, fieldKeyAction, isTypingKey, replyNavKey, replyNavTarget } from '../chatKeysRules';
import { getSendMode, insertLineBreak } from '../sendMode';
import { getDoubleClickAction, getQuickReaction, quickBarOrder, setQuickReaction, useDoubleClickAction, useQuickReaction } from '../quickReaction';
import { TYPING_SEND_MS } from '../typing';
import {
  holdSelection,
  SELECT_HOLD_MS,
  SELECT_TOUCH_SLOP_PX,
  selectTouchScrollStep,
  SELECT_MAX,
  SEL_SHAKE_MS,
  SELECT_SCROLL_TICK_MS,
  selectPress,
  selectRange,
  selectRowAt,
  selectScrollStep,
  selectSlopPassed,
  selectStartIn,
  selectUpTo,
  selectionKey,
} from '../dmSelection';
import { plural } from '../dmRowRules';
import { takeFilesDrop, useFilesDropSeq } from '../filesDrop';
import { collectDrop } from '../folderZip';
import { DRAG_MSG_MIME, downloadUrlValue, dragIds, encodeMsgDrag, grabsMessage, onForwardDrop } from '../dragOut';
import { usePhoneLayout } from '../phoneLayout';
import { deleteBothDefault, deleteRememberAvailable, rememberDeleteChoice } from '../deleteChoiceRules';
import {
  anchorIndex,
  anchorShift,
  firstUnreadIndex,
  jumpReturn,
  popJump,
  pushJump,
  unreadCountAfter,
  type FeedPlace,
  type JumpSide,
} from '../feedWindowRules';
import { canMarkRead, feedCovered, idleMs, lastSeenIndex, watchReadActivity } from '../readByView';
import { windowFocused } from '../notifications';
import { onConvCacheUrgent } from '../convCacheWriter';
import { isOwnLink, LinkConfirmModal, MessageLink, openLink, shouldWarnAboutLink } from '../linkGuard';
import { openDangerousLink } from '../dangerousLink';
import { isDangerousLink, serverLinkThreats } from '../dangerousLinkRules';
import {
  addedBelow,
  isFarFromBottom,
  isNearBottom,
  jumpDownLabel,
  jumpDownTarget,
  shouldAutoScroll,
  shouldLoadOlder,
  shouldShowCornerDown,
  shouldShowJumpDown,
  unreadDividerNeeded,
} from '../stickToBottom';
import { APPEAR_MS, LEAVE_MS, freshTail, removedInPlace, withLeaving, type Leaving } from '../bubbleMotion';
import { renderMessageText, type EmojiResolver } from '../messageText';
import { toast, toastError } from '../toast';
import { toastCopied } from '../copyConfirm';
import { canCopyImage, canSaveImage, copyImage, photoFromTouch, saveImage } from '../imageActions';
import { ALBUM_ITEM_PEER_OLD_TEXT, albumCellFromTarget, albumItemNoun, isAlbumItem } from '../albumItemRules';
import { ReadAtLine } from './ReadAtLine';
import { ReadersLine, readerLook } from './ReadersLine';
import { readersLineShown } from '../lastSeenText';
import { Avatar } from './Avatar';
import { CrownMark, crownGlow, useCrownId } from './Crown';
import { useAnimatedAvatarUrl } from '../avatarAnimation';
import { BottomSheet, SheetRow } from './BottomSheet';
import {
  ContextMenu,
  MenuDivider,
  MenuItem,
  QUICK_REACTIONS,
  ReactionBar,
  type MenuAlign,
  type MenuPos,
  type MenuSpotlight,
} from './ContextMenu';
import { EmojiPicker } from './EmojiPicker';
import { StickerPicker } from './StickerPicker';
import { GifPicker, isGifAttachment, type GifPick } from './GifPicker';
import { faveSticker, StickerMenuItems } from './StickerMessageMenu';
import { StickerSuggest } from './StickerSuggest';
import { StickerView } from './StickerView';
import { VoicePlayer, type VoiceMeta } from './VoiceMessage';
import { VoiceTopBar } from './VoiceTopBar';
import { getVoicePlayerState, takeVoiceJump, toggleVoice } from '../voicePlayer';
import { voiceTimecode, voiceTrackKey } from '../voicePlayback';
import { ExprTabs, getExprTab, type ExprTab } from './ExprTabs';
// Вложение в ленте (картинка, видео, голосовое, файл) — общее с видом «Отложенные» (06.10).
import { ATT_IMG_MAX_H, ATT_IMG_MAX_W, AttachmentView, isImage, isVideo, kb } from './AttachmentView';
// Вложения «как в Telegram» (05.10): скрепка — «Фото или видео» / «Файл», лист с галереей и камерой на телефоне.
import { MediaSheet, type MediaSendHow, type SystemPickKind } from './MediaSheet';
import { isOnceMedia } from '@gusvoice/shared';
import { onceDeadlineLocal, splitOncePlan } from '../onceMediaRules';
import { OnceTimerItems } from './OnceTimerMenu';
import { protectScreen } from '../screenGuard';
import { ATTACH_MAX, ATTACH_MAX_BYTES, dmAttachMaxBytes, attachMode, attachRoom, droppedAttachText, fitAttachments, skippedText } from '../attachRules';
import { cameraSupported } from '../cameraCapture';
import { compressPhotos } from '../imageCompress';
import { canShareFileNative, nativeMediaAvailable, pickDocumentsNative } from '../nativeMedia';
import { canCopyFileName, fileFromTarget, fileMenuActions, fileMenuLabel, runFileMenuAction } from '../fileMenu';
import { attachmentKey, cancelFileJob, fileJobOf } from '../fileActions';
import { attachmentTarget, ringDownloads, savedFilePath, showInFolder, startDownload } from '../pcDownloads';
import {
  addOutgoing,
  outgoingFailed,
  outgoingFilesLabel,
  outgoingRetry,
  outgoingSent,
  sendErrorText,
  type OutgoingMessage,
} from '../outgoingRules';
import { newClientId } from '../clientId';
// Порция «Отправка» (07.10): длинный текст режется на сообщения, прогресс и отмена загрузки у строки «в пути».
import {
  composerCounter,
  MESSAGE_TEXT_MAX,
  pastedTextBecomesFile,
  sendTextPlan,
  TEXT_FILE_MIME,
  TEXT_FILE_NAME,
  textAfterPaste,
  textFileOffer,
  tooLongText,
} from '../longTextRules';
import { clearUploadProgress, isUploadAborted, setUploadSignal } from '../uploadProgress';
import { localAttachments, OutgoingAttachments, useLocalDims } from './OutgoingAttachments';
import { SendPreview } from './SendPreview';
import { startVoiceRecording, voiceRecordingSupported, type VoiceTake } from '../voiceRecorder';
import { roundRecordingSupported, startRoundRecording, type RoundRecording } from '../roundRecorder';
import { RoundRecOverlay } from './RoundVideo';
import { VOICE_TRIM_FROM_MS, trimVoiceTake, voiceTrimFromRatios, voiceTrimmable } from '../voiceTrim';
import { dropVoiceDraft, loadVoiceDraft, saveVoiceDraft } from '../voiceDrafts';
import { VOICE_DESKTOP, VOICE_HOLD, voiceCancelPath, voiceHoldProgress } from '../voiceHold';
import { createVoiceHoldController, type VoiceHoldState } from '../voiceHoldController';
import { ComposerLinkPreview, LinkPreviewCard, linkPreviewsEnabled, previewableLinks } from './LinkPreview';
import { MessageEmbeds, attachmentsBesideEmbeds } from './MessageEmbeds';
import { SendFilesBox, type SendFilesResult } from './SendFilesBox';
import { PhotoEditor } from './PhotoEditor';
import { useHoldReorder } from './useHoldReorder';
import { photoEditable, renameTarget, replaceAt, type PhotoEdit } from '../photoEditRules';
import { composerPreviewLink, nextDismissed, sendNoPreview } from '../linkPreviewRules';
import {
  SEND_WAY_KEY,
  captionAfterPaste,
  dropKind,
  captionMoveVisible,
  dropTexts,
  moveFile,
  parseWay,
  photoSideFor,
  planSend,
  sendKind,
  spoilerIndexes,
  wayForZone,
  zoneAt,
  type DropKind,
  type DropZone,
  type SendWay,
} from '../sendFilesRules';
import {
  BubbleMeta,
  DayDivider,
  ForwardedFrom,
  MessageBubble,
  ReplyQuote,
  SelectCheck,
  type BubbleStatus,
} from './MessageBubble';
import {
  albumClass,
  albumStyleOf,
  bubbleLook,
  bubblesAllLeft,
  emojiOnlyCount,
  forwardedAuthorOpenable,
  readByPeer,
  replyQuoteLook,
  replyQuoteVideo,
  showsForwardedFrom,
} from '../bubbleRules';
import { readSendHint, noteSendHintShown, sendHintDue, SEND_HINT_MS, SEND_HINT_TEXT } from '../sendHint';
import { ForwardPicker } from './ForwardPicker';
import { ReplyOptions } from './ReplyOptions';
import { PinnedBar } from './PinnedBar';
import { SchedPick } from './SchedPick';
import { DmPinsList } from './PinnedMessages';
import { DM_PINS_MAX, isPinLimit, pinPreview, pinWhenLabel } from '../convSyncRules';
import {
  pinBarHidden,
  pinNextIndex,
  pinServiceLead,
  pinServiceMark,
  pinServiceTail,
  pinTrack,
  type PinMedia,
} from '../pinBarRules';
import { groupServiceLabel, groupServiceMark, peerColorIndex } from '../groupChatRules';
import { readPinHidden, writePinHidden } from '../pinHide';
import { PollCard } from './PollCard';
import { ConvMediaView, convMediaOf, withoutMediaFallback } from './ConvMediaCard';
import { ConvPollCard, ConvPollCreate, ConvPollMenuItems } from './ConvPoll';
import { GeoPickDialog } from './GeoPickDialog';
import { GeoPickMapLazy, geoSystemHooks } from '../geoSystem';
import { GeoLiveBar, GeoLiveCard } from './GeoLiveCard';
import { ContactSendFlow } from './ContactSendFlow';
import { PollComposer } from './PollComposer';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { Lightbox, type LightboxAction, type LightboxImage } from './Lightbox';
import { GuestMark, useGuestHome } from './GuestMark';
import { addEvidence, EVIDENCE_MAX } from '../reportEvidence';
import { confirmAction, confirmWithOption } from '../confirm';
import { pushBackHandler, TOP_LAYERS } from '../androidBack';
import { useUserMenu, type UserMenuTarget } from './UserContextMenu';
import { TextSelLayer, allTextSel, type TextSel } from './TextSelection';
import { revertReplacement, textReplacement, type Replacement } from '../fieldFormat';
import { applyEditToField, handleFormatKey, handleFormatPaste } from '../fieldFormatDom';
import { FieldFormatBar } from './FieldFormatBar';
import { ChatSearchFoot, ChatSearchHead, JumpDateDialog, useChatSearch, useSearchHighlight, type ChatSearchSource } from './ChatSearch';
import { FLOAT_DAY_HIDE_MS } from '../chatSearchRules';
import {
  cornerButtons,
  reactionsToMark,
  REACTION_SEEN_DELAY_MS,
  REACTION_SEEN_RATIO,
  type CornerKind,
} from '../cornerButtonsRules';
import { requestFeedJump, takeFeedJump, useFeedJumpSeq } from '../feedJump';
import { AutoDownloadSource } from '../autoDownload';
import { quoteFromSelection, replyJumpTarget, replyQuoteFragment, type ReplyQuoteDraft } from '../replyQuoteRules';
import { composerMaxPx } from '../composerSizeRules';
import { rememberedKeyboardHeight, rootZoom, viewportSafe } from '../popover';
import { resetKeyboardShift } from '../keyboardReset';
import { canDragExpand, dragExtra, expandAfterDrag, expandedExtra, EXPAND_SLOP } from '../stickersExpand';

/** Candidates for @-mention / #-channel autocomplete in the composer (channels only; DMs omit it). */
export type AutocompleteData = {
  users: { id: string; username: string; displayName: string; avatarUrl?: string | null; online?: boolean }[];
  roles: { id: string; name: string; mentionable: boolean }[];
  channels: { id: string; name: string }[];
  /** Группа ЛС (`groups2`): без `@everyone`/`@here` — у Telegram в группе их нет, подсказка — только участники. */
  noBroadcast?: boolean;
};
type AcItem =
  | { kind: 'user'; id: string; insert: string; label: string; handle: string; avatarUrl?: string | null; online?: boolean }
  | { kind: 'role'; id: string; insert: string; label: string }
  | { kind: 'broadcast'; id: string; insert: string; label: string; hint: string }
  | { kind: 'channel'; id: string; insert: string; label: string }
  | { kind: 'emoji'; id: string; insert: string; label: string; emoji: string }
  | { kind: 'hashtag'; id: string; insert: string; label: string }
  /** Команда бота (#230): `insert` — `/cmd`, `hint` — описание от бота. */
  | {
      kind: 'command';
      id: string;
      insert: string;
      label: string;
      hint: string;
      /** Канал (#231): чья команда — аватар 16 px и серым `@ник` в строке (tdesktop `field_autocomplete.cpp:722`). */
      bot?: { username: string; displayName: string; avatarUrl: string | null };
    };

/* Быстрые реакции листа сообщения (design-step8 C2) и полосы меню (раунд 12) — один набор `QUICK_REACTIONS` из
   `ContextMenu.tsx`, своей копии у ленты нет. */
/**
 * Тап по этому в сообщении делает своё и меню сообщения не открывает (раунд 12, HANDOFF §5): ссылка, цитата, фото и альбом,
 * карточка ссылки, чип реакции, кнопка голосового и его полоска, файл, аватар и имя, «Переслано от», нераскрытый спойлер.
 */
const TAP_OWN =
  'a, button, input, textarea, select, label, [role="button"]:not(.spoiler.open), .msg-ava, .author, .voice-msg, .att-file, .bub-fwd';
/**
 * Быстрая реакция (07.10, Telegram 3.04 / 3.06): двойной тап (телефон) и двойной клик мимо текста (ПК) ставят её, повтор
 * снимает. У Telegram это «любимая» — первая реакция полосы; у нас — выбранная в «Настройки → Вид → Двойной клик по
 * сообщению» или «Выбрать по умолчанию» в полосе (`quickReaction.ts`), по умолчанию 👍. Что делает сам двойной клик —
 * реакцию, ответ или ничего — там же (G45, как `DoubleClickQuickAction` у Telegram Desktop).
 */

/** Как выглядит поставивший реакцию (`MessagePaneProps.reactorOf`): имя и аватар. */
export type ReactorLook = { name: string; avatarUrl: string | null };

/**
 * Точка над буквами ТЕКСТА сообщения (07.10; Telegram Desktop, ресерч 04 MS-07): двойной клик по тексту выделяет слово,
 * а быструю реакцию ставит двойной клик мимо текста — по полям пузыря, времени, пустому месту. Текст — содержимое
 * `.message-body` без времени (`.bub-meta`); эмодзи-картинка в тексте — тоже текст. Буква под точкой — по прямоугольникам
 * знаков у каретки (`caretPositionFromPoint`; в старом Chromium — `caretRangeFromPoint`): пустое место строки текстом не
 * считается, хотя каретка встала бы и туда.
 */
function overMessageText(x: number, y: number, row: Element): boolean {
  const at = document.elementFromPoint(x, y);
  if (!at || !row.contains(at) || !at.closest('.message-body') || at.closest('.bub-meta')) return false;
  if (at instanceof HTMLImageElement) return true;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    node = pos.offsetNode;
    offset = pos.offset;
  } else {
    const r = doc.caretRangeFromPoint?.(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  const parent = node?.parentElement;
  if (!node || node.nodeType !== Node.TEXT_NODE || !parent || !row.contains(parent) || parent.closest('.bub-meta')) return false;
  const text = node.textContent ?? '';
  const range = document.createRange();
  for (const i of [offset - 1, offset]) {
    if (i < 0 || i >= text.length) continue;
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    for (const b of range.getClientRects()) if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true;
  }
  return false;
}
/* Потолок роста поля ввода — `composerMaxPx` (composerSizeRules.ts): 200 px, но не выше 35 % доступной высоты окна. */

/** Shimmer placeholders shown while message history loads (round-7 P8). */
function MessageSkeletons() {
  const rows = [
    [30, 85, 60],
    [24, 70],
    [34, 90, 45],
    [28, 64],
  ];
  return (
    <div className="msg-skeletons" aria-hidden>
      {rows.map((widths, i) => (
        <div className="sk-row" key={i}>
          <div className="sk sk-ava" />
          <div className="sk-lines">
            <div className="sk sk-name" />
            {widths.map((w, j) => (
              <div className="sk sk-line" key={j} style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Реакция: юникодный символ рисуется как есть, кастомная (`custom:<id>`) — картинкой.
 *
 * Эмодзи могли удалить с сервера, а реакция осталась: показываем нейтральную заглушку, а не
 * сырое `custom:d4f8…` — пользователю этот id ничего не говорит и выглядит как поломка.
 */
function renderReaction(key: string, byId: (id: string) => ServerEmoji | null): ReactNode {
  const id = customReactionId(key);
  if (!id) return key;
  const e = byId(id);
  return e ? <img className="custom-emoji" src={e.url} alt={`:${e.name}:`} title={`:${e.name}:`} /> : '❔';
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} печатает…`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
  return 'Несколько человек печатают…';
}

/** G53: пауза перед подсказкой «слово целиком» (tdesktop `kShowExactDelay`, 300 мс). */
const EXACT_SUGGEST_DELAY_MS = 300;

/**
 * Сообщение одной строкой в полосе над полем ввода (ответ, правка) — правилом цитат раунда 10 (`replyQuoteLook`): текст;
 * фото — подпись или «Фото»; голосовое — «Голосовое сообщение»; видео — «Видео»; файл — имя (08.10, п.30: слова строки списка бесед, без длительности и «Файл: »); стикер — «Стикер». Раньше всё
 * без текста было «вложение» (замечание приёмки 05.10). `thumb` — миниатюра фото или стикера перед текстом (раунд 12, за
 * переключателем пузырей).
 */
function StripText({ m, thumb }: { m: Message; thumb: boolean }) {
  const look = replyQuoteLook({ content: m.content, deleted: false }, m);
  return (
    <>
      {thumb && look.thumb ? (
        <img className={look.kind === 'sticker' ? 'rs-thumb sticker' : look.spoiler ? 'rs-thumb spoiled-thumb' : 'rs-thumb'} src={look.thumb} alt="" />
      ) : null}
      <span className="rs-text">{look.text}</span>
    </>
  );
}

/**
 * Нажатие на цитату ответа в пузыре (G55, Telegram 7.24): своя беседа — к сообщению, как было; другая беседа, где читатель
 * состоит, — она открывается на сообщении (`feedJump`); беседа, где его нет, — подсказка вместо перехода.
 */
function openReplyTarget(r: MessageReplyPreview, jumpHere: (id: string) => void) {
  const where = replyJumpTarget(r);
  if (where === 'here') return jumpHere(r.id);
  if (where === 'other' && r.conversationId) {
    requestFeedJump(r.conversationId, r.id);
    return void useStore.getState().selectDm(r.conversationId);
  }
  toast('info', 'Сообщение из другой беседы', 'Это ответ на сообщение из беседы, где вас нет.');
}

/**
 * Message body: Markdown subset + spoilers + mentions (messageText.tsx), with links routed through
 * the "you're leaving for <host>" prompt (linkGuard.tsx) so a link someone else wrote can't take you
 * anywhere without showing where first.
 */
function renderContent(
  content: string,
  authorId: string | null,
  authorName: string,
  onEmoji?: EmojiResolver,
  dangerous?: readonly string[] | null,
  roleNames?: readonly string[],
  plainBroadcast?: boolean,
) {
  return renderMessageText(
    content,
    (url, key) => <MessageLink key={key} url={url} dangerous={dangerous} />,
    onEmoji,
    roleNames,
    plainBroadcast,
  );
}

/**
 * Время сообщения «чч:мм». Один форматтер на весь модуль (фаза 0.4 ЛС, 30.09): `toLocaleTimeString` создавал его
 * заново на КАЖДОЕ сообщение при каждой перерисовке ленты — это была заметная доля замера этапа М.
 */
const TIME_FMT = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
/** «07.10.2026, 21:07» — метка времени в тексте «Скопировать» нескольких на ПК (формат даты — системной локали). */
const COPY_STAMP_FMT = new Intl.DateTimeFormat([], { dateStyle: 'short', timeStyle: 'short' });
const NO_EMOJI_BY_ID = (): ServerEmoji | null => null;
const PLAIN_NAME = (_userId: string, fallback: string) => fallback;
/** Раунд 12, выделение: ничего не выбрано — всегда ОДНИ И ТЕ ЖЕ пустые список и набор, и `memo`-строки не перерисовываются. */
const NO_PICKS: readonly string[] = [];
const NO_PICKED: ReadonlySet<string> = new Set();
/**
 * Поле ввода на время выделения — спрятано, а не снято (на его месте нижняя панель): у снятого пропали бы каретка и
 * слушатель ширины поля (вешается один раз), а набранное, ответ и правка ждут выхода из выделения.
 */
const COMPOSER_HIDDEN = { display: 'none' } as const;
/** Панель стикеров не раскрыта и не тянется (`exprLift`). */
const LIFT_NONE = { open: false, max: 0, drag: null } as const;
/** Сколько висит плашка «Переслано» (HANDOFF §9): гаснет сама. */
const FWD_DONE_MS = 4000;
/** Сколько черновик пересылки ждёт ушедший с ним текст (`outboxSettled`): дальше пересылка уходит и без него. */
const FWD_AFTER_TEXT_MS = 60_000;

/**
 * Строки очереди беседы `convId` с ключами `keys` ушли (их нет в очереди) или встали «не отправлено» — черновик пересылки
 * уходит следом (08.10). Не дождались за `FWD_AFTER_TEXT_MS` — всё равно дальше.
 */
function outboxSettled(convId: string, keys: readonly string[]): Promise<void> {
  const busy = () => (useStore.getState().outbox[convId] ?? []).some((x) => keys.includes(x.key) && x.status !== 'failed');
  if (!busy()) return Promise.resolve();
  return new Promise((resolve) => {
    let t = 0;
    const unsub = useStore.subscribe(() => {
      if (!busy()) done();
    });
    function done() {
      unsub();
      window.clearTimeout(t);
      resolve();
    }
    t = window.setTimeout(done, FWD_AFTER_TEXT_MS);
  });
}
/** «Открепить» из меню: сколько висит «Отменить» и ждёт запрос (Telegram Android — 5 с). */
const UNPIN_UNDO_MS = 5000;
/** Раунд 12, закреп в ЛС: закреплённых нет (или закрепа нет вовсе) — всегда ОДИН И ТОТ ЖЕ пустой список. */
const NO_PIN_LIST: readonly ConvPin[] = [];
/** Медиатека беседы за краем окна ленты, подтянутая просмотром (G11): пока ничего. */
const NO_MEDIA_MORE: { older: Message[]; newer: Message[] } = { older: [], newer: [] };
/** Сколько порций истории подряд просмотр тянет за шаг, ища следующее фото или видео. */
const MEDIA_PAGES_PER_STEP = 5;
/** Фото и видео сообщения — то, что листает просмотр. */
const mediaCount = (m: Message) =>
  (m.attachments ?? []).filter((a) => !a.asFile && (isImage(a.contentType) || isVideo(a.contentType))).length;
const hasMedia = (m: Message) => mediaCount(m) > 0;

/**
 * На что ещё указывает меню сообщения (07.10, Telegram 1.03 / 1.13 / 10.03): `file` — файл, видео или голосовое под
 * курсором или пальцем (пункты «Сохранить как…» / «Сохранить в загрузки» / «в галерею» / «Поделиться», `fileMenu.ts`),
 * `link` — ссылка в тексте («Открыть ссылку», «Скопировать ссылку»), `linkRect` — где она (меню ссылки на телефоне — у неё).
 */
/** `item` — ячейка альбома под правым кликом (G56): на ПК «Переслать»/«Удалить» меню берут её одну, как tdesktop `GroupPart`. */
type MenuMore = { file?: Attachment; link?: string; linkRect?: DOMRect; item?: Attachment };

/**
 * Действия строки ленты. Объект ОДИН на всю жизнь `MessagePane` и внутри зовёт свежие обработчики (`rowActsRef`):
 * строки держатся `memo`, и новая стрелочная функция на каждую перерисовку перерисовывала бы их все.
 */
interface RowActions {
  touchStart(e: React.TouchEvent, m: Message): void;
  touchMove(e: React.TouchEvent): void;
  touchEnd(): void;
  /**
   * `touch` — `contextmenu` пришёл от пальца или пера (системное долгое нажатие WebView), а не от правой кнопки мыши.
   * `photo` — правый клик по фото или ячейке альбома (раунд 12): в меню «Копировать изображение» и «Сохранить как…».
   */
  menu(m: Message, x: number, y: number, touch?: boolean, photo?: Attachment): void;
  /**
   * 07.10: на что ещё указывает правый клик или палец — файл, видео, голосовое (`file`) или ссылка в тексте (`link`).
   * Зовётся строкой прямо перед `menu` и действует на ОДИН следующий его вызов.
   */
  aim(more: MenuMore): void;
  /** Раунд 12: правый клик по фото в сообщении — меню сообщения, а не браузера (замечание приёмки 05.10). */
  photoMenu(): boolean;
  /** Тап по `/команде` в тексте сообщения бота (#230): отправить её в эту беседу (Telegram — сущность `bot_command`). */
  botCommand?(cmd: string, botUsername?: string): void;
  /**
   * Нажатие по строке (раунд 12): на телефоне тап по пузырю открывает меню у него; иначе ничего. С 07.10 в ЛС меню ждёт
   * окно двойного тапа: второй тап — быстрая реакция (`doubleTapStep`).
   */
  tap(e: React.MouseEvent<HTMLElement>, m: Message): void;
  /** Нажатие мышью по пузырю (07.10): второе нажатие двойного клика мимо текста — слово не выделять, реакцию готовить. */
  press(e: React.MouseEvent<HTMLElement>, m: Message): void;
  /** Двойной клик мышью по пузырю (07.10, ПК): мимо текста — быстрая реакция (ставит или снимает). */
  dbl(e: React.MouseEvent<HTMLElement>, m: Message): void;
  /** Правый клик или долгое нажатие по чипу реакции (07.10): окно «кто поставил». */
  who(e: React.MouseEvent<HTMLElement>, m: Message, r: ReactionGroup): void;
  /** Поставивший реакцию: имя и аватар (`reactorOf` ленты); не знаем — `null`, чип тогда с числом. */
  reactor(userId: string): ReactorLook | null;
  userMenu(e: React.MouseEvent, target: UserMenuTarget, view?: 'menu' | 'profile'): void;
  openImage(a: Attachment): void;
  react(messageId: string, emoji: string, op: 'add' | 'remove'): void;
  /** «Большая» реакция удержанием в полосе (G43, `bigreact1`); зовут только при `canBig`. */
  reactBig(messageId: string, emoji: string): void;
  picker(messageId: string, anchor: DOMRect): void;
  reply(m: Message): void;
  /** «Изменить» — правка в основном поле ввода (решение 31, как Telegram). */
  startEdit(m: Message): void;
  del(m: Message): void;
  /** Клик по цитате — к цитируемому сообщению (шаг 2г). */
  jumpTo(messageId: string): void;
  /**
   * Режим выделения (раунд 12): нажатие по строке (или пробел / Enter на ней) переключает её. Нажатие ловится на подходе
   * к строке, поэтому ссылка, цитата, фото, чип реакции внутри неё своего не делают — вся строка один флажок.
   */
  pick(e: React.MouseEvent | React.KeyboardEvent, m: Message): void;
}

type GuestHome = ReturnType<ReturnType<typeof useGuestHome>>;

interface MessageRowProps {
  m: Message;
  grouped: boolean;
  firstUnread: boolean;
  /** Подпись черты: беседа ЛС — «Непрочитанные сообщения» (Telegram, 03·3.2.1), канал сервера — «Новые сообщения». */
  unreadText: string;
  newDay: boolean;
  mine: boolean;
  /** С сообщением сейчас работают: его меню, пикер реакций, шторка, правка. */
  active: boolean;
  author: string;
  animatedUrl: string | undefined;
  crowned: boolean;
  guestHome: GuestHome;
  /** Э5 (#141): подпись «через «X», не подтверждено» у времени (`messagePaneRules.viaCaption`); нет — обычное сообщение. */
  viaText?: string | null;
  canReact: boolean;
  /** Удержание реакции в полосе ставит «большую» (G43, `onReactBig` у ленты). */
  canBig: boolean;
  /** Канал с ботами (#231): id канала — под сообщением бота его кнопки, `/команды` в тексте бота нажимаются. */
  kbChannel?: string;
  /** Корзина видна: своё — всегда, чужое — только в ЛС («удалить у себя», #212). */
  canDelete: boolean;
  onEmoji: EmojiResolver | undefined;
  emojiById: (id: string) => ServerEmoji | null;
  act: RowActions;
  /** ЛС как в Telegram (Р13): пузырь, свои справа, время внутри, без аватара и имени. */
  bubbles: boolean;
  /** Последнее в группе подряд идущих — пузырь с «хвостиком» и отступ до следующей группы. */
  tail: boolean;
  /** Широкая лента «все слева» (`MessagePane.bubLeft`): аватар у последнего в группе, и у своих тоже — как Telegram Desktop. */
  avatars: boolean;
  /**
   * Группа ЛС (07.10, `groups1`, С4): над первым пузырём серии чужих — имя автора, слева — аватар у последнего (как
   * Telegram); служебные строки рисует `MessageList` (закреп и действие в группе — пилюлей по центру).
   */
  groupChat: boolean;
  /**
   * Цитируемое сообщение, если оно есть в ленте: по нему цитата знает, что цитируют — фото, голосовое, файл, стикер
   * (`replyQuoteLook`; у пузырей — с миниатюрой, в канале — только словами). Объект из стора — стабилен для `memo`.
   */
  replyOf: Message | undefined;
  /**
   * Подпись из моих контактов для цитаты ответа и «Переслано от» (ЛС, `peerName.ts`, решение владельца 08.10 п.27). В канале
   * сервера не передаётся — там имена как были.
   */
  quoteNameOf?: (userId: string, fallback: string) => string;
  /** Палец держит этот пузырь (долгое нажатие на телефоне) — пузырь чуть сжат. */
  pressing: boolean;
  /**
   * Своё, прочитанное собеседником (Р6) — ✓✓ вместо ✓, только у пузырей. Булево, а не ключ: сдвиг «прочитано до»
   * перерисовывает лишь строки, у которых отметка сменилась, а не все `memo`-строки ленты.
   */
  read: boolean;
  /**
   * Раунд 12 — лента в режиме выделения (только пузыри ЛС): вместо действий наведения кружок `SelectCheck`, строка —
   * флажок. Булевы, а не набор выбранных: выбор одной строки перерисовывает её одну.
   */
  selecting: boolean;
  /** Строка выбрана (режим выделения): кружок залит, строка подсвечена мёдом. */
  picked: boolean;
  /** Над пузырём строка «Переслано от» (раунд 12, `showsForwardedFrom`: у первого в серии от одного автора оригинала). */
  fwdLine: boolean;
  /**
   * Палец ведёт этот пузырь влево — свайп-ответ (раунд 12, порция 6): строка `.swiping`, справа значок «ответить». Булево
   * на весь жест: сам сдвиг и рост значка лента пишет в DOM строки (`--swipe-x` / `--swipe-p`), строка их не видит.
   */
  swiping: boolean;
  /** Только что пришло (`bubbleMotion.freshTail`): пузырь въезжает снизу (`.bub-in`); число — задержка анимации, мс
   *  (отрицательная — своё продолжает въезд строки «в пути»). */
  appear?: number;
  /** Удалённое, дорисованное на время схлопывания (`bubbleMotion.removedInPlace`): без `data-mid`, мимо мыши (`.bub-out`). */
  ghost?: boolean;
}

/**
 * Одно сообщение ленты (фаза 0.4 ЛС, 30.09).
 *
 * 🔴 Отдельный `memo`-компонент, а не JSX внутри `MessagePane.messages.map`: замер этапа М показал, что при 2 000
 * сообщений в ленте каждая буква в поле ввода стоила 344 мс (×3 CPU — 2,1 с), а подгрузка 50 старых — до 0,8 с —
 * любое изменение состояния `MessagePane` перестраивало ВСЕ строки (`docs/dm/research/M1-baseline.md`). Здесь строка
 * перерисовывается, только когда поменялись её собственные данные. ⚠️ Поэтому всё, что приходит в пропсы, обязано
 * быть стабильным: примитивы, сам объект сообщения из стора, функции-резолверы в `useMemo`, действия — через `act`.
 */
const MessageRow = memo(function MessageRow({
  m,
  grouped,
  firstUnread,
  unreadText,
  newDay,
  mine,
  active,
  author,
  animatedUrl,
  crowned,
  guestHome,
  viaText,
  canReact,
  canBig,
  kbChannel,
  canDelete,
  onEmoji,
  emojiById,
  act,
  bubbles,
  tail,
  avatars,
  groupChat,
  replyOf,
  quoteNameOf,
  pressing,
  read,
  selecting,
  picked,
  fwdLine,
  swiping,
  appear,
  ghost,
}: MessageRowProps) {
  const time = TIME_FMT.format(new Date(m.createdAt));
  const who: UserMenuTarget = { userId: m.author.id, name: author, avatarUrl: m.author.avatarUrl, ...(m.author.bot ? { bot: true } : {}) };
  // `noPreview` (G19, `linkprev1`): автор убрал превью крестиком над полем — карточку под сообщением не рисуем.
  // Опасные ссылки (#218 п.5, `linkthreats1`): хосты, найденные сервером в списке угроз; без признака сервера — пусто.
  const dangerous = useStore((s) => (serverLinkThreats(s.serverFeatures) ? m.dangerousLinks : undefined));
  // Позванные ролью (#76, `@Модераторы`): названия ролей сообщения для подсветки. Строкой, чтобы селектор не отдавал новый массив
  // на каждый вызов (zustand сравнивает по ссылке и перерисовывал бы каждую строку ленты).
  const roleMentionKey = useStore((s) =>
    m.mentionRoles?.length
      ? (s.bootstrap?.roles ?? [])
          .filter((r) => m.mentionRoles!.includes(r.id))
          .map((r) => r.name)
          .join('\u0001')
      : '',
  );
  const roleMentionNames = useMemo(() => (roleMentionKey ? roleMentionKey.split('\u0001') : undefined), [roleMentionKey]);
  // Карточку по опасной ссылке не рисуем: сервер её и не собирает.
  // Текст, собранный сервером из карточек вебхука для старых клиентов (`embedsFallback`, #24), не показывается и не превьюится.
  const previews =
    m.content && !m.embedsFallback && !m.noPreview && linkPreviewsEnabled()
      ? previewableLinks(m.content).filter((u) => !isDangerousLink(u, dangerous))
      : [];
  const hasReactions = !!m.reactions?.length;
  const quick = useQuickReaction();
  // Let avatar/author (user menu), links, images and controls keep their own
  // right-click behaviour; the message menu only opens over the message body.
  const onContextMenu = (e: React.MouseEvent) => {
    const t = e.target as Element;
    // Окно «Переход на сторонний сайт» ссылки — портал: правый клик по нему всплывает сюда по дереву React, но это не строка.
    if (!(e.currentTarget as Element).contains(t)) return;
    // Раунд 12: фото (и ячейка альбома) — меню сообщения вместо меню браузера (замечание приёмки 05.10).
    const aimed = act.photoMenu();
    const photoLink = aimed ? t.closest('.att-img-link') : null;
    /* 07.10 (Telegram 1.03 / 10.03 / 1.13): ссылка в тексте, карточка файла, видео и голосовое — тоже наше меню: у ссылки
       «Открыть ссылку» / «Скопировать ссылку», у файла — «Сохранить как…» (`[data-att]` ставят сами вложения). */
    const linkEl = aimed ? t.closest<HTMLAnchorElement>('a.msg-link') : null;
    const fileEl = aimed ? t.closest('[data-att]') : null;
    // С2 порция 2: стикер (кнопка «окно набора») — тоже меню сообщения: «Посмотреть набор», «В избранное» (как Telegram).
    const stickerEl = aimed ? t.closest('.message-sticker') : null;
    if (t.closest('a, img, button, input, textarea, .msg-ava, .author') && !photoLink && !linkEl && !fileEl && !stickerEl) return;
    e.preventDefault();
    // Какое фото: картинка ячейки — `src` вложения (`AttachmentView`), по нему и находим (05.10: «Копировать изображение»).
    const src = photoLink?.querySelector('img')?.getAttribute('src');
    const photo = src ? m.attachments?.find((a) => a.url === src) : undefined;
    const more: MenuMore = {
      file: fileEl ? fileFromTarget(m.attachments, t) : undefined,
      link: linkEl?.getAttribute('href') ?? undefined,
      linkRect: linkEl?.getBoundingClientRect(),
      item: photoLink ? albumCellFromTarget(m.attachments, t) : undefined,
    };
    // Палец или перо (системное долгое нажатие WebView) — это не правый клик: решит лента (`openMsgMenu`).
    act.aim(more);
    act.menu(m, e.clientX, e.clientY, pressByTouch(e.nativeEvent) === true, photo);
  };
  const unreadLine = firstUnread ? (
    <div className="new-divider" role="separator" aria-label={unreadText}>
      <span>{unreadText}</span>
    </div>
  ) : null;
  const quote = m.replyTo ? (
    <ReplyQuote
      author={quoteNameOf && replyOf ? quoteNameOf(replyOf.author.id, m.replyTo.authorName) : m.replyTo.authorName}
      // Удалённое у обоих текста не несёт (`deleted`) — без проверки выходило «вложение». Вложение цитируемого из ленты —
      // словами правила раунда 10 («Фото», «Файл: имя»…), без миниатюры: цитата канала — одна строка.
      text={m.replyTo.deleted ? 'сообщение удалено' : (replyQuoteFragment(m.replyTo) ?? replyQuoteLook(m.replyTo, replyOf).text)}
      quote={!!m.replyTo.quote && !m.replyTo.deleted}
      onClick={() => m.replyTo && openReplyTarget(m.replyTo, act.jumpTo)}
    />
  ) : null;
  const stickerSets = useStore((s) => !!m.sticker && serverDmStickers(s.serverFeatures));
  // Геопозиция / контакт (G69, `geocontact1`): карточка вместо запасного текста (его снимает `withoutMediaFallback` у ленты).
  const convMedia = convMediaOf(m as { media?: unknown });
  const pollAndSticker = (
    <>
      {m.poll ? <PollCard poll={m.poll} channelId={m.channelId} messageId={m.id} /> : null}
      {/* Опрос в ЛС (14.10, `convpoll1`): своя карточка с голосом (`ConvPoll.tsx`). */}
      {convMedia?.kind === 'poll' ? <ConvPollCard poll={convMedia} conversationId={m.channelId} messageId={m.id} /> : null}
      {/* Трансляция геопозиции в ЛС (14.10, `geolive1`): карточка с кольцом срока и «Остановить» у автора (`GeoLiveCard.tsx`). */}
      {convMedia?.kind === 'geolive' ? <GeoLiveCard live={convMedia} conversationId={m.channelId} messageId={m.id} mine={mine} /> : null}
      {convMedia && convMedia.kind !== 'poll' && convMedia.kind !== 'geolive' ? (
        <ConvMediaView
          media={convMedia}
          onProfile={(e, userId) =>
            act.userMenu(
              e,
              { userId, name: convMedia.kind === 'contact' ? convMedia.displayName || convMedia.username : '', avatarUrl: convMedia.kind === 'contact' ? convMedia.avatarUrl : null },
              'profile',
            )
          }
          onMessage={(userId) => void useStore.getState().openDmWith(userId).catch(toastError)}
        />
      ) : null}
      {/* Стикер (#68) — крупно и без рамки сообщения. Лежит копией в самом сообщении,
          поэтому переживает удаление набора, из которого пришёл. */}
      {m.sticker ? (
        stickerSets ? (
          // С2 (`stickers2`): нажатие открывает окно набора — «Добавить N стикеров», как у Telegram (`StickerSetModal`).
          <button
            type="button"
            className="message-sticker as-button"
            title="Открыть набор"
            onClick={(e) => {
              e.stopPropagation();
              const st = useDmStickers.getState();
              st.openSet({ sticker: m.sticker!, send: st.sender ?? undefined });
            }}
          >
            <StickerView url={m.sticker.url} format={m.sticker.format} emoji={m.sticker.emoji} size={160} />
          </button>
        ) : (
          <div className="message-sticker">
            <StickerView url={m.sticker.url} format={m.sticker.format} emoji={m.sticker.emoji} size={160} />
          </div>
        )
      ) : null}
    </>
  );
  /* Карточки ссылок (#64). Своим инстансом не занимаемся — предпросмотр
     собственных страниц бессмысленен, а запрос лишний. */
  const previewCards = previews.map((u) => <LinkPreviewCard key={u} url={u} />);
  /* Голосовое: сообщение-источник для «не прослушано», автоперехода и полосы плеера (07.10, G12). У каждой ленты — и ЛС,
     и канала: признак «прослушано» есть только у бесед с `voice1`, без него точек и вызовов нет, а полоса и автопереход
     работают. */
  const voiceListened = (m as { voiceListened?: boolean }).voiceListened;
  const voiceMeta: VoiceMeta = {
    conversationId: m.channelId,
    messageId: m.id,
    mine,
    listened: voiceListened,
    author,
    createdAt: m.createdAt,
    // «Прослушать один раз» (`voice3`, G54): значок «1», без «Сохранить как…»/пересылки, сервер удаляет после прослушивания.
    once: m.attachments?.some((a) => a.once === true) || undefined,
  };
  // Файл, уже показанный картинкой в карточке вебхука (`attachment://`), отдельно не рисуем — как у Discord (#24).
  const shownAttachments = attachmentsBesideEmbeds(m.attachments, m.embeds);
  const attachmentViews = shownAttachments.map((a, j) => <AttachmentView key={j} a={a} onOpen={act.openImage} voice={voiceMeta} />);
  /* Чипы по убыванию числа (`sortReactionChips`); аватарки — на всех чипах или ни на одном (`messageChipFaces`: в ЛС всегда, где
     список полный; в канале — пока поставивших на сообщении не больше трёх, G75). */
  const chipFacesOf = messageChipFaces(m.reactions, bubbles);
  const reactionChips = (
    <>
      {sortReactionChips(m.reactions).map((r) => {
        /* «Кто поставил» (07.10, Telegram 3.20 / 3.21 / 3.30 / 3.31): сервер бесед ЛС шлёт список (`reactors`) — на чипе
           аватарки поставивших вместо числа (`chipFaces`; кого не знаем — число), правый клик или долгое нажатие по чипу —
           окно «кто поставил». Без списка (каналы, старый сервер) — чип прежний. */
        const ids = chipFacesOf.get(r.emoji) ?? null;
        const faces = ids?.map((id) => act.reactor(id));
        const shown = faces && faces.every((f): f is ReactorLook => !!f) ? faces : null;
        return (
          <button
            type="button"
            key={r.emoji}
            className={`reaction ${r.me ? 'mine' : ''}${shown ? ' faces' : ''}`}
            disabled={!canReact}
            onClick={() => act.react(m.id, r.emoji, r.me ? 'remove' : 'add')}
            onContextMenu={r.reactors?.length ? (e) => act.who(e, m, r) : undefined}
          >
            <span className="re-emoji">{renderReaction(r.emoji, emojiById)}</span>
            {shown && ids ? (
              <span className="re-faces" aria-label={shown.map((f) => f.name).join(', ')}>
                {shown.map((f, i) => (
                  <Avatar key={ids[i]} url={f.avatarUrl} name={f.name} size={18} />
                ))}
              </span>
            ) : (
              <span className="re-count">{r.count}</span>
            )}
          </button>
        );
      })}
      {canReact ? (
        <button
          type="button"
          className="reaction add"
          title="Добавить реакцию"
          onClick={(e) => act.picker(m.id, e.currentTarget.getBoundingClientRect())}
        >
          <Icon name="reaction" size={15} />
        </button>
      ) : null}
    </>
  );
  const myReactions = (m.reactions ?? []).filter((r) => r.me).map((r) => r.emoji);
  /* Быстрая реакция при наведении (G44; место и момент — как у Telegram Desktop, 3.02): в ЛС (`bubbles`) это угловая кнопка
     у пузыря (`.msg-react.corner` внутри `.bubble`, у нижнего угла снаружи, на стороне ленты): мышь на строке — кнопка
     появляется через 0,3 с и уходит через 0,3 с после ухода; мышь на кнопке — рядом (над ней) полоса `ReactionBar` (та же,
     что в меню сообщения). В каналах — по-прежнему кнопка в `.msg-actions`. Сама кнопка — быстрая реакция 👍 (повторный
     щелчок снимает), «Все реакции» в полосе — полный пикер. Показ — CSS (`.msg-react:hover` / фокус внутри), только где
     есть наведение; у верха ленты полоса уходит вниз (`data-flip`, по месту на входе мыши). */
  const reactCtl = canReact ? (
    <span className={bubbles ? 'msg-react corner' : 'msg-react'} onMouseEnter={flipReactPop} onFocus={flipReactPop}>
      <button
        type="button"
        title="Реакция"
        aria-label="Реакция"
        onClick={() => act.react(m.id, quick, quickReactOp(m.reactions, quick))}
      >
        <Icon name="reaction" size={16} />
      </button>
      <span className="msg-react-pop">
        <ReactionBar
          reactions={quickBarOrder(QUICK_REACTIONS, quick)}
          quick={quick}
          onSetQuick={setQuickReaction}
          mine={myReactions}
          onPick={(emoji) => act.react(m.id, emoji, myReactions.includes(emoji) ? 'remove' : 'add')}
          onBig={canBig ? (emoji) => act.reactBig(m.id, emoji) : undefined}
          onMore={(e) => act.picker(m.id, e.currentTarget.getBoundingClientRect())}
        />
      </span>
    </span>
  ) : null;
  const actions = (
    <div className="msg-actions">
      <button type="button" title="Ответить" onClick={() => act.reply(m)}>
        <Icon name="reply" size={16} />
      </button>
      {bubbles ? null : reactCtl}
      {/* Пересланное правке не подлежит (сервер ответит 403) — «Изменить» у него нет нигде. */}
      {mine && !m.forwardedFrom ? (
        <button type="button" title="Изменить" onClick={() => act.startEdit(m)}>
          <Icon name="edit" size={16} />
        </button>
      ) : null}
      {/* В ЛС корзина есть и у чужих: там это «удалить у себя» (#212). В канале — как было, только своё. */}
      {canDelete ? (
        <button type="button" className="danger" title="Удалить" onClick={() => act.del(m)}>
          <Icon name="trash" size={16} />
        </button>
      ) : null}
    </div>
  );

  if (bubbles) {
    /* Пузырь (ЛС как в Telegram, `MessageBubble.tsx`): вид — по `bubbleLook` (обычный, фото во всю ширину, крупные
       эмодзи, стикер). Время — внутри: в строке реакций справа; иначе в конце текста (`float`, как у Telegram:
       короткое сообщение со временем в одну строку); у фото без подписи — поверх фото; иначе отдельной строкой внизу
       (у крупных эмодзи и стикера — маленькой пилюлей). Фото в пузыре — первым, подпись под ним, как у Telegram. */
    const look = bubbleLook(m, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
    const media = look.kind === 'media';
    // «Подпись над медиа» (G48, `media2`): подпись сверху, фото или альбом под ней; время — поверх фото, как у сообщения без подписи.
    const capUp = media && m.captionAbove === true && !!m.content;
    const metaAt: 'reactions' | 'body' | 'over' | 'row' = hasReactions
      ? 'reactions'
      : media
        ? !m.content || (m.captionAbove === true && !previews.length)
          ? 'over'
          : previews.length
            ? 'row'
            : 'body'
        : look.kind === 'text' && m.content && !previews.length && !m.attachments?.length && !m.embeds?.length
          ? 'body'
          : 'row';
    /* Отметка у своих (раунд 10, Р6): дошедшее — ✓ «отправлено», прочитанное собеседником — ✓✓ (`read` считает лента
       по «прочитано до» собеседника из сводки беседы; сервер без `conv4` его не шлёт — тогда всегда ✓). */
    const status: BubbleStatus | undefined = mine ? (read ? 'read' : 'sent') : undefined;
    const meta = (
      <BubbleMeta time={bubbleTimeLabel(time, m, viaText)} edited={!!m.editedAt} over={metaAt === 'over'} status={status} title={timeTooltip(m, viaText)} />
    );
    // Цитата в пузыре знает, что цитирует (раунд 10): миниатюра фото или стикера, голосовое, файл, удалённое.
    const rq = m.replyTo ? replyQuoteLook(m.replyTo, replyOf) : null;
    // Цитата фрагмента (G55, Telegram 7.23): в цитате — выбранный кусок, а не начало сообщения; без миниатюры.
    const fragment = m.replyTo ? replyQuoteFragment(m.replyTo) : null;
    const bubbleQuote =
      m.replyTo && rq ? (
        <ReplyQuote
          author={quoteNameOf && replyOf ? quoteNameOf(replyOf.author.id, m.replyTo.authorName) : m.replyTo.authorName}
          text={fragment ?? rq.text}
          // Видео — значком камеры (06.10): вид цитаты остаётся «файлом», значок выбирает отдельное правило.
          kind={fragment ? 'text' : rq.kind === 'file' && m.replyTo && replyQuoteVideo(m.replyTo, replyOf) ? 'video' : rq.kind}
          thumb={fragment ? undefined : rq.thumb}
          spoiler={!fragment && rq.spoiler === true}
          quote={!!m.replyTo.quote && !m.replyTo.deleted}
          onClick={() => m.replyTo && openReplyTarget(m.replyTo, act.jumpTo)}
        />
      ) : null;
    const body = m.content && !m.embedsFallback ? (
      <div className="message-body">
        {linkBotCommands(
          renderContent(m.content, m.author.id, author, onEmoji, dangerous, roleMentionNames, m.mentionEveryone === false),
          m.author.bot && !mine ? act.botCommand : undefined,
        )}
        {metaAt === 'body' ? meta : null}
      </div>
    ) : null;
    /* Карточки бота в ЛС (#229, 26.10) — под текстом пузыря, как у вебхука в канале (тот же `MessageEmbeds`). Время с ними —
       отдельной строкой внизу (`metaAt` 'row'): в конце текста оно встало бы над карточками. */
    const embedCards = m.embeds?.length ? (
      <MessageEmbeds embeds={m.embeds} renderText={(t) => renderContent(t, m.author.id, author, onEmoji, dangerous, roleMentionNames)} />
    ) : null;
    // Альбом из 2–4 фото — сеткой (раунд 10): ячейки заполняют картинки, время поверх последнего фото.
    const attachments = m.attachments?.length ? (
      <div
        className={look.album ? albumClass(look.album) : 'attachments'}
        style={look.album ? (albumStyleOf(m.attachments, ATT_IMG_MAX_W, ATT_IMG_MAX_H) as React.CSSProperties | undefined) : undefined}
      >
        {look.album
          ? m.attachments.map((a, j) => <AttachmentView key={j} a={a} onOpen={act.openImage} fill />)
          : attachmentViews}
        {metaAt === 'over' ? meta : null}
      </div>
    ) : null;
    const reactions = hasReactions ? (
      <div className="reactions">
        {reactionChips}
        {meta}
      </div>
    ) : null;
    /* Широкая лента «все слева»: аватар у последнего в группе — и у своих (у Telegram Desktop так же,
       `Message::hasFromPhoto` в широкой раскладке): иначе свои фото и крупные эмодзи без пузыря не отличить от чужих.
       У остальных в группе — пустое место той же ширины, чтобы пузыри стояли ровно. */
    const showAva = avatars || (groupChat && !mine);
    const avatar = !showAva ? undefined : tail ? (
      <span
        className="msg-ava"
        // Нажатие — карточка профиля, правый клик — меню человека (как у аватара в канале).
        onClick={(e) => act.userMenu(e, who, 'profile')}
        onContextMenu={(e) => act.userMenu(e, who)}
      >
        <Avatar url={m.author.avatarUrl} animatedUrl={animatedUrl} name={author} size={34} />
      </span>
    ) : null;
    /* «Переслано от» (раунд 12, HANDOFF §2.4) — первой строкой пузыря, раньше цитаты; у фото — над снимком. Имя — кнопка к
       профилю автора оригинала; у удалённого аккаунта (признак сервера `forwardedFrom.deleted`, не имя) и в режиме выделения
       (там нажатие переключает строку) — текст. */
    const from = fwdLine ? m.forwardedFrom : null;
    const forwarded = from ? (
      <ForwardedFrom
        name={quoteNameOf ? quoteNameOf(from.userId, from.displayName) : from.displayName}
        onOpen={
          selecting || !forwardedAuthorOpenable(from)
            ? undefined
            : (e) =>
                act.userMenu(e, { userId: from.userId, name: quoteNameOf ? quoteNameOf(from.userId, from.displayName) : from.displayName, avatarUrl: null }, 'profile')
        }
      />
    ) : null;
    /* Свайп-ответ (раунд 12, HANDOFF §7): пока палец ведёт пузырь влево, у правого края строки — значок «ответить» в слоте
       `actions` (`.bub-slot.end`). Прозрачность и размер значка, сдвиг пузыря — переменные строки `--swipe-p` / `--swipe-x`,
       а взвод (`.armed`) — класс значка: их лента пишет прямо в DOM, строка перерисовывается только в начале жеста и в конце. */
    /* Кнопки под сообщением бота (#230, `ConvMessage.keyboard`): только в пузыре ЛС (боты живут только в беседах 1:1), под
       пузырём колонкой `.bub-stack`; у остальных сообщений разметка строки прежняя. */
    const kbRows = !mine && !ghost ? (m as { keyboard?: InlineKeyboard }).keyboard : undefined;
    const kbConv = (m as { conversationId?: string }).conversationId;
    const kb = kbRows?.length && kbConv ? <MessageKeyboard convId={kbConv} messageId={m.id} keyboard={kbRows} /> : undefined;
    const swipeIcon = swiping ? (
      <span className="bub-slot end" aria-hidden="true">
        <span className="swipe-reply">
          <Icon name="reply" size={18} />
        </span>
      </span>
    ) : null;
    return (
      <>
        {newDay && <DayDivider label={dayLabel(m.createdAt)} pill />}
        {unreadLine}
        <MessageBubble
          side={mine ? 'out' : 'in'}
          grouped={grouped}
          tail={tail}
          active={active}
          kind={look.kind}
          jumbo={look.jumbo}
          mediaWidth={look.mediaWidth}
          mediaEnd={metaAt === 'over'}
          className={
            ghost
              ? 'bub-out'
              : [picked ? 'picked' : swiping ? 'swiping' : pressing ? 'pressing' : '', appear !== undefined ? 'bub-in' : '']
                  .filter(Boolean)
                  .join(' ') || undefined
          }
          data-mid={ghost ? undefined : m.id}
          style={appear ? ({ '--bub-in-delay': `${appear}ms` } as React.CSSProperties) : undefined}
          aria-hidden={ghost || undefined}
          onTouchStart={(e) => act.touchStart(e, m)}
          onTouchMove={act.touchMove}
          onTouchEnd={act.touchEnd}
          onTouchCancel={act.touchEnd}
          onContextMenu={onContextMenu}
          onClick={(e) => act.tap(e, m)}
          // Быстрая реакция двойным кликом мимо текста (07.10, ПК): слово второе нажатие не выделяет.
          onMouseDown={(e) => act.press(e, m)}
          onDoubleClick={(e) => act.dbl(e, m)}
          /* Раунд 12, выделение (HANDOFF §2.2): строка — флажок целиком. Нажатие ловим на подходе (`Capture`), чтобы
             ссылка, цитата, фото и чип реакции внутри строки своего не делали; пробел и Enter — с клавиатуры. */
          role={selecting ? 'checkbox' : undefined}
          aria-checked={selecting ? picked : undefined}
          tabIndex={selecting ? 0 : undefined}
          onClickCapture={selecting ? (e) => act.pick(e, m) : undefined}
          onKeyDown={selecting ? (e) => act.pick(e, m) : undefined}
          avatar={avatar}
          kb={kb}
          actions={
            selecting ? (
              <SelectCheck checked={picked} />
            ) : swipeIcon ? (
              <>
                {actions}
                {swipeIcon}
              </>
            ) : (
              actions
            )
          }
        >
          {/* Группа: имя автора над первым пузырём серии чужих (Telegram `Message::displayFromName`). */}
          {/* Цвет имени — по id автора, семь цветов, как tdesktop `Ui::DecideColorIndex` (`groupChatRules.peerColorIndex`). */}
          {groupChat && !mine && !grouped ? (
            <div className="bub-name" style={{ color: `var(--peer-${peerColorIndex(m.author.id) + 1})` }}>
              {author}
            </div>
          ) : null}
          {forwarded}
          {bubbleQuote}
          {(media ? (
              capUp ? (
                <>
                  {body}
                  {embedCards}
                  {attachments}
                  {previewCards}
                  {reactions}
                </>
              ) : (
                <>
                  {attachments}
                  {body}
                  {embedCards}
                  {previewCards}
                  {reactions}
                </>
              )
            ) : (
              <>
                {pollAndSticker}
                {body}
                {embedCards}
                {previewCards}
                {attachments}
                {reactions}
              </>
            ))}
          {metaAt === 'row' ? <div className="bub-meta-row">{meta}</div> : null}
          {selecting ? null : reactCtl}
        </MessageBubble>
      </>
    );
  }

  return (
    <>
      {/* Дневная метка: без неё, чтобы понять, где кончился вчерашний разговор, приходится
          читать время у каждого сообщения по отдельности. */}
      {newDay && <DayDivider label={dayLabel(m.createdAt)} />}
      {unreadLine}
      <div
        // `active` — сообщение, с которым сейчас работают: открыто его контекстное меню,
        // висит его пикер реакций или оно редактируется. Наведение даёт слабую подсветку,
        // а действие — рамку: иначе при открытом меню курсор уходит на меню, ховер
        // слетает, и непонятно, к какому сообщению это меню относится.
        className={`message ${grouped ? 'grouped' : ''} ${active ? 'active' : ''}`}
        data-mid={m.id}
        onTouchStart={(e) => act.touchStart(e, m)}
        onTouchMove={act.touchMove}
        onTouchEnd={act.touchEnd}
        onTouchCancel={act.touchEnd}
        onContextMenu={onContextMenu}
        onClick={(e) => act.tap(e, m)}
      >
        <div className="msg-gutter">
          {grouped ? (
            <span className="msg-hovertime">{time}</span>
          ) : (
            <span
              className="msg-ava"
              // Нажатие — сразу карточка профиля, как у Telegram и Discord (#212); правый клик — меню. У вебхука (#24) — ничего.
              onClick={m.webhookId ? undefined : (e) => act.userMenu(e, who, 'profile')}
              onContextMenu={m.webhookId ? undefined : (e) => act.userMenu(e, who)}
            >
              <Avatar url={m.author.avatarUrl} animatedUrl={animatedUrl} name={author} size={38} />
              {crowned && <CrownMark size={13} />}
            </span>
          )}
        </div>
        <div className="message-main">
          {quote}
          {!grouped && (
            <div className="message-head">
              <span
                className={`author ${mine ? 'me' : ''}${crownGlow(crowned)}`}
                // Вебхук (#24) — не человек: ни профиля, ни меню участника (как у Discord, там это карточка приложения).
                onClick={m.webhookId ? undefined : (e) => act.userMenu(e, who, 'profile')}
                onContextMenu={m.webhookId ? undefined : (e) => act.userMenu(e, who)}
              >
                {author}
              </span>
              {m.webhookId && (
                <span className="msg-webhook-tag" title="Сообщение пришло через вебхук канала, а не от участника">
                  ВЕБХУК
                </span>
              )}
              {/* Бот (#229): настоящий пользователь, поэтому имя кликается, в отличие от вебхука. Текст — `botRules.BOT_TAG_TEXT`
                  (импорт сюда не тянем: харнессы ленты держат закрытый перечень импортов). */}
              {m.author.bot && !m.webhookId && (
                <span className="bot-tag" title="Это бот: им управляет программа его владельца">
                  БОТ
                </span>
              )}
              <GuestMark home={guestHome} size={11} />{' '}
              <span className="ts muted">{time}</span>
            </div>
          )}
          {(
            <>
              {pollAndSticker}
              {m.content && !m.embedsFallback ? (
                <div className="message-body">
                  {linkBotCommands(
                    renderContent(m.content, m.author.id, author, onEmoji, dangerous, roleMentionNames, m.mentionEveryone === false),
                    kbChannel && m.author.bot && !mine && !m.webhookId ? (cmd) => act.botCommand?.(cmd, m.author.username) : undefined,
                  )}
                  {m.editedAt ? <span className="ts muted edited"> (изм.)</span> : null}
                </div>
              ) : null}
              {/* Карточки вебхука (#24) — под текстом, как у Discord; описание и поля — тем же рендером, что текст. */}
              {m.embeds?.length ? (
                <MessageEmbeds
                  embeds={m.embeds}
                  renderText={(t) => renderContent(t, m.author.id, author, onEmoji, dangerous, roleMentionNames)}
                />
              ) : null}
              {/* Кнопки бота в канале (#231, ТЗ §4.4) — под карточками, ширина как у `.embed`; в ЛС они в пузыре (`kb`). */}
              {/* ⚠️ Условия переставлены намеренно: выражение значка «БОТ» выше — якорь мутантов `DmChatView.botGate.test`, второй копии быть не должно. */}
              {kbChannel && !m.webhookId && m.author.bot && (m as { keyboard?: InlineKeyboard }).keyboard?.length ? (
                <MessageKeyboard
                  target={{ kind: 'channel', id: kbChannel }}
                  messageId={m.id}
                  keyboard={(m as { keyboard?: InlineKeyboard }).keyboard!}
                />
              ) : null}
              {previewCards}
              {shownAttachments.length ? <div className="attachments">{attachmentViews}</div> : null}
              {hasReactions ? <div className="reactions">{reactionChips}</div> : null}
            </>
          )}
        </div>
        {actions}
      </div>
    </>
  );
});

interface MessageListProps {
  messages: Message[];
  meId: string | undefined;
  newSince: number | null | undefined;
  /** Беседа (шаг 2г): черта «новые» по ключу прочитанного; не передан — по метке визита `newSince`. */
  readKey?: number | null;
  /** Id сообщений, с которыми сейчас работают (меню, пикер, шторка, правка в поле), — у их строк рамка `active`. */
  menuId: string | undefined;
  pickerId: string | undefined;
  composerEditId: string | undefined;
  nameOf: (userId: string, fallback: string) => string;
  animatedOf: (userId: string | undefined) => string | undefined;
  guestHomeOf: (userId: string | undefined) => GuestHome;
  /** Э5: имена инстансов для подписи «через «X»» (свой / собеседника); нет — подписи нет. */
  viaNames?: { self?: string; peer?: string } | null;
  crownId: string | undefined;
  canReact: boolean;
  kbChannel?: string;
  canBig: boolean;
  canDeleteOthers: boolean;
  onEmoji: EmojiResolver | undefined;
  emojiById: (id: string) => ServerEmoji | null;
  act: RowActions;
  /** ЛС как в Telegram — пузыри (Р13). */
  bubbles: boolean;
  /** Широкая лента «все слева» — аватары у групп (`MessageRow.avatars`). */
  avatars: boolean;
  /** Группа ЛС (`groups1`): имена и аватары чужих, служебные записи (`MessageRow.groupChat`). */
  groupChat: boolean;
  /** `nameOf` и для цитат ответа / «Переслано от» (ЛС, `peerName.ts`); в канале — нет. */
  quoteNames: boolean;
  /** Строка, которую держит палец (долгое нажатие), — у пузыря отклик `pressing`. */
  pressingId: string | null;
  /** Подписи закреплённых для служебной строки «X закрепил(а) …» (G28): закреплённое может быть вне окна ленты. */
  pinTails: ReadonlyMap<string, string> | null;
  /** «Перезвонить» у записи о звонке (С5, `calls1`); нет — записи без кнопки. */
  onRedial?: () => void;
  /** Сообщения ленты по id: цитата смотрит на цитируемое (`replyQuoteLook`). */
  byId: Map<string, Message> | null;
  /**
   * Первая строка «в пути» под лентой (только у пузырей): момент отправки, мс, и есть ли у неё цитата. С ней сверяется
   * «хвостик» последнего сохранённого — серия своих продолжается в строки «в пути» одной группой. Числа, а не объект:
   * лента — `memo`.
   */
  outAt: number | null;
  outReply: boolean;
  /**
   * «Прочитано до» собеседника (Р6, только у пузырей ЛС 1:1): свои с `sortKey` не больше — ✓✓. `null` — отметок
   * «прочитано» нет. Число — `memo` ленты не рвётся; строкам уходит уже булево `read`.
   */
  peerReadKey: number | null;
  /** Раунд 12: режим выделения (только пузыри ЛС). */
  selecting: boolean;
  /** Выбранные id — один набор на выбор (без выделения — всегда `NO_PICKED`); строкам уходит булево `picked`. */
  picked: ReadonlySet<string>;
  /** Рисовать «Переслано от» (раунд 12 — пузыри за переключателем). */
  forwards: boolean;
  /** Сообщение, которое палец ведёт свайп-ответом (раунд 12, порция 6); строкам уходит булево `swiping`. */
  swipingId: string | null;
}

/** Вид вложений сообщения ленты для служебной строки «закрепил(а) фото»: по типу первого вложения; стикер — своим видом. */
function mediaOfMessage(m: Message): PinMedia | null {
  if (m.sticker) return 'sticker';
  const a = m.attachments?.[0];
  if (!a) return null;
  if (a.contentType.startsWith('image/')) return 'photo';
  if (a.contentType.startsWith('audio/')) return 'voice';
  if (a.contentType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Последнее в своей группе — у пузыря «хвостик» (и аватар в широкой ленте): следующее не склеивается с ним (другой
 * автор, пауза, ответ — `isGrouped`), начинает новый день — или следующего нет. Одно правило для сохранённых и для
 * строк «в пути» под лентой (ревью раунда 10, 03.10): серия своих — одна группа, и в переходе «сохранённые → в пути»
 * тоже; иначе у последнего сохранённого и у строки «в пути» под ним стояло по хвостику.
 */
function endsGroup(row: ListMessage, next: ListMessage | undefined): boolean {
  return !next || !isGrouped(next, row) || isNewDay(next, row);
}

/**
 * Вся лента сообщений — тоже `memo` (фаза 0.4 ЛС): набор текста, флаг «у низа», подсказка подгрузки и прочее
 * состояние `MessagePane` её пропсы не трогают, поэтому такая перерисовка обходит ленту целиком, а не сравнивает
 * тысячи строк по одной.
 */
/** Автор строки для склейки серий: у служебной строки (закреп, действие в группе) — своя метка, она не склеивается ни с кем. */
function rowAuthor(m: Message): string {
  if (pinServiceMark(m as { service?: unknown }) || groupServiceMark(m as { service?: unknown })) return `service:${m.id}`;
  // Вебхук (#24): у всех его сообщений одна строка-автор, а имя и аватар — свои у каждого. Склеиваем только подряд идущие
  // с тем же именем и аватаром, иначе «CI» и «Мониторинг» через один вебхук слились бы под одним именем (как у Discord).
  return m.webhookId ? `webhook:${m.webhookId}:${m.author.displayName}:${m.author.avatarUrl ?? ''}` : m.author.id;
}

/** Задержка въезда строки (`MessageRow.appear`): `undefined` — не въезжает (не новая или давно замечена). */
function appearOf(at: [number, number] | undefined, now: number): number | undefined {
  return at && now - at[0] < APPEAR_MS ? at[1] : undefined;
}

/** Строка ленты сейчас на экране (пусть краем)? Читается во время отрисовки — старая строка ещё в разметке. */
function rowOnScreen(id: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector(`.messages [data-mid="${CSS.escape(id)}"]`);
  const box = el?.closest('.messages');
  if (!el || !box) return false;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return r.bottom > b.top && r.top < b.bottom;
}

const MessageList = memo(function MessageList(props: MessageListProps) {
  /* Движение пузырей (polish-feed2, как у Telegram): пришедшее в хвост въезжает снизу (своё — строкой «в пути», её
     сохранённая копия уже не въезжает), удалённое на экране схлопывается. Сравнение с прошлой лентой — во время
     отрисовки (`bubbleMotion`), без лишнего прохода; удалённое вне экрана уходит сразу, как раньше, — прокрутку не трогает. */
  const prevList = useRef<readonly Message[] | null>(null);
  // id → [когда замечено, задержка анимации, мс]: своё сохранённое продолжает въезд строки «в пути» с того же места.
  const appearAt = useRef(new Map<string, [number, number]>());
  const lastOutAt = useRef<number | null>(null);
  const [leaving, setLeaving] = useState<Leaving<Message>[]>([]);
  const now = Date.now();
  const outAt = lastOutAt.current;
  if (props.outAt !== null) lastOutAt.current = props.outAt;
  if (props.bubbles && prevList.current !== props.messages) {
    const prev = prevList.current;
    prevList.current = props.messages;
    for (const [id, [t]] of appearAt.current) if (now - t > APPEAR_MS) appearAt.current.delete(id);
    if (prev && !reducedMotion()) {
      const byId = new Map(props.messages.map((m) => [m.id, m]));
      for (const id of freshTail(prev, props.messages)) {
        if (byId.get(id)?.author.id !== props.meId) appearAt.current.set(id, [now, 0]);
        // Своё: въезжала строка «в пути» (`.outgoing`, с момента отправки `outAt`) — сохранённая продолжает с того же места.
        else if (outAt !== null && now - outAt < APPEAR_MS) appearAt.current.set(id, [now, outAt - now]);
      }
      const gone = removedInPlace(prev, props.messages).filter((g) => rowOnScreen(g.row.id));
      if (gone.length) setLeaving((l) => [...l.filter((x) => !gone.some((g) => g.row.id === x.row.id)), ...gone]);
    }
  }
  useEffect(() => {
    if (leaving.length === 0) return;
    const t = setTimeout(() => setLeaving([]), LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  const ghostIds = new Set(leaving.map((g) => g.row.id));
  // Дальше — прежняя отрисовка; удалённые на время схлопывания вставлены в `p.messages` за своими соседями.
  const p: MessageListProps = leaving.length === 0 ? props : { ...props, messages: withLeaving(props.messages, leaving) };
  const unreadAt = p.readKey === undefined ? null : firstUnreadIndex(p.messages, p.meId, p.readKey);
  // Первая строка «в пути» — продолжение ленты для «хвостика» последнего сохранённого (`endsGroup`).
  const outRow: ListMessage | undefined =
    p.outAt === null
      ? undefined
      : { createdAt: new Date(p.outAt).toISOString(), authorId: p.meId ?? '', hasReply: p.outReply };
  return (
    <>
      {p.messages.map((m, i) => {
        const prev = p.messages[i - 1];
        // First message newer than the last visit — and not mine, since my own message isn't news
        // to me. Rendered once, above that message.
        // Служебная запись группы (`groups1`) склейку рвёт с обеих сторон: у неё свой «автор».
        // Пузыри ЛС: ответ серию НЕ рвёт, как у Telegram (tdesktop `computeIsAttachToPrevious`, tweb `canItemsBeGrouped` —
        // про ответ ни слова; решение владельца 08.10); рвёт он только плоскую ленту каналов (Discord).
        const row = { createdAt: m.createdAt, authorId: rowAuthor(m), hasReply: !p.bubbles && !!m.replyTo };
        const prevRow = prev ? { createdAt: prev.createdAt, authorId: rowAuthor(prev) } : undefined;
        const mine = m.author.id === p.meId;
        const grouped = isGrouped(row, prevRow);
        const newDay = isNewDay(row, prevRow);
        // Служебная строка «X закрепил(а) сообщение» (G28, `pins2`): пилюля по центру, нажатие — к закреплённому. Это не сообщение:
        // ни меню, ни выделения, ни реакций; `data-mid` — чтобы лента знала место (слежение полосы закрепа, переходы).
        const svc = p.bubbles ? pinServiceMark(m as { service?: unknown }) : null;
        if (svc) {
          const target = p.byId?.get(svc.messageId);
          const tail = target ? pinServiceTail(target.content, mediaOfMessage(target)) : (p.pinTails?.get(svc.messageId) ?? 'сообщение');
          return (
            <Fragment key={m.id}>
              {newDay && <DayDivider label={dayLabel(m.createdAt)} pill />}
              <div className="svc-pin" role="status" data-mid={m.id} data-svc="pin">
                <span>
                  <button type="button" className="svc-pin-btn" onClick={() => p.act.jumpTo(svc.messageId)}>
                    {pinServiceLead(mine, p.nameOf(m.author.id, m.author.displayName))} <b>{tail}</b>
                  </button>
                </span>
              </div>
            </Fragment>
          );
        }
        /* Действие в группе (`groups1`, тот же `ConvMessage.service`, вид `group`): «Имя добавил(а) Имя» — пилюлей по центру, как
           дата (Telegram `HistoryService` рисует служебное тем же видом, что и дневную метку). Текст собран сервером
           (`groupRules.serviceText`). Незнакомый вид служебной строки — обычное сообщение с запасным текстом (правило 11). */
        const groupSvc = p.bubbles ? groupServiceMark(m as { service?: unknown }) : null;
        if (groupSvc) {
          const firstUnread = unreadAt === null ? isFirstUnread(row, prevRow, p.meId, p.newSince) : i === unreadAt;
          return (
            <Fragment key={m.id}>
              {newDay && <DayDivider label={dayLabel(m.createdAt)} pill />}
              {firstUnread && (
                <div className="new-divider" role="separator" aria-label="Непрочитанные сообщения">
                  <span>Непрочитанные сообщения</span>
                </div>
              )}
              <div className="msg-service" role="status" data-mid={m.id} data-svc="group">
                {/* G6: «Имя удалил(а) вас» — глазами читателя (`groupServiceLabel`). */}
                <DayDivider label={groupServiceLabel(groupSvc, m.content, p.meId)} pill />
              </div>
            </Fragment>
          );
        }
        /* Запись о звонке (08.10, С5, `calls1` → `calls2`, G68; Telegram `messageActionPhoneCall`, tdesktop
           `HistoryView::Call`): пузырь от звонившего — свой справа, чужой слева. Первой строкой — «Исходящий / Входящий /
           Пропущенный / Отменённый / Отклонённый звонок (видеозвонок)» глазами читателя (`callServiceTitle`), второй — стрелка
           направления (↗ исходящий, ↙ входящий; пропущенный и отклонённый — красная) и «14:05, 3 мин»; справа — трубка или
           камера. Нажатие на пузырь — перезвонить. */
        const callSvc = p.bubbles ? callServiceMark(m as { service?: unknown }) : null;
        if (callSvc) {
          const firstUnread = unreadAt === null ? isFirstUnread(row, prevRow, p.meId, p.newSince) : i === unreadAt;
          const missed = callSvc.reason === 'missed' || callSvc.reason === 'busy';
          const title = callServiceTitle(callSvc, mine);
          const status = callRecordStatus(TIME_FMT.format(new Date(m.createdAt)), callSvc.duration);
          return (
            <Fragment key={m.id}>
              {newDay && <DayDivider label={dayLabel(m.createdAt)} pill />}
              {firstUnread && (
                <div className="new-divider" role="separator" aria-label="Непрочитанные сообщения">
                  <span>Непрочитанные сообщения</span>
                </div>
              )}
              <MessageBubble side={mine ? 'out' : 'in'} className="svc-call" data-mid={m.id} data-svc="call">
                <button
                  type="button"
                  className="svc-call-btn"
                  disabled={!p.onRedial}
                  title={p.onRedial ? 'Перезвонить' : undefined}
                  aria-label={`${title}, ${status}${p.onRedial ? '. Перезвонить' : ''}`}
                  onClick={p.onRedial}
                >
                  <span className="svc-call-body">
                    <span className="svc-call-text">{title}</span>
                    <span className="svc-call-time">
                      <span className={`svc-call-arrow ${mine ? 'out' : 'in'}${missed ? ' missed' : ''}`} aria-hidden="true">
                        <Icon name="arrow-up-right" size={14} />
                      </span>
                      {status}
                    </span>
                  </span>
                  <span className="svc-call-ico" aria-hidden="true">
                    <Icon name={callSvc.video ? 'camera' : 'phone'} size={22} />
                  </span>
                </button>
              </MessageBubble>
            </Fragment>
          );
        }
        // «Хвостик» — у последнего в группе: следующее не склеивается с этим (другой автор, пауза, ответ, новый день).
        const next = p.messages[i + 1];
        const tail = endsGroup(
          row,
          next ? { createdAt: next.createdAt, authorId: rowAuthor(next), hasReply: !p.bubbles && !!next.replyTo } : outRow,
        );
        return (
          <MessageRow
            key={m.id}
            m={withoutMediaFallback(m)}
            grouped={grouped}
            firstUnread={unreadAt === null ? isFirstUnread(row, prevRow, p.meId, p.newSince) : i === unreadAt}
            unreadText={p.readKey === undefined ? 'Новые сообщения' : 'Непрочитанные сообщения'}
            newDay={newDay}
            mine={mine}
            active={
              p.menuId === m.id || p.pickerId === m.id || p.composerEditId === m.id
            }
            // Имя автора — через резолвер: в канале сервера это ник, в ЛС остаётся обычное имя (#73).
            author={p.nameOf(m.author.id, m.author.displayName)}
            animatedUrl={p.animatedOf(m.author.id)}
            crowned={p.crownId === m.author.id}
            guestHome={p.guestHomeOf(m.author.id)}
            viaText={viaCaption((m as { via?: { instance: string; confirmed: boolean } }).via, mine, p.viaNames)}
            canReact={p.canReact}
            canBig={p.canBig}
            kbChannel={p.kbChannel}
            canDelete={mine || p.canDeleteOthers}
            onEmoji={p.onEmoji}
            emojiById={p.emojiById}
            act={p.act}
            bubbles={p.bubbles}
            tail={p.bubbles && tail}
            avatars={p.avatars}
            groupChat={p.groupChat}
            quoteNameOf={p.quoteNames ? p.nameOf : undefined}
            replyOf={m.replyTo && p.byId ? p.byId.get(m.replyTo.id) : undefined}
            pressing={p.pressingId === m.id}
            // ✓✓ (Р6): сообщение беседы несёт `sortKey` (`ConvMessage`); нет его — остаётся ✓.
            read={p.bubbles && mine && readByPeer((m as { sortKey?: number }).sortKey, p.peerReadKey)}
            selecting={p.selecting}
            picked={p.selecting && p.picked.has(m.id)}
            // Серия пересланных от одного автора — строка у первого; дневная метка между ними склейку рвёт.
            fwdLine={p.forwards && showsForwardedFrom(m, prev, grouped && !newDay)}
            swiping={p.swipingId === m.id}
            appear={ghostIds.has(m.id) ? undefined : appearOf(appearAt.current.get(m.id), now)}
            ghost={ghostIds.has(m.id)}
          />
        );
      })}
    </>
  );
});

/** Сколько после ввода человека на ленте её прокрутка считается его делом (и сколько живёт цепочка кадров прокрутки). */
const HUMAN_SCROLL_MS = 300;
/** Клавиши, которыми листают ленту. Повтор зажатой — не новый ввод: прокрутку дальше ведёт цепочка кадров. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** Событие на ленте: её листает человек клавишей ИЗ ПОЛЯ ВВОДА (там фокус, и окно клавиш прокрутки пропускает). */
const FEED_KEY_SCROLL = 'gv:feed-key-scroll';

/**
 * Плавающая дата ленты пузырей (раунд 10): ОДНА пилюля поверх ленты — день верхнего видимого сообщения, пока листают;
 * через 1,5 с без прокрутки гаснет. Если в полосе под пилюлей виден настоящий разделитель дня — пилюли нет, чтобы
 * не двоились. Своё состояние и свой слушатель прокрутки: кадр прокрутки перерисовывает только её, а не ленту
 * (фаза 0.4: перерисовка `MessagePane` стоит дорого). Пилюля сама `pointer-events: none` — в `elementFromPoint` не
 * попадает, под ней видно строку.
 * 🔴 Только когда листает ЧЕЛОВЕК (ревью 03.10). Лента ездит и сама — открытие беседы (`stickDown`), пришедшее или своё
 * сообщение у низа, догрузка картинок, пропавшее «печатает…», — и пилюля мигала «Сегодня» над тем, кто просто сидит
 * внизу. Прокрутка — его, если за `HUMAN_SCROLL_MS` до неё был ввод на ленте (колесо, палец, клавиши прокрутки, нажатие
 * на саму ленту — это полоса прокрутки) или если она продолжает такую же прокрутку: инерция после пальца, плавная
 * прокрутка клавишами, тяга ползунка идут кадрами без нового ввода.
 * «Меньше движения» (`HANDOFF.md` §5 «без переходов»): переходы снимают стили, а гаснет пилюля по тому же таймеру —
 * сразу, без угасания («не гаснет, пока нужна» — пока листают, а не навсегда).
 * 🔴 Не липкие разделители: в одном контейнере прокрутки прилипший не уезжает, следующий наезжает на него, переход по
 * якорю ломается — так уже было с заголовками групп настроек (19.09).
 */
function FloatingDay({
  listRef,
  dayOf,
  onPick,
}: {
  listRef: React.RefObject<HTMLDivElement>;
  dayOf: (messageId: string) => string | null;
  /** Нажатие на пилюлю — календарь «Перейти к дате» на этом дне (G25, tdesktop `DateClickHandler`); без него — не кнопка. */
  onPick?: (messageId: string) => void;
}) {
  const [shown, setShown] = useState<{ day: string; on: boolean; mid?: string }>({ day: '', on: false });
  const dayOfRef = useRef(dayOf);
  dayOfRef.current = dayOf;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    let hide: number | null = null;
    /** Последний ввод человека на ленте — или последний кадр прокрутки, которую он начал. */
    let human = Number.NEGATIVE_INFINITY;
    const touched = () => {
      human = performance.now();
    };
    const look = () => {
      frame = 0;
      const box = list.getBoundingClientRect();
      const x = box.left + box.width / 2;
      let day: string | null = null;
      let dayMid: string | undefined;
      for (const dy of [12, 28, 44, 60]) {
        const hit = document.elementFromPoint(x, box.top + dy);
        if (!hit || !list.contains(hit)) continue;
        if (hit.closest('.day-divider')) {
          setShown((s) => (s.on ? { ...s, on: false } : s));
          return;
        }
        const mid = hit.closest<HTMLElement>('[data-mid]')?.dataset.mid;
        if (!day && mid) {
          day = dayOfRef.current(mid);
          dayMid = mid;
        }
      }
      if (!day) return;
      const label = day;
      setShown((s) => (s.on && s.day === label ? s : { day: label, on: true, mid: dayMid }));
      if (hide !== null) window.clearTimeout(hide);
      // 1 с, как у Telegram (tdesktop `kScrollDateHideTimeout`, G25); было 1,5 с.
      hide = window.setTimeout(() => setShown((s) => (s.on ? { ...s, on: false } : s)), FLOAT_DAY_HIDE_MS);
    };
    const onScroll = () => {
      const now = performance.now();
      // Ленту сдвинул код (низ при открытии, новое сообщение, догрузка картинки) — пилюлю не зовём.
      if (now - human > HUMAN_SCROLL_MS) return;
      human = now;
      if (!frame) frame = requestAnimationFrame(look);
    };
    /* Нажатие — только на саму ленту (полоса прокрутки): по строке это кнопка, ссылка или цитата. «Повторить» под
       неотправленным, например, убирает строку ошибки — лента короче, браузер сам сдвигает её, и это не прокрутка. */
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === list) touched();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !SCROLL_KEYS.has(e.key)) return;
      const t = e.target;
      // Фокуса нет — браузер листает то, по чему щёлкнули последним; это может быть лента. Фокус есть — только в ней.
      if (t instanceof Element && t !== document.body && t !== document.documentElement && t !== list) {
        // Пробел на кнопке строки нажимает её, а не листает; в поле правки клавиши — это текст.
        if (!list.contains(t) || e.key === ' ' || t.closest('input, textarea, select, [contenteditable]')) return;
      }
      touched();
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    list.addEventListener('wheel', touched, { passive: true });
    list.addEventListener(FEED_KEY_SCROLL, touched);
    list.addEventListener('touchmove', touched, { passive: true });
    list.addEventListener('pointerdown', onPointerDown, { passive: true });
    // Клавиши — с окна: без фокуса (щёлкнули по тексту ленты) событие приходит в `body`, а листается лента.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      list.removeEventListener('scroll', onScroll);
      list.removeEventListener('wheel', touched);
      list.removeEventListener(FEED_KEY_SCROLL, touched);
      list.removeEventListener('touchmove', touched);
      list.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
      if (frame) cancelAnimationFrame(frame);
      if (hide !== null) window.clearTimeout(hide);
    };
  }, [listRef]);
  if (!shown.day) return null;
  return (
    <div
      className={`${shown.on ? 'bub-float on' : 'bub-float'}${onPick ? ' can-pick' : ''}`}
      aria-hidden="true"
      onClick={onPick && shown.mid ? () => onPick(shown.mid!) : undefined}
    >
      <DayDivider label={shown.day} pill />
    </div>
  );
}

/** Человек просил меньше движения — прокрутка без плавности. */
function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Сколько после отпускания пальца, открывшего лист долгим нажатием, ждём лишний `click`, чтобы его проглотить. */
const LP_CLICK_GUARD_MS = 400;

/**
 * Проглотить ОДИН `click` в ближайшие `LP_CLICK_GUARD_MS` — запасной вариант к `preventDefault()` на `touchend` долгого
 * нажатия (`swallowNativeLongPress`): если браузер всё же синтезирует клик, он не нажмёт строку листа, открывшегося под
 * пальцем. Окно короткое — следующее настоящее нажатие человек за него не успеет.
 */
function swallowNextClick() {
  const timer = window.setTimeout(off, LP_CLICK_GUARD_MS);
  window.addEventListener('click', eat, true);
  function off() {
    window.clearTimeout(timer);
    window.removeEventListener('click', eat, true);
  }
  function eat(e: MouseEvent) {
    off();
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/**
 * Раунд 12: проглотить ОДИН `click` — с этой минуты и до `LP_CLICK_GUARD_MS` после вызова возвращённой функции (палец
 * поднят). Запасной вариант для меню у пузыря, открытого долгим нажатием: меню встаёт, пока палец ещё держит строку, и
 * его слушатель «клик мимо» (захват на `window`) встал бы раньше, чем `swallowNextClick` из `touchend`, — клик того же
 * касания, если браузер его всё же соберёт, закрыл бы меню. Этот слушатель встаёт до открытия меню и срабатывает первым.
 */
function holdNextClick(): () => void {
  let timer: number | null = null;
  window.addEventListener('click', eat, true);
  function off() {
    if (timer !== null) window.clearTimeout(timer);
    window.removeEventListener('click', eat, true);
  }
  function eat(e: MouseEvent) {
    off();
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  return () => {
    if (timer === null) timer = window.setTimeout(off, LP_CLICK_GUARD_MS);
  };
}

/** Фокус в поле ввода (текстовое поле, `contenteditable`): его каретку не трогаем — на телефоне за ней держится клавиатура. */
function fieldFocused(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLElement && (a.isContentEditable || a.matches('textarea, input'));
}

/**
 * Меню у пузыря (раунд 12): прямоугольник пузыря (`anchor`), полоса строки, которая остаётся яркой под подложкой
 * (`spotlight`), и край пузыря, к которому прижат блок (`align`: своё в ЛС — справа). Всё экранное, как из
 * `getBoundingClientRect()`, — вёрсточное считает `ContextMenu`.
 */
type BubbleSpot = { anchor: DOMRect; spotlight: MenuSpotlight; align: MenuAlign };

/**
 * Жест свайп-ответа (раунд 12, порция 6): строка (её DOM пишет каждое движение пальца), откуда пошёл палец, прокрутка
 * ленты в начале касания (поехала — прокрутку начал браузер), решено ли, что это свайп (`on`), взвод и снятие слушателей
 * конца жеста с окна (`off`).
 */
type SwipeGesture = {
  id: string;
  row: HTMLElement;
  x: number;
  y: number;
  top: number;
  on: boolean;
  armed: boolean;
  off: (() => void) | null;
  /** Пределы жеста: палец — Android, тачпад — Web K (`messagePaneRules.SWIPE_TOUCH / SWIPE_WHEEL`). */
  lim: SwipeLimits;
  /** Смещение пальца по горизонтали в момент начала жеста: сдвиг пузыря считается от него (Android переносит точку отсчёта). */
  base: number;
  /** Вибро-отклик на пороге уже был в этом жесте — один раз. */
  buzzed: boolean;
};

/**
 * Выделение мышью (замечание владельца 05.10; правила — `dmSelection.ts`): точка и строка нажатия (`from`) — нажатие
 * рядом с пузырём или в режиме выделения (`selectPress`; по самому пузырю жеста нет — там выделяют текст), выбранные до
 * протяжки (`base`) и что протяжка с ними делает (`add` — добавляет, иначе снимает), идёт ли она (`on`), сработало ли
 * удержание (`held`), снята ли Esc (`dead` — до отпускания), последняя точка указателя и строка под ним (`at`), таймер
 * удержания, кадр автопрокрутки (`tick` — время прошлого кадра, `rest` — недокрученная доля пикселя) и снятие слушателей
 * окна (`off`). Пока выделяют, указатель захвачен лентой (`list`, `pointerId`): шапка и поле под ним не подсвечиваются
 * наведением — как у Telegram, где мышь держит лента.
 */
type SelGesture = {
  list: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  from: string;
  base: readonly string[];
  add: boolean;
  on: boolean;
  held: boolean;
  dead: boolean;
  px: number;
  py: number;
  at: string | null;
  timer: number | null;
  frame: number;
  tick: number;
  rest: number;
  off: () => void;
  /** Палец (G43): жест ведёт `touchmove` окна, а не указатель мыши; `moved` — палец ушёл дальше `SELECT_TOUCH_SLOP_PX`. */
  touch: boolean;
  moved: boolean;
};

/** Меню у пузыря стоит там же — новое состояние не нужно: иначе каждый кадр прокрутки перерисовывал бы `MessagePane`. */
function sameSpot(a: BubbleSpot, b: BubbleSpot): boolean {
  return (
    a.anchor.left === b.anchor.left &&
    a.anchor.top === b.anchor.top &&
    a.anchor.right === b.anchor.right &&
    a.anchor.bottom === b.anchor.bottom &&
    a.spotlight.top === b.spotlight.top &&
    a.spotlight.bottom === b.spotlight.bottom &&
    a.align === b.align
  );
}

/**
 * Окно уже ширины, с которой `ContextMenu` по точке становится листом (≤ 620 px): меню сообщения нового вида встаёт там у
 * пузыря, как на телефоне (вид «по точке с полосой реакций» на узком экране макетом не задан).
 */
function narrowWindow(): boolean {
  return window.matchMedia('(max-width: 620px)').matches;
}

/**
 * Телефон (раунд 12): палец и раскладка телефона. Только тогда тап по пузырю открывает меню и пузырь отвечает свайпом.
 * Палец ли — по самому нажатию (`touch`, `messagePaneRules.pressByTouch`, 05.10): медиазапрос говорит об устройстве, а не о
 * нажатии (у S25 Ultra со стилусом `any-pointer: fine` истинно). Не сказано (`null`) — по основному указателю, как раньше.
 */
/** Есть ли между целью и строкой блок со своей горизонтальной прокруткой (код, таблица): жест по нему — его, не свайп. */
function scrollsSideways(from: Element, row: Element): boolean {
  for (let el: Element | null = from; el && el !== row; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

/**
 * Полоса быстрых реакций при наведении (G44) встаёт над кнопкой; если над ней до края ленты тесно (< 56 px), — под неё.
 * Решаем на входе мыши и пишем в `data-flip` самой обёртки: состояние React строке не нужно.
 */
function flipReactPop(e: React.SyntheticEvent<HTMLElement>) {
  const el = e.currentTarget;
  const feed = el.closest('.messages');
  const room = el.getBoundingClientRect().top - (feed?.getBoundingClientRect().top ?? 0);
  el.dataset.flip = room < 56 ? 'down' : '';
}

/** Сколько после `resize` окна (клавиатура) смена высоты ленты считается её следствием и держит низ ленты (B9, 10.10). */
const VIEWPORT_ANCHOR_MS = 400;

function phoneTaps(touch: boolean | null = null): boolean {
  return (touch ?? window.matchMedia('(pointer: coarse)').matches) && window.matchMedia('(max-width: 760px)').matches;
}

/**
 * Момент отправки строки «в пути», мс: у очереди бесед — `OutboxItem.createdAt`, у старой отправки — свой, с постановки
 * в ленту (`submit`). По нему время в пузыре и группировка с соседями.
 */
function outSentAt(o: object): number | null {
  return 'createdAt' in o && typeof o.createdAt === 'number' ? o.createdAt : null;
}

/**
 * Окно ленты беседы (ЛС, шаг 2г, `feedWindowRules.ts`): в ленте кусок истории, а не всё подряд. Лента подтягивает
 * старое сверху и новое снизу, держит прокрутку якорем, переходит к цитате и обратно, помнит место.
 */
export interface FeedWindowProps {
  /** Выше окна есть ещё (подгрузка вверх). */
  hasOlder: boolean;
  /** Ниже окна есть ещё — окно не у хвоста беседы (открыли у непрочитанного, перешли к цитате). */
  hasNewer: boolean;
  loadNewer: () => Promise<boolean>;
  /** «Вниз»: последние сообщения беседы. */
  jumpLatest: () => Promise<void>;
  /** К сообщению: окно заменяется его окрестностью, если его нет в окне. `false` — сообщения больше нет. */
  jumpTo: (messageId: string) => Promise<boolean>;
  /** Непрочитанных в беседе — счётчик «Вниз», пока окно не у хвоста (свежее туда не попадает). */
  unreadBelow: number;
  /** Где встать при открытии, если не к непрочитанному (`null` — снизу). Читается при смене ленты. */
  place: FeedPlace | null;
  /** Запомнить место: при остановке прокрутки и уходе (`null` — человек внизу). */
  onPlace: (p: FeedPlace | null) => void;
  /** Ключ прочитанного на момент открытия — черта «Новые сообщения». */
  readKey: number | null;
  /** Окно из кеша на диске (после перезагрузки): беседа уже просит свежую порцию, и та заменит окно целиком. */
  stale?: boolean;
}

/**
 * Действия над сообщениями беседы пачкой (раунд 12, порция 5): пересылка, удаление выделенного. Даёт только ЛС в режиме
 * бесед у сервера с `conv5` (`DmChatView`); ленты без них (каналы, старый сервер) — без «Переслать»,
 * «Выделить» и выделения. Ошибку сети или сервера каждое действие бросает — тост показывает лента.
 */
export interface MessageBatch {
  /**
   * Переслать сообщения этой ленты (по порядку ленты) в беседу `to`; ответ сервера уже в сторе. `opts.from` — сообщения
   * ДРУГОЙ беседы (черновик пересылки в поле этой, `fwdDrafts`); нет — этой.
   */
  forward: (
    messageIds: string[],
    to: string,
    silent?: boolean,
    opts?: { hideSender?: boolean; hideCaptions?: boolean; from?: string },
  ) => Promise<void>;
  /** Сервер умеет переслать «без звука» (С3, `conv8`): в «⋯» окна «Переслать в…» есть «Отправить без звука». */
  silentForward?: boolean;
  /** Сервер умеет «скрыть имя отправителя / подписи» (G71, `fwd2`): в окне есть переключатели. */
  hideOptions?: boolean;
  /** «Комментарий» окна «Переслать в…» (G71): текст отдельным сообщением в беседу `to`, до пересланных. Нет — поля нет. */
  comment?: (to: string, content: string, silent: boolean) => Promise<void>;
  /**
   * «Отправить позже» из окна «Переслать в…» (G71): тексты (по порядку, комментарий первым) — отложенными в беседу `to`.
   * Только текст: вложения в отложенные не пересылаются, и без этого поля пункта «позже» в окне нет.
   */
  later?: (to: string, texts: string[], at: Date, silent: boolean) => Promise<void>;
  /** Удалить пачкой: `both` — у обоих, `me` — у себя; ответ уже в сторе. */
  deleteMany: (messageIds: string[], scope: 'me' | 'both') => Promise<void>;
  /**
   * G56 (`album1`): переслать ОДИН элемент альбома — новое сообщение с ним одним. Нет — пунктов «одного элемента» нет, просмотр
   * и меню пересылают сообщение целиком, как раньше.
   */
  forwardItem?: (messageId: string, attachmentId: string, to: string, silent?: boolean, opts?: { hideSender?: boolean }) => Promise<void>;
  /** G56 (`album1`): убрать ОДИН элемент альбома (`both` — у всех, только своё; `me` — у себя). Последний — сообщение целиком. */
  deleteItem?: (messageId: string, attachmentId: string, scope: 'me' | 'both') => Promise<void>;
  /** Имя собеседника беседы — для плашки «Переслано: <имя>». */
  peerName: (conversationId: string) => string;
  /** «Открыть» на плашке — к беседе получателя. */
  open: (conversationId: string) => void;
}

/**
 * Закреп в ЛС (раунд 12, порция 7; сервер С2, `conv7`): мои закреплённые этой беседы и действия с ними. Даёт только
 * `DmChatView` в режиме бесед у сервера с признаком. Нет пропа —
 * ни «Закрепить» в меню, ни полосы под шапкой. Ошибку сети или сервера действия бросают — тост показывает лента.
 */
export interface MessagePins {
  /** Мои закреплённые — от старых к новым по ленте (`ConvPin`: превью, миниатюра, «для обоих»). */
  list: readonly ConvPin[];
  /**
   * Закрепить: `both` — ещё и у собеседника. Ответ сервера уже в сторе. `notify` — только группа: галочка «Уведомить всех
   * участников» (G4); в 1:1 не передаётся.
   */
  pin: (messageId: string, scope: 'me' | 'both', notify?: boolean) => Promise<void>;
  /** Открепить: `both` — и закреп «для обоих» у собеседника. Ответ сервера уже в сторе. */
  unpin: (messageId: string, scope: 'me' | 'both') => Promise<void>;
}

/**
 * Раунд 12, порция 8 — меню кнопки «Отправить» и «Отложенные» (сервер С3 `conv8`, С4 `conv9`; HANDOFF §8). Даёт только
 * `DmChatView` в режиме бесед. Нет пропа — у кнопки «Отправить» меню
 * нет и входа «Отложенные» нет, как раньше. Пункт, которого сервер не объявил, — `false` (его нет в меню).
 */
export interface MessageSendMenu {
  /** «Отправить без звука» (С3): строка очереди уходит с `silent`. */
  silent: boolean;
  /** «Отправить позже» (С4): окно `SchedPick`. */
  later: boolean;
  /**
   * «Когда будет в сети» (С4) — в любом статусе собеседника (решение владельца 05.10): в сети — уйдёт на ближайшем такте
   * планировщика сервера.
   */
  whenOnline: boolean;
  /**
   * Сервер принимает отложенные С ВЛОЖЕНИЯМИ (06.10, `conv10` — `convSyncRules.serverScheduledAttachments`): «позже» и
   * «когда в сети» доступны и с файлами в поле или в листе. Нет (старый сервер) — с файлами пункты серые, «Только текст,
   * без вложений».
   */
  media?: boolean;
  /**
   * Отложить: `at` — время, `null` — «когда будет в сети»; `files` — вложения (только при `media`; нет поля — только текст).
   * Отказ бросает — тост, текст и файлы в поле вернёт лента.
   */
  schedule: (item: {
    content: string;
    replyToId: string | null;
    at: Date | null;
    files?: File[];
    silent?: boolean;
    /** Из окна отправки файлов (G48): «как файл», индексы файлов под спойлером, подпись над медиа — только при признаках сервера. */
    asFile?: boolean;
    spoilers?: number[];
    captionAbove?: boolean;
  }) => Promise<void>;
  /** Сколько моих отложенных в беседе: больше нуля — в поле вход «Отложенные сообщения: N». */
  scheduledCount: number;
  /** Открыть вид «Отложенные». */
  openScheduled: () => void;
  /** Вид «Отложенные», пока открыт (`ScheduledView`): лента ставит его поверх себя, внутри `.chat`. */
  view?: ReactNode;
}

/** Ожидание места (`settlePlace`): `until` — срок догрузок у края окна, `applied` — строка уже стояла на месте. */
type PendingPlace = { kind: 'place'; place: FeedPlace; until?: number; applied?: boolean };

/**
 * Generic message list + composer (attachments, edit/delete, mentions). Used by both the
 * server channel chat and direct messages — the caller supplies the transport callbacks.
 */
export function MessagePane({
  title,
  placeholder,
  messages,
  meId,
  onSend,
  outbox: outboxProp,
  sendFlags,
  mediaFlags,
  quoteOn = false,
  draft,
  draftRemote,
  onDraftChange,
  onEdit,
  onDelete,
  deletePeerName,
  batch,
  deleteOthersForBoth = false,
  pins,
  sendMenu,
  onReact,
  onReactBig,
  reactorOf,
  onCopyLink,
  canModerate,
  onPin,
  loading,
  autocomplete,
  botPeer,
  botChannelId,
  newSince,
  scrollKey,
  feedId,
  onLoadOlder,
  onTyping,
  typingUsers,
  pollChannelId,
  onEscapeClose,
  emptyState,
  headerActions,
  composerReplacement,
  composerNotice,
  topBar,
  readOnly = false,
  filesBlocked,
  viaNames,
  composerNote,
  nameOf = PLAIN_NAME,
  onEmoji,
  customEmojis,
  emojiById = NO_EMOJI_BY_ID,
  stickerPacks,
  onSendSticker,
  onSendGif,
  onSendMedia,
  convPoll,
  geoLive,
  onSaveGif,
  stickerRecent,
  stickerCatalog,
  onStickerUsed,
  onSendVoice,
  voiceOnce: voiceOnceAllowed,
  mediaOnce = false,
  roundOk,
  serverId,
  feedWindow,
  chatSearch,
  cornerThings,
  bubbles = false,
  onRedial,
  groupChat = false,
  quoteNames = false,
  peerReadKey = null,
  readAtConvId = null,
  readersConvId = null,
  bigFiles = false,
  onSeen,
  loadMediaPage,
}: {
  /**
   * Медиатека беседы для просмотра (G11): порция истории старше (`-1`) или новее (`1`) сообщения `edge`, по порядку времени,
   * и есть ли дальше. Просмотр листает фото и видео всей беседы, а не только загруженного окна ленты: дошли до края —
   * лента тянет порции (ленту это не двигает, они живут, пока открыт просмотр). Нет — листается загруженное окно.
   */
  loadMediaPage?: (dir: -1 | 1, edge: Message) => Promise<{ messages: Message[]; more: boolean }>;
  title: ReactNode;
  placeholder: string;
  /**
   * Сервер, в котором открыт этот чат, — нужен ТОЛЬКО чтобы узнать носителя короны.
   * ⚠️ В личных сообщениях не передаётся, и это правильно: сезон принадлежит серверу, а не паре
   * собеседников. Нет сервера — нет короны, безо всяких условий на месте отрисовки.
   */
  serverId?: string;
  /** Окно ленты беседы (ЛС, шаг 2г). Каналы не передают — у их истории нет `after`/`around`. */
  feedWindow?: FeedWindowProps;
  /**
   * Поиск в беседе и «Перейти к дате» (G05, G25, признак `search1`; `ChatSearch.tsx`): лупа и пункт меню — у владельца,
   * Ctrl+F, шапка с полем, «N из M», календарь — здесь. Только ЛС с окном ленты: каналам нечем грузить «вокруг».
   */
  chatSearch?: ChatSearchSource;
  /**
   * Кнопки «@» и «♥» над «вниз» (G24, `cornerButtonsRules.ts`): счётчики и действия. Реакции читаются, когда сообщение с
   * `reactionUnread` побыло на экране (`onReactionsRead`), клик по «♥» — к самому старому (`onReactionsJump` отдаёт его id), ПКМ —
   * «Прочитать все реакции» (`onReactionsRead(null)`). Упоминания — зарезервировано под группы. Только беседы ЛС.
   */
  cornerThings?: {
    reactions?: number;
    mentions?: number;
    onReactionsJump?: () => Promise<string | null>;
    onMentionsJump?: () => Promise<string | null>;
    onReactionsRead?: (ids: string[] | null) => void;
  };
  /**
   * «Прочитано» по видимому (G09, `readByView.ts`): лента сообщает ключ последнего сообщения, чей нижний край в её окне,
   * — только когда человек смотрит (`canMarkRead`) и не до прыжка к черте «Новые». Беседы ЛС; каналы не передают.
   */
  onSeen?: (sortKey: number) => void;
  /** ЛС как в Telegram (Р13): пузыри, свои справа. Каналы не передают. */
  bubbles?: boolean;
  /** «Перезвонить» у записи о звонке в ленте (08.10, С5, `calls1`): беседа 1:1, сервер умеет звонки. */
  onRedial?: () => void;
  /** Группа ЛС (07.10, `groups1`): имена и аватары чужих над пузырями, служебные записи по центру. */
  groupChat?: boolean;
  /**
   * Подпись из моих контактов и в цитатах ответа / «Переслано от» (ЛС, 08.10, решение владельца п.27): `nameOf` у ЛС — это
   * `usePeerName` (`peerName.ts`). Канал сервера не передаёт — его цитаты остаются с именем из сообщения.
   */
  quoteNames?: boolean;
  /**
   * «Прочитано до» собеседника (ЛС 1:1, Р6 — `convSyncRules.peerReadKeyOf`): у пузырей свои сообщения с `sortKey` не
   * больше — ✓✓ «прочитано». Каналы и лента без пузырей не передают — отметок там нет.
   */
  peerReadKey?: number | null;
  /** Беседа 1:1 с «Прочитано в 12:34» в подвале меню своего прочитанного (С1, `lastseen1`); `null` — строки нет. */
  readAtConvId?: string | null;
  /**
   * Группа ЛС с «N прочитали» в меню своего прочитанного сообщения (15.10, `readers1`; Telegram «Seen by»); `null` — строки нет.
   * Взаимоисключающе с `readAtConvId` (тот — только 1:1).
   */
  readersConvId?: string | null;
  /** Лента бесед ЛС: предел файла — по серверу (`bigfile1`: до 512 МБ кусками, `attachRules.dmAttachMaxBytes`); нет — 25 МБ. */
  bigFiles?: boolean;
  messages: Message[];
  meId: string | undefined;
  /** History still loading — show shimmer skeletons instead of the empty state. */
  loading?: boolean;
  /**
   * `sendKey` — id отправки (UUID, ЛС этап 2): один на строку «в пути» и на все её повторы, поэтому сервер бесед
   * узнаёт повтор, а лента — своё сообщение, пришедшее раньше ответа. Каналы его не передают серверу.
   * «Отменить отправку» (07.10): сигнал отмены строки — `uploadProgress.uploadSignal(sendKey)` (его отдают `api.upload*`),
   * прогресс файлов — в `uploadProgress` по `sendKey`. Отменили, когда сообщение уже ушло, — зовущий его удаляет и
   * бросает `uploadAborted()`.
   */
  onSend: (content: string, files: File[], replyToId: string | null | undefined, sendKey: string) => Promise<void>;
  /**
   * Очередь исходящих снаружи (ЛС этап 2, шаг 2в): строки «в пути» живут в сторе по беседе и на диске, а не в этом
   * компоненте, — переживают смену беседы, вход в голос и перезапуск, повторяются сами. Нет — прежний список в
   * компоненте (каналы), и тогда отправка идёт через `onSend`.
   */
  /**
   * Черновик (ЛС этап 2, шаг 2д): что лежало в поле этой ленты в прошлый раз. Лента пересоздаётся при смене беседы и
   * при входе в голос — без этого набранное пропадало. Изменения уходят в `onDraftChange` (с задержкой и сразу при
   * пересоздании ленты); текст правки черновиком не считается.
   */
  draft?: { text: string; replyToId: string | null };
  /**
   * Черновик, пришедший с другого моего устройства (ЛС, Р7): новый `rev` — положить в поле, если человек здесь не
   * печатает (поле не в фокусе с текстом, последние 300 мс без букв) и не правит сообщение. Пусто — очистить поле
   * (погашен отправкой на другом устройстве).
   */
  draftRemote?: { text: string; replyToId: string | null; rev: number };
  onDraftChange?: (text: string, replyToId: string | null) => void;
  outbox?: {
    items: readonly (OutgoingMessage<File> & { fileNames?: string[] })[];
    enqueue: (item: {
      key: string;
      content: string;
      files: File[];
      replyToId: string | null;
      silent?: boolean;
      /** «Отправить как файлы» (G48, `linkprev1`) и «без превью» (G19): только при `sendFlags`. */
      asFile?: boolean;
      noPreview?: boolean;
      /** Спойлер (индексы файлов) и «подпись над медиа» (G48): только при `mediaFlags`. */
      spoilers?: number[];
      /** Одноразовое фото/видео (`ttlmedia1`, #226): 0 — «просмотр один раз», иначе таймер, с. Только у строки с одним файлом. */
      onceTtl?: number;
      captionAbove?: boolean;
      /** Цитата фрагмента (G55, `quote1`): ставит сама лента — по полосе ответа (`replyExtra`). */
      replyQuote?: ReplyQuoteDraft | null;
    }) => void;
    retry: (key: string) => void;
    discard: (key: string) => void;
  };
  /**
   * Сервер ЛС с признаком `quote1` (G55): «Ответить с цитатой» у выделенного текста, «Цитировать» у выделения пальцем,
   * Ctrl + «Ответить» — «Ответить в другом чате», нажатие на полосу ответа — окно параметров ответа (`ReplyOptions`).
   */
  quoteOn?: boolean;
  /**
   * Сервер ЛС с признаком `linkprev1` (G19 + G48): полоса превью ссылки над полем с крестиком «без превью» и подсказка
   * «как файл» у вложений. Без него полосы нет, а «Отправить как файлы» шлёт оригиналы без подсказки (как фото).
   */
  sendFlags?: boolean;
  /** Сервер ЛС с признаком `media2` (G48): в окне отправки файлов — «Высокое качество», спойлер, подпись над медиа. */
  mediaFlags?: boolean;
  onEdit: (m: Message, content: string) => Promise<void>;
  /** `scope` — только в ЛС (`deletePeerName`): «у меня» или «у обоих». В канале не передаётся. */
  onDelete: (m: Message, scope?: 'me' | 'both') => Promise<void>;
  /**
   * Имя собеседника — ЛС удаляет «как в Telegram» (#212, Р5): своё — «Удалить» с галочкой «Также удалить для
   * {имя}», чужое — только у себя. Не передан (канал) — удаление как было: своё или модератором, у всех.
   */
  deletePeerName?: string;
  /**
   * Раунд 12, порция 5 — пересылка, выделение, удаление пачкой (`MessageBatch`; только ЛС в режиме бесед, `conv5`). Нет
   * пропа — лента без пересылки, выделения и удаления пачкой.
   */
  batch?: MessageBatch;
  /**
   * Сервер удаляет чужое «у обоих» (С1, `conv6`, режим бесед): у чужого в окне удаления — галочка «Также удалить для
   * собеседника», в пачке галочка — на все выбранные. Без признака у чужого галочки нет (только «у себя»), в пачке она —
   * только на мои. Только за переключателем пузырей.
   */
  deleteOthersForBoth?: boolean;
  /**
   * Закреп в ЛС (раунд 12, порция 7, `MessagePins`): «Закрепить» / «Открепить» в меню сообщения, полоса закрепа под шапкой
   * и список всех закреплённых. Только за переключателем пузырей; без него лента такая же, как без этого пропа.
   */
  pins?: MessagePins;
  /**
   * Меню кнопки «Отправить» и «Отложенные» (раунд 12, порция 8, `MessageSendMenu`): без звука, позже, когда в сети, вход и
   * вид отложенных. Только за переключателем пузырей; без него поле ввода такое же, как без этого пропа.
   */
  sendMenu?: MessageSendMenu;
  onReact?: (messageId: string, emoji: string, op: 'add' | 'remove') => void;
  /**
   * «Большая» реакция удержанием в полосе реакций (08.10, G43, `bigreact1`, «как TG»): ставит реакцию «большой» и играет крупную
   * анимацию. Нет пропса (каналы, сервер без признака) — удержание как было.
   */
  onReactBig?: (messageId: string, emoji: string) => void;
  /**
   * «Кто поставил» (07.10, ЛС): имя и аватар поставившего реакцию по id — для аватарок на чипе и окна «кто поставил».
   * Ссылка стабильная (`useMemo` у зовущего). Нет — чипы с числом.
   */
  reactorOf?: (userId: string) => ReactorLook | null;
  /** When provided, the message menu shows "Копировать ссылку" (channels only). */
  onCopyLink?: (m: Message) => void;
  /** Caller can delete others' messages (MANAGE_MESSAGES) — shows delete on non-own messages. */
  canModerate?: boolean;
  /** When provided, the message menu shows Закрепить/Открепить (channels, MANAGE_MESSAGES). */
  onPin?: (m: Message, pinned: boolean) => void;
  /**
   * Собеседник — бот (#230): его команды (`GET /conv/:id/bot` по `feedId`, кэш `botCommands.ts`) — список по «/» в начале
   * поля, кнопка «Меню» у поля, `/команды` в его тексте нажимаются и уходят сообщением. Не бот — `/` как был.
   */
  botPeer?: boolean;
  /**
   * Канал сервера (#231): его id — подсказка команд ботов канала по «/» (`GET /channels/:id/bots`, кэш `botCommands.ts`),
   * «Меню» у поля, кнопки под сообщениями ботов и нажимаемые `/команды` в их тексте. Не передан — ничего этого нет.
   */
  botChannelId?: string;
  /** @mention / #channel autocomplete candidates (server channels only). */
  autocomplete?: AutocompleteData;
  /**
   * Millisecond timestamp of the last visit — everything newer gets a «Новые сообщения» divider above
   * it (#15). Fixed at open time by the caller, so the divider stays put while you read instead of
   * sliding down with every arriving message.
   */
  newSince?: number | null;
  /**
   * Кто мы сейчас читаем: id канала или диалога. Меняется — значит открыли ДРУГУЮ ленту, и её
   * надо показать снизу, с последнего сообщения. Без этого признака компонент не отличает «пришло
   * новое сообщение» от «мы вообще в другом месте»: он не перемонтируется при переходе.
   */
  scrollKey?: string;
  /**
   * Какая это лента — id канала или ЛС (#194). Строки «отправляется» помечаются им: компонент при смене
   * канала не пересоздаётся, и без метки чужое сообщение в пути мелькнуло бы в соседней ленте.
   */
  feedId?: string;
  /**
   * Подтянуть более старые сообщения, когда человек долистал почти до начала загруженного.
   * Возвращает, есть ли смысл просить дальше. Не передан — подгрузки нет (например, в ЛС).
   */
  onLoadOlder?: () => Promise<boolean>;
  /** Called (throttled by the pane) while the user types, to broadcast a typing signal. */
  onTyping?: (action?: TypingAction) => void;
  /** Other users currently typing here — rendered as the "…печатает" indicator. */
  typingUsers?: { id: string; name: string }[];
  /** Id канала для опросов (#17). Не передан — кнопки опроса нет (ЛС опросов не имеют). */
  pollChannelId?: string;
  /**
   * Наборы стикеров сервера (#68). Пустые/не переданы — кнопки стикеров нет. ЛС их не передают:
   * наборы принадлежат серверу, ровно как ники (#73) и эмодзи (#18).
   */
  stickerPacks?: StickerPack[];
  /** Отправить стикер. Идёт отдельно от `onSend`: у стикера нет ни текста, ни вложений. */
  onSendSticker?: (stickerId: string) => Promise<void>;
  /** ЛС (`gifs1`, Р-7): вкладка «GIF» в панели строки ввода — «Мои GIF» и поиск (`GifPicker`); отправка GIF. */
  onSendGif?: (pick: GifPick) => Promise<void>;
  /**
   * ЛС (14.10, G69, `geocontact1`): пункты «Геопозиция» и «Контакт» в листе вложений (телефон), меню скрепки (ПК) и шторке «+»;
   * отправка вида сообщения. Нет пропа — пунктов нет.
   */
  onSendMedia?: (media: import('@gusvoice/shared').ConvMediaInput) => Promise<void>;
  /** ЛС (14.10, `convpoll1`): пункт «Опрос» рядом с «Геопозицией» (отправка — тот же `onSendMedia`). */
  convPoll?: boolean;
  /** ЛС (14.10, `geolive1`): в окне «Геопозиция» пункт «Транслировать геопозицию» (только телефонная раскладка; отправка — `onSendMedia`). */
  geoLive?: boolean;
  /** ЛС (`gifs1`): «Сохранить GIF» в меню сообщения с GIF. */
  onSaveGif?: (a: Attachment) => void;
  /**
   * ЛС (С2, `stickers2`): недавние стикеры и содержимое вкладки «Наборы стикеров» (каталог инстанса). С каталогом вкладка
   * «Стикеры» есть и без своих наборов — в ней же их и добавляют. `onStickerUsed` — после отправки (недавние).
   */
  stickerRecent?: Sticker[];
  stickerCatalog?: ReactNode;
  onStickerUsed?: (s: Sticker) => void;
  /**
   * Отправить голосовое (#20). Отдельно от `onSend`, потому что несёт огибающую и длительность —
   * их надо приложить к вложению, а `onSend` принимает голые файлы. ЛС это тоже умеют: голосовое
   * не серверная настройка, в отличие от стикеров и ников.
   */
  onSendVoice?: (take: VoiceTake, opts?: { once?: boolean }) => Promise<void>;
  /**
   * Кружки (08.10, G68, признак сервера `circles1`): короткое нажатие на кнопку записи переключает «микрофон ↔ камера», в
   * режиме камеры удержание пишет видеосообщение (`roundRecorder.ts`) и уходит тем же `onSendVoice` (`take.round`). Нет —
   * режима камеры нет, кнопка прежняя.
   */
  roundOk?: boolean;
  /**
   * Кнопка «1» — «Прослушать один раз» (08.10, G54, признак сервера `voice3`): только личка 1:1 с человеком (не группа, не
   * «Избранное», не канал). Нет — кнопки нет.
   */
  voiceOnce?: boolean;
  /**
   * «Таймер самоуничтожения» у фото и видео (19.10, #226, признак сервера `ttlmedia1`): только личка 1:1 с человеком. Нет —
   * пункта нет ни в окне отправки (ПК), ни в меню удержания «Отправить» галереи (телефон).
   */
  mediaOnce?: boolean;
  /**
   * Последний шаг Esc — закрыть беседу (07.10, G15; Telegram Desktop `HistoryWidget::escape` → `_cancelRequests`). Даёт
   * беседа ЛС на ПК; нет — последний Esc ничего не делает (каналы сервера, телефон: там «назад» — свой жест).
   */
  onEscapeClose?: () => void;
  emptyState?: ReactNode;
  /** Optional controls rendered right-aligned in the top bar (e.g. a DM push-mute toggle). */
  headerActions?: ReactNode;
  /** Вместо поля ввода — эта разметка (например, плашка блокировки в ЛС, #212). */
  composerReplacement?: ReactNode;
  /**
   * Плашка НАД полем ввода, поле остаётся (ЛС между инстансами, исправления ревью 12.10, п. 7: «Сообщения ждут, пока «X» их
   * заберёт»). Не показывается вместе с `composerReplacement`, в выделении и в поиске на телефоне.
   */
  composerNotice?: ReactNode;
  /** Полоса под шапкой беседы, над закрепом (08.10, `stranger1`, С7: плашка незнакомца в ЛС). */
  topBar?: ReactNode;
  /**
   * Лента только на чтение (бывшая группа, `groups3`; Telegram `ChatObject.isNotInChat`): ни ответа, ни правки, ни удаления —
   * сервер ответил бы «нет такой». Реакции выключает вызывающий (`onReact` пуст), пересылку — тоже (`batch` пуст).
   */
  readOnly?: boolean;
  /**
   * Вложения в эту ленту пока нельзя (Э2 часть Б, #141: беседа с человеком другого инстанса — файлы ездят с Э3). Значение — подсказка:
   * скрепка неактивна (нажатие показывает её), вставка и бросок файла отвечают ею же, рамка броска не рисуется; сервер всё равно
   * откажет (`federation.dm_attachments_later`), но человек узнаёт это ДО отправки. Текст и ответы не затрагиваются.
   */
  filesBlocked?: string;
  /** Э5 (#141): названия инстансов для подписи «через «X», не подтверждено» у сообщений, принятых в обход дома (`ConvMessage.via`). */
  viaNames?: { self?: string; peer?: string } | null;
  /** Э5 (#141): плашка над полем ввода («Инстанс «X» недоступен — пишем через «Y»»); нет — ничего. */
  composerNote?: ReactNode;
  /**
   * Как звать автора (#19/#73). Канал сервера передаёт резолвер ников (`useNameResolver`), **ЛС не
   * передают ничего** — по умолчанию берётся имя из самого сообщения. Ник живёт в пределах сервера,
   * и тащить его в личку было бы применением чужой настройки не к месту.
   */
  nameOf?: (userId: string, fallback: string) => string;
  /**
   * Кастомные эмодзи сервера (#18): резолвер `:имя:`→URL для отрисовки и список для пикера.
   * **ЛС не передают ничего** — эмодзи принадлежат серверу, как и ники.
   */
  onEmoji?: EmojiResolver;
  customEmojis?: ServerEmoji[];
  /** Поиск кастомного эмодзи по id — реакции ключуются `custom:<id>`, а не именем. */
  emojiById?: (id: string) => ServerEmoji | null;
}) {
  const [text, setText] = useState(draft?.text ?? '');
  const [pending, setPending] = useState<File[]>([]);
  /**
   * Сколько файлов лежит в поле СЕЙЧАС — по последней отрисовке и с поправкой на уже принятое в этом ходе. `addFiles` зовут и
   * из отложенных колбэков (сжатие фото, системное «Файлы»), где замыкание старое: счёт «сколько влезет» по нему врал бы.
   */
  const pendingNow = useRef<File[]>(pending);
  pendingNow.current = pending;
  /**
   * Правка прикреплённого до отправки на полосе (08.10, #211, G49): меню плитки (правый клик на ПК, «⋯» на телефоне) —
   * «Изменить фото» (`PhotoEditor`), «Заменить файл», «Переименовать» (не картинки), «Удалить»; перестановка удержанием и
   * перетаскиванием (`useHoldReorder`). Исходники правленых фото — `attOrigins`: повторная правка начинается с той же рамки.
   */
  const [attMenu, setAttMenu] = useState<{ file: File; pos?: { x: number; y: number }; anchor?: DOMRect } | null>(null);
  const [attEdit, setAttEdit] = useState<File | null>(null);
  const [attRename, setAttRename] = useState<File | null>(null);
  const attOrigins = useRef(new Map<File, { src: File; edit: PhotoEdit }>());
  /** «Заменить файл»: системный выбор живёт, только пока он нужен (в `.composer` ровно два своих выбора файлов). */
  const [attReplace, setAttReplace] = useState<File | null>(null);
  const attReplaceRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!attReplace) return;
    const el = attReplaceRef.current;
    if (!el) return;
    const gone = () => setAttReplace(null);
    el.addEventListener('cancel', gone);
    el.click();
    return () => el.removeEventListener('cancel', gone);
  }, [attReplace]);
  const attReorder = useHoldReorder(pending.length, (from, to) => {
    const next = moveFile(pendingNow.current, from, to);
    pendingNow.current = next;
    setPending(next);
  });
  /** Файл полосы на месте `old` меняется на `next` (правка, замена, имя); исходник правки переезжает с ним. */
  const swapPending = (old: File, next: File, origin?: { src: File; edit: PhotoEdit }) => {
    attOrigins.current.delete(old);
    if (origin) attOrigins.current.set(next, origin);
    const i = pendingNow.current.indexOf(old);
    if (i < 0) return;
    const list = replaceAt(pendingNow.current, i, next);
    pendingNow.current = list;
    setPending(list);
  };
  /** Свои сообщения в пути (#194) — правила в `outgoingRules.ts`. `createdAt` — момент отправки, мс (`outSentAt`). */
  const [outgoing, setOutgoing] = useState<
    (OutgoingMessage & { feedId: string | undefined; afterId: string | undefined; createdAt: number })[]
  >([]);
  /** Индекс картинки, открытой на просмотр ДО отправки (null — просмотр закрыт). */
  const [pendingBox, setPendingBox] = useState<number | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  // «Геопозиция» / «Контакт» (G69): открытое окно выбора.
  const [mediaPick, setMediaPick] = useState<'geo' | 'contact' | 'poll' | null>(null);
  const mediaActions: { key: string; icon: 'map-pin' | 'user' | 'activity'; label: string; run: () => void }[] = onSendMedia
    ? [
        { key: 'geo', icon: 'map-pin', label: 'Геопозиция', run: () => setMediaPick('geo') },
        // Опрос (`convpoll1`) — между «Геопозицией» и «Контактом», как кнопки листа Telegram Android (`ChatAttachAlert`).
        ...(convPoll ? [{ key: 'poll', icon: 'activity' as const, label: 'Опрос', run: () => setMediaPick('poll') }] : []),
        { key: 'contact', icon: 'user', label: 'Контакт', run: () => setMediaPick('contact') },
      ]
    : [];
  // Вкладка пикера строки ввода (#159): стикеры — соседняя вкладка эмодзи, а не отдельная кнопка.
  const [exprTab, setExprTabState] = useState<ExprTab>(getExprTab);
  // Шторка «+» на телефоне (#159): где стоит кнопка — туда же встанет пикер стикеров. null = закрыта.
  const [plusAnchor, setPlusAnchor] = useState<DOMRect | null>(null);
  /** Меню скрепки на ПК (05.10): «Фото или видео» / «Файл» у кнопки, как у Telegram Desktop. null = закрыто. */
  const [attachAnchor, setAttachAnchor] = useState<DOMRect | null>(null);
  /** Лист вложений «как в Telegram» (галерея, камера, «Файл») — телефон: приложение Android и браузер. */
  const [mediaOpen, setMediaOpen] = useState(false);
  /**
   * Запись голосового (#20) и кнопка записи на месте «отправить» (#159, как в Telegram). Весь жизненный
   * цикл — асинхронный микрофон, мёртвые нажатия, «без рук», «стоп» с прослушиванием — живёт в
   * `voiceHoldController.ts` (без React, вынос для тестов 22.09); пороги жеста — `voiceHold.ts`. Здесь
   * только перевод событий указателя и отрисовка состояния.
   */
  const onSendVoiceRef = useRef(onSendVoice);
  onSendVoiceRef.current = onSendVoice;
  /** «Прослушать один раз» включено для этой записи (G54) — сбрасывается, когда записи нет. */
  const [voiceOnceOn, setVoiceOnceOn] = useState(false);
  const voiceOnceRef = useRef(false);
  voiceOnceRef.current = voiceOnceOn && !!voiceOnceAllowed;
  /** Ручки обрезки прослушивания (G13): доли 0..1 от записи длиной `totalMs`; `null` — вся запись. */
  const [trimSel, setTrimSel] = useState<{ from: number; to: number; totalMs: number } | null>(null);
  const trimSelRef = useRef(trimSel);
  trimSelRef.current = trimSel;
  /** Файл прослушивания режется (WebM, разбирается) — ручки показываются. */
  const [trimOk, setTrimOk] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceHoldState<VoiceTake> | null>(null);
  /** Сколько записанных голосовых сейчас грузится (голосовое уходит прямым вызовом, не строкой очереди `outgoing`). */
  const [voiceSending, setVoiceSending] = useState(0);
  /**
   * Режим кнопки записи (G68, Telegram Android `ChatActivityEnterView` `isInVideoMode` / tdesktop `VoiceRecordBar` `_kind`):
   * `round` — кружок с камеры. Помнится на устройстве (`gv.recMode`), как у Telegram. Без `roundOk` — всегда голосовое.
   */
  const [roundMode, setRoundModeState] = useState(() => {
    try {
      return localStorage.getItem('gv.recMode') === 'round';
    } catch {
      return false;
    }
  });
  const roundOkNow = !!roundOk && roundRecordingSupported();
  const roundModeRef = useRef(false);
  roundModeRef.current = roundMode && roundOkNow;
  const roundOkRef = useRef(false);
  roundOkRef.current = roundOkNow;
  const toggleRoundMode = () => {
    setRoundModeState((cur) => {
      const next = !cur;
      try {
        localStorage.setItem('gv.recMode', next ? 'round' : 'voice');
      } catch {
        /* приватный режим — режим не помнится */
      }
      return next;
    });
    navigator.vibrate?.(8);
  };
  /** Идущая запись кружка — её поток в круглом предпросмотре поверх ленты; `null` — пишется голосовое или ничего. */
  const [roundLive, setRoundLive] = useState<RoundRecording | null>(null);
  /** Пишется или слушается кружок — для подтверждения выброса и ухода из беседы (кружок черновиком не хранится). */
  const roundLiveRef = useRef<RoundRecording | null>(null);
  roundLiveRef.current = roundLive;
  const voice = useMemo(
    () =>
      createVoiceHoldController<VoiceTake>({
        openMic: async () => {
          if (!roundModeRef.current) return startVoiceRecording();
          const r = await startRoundRecording();
          // D19: кружок живёт ровно столько, сколько жив ЭТОТ рекордер. Контроллер отменяет рекордер, пришедший к мёртвому
          // нажатию (короткий тап, сразу новое удержание), — вместе с ним снимаем вид «кружок» (только если он ещё наш:
          // новая запись уже могла занять место), иначе круг камеры и «видеосообщение» висели бы над голосовой записью.
          const cancel0 = r.cancel;
          r.cancel = () => {
            setRoundLive((cur) => (cur === r ? null : cur));
            cancel0.call(r);
          };
          setRoundLive(r);
          return r;
        },
        send: async (take) => {
          // Обрезка (G13): режем ровно перед отправкой — запись на паузе к этому моменту дописана до конца (`sendPreview`).
          // Ручки и «один раз» — до первого ожидания: прослушивание уже ушло с экрана, и его состояние вот-вот сбросится.
          // Кружок не режется (ручек у него нет).
          const sel = take.round ? null : trimSelRef.current;
          const once = voiceOnceRef.current;
          const cut = sel ? await trimVoiceTake(take, voiceTrimFromRatios(sel.from, sel.to, sel.totalMs)) : take;
          if (!cut) {
            toast('error', 'Не удалось обрезать запись');
            return;
          }
          // «Отправляет голосовое…» (G21): пока записанное грузится — собеседник видит это, а не «отправляет файл».
          setVoiceSending((n) => n + 1);
          try {
            await onSendVoiceRef.current?.(cut, once ? { once: true } : undefined);
          } finally {
            setVoiceSending((n) => n - 1);
          }
        },
        previewUrl: (take) => URL.createObjectURL(take.file),
        releasePreviewUrl: (url) => URL.revokeObjectURL(url),
        toast: (kind, title, body) => toast(kind, title, body),
        toastError: (err) => toastError(err),
        vibrate: () => navigator.vibrate?.(8),
        now: () => performance.now(),
        wallNow: () => Date.now(),
        maxMs: VOICE_MAX_MS,
        // Телефон — порог Android (700 мс), компьютер — Telegram Desktop (секунда).
        minTakeMs: () => (phoneLayoutRef.current ? VOICE_HOLD.minHoldMs : VOICE_DESKTOP.minTakeMs),
        // Android после промаха показывает «Удерживайте для записи» (`ChatActivity.showVoiceHint`, `HoldToAudioOnly`).
        /* С кружками смену режима «микрофон ↔ камера» даёт ТОЛЬКО отпускание до начала записи (`onMicUp` / `onDeskMicUpRound`;
           Android `ChatActivityEnterView`: режим меняется при отпускании до 150 мс). Запись уже началась (камера открывалась) и вышла
           слишком короткой — выбрасывается, режим прежний, подсказка (D19, ревью 09.10: раньше здесь тоже звался `toggleRoundMode`). */
        hint: () => toast('info', 'Удерживайте для записи'),
        onChange: setVoiceState,
      }),
    [],
  );
  const phoneLayoutRef = useRef(false);
  const { recording, recBusy, recMs, recLevel, preview, paused, holdUi } = voiceState ?? voice.getState();
  // Запись кружка кончилась (отправлена, выброшена, отменена) — предпросмотр камеры уходит.
  useEffect(() => {
    if (!recording && !preview && !holdUi && roundLive) setRoundLive(null);
  }, [recording, preview, holdUi, roundLive]);
  /** Кружок слушается перед отправкой — круглое окно с записанным вместо полоски голосового. */
  const roundPreview = preview?.take.round ? preview : null;
  /** Кружок пишется — круглое окно с камерой поверх ленты. */
  const roundRec = !!roundLive && !roundPreview && (recording || !!holdUi);
  /** Компьютер: кнопка зажата, а запись удержанием ещё не началась (Telegram Desktop ждёт 120 мс — короче это клик). */
  const micPressRef = useRef<{ timer: number; id: number; held: boolean } | null>(null);
  /**
   * Телефон с кружками: касание кнопки микрофона ещё не запись. Telegram Android (`ChatActivityEnterView`, `ACTION_DOWN` →
   * `postDelayed(recordAudioVideoRunnable, 150)`) начинает писать только через 150 мс удержания; отпустил раньше — это
   * переключатель «микрофон ↔ камера», камера не открывается (D19: она успевала открыться и закрыться, а новое удержание
   * в этот миг получало чужой кружок).
   */
  const phonePressRef = useRef<{ timer: number; id: number; x: number; y: number; path: number } | null>(null);
  // Лента закрыта в течение задержки старта — запись по таймеру не начинается (D19, ревью 09.10).
  useEffect(
    () => () => {
      const pend = phonePressRef.current;
      if (pend) clearTimeout(pend.timer);
      phonePressRef.current = null;
    },
    [],
  );
  /** Картинки среди прикреплённого — только они получают миниатюру и просмотр. */
  const pendingImages = useMemo(() => pending.filter((f) => f.type.startsWith('image/')), [pending]);
  /**
   * Object URL на каждую прикреплённую картинку.
   *
   * Ссылки держим В РЕФЕ и правим точечно (добавили файл — создали, убрали — отдали обратно), а не
   * пересоздаём весь набор на каждое изменение: пересоздание отзывало бы ссылки, на которые ещё
   * смотрит текущий кадр, и миниатюры моргали бы при удалении соседней.
   *
   * `revokeObjectURL` обязателен: пока ссылка жива, браузер держит В ПАМЯТИ весь файл. Десять
   * скриншотов — это десятки мегабайт, висящих до перезагрузки вкладки.
   */
  const urlsRef = useRef(new Map<File, string>());
  const [, bumpUrls] = useState(0);
  useEffect(() => {
    const map = urlsRef.current;
    let changed = false;
    for (const f of pendingImages) {
      if (!map.has(f)) {
        map.set(f, URL.createObjectURL(f));
        changed = true;
      }
    }
    for (const [f, u] of map) {
      if (!pendingImages.includes(f)) {
        URL.revokeObjectURL(u);
        map.delete(f);
        changed = true;
      }
    }
    if (changed) bumpUrls((n) => n + 1);
  }, [pendingImages]);
  // Уход со страницы/размонтирование — отдать всё, что осталось.
  useEffect(() => {
    const map = urlsRef.current;
    return () => {
      for (const u of map.values()) URL.revokeObjectURL(u);
      map.clear();
    };
  }, []);
  const previewUrls = urlsRef.current;
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  /**
   * Цитата фрагмента и «из другой беседы» у ответа в поле (G55, `quote1`): действует, только пока `id` — это `replyingTo`
   * (сменился ответ — пропала сама собой). Ref дублирует состояние: отправка снимает `replyingTo` раньше, чем строка уходит
   * в очередь (`outbox.enqueue` ниже читает ref).
   */
  const [replyExtra, setReplyExtraState] = useState<{ id: string; quote: ReplyQuoteDraft | null; foreign: boolean } | null>(null);
  const replyExtraRef = useRef(replyExtra);
  const setReplyExtra = (v: { id: string; quote: ReplyQuoteDraft | null; foreign: boolean } | null) => {
    replyExtraRef.current = v;
    setReplyExtraState(v);
  };
  const replyNow = replyingTo && replyExtra?.id === replyingTo.id ? replyExtra : null;
  /** Окно параметров ответа (G55): открыто по нажатию на полосу ответа. */
  const [replyOpts, setReplyOpts] = useState(false);
  /** «Ответить в другом чате» (G55): выбор беседы — окно «Переслать в…» в режиме одной беседы. */
  const [replyElsewhere, setReplyElsewhere] = useState<{ m: Message; quote: ReplyQuoteDraft | null } | null>(null);
  // Очередь бесед: строке с ответом — его цитата (полоса ответа уже снята к этому моменту, поэтому ref).
  const outbox = useMemo(
    () =>
      outboxProp && {
        ...outboxProp,
        enqueue: (item: Parameters<typeof outboxProp.enqueue>[0]) => {
          const x = replyExtraRef.current;
          outboxProp.enqueue(x && x.quote && item.replyToId === x.id ? { ...item, replyQuote: x.quote } : item);
        },
      },
    [outboxProp],
  );
  /**
   * Правка в ОСНОВНОМ поле — телефон (#212, 28.09, проход по касаниям на S25). Раньше и на телефоне правка шла
   * по-десктопному: маленькое поле внутри сообщения с подсказкой «Enter — сохранить · Esc — отмена» (Esc на
   * телефоне нет), без кнопок, а «назад» уводила в список — вернёшься, правка висит, выйти можно только сохранив.
   * Теперь как у Telegram: текст в поле ввода, над ним плашка «Редактирование» с ✕, вместо «отправить» — ✓,
   * «назад» отменяет. На компьютере правка по-прежнему в самом сообщении (так у Discord, и мышью это ближе).
   */
  const [composerEdit, setComposerEdit] = useState<Message | null>(null);
  /** Что лежало в поле до правки — отмена и сохранение возвращают черновик на место, как у Telegram. */
  const draftBeforeEdit = useRef<{ text: string; replyingTo: Message | null } | null>(null);
  /* Черновик (шаг 2д): ответ из черновика ставим, когда цитируемое появилось в ленте (история могла ещё грузиться);
     сообщаем наружу с задержкой, а при пересоздании ленты — сразу последнее (`messagePaneRules.createDraftSaver`). */
  const draftReplyId = useRef(draft?.replyToId ?? null);
  const onDraftRef = useRef(onDraftChange);
  onDraftRef.current = onDraftChange;
  const [draftSaver] = useState(() =>
    createDraftSaver((d: { text: string; replyToId: string | null }) => onDraftRef.current?.(d.text, d.replyToId)),
  );
  useEffect(() => {
    const id = draftReplyId.current;
    if (!id || replyingTo) return;
    const m = messages.find((x) => x.id === id);
    if (m) {
      draftReplyId.current = null;
      setReplyingTo(m);
    }
  }, [messages, replyingTo]);
  /* 🔴 Первый проход — то, что положили в поле при открытии: это не набор, отдавать наружу нечего. Иначе отложенная
     запись начального значения выглядела бы как «человек печатает» и не пускала в поле черновик, пришедший с другого
     устройства через миг после открытия, — а потом записывала пустое поверх него (стенд Р7, 01.10). */
  const draftSeen = useRef(false);
  useEffect(() => {
    if (!onDraftRef.current) return;
    if (!draftSeen.current) {
      draftSeen.current = true;
      return;
    }
    const before = draftBeforeEdit.current;
    draftSaver.change(
      draftToSave({
        text,
        replyToId: replyingTo?.id ?? draftReplyId.current,
        editing: !!composerEdit,
        beforeEdit: before && { text: before.text, replyToId: before.replyingTo?.id ?? null },
      }),
    );
  }, [text, replyingTo, composerEdit, draftSaver]);
  useEffect(() => () => draftSaver.flush(), [draftSaver]);
  /* Черновик с другого устройства (Р7). Поле не затираем, пока человек здесь печатает: его набранное важнее — оно
     уйдёт на сервер следом и само станет черновиком у остальных. */
  const remoteRev = useRef(draftRemote?.rev ?? 0);
  useEffect(() => {
    const r = draftRemote;
    if (!r || r.rev === remoteRev.current) return;
    remoteRev.current = r.rev;
    if (composerEdit || draftSaver.pending()) return;
    const input = inputRef.current;
    if (input && document.activeElement === input && text.trim()) return;
    setText(r.text);
    const reply = r.replyToId ? (messages.find((m) => m.id === r.replyToId) ?? null) : null;
    // Цитируемого ещё нет в ленте — встанет, когда подгрузится (тот же путь, что у черновика при открытии).
    draftReplyId.current = r.replyToId && !reply ? r.replyToId : null;
    setReplyingTo(reply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftRemote?.rev]);
  // Срочная запись кеша бесед (фон, выгрузка, переход в другой инстанс) — сначала отложенный черновик: переход сбросит
  // беседы раньше, чем лента уйдёт с экрана, и её прощальная запись досталась бы уже новому инстансу.
  useEffect(() => onConvCacheUrgent(() => draftSaver.flush()), [draftSaver]);
  const [picker, setPicker] = useState<
    { kind: 'msg'; messageId: string; anchor: DOMRect } | { kind: 'composer'; anchor: DOMRect; el?: Element } | null
  >(null);
  /* Панель эмодзи колонкой справа от ленты (G61, `exprDock.ts`): ПК, поле ввода на месте, беседа шире 380 + 345 px. `chatEl` — корень беседы
     (`.chat`, колбэк-реф). Закреплённая панель — не всплывающая: наведение её не открывает, щелчок по кнопке смайлика её убирает. */
  const [chatEl, setChatEl] = useState<HTMLDivElement | null>(null);
  /** Верхний слой беседы — шапка и капсула полос (tg3, #218; эффект `--chat-top-h` ниже). */
  const chatTopRef = useRef<HTMLDivElement>(null);
  const dockPhone = usePhoneLayout();
  const dock = useExprDock(chatEl, !dockPhone && !composerReplacement);
  const docked = dock.docked;
  /* Панель эмодзи / стикеров / GIF на телефоне — НА МЕСТЕ КЛАВИАТУРЫ под полем ввода, во всю ширину, высотой с клавиатуру
     (tg3, #218; Telegram Android `ChatActivityEnterView.showPopup` `:12657-12727`, Web K на узком экране — `is-under`,
     `input.ts:1663`). Всплывающее окно над кнопкой — только ПК. Высота берётся в момент открытия: запомненная высота
     клавиатуры (`rememberedKeyboardHeight`, `popover.ts`) в вёрсточных px. */
  const exprUnder = dockPhone && picker?.kind === 'composer';
  const exprUnderH = useMemo(() => (exprUnder ? Math.round(rememberedKeyboardHeight() / rootZoom()) : 0), [exprUnder]);
  const exprUnderRef = useRef(false);
  exprUnderRef.current = exprUnder;
  /* Раскрытие панели стикеров / GIF протяжкой вверх (#218; Telegram Android `setStickersExpanded`, числа — `stickersExpand.ts`):
     `open` — раскрыта, `max` — на сколько выше обычной, `drag` — надбавка под пальцем (протяжка идёт). Панель и поле ввода едут
     вверх вместе (`--expr-lift` у `.chat`, поток ленты не меняется), капсула закрепа гаснет (`.expr-up`). */
  const [exprLift, setExprLift] = useState<{ open: boolean; max: number; drag: number | null }>(LIFT_NONE);
  const liftTouch = useRef<{ x: number; y: number; on: boolean; start: number; wasOpen: boolean; max: number; pts: { t: number; y: number }[] } | null>(null);
  const liftExtra = exprUnder ? (exprLift.drag ?? (exprLift.open ? exprLift.max : 0)) : 0;
  const liftUp = exprUnder && (exprLift.open || exprLift.drag !== null);
  // Панель закрылась или ушли на «Эмодзи» — свернуть (`updateExpandabilityRunnable`, `ChatActivityEnterView.java:815-821`).
  useEffect(() => {
    if (!exprUnder || exprTab === 'emoji') setExprLift((l) => (l === LIFT_NONE ? l : LIFT_NONE));
  }, [exprUnder, exprTab]);
  /** Сколько панели расти до шапки: низ шапки + 6, поле ввода (со строкой ответа) — над панелью. Вёрсточные px. */
  const measureLiftMax = (): number => {
    const top = chatTopRef.current;
    const chat = top?.parentElement;
    const head = top?.querySelector<HTMLElement>(':scope > .channel-topbar');
    const comp = chat?.querySelector<HTMLElement>(':scope > form.composer');
    if (!top || !chat || !head || !comp) return 0;
    const strip = chat.querySelector<HTMLElement>(':scope > .reply-strip');
    const mb = parseFloat(getComputedStyle(comp).marginBottom) || 0;
    return expandedExtra({
      headerBottom: top.offsetTop + head.offsetTop + head.offsetHeight,
      chatBottom: chat.clientHeight,
      composerHeight: comp.offsetHeight + mb + (strip?.offsetHeight ?? 0),
      panelHeight: exprUnderH,
    });
  };
  /* Протяжка за верх панели — строку поиска и наборов (`EmojiView.DraggableScrollSlidingTabStrip`, `EmojiView.java:1227-1310`):
     сдвиг вертикально больше 8 — наша, вбок — прокрутка наборов. Касания, не указатель: `touch-action: pan-x` на этих строках. */
  const onLiftStart = (e: React.TouchEvent) => {
    liftTouch.current = null;
    if (e.touches.length !== 1 || !(e.target instanceof Element) || !e.target.closest('.emoji-search, .emoji-tabs')) return;
    // Стикеры есть: свои наборы, недавние или избранные (`areThereAnyStickers`).
    const hasStickers = !!(stickerPacks?.some((p) => p.stickers.length > 0) || stickerRecent?.length || dmFaved?.length);
    if (!canDragExpand(exprTab, exprLift.open, text, hasStickers)) return;
    const t = e.touches[0];
    liftTouch.current = { x: t.clientX, y: t.clientY, on: false, start: 0, wasOpen: exprLift.open, max: 0, pts: [] };
  };
  const onLiftMove = (e: React.TouchEvent) => {
    const g = liftTouch.current;
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    const z = rootZoom();
    if (!g.on) {
      const dx = Math.abs(t.clientX - g.x) / z;
      const dy = Math.abs(t.clientY - g.y) / z;
      if (dx >= EXPAND_SLOP && dx > dy) {
        liftTouch.current = null;
        return;
      }
      if (dy < EXPAND_SLOP) return;
      const max = measureLiftMax();
      if (max <= 0) {
        liftTouch.current = null;
        return;
      }
      // Отсчёт пути — с этой точки (как `downY = ev.getRawY()` при старте протяжки у Telegram).
      Object.assign(g, { on: true, y: t.clientY, max, start: g.wasOpen ? max : 0 });
    }
    const now = performance.now();
    g.pts.push({ t: now, y: t.clientY / z });
    while (g.pts.length > 2 && now - g.pts[0].t > 100) g.pts.shift();
    setExprLift({ open: g.wasOpen, max: g.max, drag: dragExtra(g.start, (t.clientY - g.y) / z, g.max) });
  };
  const onLiftEnd = (e: React.TouchEvent) => {
    const g = liftTouch.current;
    liftTouch.current = null;
    if (!g?.on) return;
    if (e.type === 'touchcancel') {
      setExprLift({ open: g.wasOpen, max: g.max, drag: null });
      return;
    }
    // Скорость — по последним 100 мс вместе с точкой отпускания (`VelocityTracker`): палец остановился и подержал — броска нет.
    const now = performance.now();
    const up = e.changedTouches[0];
    if (up) g.pts.push({ t: now, y: up.clientY / rootZoom() });
    const pts = g.pts.filter((p) => now - p.t <= 100);
    const a = pts[0];
    const b = pts[pts.length - 1];
    const v = a && b && b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0;
    setExprLift((l) => {
      const extra = l.drag ?? 0;
      return { open: expandAfterDrag(g.wasOpen, v, g.max > 0 ? extra / g.max : 0), max: g.max, drag: null };
    });
  };
  // Панель эмодзи и меню скрепки по наведению мыши (G61, `hoverPanel.ts`): открываются через 200 мс, закрываются через 300 мс после ухода мыши.
  const emojiHover = useHoverPanel({
    isOpen: picker?.kind === 'composer' || docked,
    pin: () => {
      if (!dock.canPin || !hoverPanelsAvailable()) return false;
      dock.setPinned(true);
      return true;
    },
    open: () => {
      const b = document.querySelector('.composer .att-btn.emoji');
      if (b) setPicker({ kind: 'composer', anchor: b.getBoundingClientRect(), el: b });
    },
    close: () => setPicker(null),
    // Панель — та вкладка, что открыта последней: эмодзи `.emoji-pop`, стикеры и GIF `.sticker-pop` (у GIF ещё `.gif-pop`). Был только
    // `.emoji-pop` — мышь на панели стикеров или GIF считалась «ушедшей», и открытая наведением панель закрывалась через 300 мс.
    panel: '.emoji-pop, .sticker-pop',
    trigger: '.composer .att-btn.emoji',
  });
  const attachHover = useHoverPanel({
    isOpen: !!attachAnchor,
    open: () => {
      const b = document.querySelector('.composer .att-btn.attach');
      if (b) setAttachAnchor(b.getBoundingClientRect());
    },
    close: () => setAttachAnchor(null),
    panel: '.ctx-menu',
    trigger: '.composer .att-btn.attach',
  });
  /* Меню сообщения: по точке правого клика (`pos`) или, раунд 12, у пузыря (`bubble`: телефон и узкое окно; `pos` тогда —
     угол пузыря, запасной якорь «Все реакции»). `photo` — открыто правым кликом по фото (пункты «Копировать изображение»,
     «Сохранить как…»). `file` / `link` (07.10) — файл, видео, голосовое или ссылка в тексте под курсором (`MenuMore`). */
  /** Выделенный пальцем текст сообщения (#211, Telegram 2.02 / 4.34): маркеры и панель — `TextSelLayer`. */
  const [textSel, setTextSel] = useState<TextSel | null>(null);
  const [msgMenu, setMsgMenu] = useState<{
    m: Message;
    pos: MenuPos;
    bubble?: BubbleSpot;
    photo?: Attachment;
    file?: Attachment;
    link?: string;
    /** G56: ячейка альбома под правым кликом (ПК) — «Переслать»/«Удалить» для неё одной. */
    item?: Attachment;
    /** Выделенный в пузыре текст (G55): «Ответить с цитатой» вместо «Ответить» (Telegram 1.30). */
    quote?: ReplyQuoteDraft | 'too-long';
  } | null>(null);
  /** Меню ссылки на телефоне (07.10, Telegram 2.21 / 10.03): удержание пальцем по ссылке в тексте — «Открыть · Скопировать ссылку». */
  const [linkMenu, setLinkMenu] = useState<{ m: Message; url: string; anchor: DOMRect } | null>(null);
  /** Окно «Открыть ссылку?» для «Открыть ссылку» из меню (то же, что у нажатия на ссылку, `linkGuard`). */
  const [linkAsk, setLinkAsk] = useState<{ url: string } | null>(null);
  // «Поделиться» (приложение Android): есть ли он у натива — спросить заранее, к первому меню ответ уже будет.
  useEffect(() => {
    canShareFileNative();
  }, []);
  /**
   * Меню в режиме выделения (07.10, сверка 01·1.31 / 1.32 / 4.23; Telegram Desktop) — правый клик мышью по сообщению, пока
   * что-то выбрано. `m` — по какому кликнули: выбрано оно — меню выделения (скопировать / переслать / удалить выбранное,
   * отменить выбор), нет — «Выделить» и «Выделить до этого сообщения». Пальцем (системное долгое нажатие) меню в выделении
   * по-прежнему нет — там тап переключает строку.
   */
  const [selMenu, setSelMenu] = useState<{ m: Message; pos: MenuPos } | null>(null);
  /* Окно «кто поставил» (07.10): чья реакция — по id сообщения и эмодзи (список берём из ленты на каждой перерисовке —
     снял реакцию собеседник, окно это видит); у точки правого клика (ПК) или у чипа (палец, узкое окно). */
  const [who, setWho] = useState<{ id: string; emoji: string; pos?: MenuPos; anchor?: DOMRect } | null>(null);
  /** Окно «кто прочитал» (15.10, `readers1`): из строки «N прочитали» меню своего сообщения в группе — у того же места. */
  const [seen, setSeen] = useState<{ id: string; list: ConvReader[]; pos?: MenuPos; anchor?: DOMRect } | null>(null);
  /* Неотправленное (раунд 10): «Удалить» и «Повторить отправку» живут в листе (телефон) и в меню (ПК), а не в строке
     под пузырём. Ключ строки «в пути» — у неё ещё нет id. Раунд 12: на телефоне и в узком окне — меню у пузыря. */
  const [outSheet, setOutSheet] = useState<string | null>(null);
  const [outMenu, setOutMenu] = useState<{ key: string; pos: MenuPos; bubble?: BubbleSpot } | null>(null);
  /** Строка «в пути», у пузыря которой открыто меню (раунд 12): за ней меню следит, пока открыто (`data-mid` у неё нет). */
  const outMenuRow = useRef<HTMLElement | null>(null);
  /**
   * Раунд 12, порция 5 — пересылка, выделение и удаление пачкой (`batch`): только у пузырей (ЛС). Нет — ни «Переслать»,
   * ни «Выделить», ни выделения. Действия с сообщением раунда 12 (меню с полосой реакций, тап по пузырю на телефоне, меню
   * у пузыря вместо листа; `docs/design/design-step12/HANDOFF.md`) — у всех лент, и в ЛС, и в каналах (с 09.10 без
   * переключателя устройства).
   */
  const batchOn = bubbles ? batch : undefined;
  const othersForBoth = deleteOthersForBoth;
  /**
   * Раунд 12, порция 7 — закреп в ЛС (HANDOFF §2.3, §10): только у пузырей (ЛС). Полоса под
   * шапкой показывает одно закреплённое: при открытии — самое новое; нажатие ведёт к нему (переход к цитате) и
   * показывает предыдущее по кругу. Какое показано — по id (`pinShown`), а не по номеру: список меняется событиями, а
   * показанное остаётся на месте; его не стало (открепили, удалили) — снова самое новое.
   */
  const pinsOn = bubbles ? pins : undefined;
  /**
   * Волна 5 (07.10, G27/G28; Telegram Desktop `history_widget.cpp`, `history_view_pinned_tracker.cpp`): полоса идёт за прокруткой
   * (`trackPinned`), правый щелчок — следующее закреплённое (`nextPinned`), долгое нажатие — список; «Открепить» из меню откладывается
   * на 5 с с «Отменить» (`unpinSoon`: id ждущих — `pinUndoHidden`, из полосы их уже нет); «Скрыть закреплённые» — только у себя
   * (`pinHide.ts`, до нового закреплённого). `rawPinList` — мои закреплённые с сервера, `myPinList` — без ждущих отмены,
   * `pinList` — то, что видно в полосе (`myPinList`, если полоса не скрыта).
   */
  const [pinUndoHidden, setPinUndoHidden] = useState<ReadonlySet<string>>(NO_PICKED);
  const rawPinList = pinsOn?.list ?? NO_PIN_LIST;
  const myPinList = useMemo(
    () => (pinUndoHidden.size > 0 ? rawPinList.filter((p) => !pinUndoHidden.has(p.message.id)) : rawPinList),
    [rawPinList, pinUndoHidden],
  );
  const [pinHideTick, setPinHideTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `pinHideTick` — только повод перечитать хранилище
  const pinHiddenTop = useMemo(() => (feedId ? readPinHidden(feedId) : null), [feedId, pinHideTick]);
  const pinList = pinBarHidden(
    myPinList.map((p) => p.message.id),
    pinHiddenTop,
  )
    ? NO_PIN_LIST
    : myPinList;
  const pinCount = pinList.length;
  const [pinShown, setPinShown] = useState<string | null>(null);
  const pinAt = pinShown ? pinList.findIndex((p) => p.message.id === pinShown) : -1;
  const pinIndex = pinAt >= 0 ? pinAt : pinCount - 1;
  const pinCur = pinCount > 0 ? pinList[pinIndex] : undefined;
  const pinnedIds = useMemo(() => new Set(myPinList.map((p) => p.message.id)), [myPinList]);
  /** Подписи закреплённых для служебной строки «X закрепил(а) …» — закреплённое может быть вне окна ленты. */
  const pinTails = useMemo(
    () =>
      pinsOn
        ? new Map(
            rawPinList.map((p) => {
              const k = p.message.attachmentKind;
              const media: PinMedia | null = p.message.attachments > 0 ? (p.message.attachmentVideo ? 'video' : (k ?? 'file')) : null;
              return [p.message.id, pinServiceTail(p.message.text, media)] as const;
            }),
          )
        : null,
    [pinsOn, rawPinList],
  );
  /** Список всех закреплённых (`.pins-pop`, при 2+) открыт; кнопка, которой его открыли, — вернуть ей фокус по Esc. */
  const [pinsListOpen, setPinsListOpen] = useState(false);
  const pinsListShown = pinsListOpen && pinCount > 1;
  const pinsOpener = useRef<HTMLElement | null>(null);
  /**
   * Режим выделения (HANDOFF §6): выбранные id в порядке выбора; пусто — выделения нет (снял последнее — вышел). Только
   * сохранённые сообщения: строки «в пути» и «не отправлено» в выделение не попадают (решение владельца 04.10).
   */
  const [picked, setPicked] = useState<readonly string[]>(NO_PICKS);
  const selecting = picked.length > 0;
  const pickedSet = useMemo(() => (picked.length ? new Set(picked) : NO_PICKED), [picked]);
  /** «Переслать в…» открыто — какие сообщения уйдут (по порядку ленты). */
  const [fwdIds, setFwdIds] = useState<string[] | null>(null);
  /** G56: «Переслать в…» открыто для ОДНОГО элемента альбома (`fwdIds` — его сообщение). */
  const [fwdItem, setFwdItem] = useState<{ messageId: string; attachmentId: string } | null>(null);
  /** Беседы, отмеченные в «Переслать в…» заранее: бросок сообщений на строку списка (G76). */
  /** «Изменить получателя» полосы «Пересылка»: окно «Переслать в…» берёт сообщения и опции черновика, а не ленты. */
  const [fwdSrc, setFwdSrc] = useState<FwdDraft | null>(null);
  /** Плашка «Переслано: <имя>» (HANDOFF §9): кому; `n` — номер показа (новый показ заново заводит таймер и появление). */
  const [fwdDone, setFwdDone] = useState<{ to: string | null; name: string; n: number; later?: boolean } | null>(null);
  /** Раскладка телефона (≤ 760 px): там выйти из выделения — крестик на месте «назад» (`MainLayout`), а не в шапке. */
  const phoneLayout = usePhoneLayout();
  /* Галочка «Также удалить для собеседника» (Р-1): ПК — отмечена, «Запомнить выбор» помнит обратное на устройстве; телефон — снята,
     без «запомнить» (Telegram Desktop `DeleteMessagesBox` / Android `createDeleteMessagesAlert`). Читается при открытии окна. */
  const delBothDefault = () => deleteBothDefault(phoneLayout);
  const delRemember = deleteRememberAvailable(phoneLayout);
  /** Кнопка «Не отправлено», которой открыты меню или лист неотправленного: фокус уходит в них и возвращается на неё. */
  const outActionsFrom = useRef<{ key: string; btn: HTMLButtonElement } | null>(null);
  // Палец держит пузырь (id сообщения или ключ строки «в пути») — пузырь чуть сжат (раунд 10, только пузыри).
  const [pressingId, setPressingId] = useState<string | null>(null);
  const pressTimer = useRef<number | null>(null);
  /**
   * Свайп-ответ (раунд 12, порция 6; HANDOFF §7; пороги и кривая — `messagePaneRules.swipe*`): палец ведёт пузырь влево —
   * ответ на это сообщение. Только телефон (`phoneTaps()`: палец и ≤ 760 px, как тап-меню, — проверка в начале касания),
   * только пузыри ЛС за переключателем, не в выделении и не там, где вместо поля ввода плашка (заблокированный
   * собеседник). В каналах нет.
   * ⚠️ Палец не трогает React: каждое движение пишет `--swipe-x` / `--swipe-p` и `.armed` прямо в DOM строки
   * (`swipe.current.row`); `swipingId` меняется дважды за жест — в начале (строке `.swiping` и значок) и в конце.
   * Прокрутку ведёт браузер: у строк `touch-action: pan-y` (класс ленты `swipes`, CSS «Раунд 12» §4) — жест, пошедший
   * вбок, он не прокручивает, а пошедший по вертикали свайпом не станет.
   */
  const swipeReply = bubbles && !selecting && !composerReplacement;
  const [swipingId, setSwipingId] = useState<string | null>(null);
  const swipe = useRef<SwipeGesture | null>(null);
  /** Отпустил за порогом — ответ. Через ref: конец жеста ловит слушатель на окне, а лента и поле к тому времени свежее. */
  const swipeAnswer = useRef((_id: string) => {});
  swipeAnswer.current = (id) => {
    const m = messages.find((x) => x.id === id);
    // Сообщения уже нет (удалили у обоих), вместо поля плашка, началось выделение — отвечать некуда.
    if (m && !composerReplacement && !selecting) startReply(m);
  };
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Открытое одноразовое фото/видео (#226): свой просмотр, без ряда остальных медиа.
  const [onceView, setOnceView] = useState<{ att: Attachment; msg: Message; deadline: number | null } | null>(null);
  // @mention / #channel autocomplete: the active trigger token + the highlighted suggestion.
  const [ac, setAc] = useState<AcToken | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  /* `#` в беседах (G36, Telegram `FieldAutocomplete` Hashtags): недавно писанные хэштеги; в канале сервера `#` — по-прежнему каналы. */
  const hashtagsOn = !autocomplete?.channels.length;
  /** Команды бота беседы (#230): `undefined` — не бот или ещё не пришли; пустой список — у бота команд нет. */
  const botCommands0 = useBotCommands(botPeer && feedId ? feedId : null);
  /** Боты канала (#231) и их команды одним списком; в беседе — `undefined`. */
  const channelBots = useChannelBots(!botPeer ? botChannelId : null);
  const channelCmds = useMemo(() => (channelBots ? channelCommandList(channelBots) : undefined), [channelBots]);
  // Дальше лента зовёт «команды» одним именем: беседа — команды бота, канал — команды всех его ботов.
  const botCommands = botCommands0 ?? channelCmds;
  // Список команд длиннее окна подсказок (до 100) — выбранная стрелками строка остаётся видимой.
  useEffect(() => {
    if (ac?.trigger !== '/') return;
    document.querySelector('.composer .ac-pop .ac-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [ac, acIndex]);
  /** Таймер показа подсказки «слово целиком» (G53, `refreshAc`). */
  const acExactTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(acExactTimer.current), []);
  /* Когда последний раз ушёл сигнал набора — ПО ВИДАМ (G21): «печатает» не должно глушить «записывает голосовое». */
  const lastTypingSent = useRef<Partial<Record<TypingAction, number>>>({});
  /** Сигнал действия не чаще раза в `TYPING_SEND_MS` на вид (Telegram `api_send_progress.cpp: kSendMyTypingInterval` = 5 с; у нас 4 с — см. `typing.ts`). */
  const signalAction = (action: TypingAction) => {
    if (!onTyping) return;
    const now = Date.now();
    if (now - (lastTypingSent.current[action] ?? 0) <= TYPING_SEND_MS) return;
    lastTypingSent.current[action] = now;
    onTyping(action);
  };
  const signalActionRef = useRef(signalAction);
  signalActionRef.current = signalAction;
  // Long-press bookkeeping: the pending timer + the touch start point (to cancel on scroll).
  const lpTimer = useRef<number | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  /** Палец долгого нажатия (G43): его `identifier` и точка касания — по ним протяжка после удержания находит свой палец. */
  const lpTouch = useRef<{ id: number; x: number; y: number } | null>(null);
  /** Сработать долгому нажатию прямо сейчас, не дожидаясь таймера: системное долгое нажатие пришло раньше (`openMsgMenu`). */
  const lpFire = useRef<(() => void) | null>(null);
  /** Слушатели протяжки из меню (`startMenuRange`, 10.10): снять — новым удержанием и при уходе ленты, конца касания могло не быть. */
  const menuRangeOff = useRef<(() => void) | null>(null);
  useEffect(() => () => menuRangeOff.current?.(), []);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Системный выбор «Фото или видео» (`accept` — фото и видео); `mediaCompress` — сжимать фото, как у Telegram. */
  const mediaRef = useRef<HTMLInputElement>(null);
  const mediaCompress = useRef(true);
  /** Лист вложений отправляет сразу: файлы ушли в `addFiles`, отправка — когда они легли в поле (эффект по `pending`). */
  const sendAfterAdd = useRef<'now' | 'silent' | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * Стоял ли человек у низа ПЕРЕД приходом нового. Держим рефом, а не состоянием: значение читает
   * эффект прокрутки, и ему нужно последнее событие мыши, а не то, что было на момент отрисовки.
   */
  const nearBottomRef = useRef(true);
  const [nearBottom, setNearBottom] = useState(true);
  // Дальше порога «вниз» от низа (`JUMP_DOWN_SHOWN_AFTER`, как у Telegram Desktop) — только для круглой «вниз» беседы.
  const [farFromEnd, setFarFromEnd] = useState(false);
  /**
   * Раунд 12: открыто меню у пузыря — лента сама к низу не прилипает (новое сообщение, догрузка картинки): пузырь уехал
   * бы из-под меню. Просьба прилипнуть откладывается (`stickAfterMenu`) и исполняется, когда меню закроют.
   */
  const holdFeedRef = useRef(false);
  const stickAfterMenu = useRef(false);
  /* Пузыри в широкой ленте на компьютере — все слева, как «широкая раскладка» Telegram Desktop (`bubblesAllLeft`).
     Считаем по ширине самой ленты: окно сузили — свои снова справа, как на телефоне. Меняется только сторона, не
     высота строк, поэтому прокрутка при переключении не прыгает. */
  const [bubLeft, setBubLeft] = useState(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!bubbles || !el || isMobile() || typeof ResizeObserver !== 'function') return;
    const check = () => setBubLeft(bubblesAllLeft(el.clientWidth, false));
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bubbles]);
  /* Сообщения по id (раунд 10): цитата смотрит на цитируемое (с 05.10 и в канале — словами), плавающая дата пузырей — на
     день строки. */
  const msgById = useMemo(() => new Map(messages.map((x) => [x.id, x])), [messages]);
  const dayOfMessage = useMemo(
    () => (mid: string) => {
      const m = msgById?.get(mid);
      return m ? dayLabel(m.createdAt) : null;
    },
    [msgById],
  );
  /** Сколько сообщений пришло, пока человек читал выше — столько и обещает кнопка «вниз». */
  const [unseenBelow, setUnseenBelow] = useState(0);
  /** Идёт ли сейчас подгрузка истории и осталось ли что тянуть (рефы — их читает обработчик прокрутки). */
  const olderBusy = useRef(false);
  const hasOlder = useRef(true);
  const [showOlderHint, setShowOlderHint] = useState(false);
  /* Окно беседы (шаг 2г). Свежие пропсы — в ref: их читают обработчики прокрутки и таймеры. */
  const fwRef = useRef(feedWindow);
  fwRef.current = feedWindow;
  /**
   * Черта «Новые сообщения» уходит, как только я сам написал в эту ленту (замечание владельца 05.10, как у Telegram: своё
   * исходящее снимает черту непрочитанного), — до следующего визита (`scrollKey`). «Написал» — отправка отсюда (сразу, и без
   * сети тоже) и моё сообщение, пришедшее снизу (с другого устройства, отложенное, пересланное сюда). Только с раундом 12.
   */
  const [unreadDropAt, setUnreadDropAt] = useState<string | null>(null);
  /**
   * Черты «Новые сообщения» в этом визите нет по правилам Telegram (G26, 03·3.2.1–3.2.2): всё непрочитанное поместилось на
   * последний экран (`unreadDividerNeeded`) или пришло новое, пока человек внизу. Только окно беседы.
   */
  const [dividerOffAt, setDividerOffAt] = useState<string | null>(null);
  const unreadDropped = unreadDropAt === (scrollKey ?? '') || dividerOffAt === (scrollKey ?? '');
  function dropUnreadLine() {
    wantUnreadJump.current = false;
    setUnreadDropAt(scrollKey ?? '');
  }
  /** Чем отмечено прочитанное: беседа — ключ (`readKey`), канал — метка визита (`newSince`). */
  const unreadMark = unreadDropped ? null : feedWindow ? feedWindow.readKey : newSince;
  const newerBusy = useRef(false);
  /** Якорь, который держим, пока идёт операция окна (подгрузка вверх/вниз с обрезкой края). */
  const heldAnchor = useRef<FeedPlace | null>(null);
  /** Сколько операций окна идёт сейчас (`holdAnchor`). */
  const heldOps = useRef(0);
  /** Лента, пришедшая ответом на переход (цитата, «Назад», место, «Вниз»), — это не «пришло новое снизу». */
  const navMessages = useRef<Message[] | null>(null);
  /** Куда встать, когда нужная строка появится в ленте: место, сообщение (переход) или низ («Вниз»). */
  const pendingScroll = useRef<PendingPlace | { kind: 'message'; id: string } | { kind: 'bottom' } | null>(null);
  /** Откуда переходили к цитатам — кнопка «Назад» (`feedWindowRules.pushJump`). */
  const [jumpStack, setJumpStack] = useState<FeedPlace[]>([]);
  /** ПКМ по «♥» (G24): меню «Прочитать все реакции». */
  const [cornerMenu, setCornerMenu] = useState<MenuPos | null>(null);
  /** С какой стороны от своего отступа строка места «Назад» (`dropReachedJumps`) — по объекту места, пока оно в стеке. */
  const [jumpSides] = useState(() => new WeakMap<FeedPlace, JumpSide>());
  const placeTimer = useRef<number | null>(null);
  /** Открыли беседу на месте (не к непрочитанному и не снизу) — эффект смены ленты не тянет её вниз. */
  const restoringPlace = useRef(false);
  /**
   * Открыли ленту и ещё не решили, куда встать.
   *
   * 🔴 Черта «Новые сообщения» рисовалась правильно, но пользы не приносила: лента открывалась
   * НИЖЕ неё, и человек видел черту, только если сам догадывался пролистать вверх. В Discord
   * открытие канала ведёт как раз к этой границе — «докуда я дочитал» и есть то место, с которого
   * человек собирался продолжить.
   */
  const wantUnreadJump = useRef(false);
  /**
   * Тащат ли сейчас файл над окном чата.
   *
   * 🔴 Бросить файл в чат можно было и раньше, но интерфейс об этом молчал: ни рамки, ни подписи —
   * приём обнаруживался случайно или от знакомых. Счётчик, а не флаг: `dragleave` стреляет и при
   * переходе курсора на ДОЧЕРНИЙ элемент, и простой флаг мигал бы на каждом сообщении под курсором.
   */
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  /**
   * Окно отправки файлов на ПК (G48): файлы, выбор способа и подпись. Открывается вместо полосы вложений, когда есть очередь
   * ЛС (`outbox`) и это не телефон. `boxNow` — то же состояние без ожидания отрисовки: два выбора в одном такте видят друг друга.
   */
  const [box, setBox] = useState<{ files: File[]; way: SendWay; caption: string; saved: SendWay } | null>(null);
  const boxNow = useRef(box);
  boxNow.current = box;
  /** Что тащат над чатом и над какой зоной (G37, две зоны броска): только у окна отправки. */
  const [dropInfo, setDropInfo] = useState<{ kind: DropKind; zone: DropZone } | null>(null);
  /** Превью ссылки над полем убрано крестиком (G19): живёт, пока в тексте остаётся ссылка (`nextDismissed`). */
  const [previewOff, setPreviewOff] = useState(false);
  const previewLink = useMemo(() => composerPreviewLink(text, isOwnLink), [text]);
  useEffect(() => setPreviewOff((d) => nextDismissed(d, previewLink)), [previewLink]);
  /** Последнее сообщение прошлой отрисовки — по нему считаем, сколько пришло именно снизу. */
  const prevLastId = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** В поле больше одной строки — кнопки встают к нижнему краю, как у Telegram (`.composer.multiline`). */
  const [multiline, setMultiline] = useState(false);
  /* Поле растёт под текст до потолка, дальше прокручивается само (#212). Меряем по `scrollHeight` после
     сброса высоты: `field-sizing: content` удобнее, но WebView на старых Android и Safari его не знают. */
  const fitComposer = () => {
    const el = inputRef.current;
    // Поле ещё не разложено (почти нулевая ширина) — мерить нечего: подсказка перенеслась бы по буквам.
    if (!el || el.clientWidth < 40) return;
    el.style.height = 'auto';
    const full = el.scrollHeight;
    // Потолок — от доступной высоты (видимое окно без системных вставок): в ландшафте и с клавиатурой он ниже 200.
    const safe = viewportSafe();
    const cap = composerMaxPx(safe.vh - (safe.top ?? 0));
    const h = Math.min(full, cap);
    el.style.height = `${h}px`;
    el.style.overflowY = full > cap ? 'auto' : 'hidden';
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    setMultiline(h > line * 1.5 + pad);
  };
  /* Подсказка пустого поля: правка, ответ («Ответ <имя>…») или своя. Высота пустого поля — по ней, поэтому мерим и при её
     смене: на телефоне подсказка «Ответ <имя>…» может быть длиннее «Сообщение». Без этого поле оставалось высотой прошлой
     подсказки до следующей смены ширины — а она случается на выходе из выделения (поле было спрятано), и поле
     сжималось на 17 px под неподвижной лентой: строки у низа уезжали вниз (общая проверка 05.10, кейс F). */
  const composerHint = composerEdit
    ? 'Текст сообщения'
    : replyingTo
      ? `Ответ ${nameOf(replyingTo.author.id, replyingTo.author.displayName)}…`
      : placeholder;
  useLayoutEffect(fitComposer, [text, composerHint]);
  /* ⚠️ И при смене ШИРИНЫ: при монтировании поле бывает почти нулевой ширины (лента ещё грузится), подсказка
     переносится по буквам — и пустое поле раздувалось до потолка. Высота на ширину не влияет, петли нет. */
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitComposer();
    });
    ro.observe(el);
    // Поворот и клавиатура меняют доступную высоту — а с ней потолок поля (`composerMaxPx`).
    const onViewport = () => fitComposer();
    window.addEventListener('resize', onViewport);
    window.visualViewport?.addEventListener('resize', onViewport);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onViewport);
      window.visualViewport?.removeEventListener('resize', onViewport);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fitComposer читает только ref
  }, []);
  const { open: openUserMenu, menu: userMenu } = useUserMenu();
  /* Я — для аватара у строки «в пути» в широкой ленте пузырей: она бывает последней в моей группе, а аватар — у
     последнего (`MessageRow` берёт его из автора сообщения, у строки «в пути» автора ещё нет). */
  const me = useStore((s) => s.user);
  /**
   * Корона в чате рисуется В ШАПКЕ БЛОКА, а не у каждого сообщения: подряд идущие сообщения
   * одного человека группируются под одной аватаркой (`grouped`), и значок едет вместе с ней.
   * ⚠️ Иначе у того, кто пишет много, корона повторялась бы десятками в одном экране — награда
   * превратилась бы в шум за первые же полчаса разговора.
   */
  const crownId = useCrownId(serverId);
  // Одна подписка на компонент — внутри `map` хук звать нельзя.
  const animatedOf = useAnimatedAvatarUrl();
  // Гость ли автор — из общего ростера, тем же приёмом, что и его движущийся аватар.
  const guestHomeOf = useGuestHome();
  /* Действия строк ленты: свежие обработчики кладём в ref на каждой перерисовке, а строкам отдаём ОДИН объект,
     который их зовёт, — иначе новые стрелочные функции перерисовывали бы все `memo`-строки (фаза 0.4). */
  /** Цель следующего меню строки (`RowActions.aim`, 07.10): файл или ссылка под курсором; `menu` забирает и сбрасывает. */
  const menuAim = useRef<MenuMore | undefined>(undefined);
  const rowActsRef = useRef<RowActions>(null!);
  rowActsRef.current = {
    touchStart: (e, m) => onMsgTouchStart(e, m),
    touchMove: (e) => {
      onMsgTouchMove(e);
      swipeMove(e);
    },
    touchEnd: () => {
      cancelLongPress();
      swipeForget();
    },
    menu: (m, x, y, touch, photo) => {
      const more = menuAim.current;
      menuAim.current = undefined;
      openMsgMenu(m, x, y, touch, photo, more);
    },
    aim: (more) => {
      menuAim.current = more;
    },
    photoMenu: () => true,
    // Канал (#231): `/cmd` из текста бота уходит ЭТОМУ боту — с `@ником`, если ту же команду знает другой бот канала.
    botCommand: (cmd, botUsername) => sendBotCommand(channelCmds ? botCommandFromMessage(cmd, botUsername, channelCmds) : cmd),
    tap: (e, m) => onRowTap(e, m),
    press: (e, m) => onRowPress(e, m),
    dbl: (e, m) => onRowDouble(e, m),
    who: (e, m, r) => openWho(e, m, r),
    reactor: (id) => reactorOf?.(id) ?? null,
    userMenu: (e, target, view) => openUserMenu(e, target, view),
    openImage: (a) => openImage(a),
    react: (id, emoji, op) => onReact?.(id, emoji, op),
    reactBig: (id, emoji) => onReactBig?.(id, emoji),
    picker: (messageId, anchor) => setPicker({ kind: 'msg', messageId, anchor }),
    reply: (m) => startReply(m),
    startEdit: (m) => editFromMenu(m),
    del: (m) => void del(m),
    jumpTo: (id) => void jumpToMessage(id),
    pick: (e, m) => onPick(e, m),
  };
  const rowActs = useMemo<RowActions>(
    () => ({
      touchStart: (e, m) => rowActsRef.current.touchStart(e, m),
      touchMove: (e) => rowActsRef.current.touchMove(e),
      touchEnd: () => rowActsRef.current.touchEnd(),
      menu: (m, x, y, touch, photo) => rowActsRef.current.menu(m, x, y, touch, photo),
      aim: (more) => rowActsRef.current.aim(more),
      photoMenu: () => rowActsRef.current.photoMenu(),
      botCommand: (cmd, botUsername) => rowActsRef.current.botCommand?.(cmd, botUsername),
      tap: (e, m) => rowActsRef.current.tap(e, m),
      press: (e, m) => rowActsRef.current.press(e, m),
      dbl: (e, m) => rowActsRef.current.dbl(e, m),
      who: (e, m, r) => rowActsRef.current.who(e, m, r),
      reactor: (id) => rowActsRef.current.reactor(id),
      userMenu: (e, target, view) => rowActsRef.current.userMenu(e, target, view),
      openImage: (a) => rowActsRef.current.openImage(a),
      react: (id, emoji, op) => rowActsRef.current.react(id, emoji, op),
      reactBig: (id, emoji) => rowActsRef.current.reactBig(id, emoji),
      picker: (messageId, anchor) => rowActsRef.current.picker(messageId, anchor),
      reply: (m) => rowActsRef.current.reply(m),
      startEdit: (m) => rowActsRef.current.startEdit(m),
      del: (m) => rowActsRef.current.del(m),
      jumpTo: (id) => rowActsRef.current.jumpTo(id),
      pick: (e, m) => rowActsRef.current.pick(e, m),
    }),
    [],
  );

  /**
   * Прижать ленту к низу. Именно `scrollTop`, а не `scrollIntoView`: второй ищет ближайшего
   * прокручиваемого предка и в скрытой вкладке с `behavior: 'smooth'` не исполняется вовсе.
   */
  function stickDown() {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Куда встали (браузер упёр в край): `scroll` отсюда — это «прижато», даже если строка уже успела подрасти (kbjump).
    stickWant.current = el.scrollTop;
  }
  /** Прокрутка, которую поставил `stickDown` и чей `scroll` ещё не пришёл; `null` — нет. Читает эффект прилипания (kbjump). */
  const stickWant = useRef<number | null>(null);

  // ─── Окно беседы (шаг 2г): якорь, переходы, место ───────────────────────────────────────────────────────────────
  function rowsOf(box: HTMLElement): NodeListOf<HTMLElement> {
    return box.querySelectorAll<HTMLElement>('.message[data-mid]');
  }

  function rowOf(id: string): HTMLElement | null {
    const box = listRef.current;
    if (!box) return null;
    for (const r of rowsOf(box)) if (r.dataset.mid === id) return r;
    return null;
  }

  /** Сообщение у верхней кромки ленты и его отступ — якорь прокрутки. */
  function captureAnchor(): FeedPlace | null {
    const box = listRef.current;
    if (!box) return null;
    const rows = rowsOf(box);
    const viewTop = box.getBoundingClientRect().top;
    const i = anchorIndex(rows.length, (k) => rows[k].getBoundingClientRect().bottom, viewTop);
    if (i < 0) return null;
    return { messageId: rows[i].dataset.mid as string, offset: rows[i].getBoundingClientRect().top - viewTop };
  }

  /** Вернуть якорь на его отступ. `false` — строки нет в ленте. */
  function restoreAnchor(a: FeedPlace): boolean {
    const box = listRef.current;
    const row = rowOf(a.messageId);
    if (!box || !row) return false;
    box.scrollTop += anchorShift(a, row.getBoundingClientRect().top, box.getBoundingClientRect().top);
    return true;
  }

  /** Встать строкой на её отступ: `done` — встала; `newer`/`older` — край ленты не пустил (за ним ещё не догружено). */
  function placeAnchor(a: FeedPlace): 'done' | 'newer' | 'older' | 'missing' {
    const box = listRef.current;
    if (!restoreAnchor(a) || !box) return 'missing';
    const row = rowOf(a.messageId);
    if (!row) return 'missing';
    const off = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (Math.abs(off - a.offset) <= 2) return 'done';
    return off > a.offset ? 'newer' : 'older';
  }

  /**
   * Место из ожидания («Назад», открытие на месте). 🔴 Упёрлись в край окна, а за краем есть ещё (02.10, вид телефона:
   * порция «вокруг» места кончилась за одно сообщение до конца беседы, ниже места не хватало строк) — догрузить и встать
   * снова, а не застыть со сдвигом в сотню пикселей. Не дольше 2 с: дальше лента уже в руках человека. Строки нет —
   * ждём её дальше.
   *
   * 🔴 Окно из кеша (после перезагрузки): строка места есть и в нём — ставим сразу, первый кадр уже на месте, но
   * ожидание не снимаем и ничего не догружаем: беседа уже просит свежую порцию, и та ЗАМЕНИТ окно (соседи места в ней
   * другие — край окажется ближе, строка съедет). Окончательно встаём по свежей.
   */
  function settlePlace(p: PendingPlace): void {
    const done = () => {
      if (pendingScroll.current === p) pendingScroll.current = null;
    };
    if (p.until !== undefined && Date.now() >= p.until) return done();
    const r = placeAnchor(p.place);
    if (r === 'missing') return;
    p.applied = true;
    const fw = fwRef.current;
    if (fw?.stale) return;
    const more = r === 'newer' ? !!fw?.hasNewer : r === 'older' ? !!fw?.hasOlder : false;
    if (!more) return done();
    if (p.until === undefined) {
      p.until = Date.now() + 2000;
      // Догрузка не удалась или ничего не принесла — лента не меняется, и ожидание снимет срок, а не следующая порция.
      window.setTimeout(done, 2100);
    }
    if (r === 'newer') loadNewer();
    else loadOlderWindowed();
  }

  /** Поставить строку посередине ленты и подсветить (переход к цитате). `false` — строки нет. */
  function scrollToRow(id: string): boolean {
    const box = listRef.current;
    const row = rowOf(id);
    if (!box || !row) return false;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    box.scrollTop += r.top - b.top - Math.max(0, (box.clientHeight - r.height) / 2);
    row.classList.remove('jump-hit');
    void row.offsetWidth; // перезапуск подсветки при повторном переходе к той же строке
    row.classList.add('jump-hit');
    // Пузыри ЛС — 2 с, как вспышка Telegram (`bubJumpHit` в styles.css); каналы — своя 1,6 с (`.message.jump-hit`).
    window.setTimeout(() => row.classList.remove('jump-hit'), bubbles ? 2000 : 1600);
    return true;
  }

  /** Место для памяти: `null`, если человек внизу у хвоста беседы. */
  function currentPlace(): FeedPlace | null {
    const fw = fwRef.current;
    if (nearBottomRef.current && !fw?.hasNewer) return null;
    return captureAnchor();
  }

  function savePlaceSoon(): void {
    if (!fwRef.current) return;
    if (placeTimer.current !== null) window.clearTimeout(placeTimer.current);
    placeTimer.current = window.setTimeout(() => {
      placeTimer.current = null;
      // Место ещё ставится (ждём свежую порцию, догружаем край) — промежуточное положение не место человека.
      if (pendingScroll.current?.kind === 'place') return;
      fwRef.current?.onPlace(currentPlace());
    }, 400);
  }

  /**
   * Держать якорь, пока идёт операция окна: лента меняется сверху и снизу, а человек остаётся на своей строке.
   * 🔴 Отпускаем, когда закончилась ПОСЛЕДНЯЯ из идущих (02.10, стенд 2г): подгрузка старого и подгрузка нового шли
   * разом, первая закончившаяся снимала якорь, и порция второй считалась «пришло новое» — последнее сообщение беседы моё,
   * и лента уезжала в самый низ.
   */
  function holdAnchor<T>(op: Promise<T>): Promise<T> {
    heldOps.current++;
    heldAnchor.current = captureAnchor();
    return op.finally(() => {
      // Ответ уже в ленте (стор обновляется синхронно) — отпускаем после кадра, когда его разметка точно применена.
      requestAnimationFrame(() => {
        heldOps.current--;
        if (heldOps.current === 0) heldAnchor.current = null;
      });
    });
  }

  /**
   * Человек перешёл или листает, пока идёт операция окна, — держать его НОВОЕ положение. 🔴 02.10: ответ подгрузки
   * возвращал ленту на якорь, снятый в её начале, — на телефоне «Назад» встал на 668 px вместо −12, на стенде колесо во
   * время подгрузки старого (прокрутка ещё катилась) — скачок назад на 581 px.
   */
  function followHeld(): void {
    if (heldOps.current > 0) heldAnchor.current = captureAnchor() ?? heldAnchor.current;
  }

  /** Окно: подтянуть старое сверху, держа якорь (низ окна при этом может обрезаться — разница высот соврала бы). */
  function loadOlderWindowed(): void {
    if (!onLoadOlder || olderBusy.current || !fwRef.current?.hasOlder) return;
    olderBusy.current = true;
    setShowOlderHint(true);
    void holdAnchor(onLoadOlder())
      .catch(() => {})
      .finally(() => {
        olderBusy.current = false;
        setShowOlderHint(false);
      });
  }

  function loadNewer(): void {
    const fw = fwRef.current;
    if (!fw || newerBusy.current) return;
    newerBusy.current = true;
    void holdAnchor(fw.loadNewer())
      .catch(() => {})
      .finally(() => {
        newerBusy.current = false;
      });
  }

  /** «Вниз»: окно не у хвоста — последние сообщения беседы, у хвоста — просто к низу. */
  async function goLatest(): Promise<void> {
    const fw = fwRef.current;
    /* G26: сначала к первому непрочитанному, если оно ниже экрана (Telegram 03·3.3.1–3.3.2), потом — в конец. Стек «Назад»
       не трогаем: это ещё не уход в конец. */
    /* Явный переход — «к непрочитанному» или «в конец» — снимает черту (и в канале): у Telegram Desktop обе ветки показа проходят через
       `destroyUnreadBar` (tdesktop `history/history_widget.cpp`, `showHistory`: «To end or to unread»; ресерч 03·3.2.2 г). */
    // И в канале (там нет окна беседы, но та же черта по метке визита): у Telegram правило одно на любую беседу (сверка 07.10).
    setDividerOffAt(scrollKey ?? '');
    const box = listRef.current;
    const unreadRow = fw && onSeen ? firstUnreadRow() : null;
    const boxBottom = box ? Math.min(box.getBoundingClientRect().bottom, window.innerHeight) : 0;
    if (box && unreadRow && jumpDownTarget(unreadRow.getBoundingClientRect().top, boxBottom) === 'unread') {
      const shift = unreadRow.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTo({ top: Math.max(0, box.scrollTop + shift - 48), behavior: reducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    setJumpStack([]);
    nearBottomRef.current = true;
    setNearBottom(true);
    setUnseenBelow(0);
    if (!fw?.hasNewer) {
      const el = listRef.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    pendingScroll.current = { kind: 'bottom' };
    await fw.jumpLatest().catch((e) => toastError(e, 'Не удалось загрузить последние сообщения'));
    requestAnimationFrame(() => {
      if (pendingScroll.current?.kind !== 'bottom') return;
      pendingScroll.current = null;
      stickDown();
    });
  }

  /** Клик по цитате: к сообщению, место перехода — в стек «Назад». */
  async function jumpToMessage(id: string, noBack = false): Promise<void> {
    // Поиск и «Перейти к дате» (G05, G25) не копят «Назад»: у Telegram по ним ходят стрелками, а не возвратом.
    const from = noBack ? null : captureAnchor();
    if (rowOf(id)) {
      if (from) setJumpStack((s) => pushJump(s, from));
      scrollToRow(id);
      followHeld();
      return;
    }
    const fw = fwRef.current;
    if (!fw) {
      toast('info', 'Это сообщение выше загруженной истории — пролистайте вверх');
      return;
    }
    pendingScroll.current = { kind: 'message', id };
    let ok: boolean;
    try {
      ok = await fw.jumpTo(id);
    } catch (e) {
      // Сеть или сервер — не «удалено»; переход в другой инстанс тост глотает сам.
      pendingScroll.current = null;
      toastError(e, 'Не удалось открыть сообщение');
      return;
    }
    if (!ok) {
      pendingScroll.current = null;
      toast('info', 'Сообщение удалено');
      return;
    }
    if (from) setJumpStack((s) => pushJump(s, from));
    requestAnimationFrame(() => {
      const p = pendingScroll.current;
      if (p?.kind === 'message' && scrollToRow(p.id)) {
        pendingScroll.current = null;
        followHeld();
      }
    });
  }

  /* Полоса плеера голосовых из другой ленты открыла эту (`VoiceTopBar`) — переход к сообщению, когда лента загрузилась.
     Заказ забирается один раз; пока окна нет (`loading`, пусто), ждём. 🔴 Переходить — после того, как лента встала на
     своё место открытия (`pendingScroll`: запомненное место, низ, черта непрочитанного): иначе встающее место перебивает
     переход, и человек оказывается внизу (стенд 07.10). Ждём, пока ожидание снимется, но не дольше 4 с. */
  const voiceFeedReady = !loading && messages.length > 0;
  const jumpRef = useRef(jumpToMessage);
  jumpRef.current = jumpToMessage;

  /* Поиск в беседе и «Перейти к дате» (G05, G25; `ChatSearch.tsx`). Найденное — переходом «вокруг» без «Назад». Дневная
     метка в ленте — тоже дата Telegram (`DateClickHandler`): нажатие открывает календарь на её дне. */
  const cs = useChatSearch(chatSearch, (id) => jumpRef.current(id, true), feedId ?? null);
  useSearchHighlight(listRef, cs.open && cs.state ? cs.state.query : '', messages);
  const searchFoot = cs.open && phoneLayout;
  const dayPickRef = useRef<(mid: string) => void>(() => {});
  dayPickRef.current = (mid) => {
    const m = messages.find((x) => x.id === mid);
    if (m) cs.openCalendar(new Date(m.createdAt));
  };
  useEffect(() => {
    const list = listRef.current;
    if (!chatSearch || !list) return;
    const onClick = (e: MouseEvent) => {
      const pill = e.target instanceof Element ? e.target.closest('.day-divider.pill > span') : null;
      if (!pill || !list.contains(pill) || selecting) return;
      const next = pill.parentElement?.nextElementSibling;
      const mid = (next?.closest<HTMLElement>('[data-mid]') ?? next?.querySelector<HTMLElement>('[data-mid]'))?.dataset.mid;
      if (mid) dayPickRef.current(mid);
    };
    list.addEventListener('click', onClick);
    return () => list.removeEventListener('click', onClick);
  }, [!!chatSearch, selecting]); // eslint-disable-line react-hooks/exhaustive-deps
  // «Ответить в другом чате» (G55): ответ, выбранный в другой беседе, ждёт эту ленту — ставим его в поле с цитатой.
  const crossReply = useStore((s) => (s.crossReply && s.crossReply.convId === feedId ? s.crossReply : null));
  /** Черновик пересылки в эту беседу (08.10, `fwdDrafts`): полоса «Пересылка» над полем, уходит с отправкой. Только с пачкой. */
  const fwdDraft = useStore((s) => (batchOn && feedId ? s.fwdDrafts[feedId] : undefined)) ?? null;
  /** Меню полосы «Пересылка» (Telegram 5.22: скрыть имя / подписи, изменить получателя, не пересылать). */
  const [fwdMenu, setFwdMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!crossReply || !outbox || !quoteOn) return;
    useStore.getState().setCrossReply(null);
    if (readOnly) return;
    setReplyingTo(crossReply.message);
    setReplyExtra({ id: crossReply.message.id, quote: crossReply.quote, foreign: true });
    inputRef.current?.focus();
  }, [crossReply]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * «Поделиться в GusVoice» (09.10, G79; Telegram Android: `DialogsActivity` в режиме выбора → `ChatActivity` с вложениями в
   * предпросмотре): пришедшее из чужого приложения ждёт эту ленту (`store.sharedIn`, кладёт `ShareIncoming`). Файлы — тем же
   * `addFiles`, что «Прикрепить» (ПК — окно отправки с текстом подписью, телефон — полоса у поля), текст — в поле (к уже
   * набранному — с новой строки). Отправляет только человек.
   */
  const sharedIn = useStore((s) => (s.sharedIn && s.sharedIn.convId === feedId ? s.sharedIn : null));
  useEffect(() => {
    if (!sharedIn) return;
    useStore.getState().setSharedIn(null);
    if (readOnly) return void toast('info', 'В эту беседу писать нельзя');
    // Идёт правка сообщения: поле занято её текстом, вложение к правке не прицепить (`addFiles`) — не мешаем их.
    if (composerEdit) return void toast('info', 'Сначала закончите правку сообщения');
    const add = sharedIn.text;
    const boxed = sharedIn.files.length > 0 && !!outbox && !phoneLayout;
    if (sharedIn.files.length > 0) addFiles(sharedIn.files, boxed ? { caption: add } : undefined);
    if (add && !boxed) {
      setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n${add}` : add));
      refocusComposer();
    }
  }, [sharedIn]); // eslint-disable-line react-hooks/exhaustive-deps
  const feedJumpSeq = useFeedJumpSeq();
  useEffect(() => {
    if (!voiceFeedReady) return;
    // Заказ перехода из полосы голосовых или из поиска по списку (G35, `feedJump.ts`) — одно и то же: лента открылась, идём к id.
    const id = takeVoiceJump(feedId) ?? takeFeedJump(feedId);
    if (!id) return;
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      const waited = Date.now() - t0;
      if (waited < 150 || (pendingScroll.current && waited < 4000)) return;
      window.clearInterval(timer);
      void jumpRef.current(id);
    }, 50);
    return () => window.clearInterval(timer);
  }, [feedId, voiceFeedReady, feedJumpSeq]);

  /* Файлы, брошенные из проводника на строку беседы в списке (G37, `filesDrop.ts`): лента этой беседы забирает заказ — сразу,
     если уже открыта, или когда откроется — и кладёт файлы в окно отправки (как бросок прямо в ленту, `addFiles`). Телефон и
     не-ЛС (`outbox`) не участвуют: на них строка файлов не принимает. */
  const filesDropSeq = useFilesDropSeq();
  /* Беседа сейчас: упаковка папки (`collectDrop`) идёт секунды, и файл не должен упасть в чужую беседу, если успели переключиться. */
  const feedNow = useRef(feedId);
  feedNow.current = feedId;
  useEffect(() => {
    if (!feedId || !outbox || phoneLayout) return;
    const files = takeFilesDrop(feedId);
    if (files) addFiles(files);
  }, [feedId, filesDropSeq]); // eslint-disable-line react-hooks/exhaustive-deps -- addFiles читает рефы на момент вызова

  /* Непрочитанные реакции на мои сообщения гасятся, когда сообщение побыло на экране (G24; tdesktop `HistoryItem::markReactionsRead`:
     показано при активном окне). Наблюдатель — по строкам с `reactionUnread`; пауза `REACTION_SEEN_DELAY_MS` не даёт прокрутке
     «прочитать» всё, что мелькнуло; окно без фокуса не читает — дочитает по возвращению. */
  const unreadReactIds = useMemo(
    () => (cornerThings?.onReactionsRead ? messages.filter((m) => (m as { reactionUnread?: true }).reactionUnread).map((m) => m.id) : []),
    [messages, cornerThings?.onReactionsRead],
  );
  const reactionsReadRef = useRef(cornerThings?.onReactionsRead);
  reactionsReadRef.current = cornerThings?.onReactionsRead;
  const unreadReactKey = unreadReactIds.join(',');
  useEffect(() => {
    const list = listRef.current;
    if (!list || unreadReactIds.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const ids = reactionsToMark(unreadReactIds, visible);
      if (ids.length > 0) reactionsReadRef.current?.(ids);
    };
    const arm = () => {
      if (timer === undefined) timer = window.setTimeout(flush, REACTION_SEEN_DELAY_MS);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.mid;
          if (!id) continue;
          // Высокое сообщение (больше окна) не наберёт долю целиком — хватает, чтобы оно занимало бо́льшую часть окна ленты.
          const shown = e.isIntersecting && (e.intersectionRatio >= REACTION_SEEN_RATIO || e.intersectionRect.height >= list.clientHeight * REACTION_SEEN_RATIO);
          if (shown) visible.add(id);
          else visible.delete(id);
        }
        if (visible.size > 0) arm();
      },
      { root: list, threshold: [0, 0.25, REACTION_SEEN_RATIO, 1] },
    );
    for (const id of unreadReactIds) {
      const el = list.querySelector(`[data-mid="${CSS.escape(id)}"]`);
      if (el) io.observe(el);
    }
    window.addEventListener('focus', arm);
    return () => {
      io.disconnect();
      window.removeEventListener('focus', arm);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [unreadReactKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Кнопки «@» / «♥»: к самому старому непрочитанному (tdesktop `CornerButtons::reactionsClick` → `minLoaded()`). */
  async function cornerJump(kind: CornerKind): Promise<void> {
    const fn = kind === 'reactions' ? cornerThings?.onReactionsJump : cornerThings?.onMentionsJump;
    if (!fn) return;
    let id: string | null = null;
    try {
      id = await fn();
    } catch (e) {
      toastError(e, 'Не удалось найти сообщение');
      return;
    }
    if (id) void jumpToMessage(id);
  }
  const cornerBtns = cornerButtons({ reactions: cornerThings?.onReactionsJump ? cornerThings.reactions : 0, mentions: cornerThings?.onMentionsJump ? cornerThings.mentions : 0 });

  /** «Назад»: к месту, откуда переходили. */
  async function goBack(): Promise<void> {
    const { place, stack } = popJump(jumpStack);
    setJumpStack(stack);
    if (!place) return;
    if (restoreAnchor(place)) {
      followHeld();
      return;
    }
    const fw = fwRef.current;
    if (!fw) return;
    pendingScroll.current = { kind: 'place', place };
    let ok: boolean;
    try {
      ok = await fw.jumpTo(place.messageId);
    } catch (e) {
      pendingScroll.current = null;
      toastError(e, 'Не удалось вернуться');
      return;
    }
    if (!ok) {
      pendingScroll.current = null;
      return;
    }
    requestAnimationFrame(() => {
      const p = pendingScroll.current;
      if (p?.kind === 'place') {
        settlePlace(p);
        followHeld();
      }
    });
  }

  /**
   * Человек сам вернулся к месту «Назад» (прокруткой) — место из стека долой, и следующее под ним, если дошли и до него
   * (`jumpReturn`, как у Telegram Desktop). Раньше стек чистили только «Вниз» и смена ленты: вернулся к низу пальцем —
   * плашка «Назад» висела дальше, над панелью выделения и при пересылке (приёмка телефона 05.10). Строки места нет в
   * ленте (окно ушло дальше) — ждём, пока появится.
   */
  function dropReachedJumps(): void {
    const box = listRef.current;
    if (!box || jumpStack.length === 0) return;
    const top = box.getBoundingClientRect().top;
    let n = jumpStack.length;
    while (n > 0) {
      const place = jumpStack[n - 1];
      const row = rowOf(place.messageId);
      if (!row) break;
      const r = jumpReturn(row.getBoundingClientRect().top - top, place, jumpSides.get(place) ?? null);
      if (r.side) jumpSides.set(place, r.side);
      if (!r.reached) break;
      n--;
    }
    if (n < jumpStack.length) setJumpStack(jumpStack.slice(0, n));
  }

  /* Лента окна изменилась — встать куда ждали (переход, «Вниз», место) или удержать якорь идущей операции. До
     отрисовки кадра (`useLayoutEffect`): иначе человек увидел бы скачок. */
  useLayoutEffect(() => {
    if (!feedWindow) return;
    const p = pendingScroll.current;
    if (p) {
      if (p.kind === 'bottom') {
        pendingScroll.current = null;
        stickDown();
      } else if (p.kind === 'message') {
        if (scrollToRow(p.id)) pendingScroll.current = null;
      } else settlePlace(p);
      syncNearBottom();
      followHeld();
      navMessages.current = messages;
      return;
    }
    if (heldAnchor.current && restoreAnchor(heldAnchor.current)) syncNearBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  /* 🔴 Подсказка «Подтягиваем историю…» встаёт НАД строками — якорь операции держим и через неё (05.10, «якорь прыгает на
     33 px», разбор порции 6). На ненулевой прокрутке строки на месте держит сам браузер (`overflow-anchor`), на нулевой —
     нет: колесо докатило ленту до самого верха раньше, чем пришла порция старого, подсказка сдвигала строки вниз на свою
     высоту (33 px на телефоне), события прокрутки при этом нет — якорь оставался снятым ДО подсказки, и приход порции
     возвращал строку на место «без подсказки»: видимый скачок −33. Теперь строка остаётся, где её видели, а подсказка
     уходит за верхнюю кромку — как у браузера на ненулевой прокрутке (видна, если тянуть выше). Сдвинуть некуда (лента
     короче экрана) — новое положение и есть место человека (`followHeld`). Сдвиг меньше пикселя не трогаем: строки уже
     удержал браузер, а лишняя запись `scrollTop` — программная прокрутка посреди прокрутки человека. Каналы (без окна)
     якоря операции не держат — правило их не касается. */
  useLayoutEffect(() => {
    const held = heldAnchor.current;
    const box = listRef.current;
    if (!showOlderHint || !held || !box) return;
    const row = rowOf(held.messageId);
    if (row) {
      const shift = anchorShift(held, row.getBoundingClientRect().top, box.getBoundingClientRect().top);
      if (Math.abs(shift) >= 1) box.scrollTop += shift;
    }
    followHeld();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOlderHint]);

  /* ─── Канал и любая лента без окна: тот же якорь на подгрузке старого (06.10, хвост «+33 / −5 px») ──────────────────────
     Без окна (каналы) место держала разница высот (`keepPositionAfterPrepend`,
     кадром позже), а подсказку она не видела: колесо докатывало ленту до нуля, подсказка вставала над строками (+33 px,
     браузер на нулевой прокрутке их не держит), а приход порции возвращал строку к положению «без подсказки» (−33); листал
     человек, пока порция в пути, — порция отбрасывала его назад на всю прокрутку (стенд: −150 / +167 px). Теперь — как у окна
     бесед: строка у верхней кромки запоминается в событии прокрутки, с которого началась подгрузка (до подсказки), следует
     за прокруткой человека, возвращается на место, когда встала подсказка, и ещё раз — когда пришла порция (до отрисовки
     кадра). 🔴 Держим НИЗ строки, а не верх: у первой строки канала с приходом порции пропадает шапка (имя и время — строка
     склеивается с последним сообщением порции того же автора; у пузыря — верхний отступ группы), и верх на месте увёл бы
     текст вверх на высоту шапки (31 px на стенде). Свой реф, а не `heldAnchor`: тот глушит счётчик «новых» и прилипание к
     низу на время операции. */
  const chanHeld = useRef<FeedPlace | null>(null);
  /** Номер подгрузки старого без окна: отпускание прошлой не снимет якорь следующей. */
  const chanOp = useRef(0);

  /** Лента без окна: строка у верхней кромки и отступ её НИЗА от кромки. */
  function captureChanAnchor(): FeedPlace | null {
    const box = listRef.current;
    if (!box) return null;
    const rows = rowsOf(box);
    const viewTop = box.getBoundingClientRect().top;
    const i = anchorIndex(rows.length, (k) => rows[k].getBoundingClientRect().bottom, viewTop);
    if (i < 0) return null;
    return { messageId: rows[i].dataset.mid as string, offset: rows[i].getBoundingClientRect().bottom - viewTop };
  }

  /** Без окна: вернуть низ строки на его отступ и запомнить, где строки теперь (прокрутка упёрлась — новое место и есть место). */
  function holdChanAnchor(): void {
    const held = chanHeld.current;
    const box = listRef.current;
    if (!held || !box) return;
    const row = rowOf(held.messageId);
    if (!row) return;
    const shift = anchorShift(held, row.getBoundingClientRect().bottom, box.getBoundingClientRect().top);
    // Меньше пикселя — строки уже удержал браузер; лишняя запись `scrollTop` — программная прокрутка посреди человека.
    if (Math.abs(shift) >= 1) box.scrollTop += shift;
    chanHeld.current = captureChanAnchor() ?? held;
  }

  // Встала подсказка — строка обратно на место, подсказка уходит за верхнюю кромку (снятие подсказки держит браузер).
  useLayoutEffect(() => {
    if (showOlderHint && !feedWindow) holdChanAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOlderHint]);

  // Пришла порция старого — строка на месте до первого кадра (React уже положил строки, браузер их ещё не показал).
  useLayoutEffect(() => {
    if (!feedWindow) holdChanAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  /* 🔴 «У низа» — по настоящему положению сразу после того, как окно встало (01.10, поймано замером на стенде).
     Признак остаётся от прокрутки ПЕРЕД подгрузкой («был у низа окна»), а удержание якоря отпускается раньше, чем
     React доходит до эффекта «добавлено снизу», — и тот по старому признаку прижимал ленту к низу: подгрузка порции
     новее утаскивала человека на 4 тысячи пикселей вниз. */
  function syncNearBottom(): void {
    const box = listRef.current;
    if (!box) return;
    nearBottomRef.current = isNearBottom(box);
    setNearBottom(nearBottomRef.current);
    setFarFromEnd(isFarFromBottom(box));
  }

  /* 🔴 Окно короче экрана (01.10, поймано сценарием на стенде): открыли у одного-двух последних непрочитанных — прокрутки
     нет, и подгрузка по прокрутке не случится никогда: человек видел два сообщения и не мог отлистать выше. Добираем
     историю, пока лента не заполнит экран. */
  useEffect(() => {
    if (!feedWindow || messages.length === 0) return;
    const box = listRef.current;
    if (!box || box.scrollHeight > box.clientHeight + 4) return;
    if (feedWindow.hasOlder) loadOlderWindowed();
    else if (feedWindow.hasNewer) loadNewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, feedWindow?.hasOlder, feedWindow?.hasNewer]);

  /* Открыли беседу на месте — встаём на него до первого кадра; без места эффект смены ленты ставит её вниз или к
     черте непрочитанного, как раньше. */
  useLayoutEffect(() => {
    const fw = fwRef.current;
    restoringPlace.current = false;
    if (!fw) return;
    setJumpStack([]);
    if (!fw.place) return;
    restoringPlace.current = true;
    const pending: PendingPlace = { kind: 'place', place: fw.place };
    pendingScroll.current = pending;
    settlePlace(pending);
    if (pendingScroll.current !== pending) return;
    /* Строки места нет и не пришло (сообщение удалили — стор открыл последние): не ждать вечно, встать вниз. Иначе
       ожидание глушило бы и прилипание к низу (эффект «добавлено снизу» молчит, пока что-то ждём). Место уже стояло по
       окну из кеша, а свежая порция не пришла (нет сети) — человек на своём месте, вниз не тянем. */
    const giveUp = window.setTimeout(() => {
      if (pendingScroll.current !== pending) return;
      pendingScroll.current = null;
      if (pending.applied) return;
      nearBottomRef.current = true;
      setNearBottom(true);
      stickDown();
    }, 4000);
    return () => window.clearTimeout(giveUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  // Ушёл из беседы — запомнить место (до снятия разметки: `useLayoutEffect` убирается раньше DOM). Ушёл, пока место
  // ещё ставилось, — помним его, а не промежуточное положение.
  useLayoutEffect(
    () => () => {
      if (placeTimer.current !== null) window.clearTimeout(placeTimer.current);
      const p = pendingScroll.current;
      fwRef.current?.onPlace(p?.kind === 'place' ? p.place : currentPlace());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /* Щипок по фото в ленте (G43, Telegram `PinchToZoomHelper`): слой с фото поверх чата, возврат на место за 220 мс. Два пальца на
     фото — долгое нажатие и свайп первого пальца ни к чему. */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    return attachFeedPinch(el, () => {
      cancelLongPress();
      swipeDrop();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelLongPress / swipeDrop трогают только ref'ы и setState
  }, []);

  /* Человек сам взялся за ленту, пока место ещё ставилось (медленная сеть: свежая порция идёт секунды) — ожидание
     снимаем: его движение важнее, а пришедшая порция дёрнула бы ленту обратно. */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const drop = () => {
      if (pendingScroll.current?.kind === 'place') pendingScroll.current = null;
    };
    el.addEventListener('wheel', drop, { passive: true });
    el.addEventListener('touchstart', drop, { passive: true });
    return () => {
      el.removeEventListener('wheel', drop);
      el.removeEventListener('touchstart', drop);
    };
  }, []);

  /**
   * 🔴 Удержание низа, пока догружается содержимое (19.09, найдено живой проверкой).
   *
   * Одного прыжка вниз при открытии канала НЕ хватает: картинки в ленте ещё не загружены, высота
   * у них нулевая, и как только браузер их получит, лента вырастет под нами — человек окажется
   * посреди истории, хотя открывал канал и ждал увидеть последнее. Ровно это и случилось на
   * проверке: канал с мемами открылся в 4672 пикселях от низа.
   *
   * Слушаем `load` в фазе перехвата (у картинок это событие не всплывает) и, пока человек НЕ
   * отлистал сам, прижимаем ленту обратно. Отлистал — не трогаем: его положение важнее.
   */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onLoad = () => {
      if (!nearBottomRef.current) return;
      // Открыто меню у пузыря (раунд 12) — прижмём, когда его закроют: иначе пузырь уехал бы из-под меню.
      if (holdFeedRef.current) stickAfterMenu.current = true;
      else el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, []);

  /**
   * 🔴 Низ держится, когда лента становится НИЖЕ (приёмка на телефоне 06.10, п. 5): выехала клавиатура (окно приложения
   * ужимается — низ ему отдаёт `MainActivity`), встала полоса ответа или прикреплённое, выросло поле, появилась строка
   * «печатает». Прокрутка при этом прежняя, и последние сообщения уходили под поле. Как у Telegram: лента была прижата к
   * низу — остаётся прижатой. Именно прижатая (до низа ≤ 2 px), а не «почти у низа» (`nearBottomRef`, 64 px): на выходе из
   * выделения поле возвращается, и строки у того, кто стоял чуть выше низа, не должны прыгать (`keepRowOnSelect`). Лента
   * выросла — низ держит сам браузер (прокрутка упирается в край). Открыто меню у пузыря — ленту не двигаем (как `onLoad`
   * выше), идёт переход (`pendingScroll`) — место ставит он.
   */
  /* Окно телефона сменило высоту (клавиатура, вставка системной панели вслед за ней) — низ ленты стоит на месте при ЛЮБОЙ
     прокрутке, не только у прижатой: так ведёт себя перевёрнутый список TG Android (`ChatActivity.java:6499`,
     `GridLayoutManagerFixed(…, !reversed)` — якорь у нижнего края). Раньше лента, стоявшая хоть на 3 px выше низа, при
     клавиатуре держала верх, и сообщение, на которое отвечают свайпом, уходило под клавиатуру на её высоту (аудит S20+
     10.10, B9: «лента на 370 px выше низа»). Закрылась клавиатура — та же поправка обратно, место не теряется. `lastTop` —
     прокрутка до смены (браузер мог уже упереть её в край); окно смены — `VIEWPORT_ANCHOR_MS` после `resize`. ПК — как было.
     🔴 kbjump (S20+ 13.10): отправил при клавиатуре, закрыл её «Назад» — лента уезжала вверх на высоту клавиатуры. Обработчик
     `resize` (поле ввода, `fitComposer`) читает раскладку раньше кадра — браузер уже упёр прокрутку в новый край и шлёт
     `scroll` ДО `ResizeObserver`; `lastTop` становился этой упёртой прокруткой, и поправка вычиталась второй раз. Теперь
     `scroll`, пришедший при высоте, которую наблюдатель ещё не видел (`el.clientHeight !== h`), `lastTop` не трогает, а
     прижатая к низу лента (`pinned`, до низа ≤ 2 px) после смены окна встаёт ровно в низ — как перевёрнутый список TG Android. */
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    let h = el.clientHeight;
    let lastTop = el.scrollTop;
    let vpAt = Number.NEGATIVE_INFINITY;
    const gapOf = (box: number) => el.scrollHeight - el.scrollTop - box;
    // Прижата ли лента к низу по последней прокрутке, которую видели при ИЗВЕСТНОЙ высоте ленты.
    let pinned = gapOf(h) <= 2;
    const onScroll = () => {
      const want = stickWant.current;
      stickWant.current = null;
      if (el.clientHeight !== h) return;
      lastTop = el.scrollTop;
      // Свой прыжок вниз — прижата, даже если строка (медиа, превью) выросла между прыжком и этим `scroll`.
      pinned = gapOf(h) <= 2 || (want !== null && Math.abs(el.scrollTop - want) <= 2);
    };
    const onViewport = () => {
      vpAt = performance.now();
    };
    const ro = new ResizeObserver(() => {
      const next = el.clientHeight;
      const shrink = h - next;
      h = next;
      const top = lastTop;
      lastTop = el.scrollTop;
      if (shrink === 0 || holdFeedRef.current || pendingScroll.current) return;
      if (performance.now() - vpAt < VIEWPORT_ANCHOR_MS && phoneTaps()) {
        // Прижатая и с тех пор не сдвинутая (браузер разве что упёр её в новый край) — в низ; иначе низ держит `top + shrink`.
        const stayed = Math.abs(el.scrollTop - Math.min(top, el.scrollHeight - next)) <= 2;
        el.scrollTop = pinned && stayed ? Math.max(0, el.scrollHeight - next) : Math.max(0, top + shrink);
        lastTop = el.scrollTop;
        pinned = gapOf(next) <= 2;
        return;
      }
      if (shrink < 0) return;
      // До смены: прокрутка та же (лента ужалась снизу), высота — прежняя.
      if (el.scrollHeight - el.scrollTop - (next + shrink) > 2) return;
      el.scrollTop += shrink;
      lastTop = el.scrollTop;
      pinned = true;
    });
    ro.observe(el);
    /* 🔴 kbjump, второе (S20+ 13.10): прижатая к низу лента, а последняя строка ВЫРОСЛА после вставки — превью ссылки
       (карточка с заголовком и описанием приходит правкой сообщения, число строк не меняется), «печатает», ответ сервера
       на строку «в пути». Ни прокрутки, ни `[messages.length]`, ни `load` картинки — и карточка оставалась под полем.
       Как TG Android (перевёрнутый список, якорь у нижнего края): была прижата — остаётся прижатой. Только если с последней
       прокрутки положение не трогали (`lastTop`): иначе это чужой переход (черта непрочитанного, цитата) — его не перебиваем. */
    const onContent = () => {
      const want = stickWant.current;
      // Только что прыгнули вниз (`stickDown`), а `scroll` ещё не пришёл — строка выросла в том же кадре: догоняем низ.
      const jumped = want !== null && Math.abs(el.scrollTop - want) <= 2;
      if (!jumped && (!pinned || Math.abs(el.scrollTop - lastTop) > 1)) return;
      if (el.clientHeight !== h) return;
      if (gapOf(h) <= 2 || pendingScroll.current || heldAnchor.current || chanHeld.current || fwRef.current?.hasNewer) return;
      if (holdFeedRef.current) {
        stickAfterMenu.current = true;
        return;
      }
      el.scrollTop = Math.max(0, el.scrollHeight - h);
      lastTop = el.scrollTop;
      if (jumped) stickWant.current = el.scrollTop;
    };
    const rows = new ResizeObserver(onContent);
    for (const child of Array.from(el.children)) rows.observe(child);
    const kids = typeof MutationObserver === 'function'
      ? new MutationObserver((list) => {
          for (const m of list) {
            for (const n of Array.from(m.addedNodes)) if (n instanceof Element) rows.observe(n);
            for (const n of Array.from(m.removedNodes)) if (n instanceof Element) rows.unobserve(n);
          }
        })
      : null;
    kids?.observe(el, { childList: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onViewport);
    window.visualViewport?.addEventListener('resize', onViewport);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      rows.disconnect();
      kids?.disconnect();
      window.removeEventListener('resize', onViewport);
      window.visualViewport?.removeEventListener('resize', onViewport);
    };
  }, []);

  /**
   * Верхний слой беседы на телефоне (tg3, #218): шапка и капсула полос лежат ПОВЕРХ ленты, лента начинается под ними
   * отступом (`.messages` — `padding-top: var(--chat-top-h) + 4px`, как `chatListViewPaddingTop` = `dp(4)` + шапка + панель
   * в `ChatActivity.java:11943-11953`). Высоту слоя меряем и отдаём `.chat` переменной `--chat-top-h`. Слой вырос или
   * сжался (встал закреп, заиграло голосовое) — прокрутку сдвигаем на ту же величину: строки на экране стоят на месте, а
   * прижатая к низу лента остаётся прижатой (раньше это делал `ResizeObserver` выше — лента сжималась по высоте). ПК — слой
   * `display: contents`, переменной нет.
   */
  useEffect(() => {
    const top = chatTopRef.current;
    const chat = chatEl;
    if (!chat) return;
    if (!top || !dockPhone || typeof ResizeObserver !== 'function') {
      chat.style.removeProperty('--chat-top-h');
      return;
    }
    let h = -1;
    const apply = () => {
      const next = top.offsetHeight;
      if (next === h) return;
      const d = h < 0 ? 0 : next - h;
      h = next;
      chat.style.setProperty('--chat-top-h', `${next}px`);
      const list = listRef.current;
      if (list && d !== 0 && !pendingScroll.current) list.scrollTop += d;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(top);
    return () => {
      ro.disconnect();
      chat.style.removeProperty('--chat-top-h');
    };
  }, [chatEl, dockPhone]);

  /**
   * Панель под полем → клавиатура (tg3, #218): касание поля или кнопки «клавиатура» поднимает клавиатуру, а панель уходит,
   * только когда клавиатура встала (`data-kb` на `<html>`, `refreshKeyboardFlag`) — иначе лента на миг вырастала бы на высоту
   * панели и снова сжималась. Клавиатура не поднялась (внешняя, эмуляция) — панель уходит через 600 мс.
   */
  /** Ожидание «клавиатура встала → убрать панель». `cancel` — без закрытия: панель уже закрыли иначе (Esc/«назад»), и старый
   *  таймер не должен закрыть НОВУЮ, открытую за эти 600 мс (находка Codex R146). */
  const kbFromPanelRef = useRef<{ cancel: () => void } | null>(null);
  function keyboardFromPanel() {
    if (kbFromPanelRef.current) return;
    const root = document.documentElement;
    const cancel = () => {
      clearTimeout(timer);
      obs.disconnect();
      kbFromPanelRef.current = null;
    };
    const done = () => {
      cancel();
      setPicker((p) => (p?.kind === 'composer' ? null : p));
    };
    const obs = new MutationObserver(() => {
      if (root.hasAttribute('data-kb')) done();
    });
    obs.observe(root, { attributes: true, attributeFilter: ['data-kb'] });
    const timer = window.setTimeout(done, 600);
    kbFromPanelRef.current = { cancel };
    if (root.hasAttribute('data-kb')) done();
  }
  useEffect(() => () => kbFromPanelRef.current?.cancel(), []);
  /* Панель под полем закрывают «назад» Android и Esc (у всплывающей это делал сам пикер; под полем он `docked` и молчит). */
  useEffect(() => {
    if (!exprUnder) return;
    const close = () => setPicker((p) => (p?.kind === 'composer' ? null : p));
    // Перехват на погружении: Esc закрывает только панель, а не беседу (выход из ленты по Esc слушает окно дальше).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector(TOP_LAYERS)) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    const back = pushBackHandler(() => {
      close();
      return true;
    });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      back();
      // Панель закрылась (чем угодно) — ожидание её закрытия больше не нужно.
      kbFromPanelRef.current?.cancel();
    };
  }, [exprUnder]);

  /**
   * Встать у границы непрочитанного — отдельным эффектом, а НЕ вместе с прокруткой по приходу
   * сообщений.
   *
   * 🔴 **Почему так (19.09, поймано живой проверкой).** Первая попытка искала черту сразу, как
   * приехали сообщения, — и не находила: метку последнего визита (`newSince`) выставляет родитель
   * в своём эффекте, а эффекты детей в React выполняются РАНЬШЕ родительских. То есть на момент
   * поиска черта ещё не отрисована, флаг сгорал впустую, и лента оставалась внизу.
   *
   * Теперь ждём именно её появления: эффект зависит и от метки, и от длины ленты, а флаг гаснет
   * только когда прыжок состоялся (или когда истёк срок ожидания — см. эффект смены ленты).
   */
  function tryUnreadJump(): void {
    if (!wantUnreadJump.current || messages.length === 0) return;
    if (unreadMark === null || unreadMark === undefined || (!feedWindow && !unreadMark)) return;
    const box = listRef.current;
    const mark = box?.querySelector<HTMLElement>('.new-divider');
    if (!box || !mark) return;
    wantUnreadJump.current = false;
    /* G26 (Telegram ПК Н8): черта и прыжок к ней — только если первое непрочитанное выше последнего экрана. Иначе всё
       непрочитанное и так видно внизу: черты нет, лента внизу. */
    const fwNow = fwRef.current;
    const toEnd = box.scrollHeight - (box.scrollTop + mark.getBoundingClientRect().top - box.getBoundingClientRect().top);
    if (fwNow && !unreadDividerNeeded(toEnd, box.clientHeight, !fwNow.hasNewer)) {
      setDividerOffAt(scrollKey ?? '');
      stickDown();
      nearBottomRef.current = true;
      setNearBottom(true);
      setUnseenBelow(0);
      return;
    }
    /* Небольшой отступ сверху: черта должна быть видна целиком, а не прилипать к кромке.
       🔴 Считаем по прямоугольникам, а НЕ по `offsetTop` (20.09, поймано снимком экрана телефона).
       `offsetTop` отсчитывается от `offsetParent`, а им оказалась обёртка чата — вместе с шапкой
       канала. Из-за этой разницы (у телефона ровно 59 px, высота шапки) лента вставала так, что
       черта пряталась ПОД шапкой: замер давал «черта на y=85» при кромке ленты 96, то есть человек
       её не видел вовсе, хотя прыжок отработал. Разница кромок такой ошибки не знает. */
    const shift = mark.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop = Math.max(0, box.scrollTop + shift - 48);
    nearBottomRef.current = isNearBottom(box);
    setNearBottom(nearBottomRef.current);
    setFarFromEnd(isFarFromBottom(box));
    setUnseenBelow(0);
  }
  // Окно беседы: ключ прочитанного приходит отдельно от ленты (снят в начале визита) — ждём и его.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(tryUnreadJump, [unreadMark, messages.length]);

  // ─── «Прочитано» по видимому (G09) и «Вниз» к первому непрочитанному (G26) ─────────────────────────────────────────
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const scrollKeyRef = useRef(scrollKey);
  scrollKeyRef.current = scrollKey;
  /** Ключи сообщений ленты по id — строка в DOM знает только `data-mid`. */
  const keyById = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of messages) {
      const k = (m as { sortKey?: number }).sortKey;
      if (k !== undefined) map.set(m.id, k);
    }
    return map;
  }, [messages]);
  const keyByIdRef = useRef(keyById);
  keyByIdRef.current = keyById;
  /** Увиденное в этом визите (`at` — `scrollKey`): число на «Вниз» и первое непрочитанное. */
  const [seenKey, setSeenKey] = useState<{ at: string; key: number } | null>(null);
  const seenFrame = useRef<number | null>(null);
  const coverTimer = useRef<number | null>(null);
  /** Последнее сообщение, чей нижний край в окне ленты, — `onSeen`, если человек смотрит (`readByView.canMarkRead`). */
  function reportSeen(): void {
    seenFrame.current = null;
    const box = listRef.current;
    const report = onSeenRef.current;
    if (!box || !report) return;
    const covered = feedCovered();
    if (!canMarkRead({ focused: windowFocused(), covered, idleMs: idleMs(), mobile: isMobile() })) {
      // Слой закрывают не только кликом (Esc «Назад» Android, закрытие по таймеру или из кода) — проверяем, пока он есть.
      if (covered && coverTimer.current === null)
        coverTimer.current = window.setTimeout(() => {
          coverTimer.current = null;
          scheduleSeen();
        }, 700);
      return;
    }
    // Ждём прыжка к черте «Новые»: до него лента стоит внизу, и «увиденным» оказалось бы всё непрочитанное.
    if (wantUnreadJump.current && box.querySelector('.new-divider')) return;
    const view = box.getBoundingClientRect();
    // Окно ленты, обрезанное окном браузера: вылезшая за край часть ленты человеку не видна.
    const viewTop = Math.max(view.top, 0);
    const viewBottom = Math.min(view.bottom, window.innerHeight);
    if (viewBottom - viewTop <= 0) return;
    const rows = rowsOf(box);
    const i = lastSeenIndex(rows.length, (k) => rows[k].getBoundingClientRect().bottom, viewTop, viewBottom);
    if (i < 0) return;
    const key = keyByIdRef.current.get(rows[i].dataset.mid ?? '');
    if (key === undefined) return;
    const at = scrollKeyRef.current ?? '';
    setSeenKey((p) => (p && p.at === at && p.key >= key ? p : { at, key }));
    report(key);
  }
  /** Посмотреть, что видно, — кадром позже (прокрутка, новая лента, возврат в окно, закрытие слоя). */
  function scheduleSeen(): void {
    if (seenFrame.current !== null || !onSeenRef.current) return;
    seenFrame.current = requestAnimationFrame(reportSeen);
  }
  const reads = onSeen !== undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(scheduleSeen, [messages, scrollKey, reads]);
  useEffect(() => {
    if (!reads) return;
    const wake = () => scheduleSeen();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    const off = watchReadActivity(wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      off();
      if (seenFrame.current !== null) cancelAnimationFrame(seenFrame.current);
      seenFrame.current = null;
      if (coverTimer.current !== null) window.clearTimeout(coverTimer.current);
      coverTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads]);
  /** Докуда прочитано в этом визите: снимок при входе или увиденное, что дальше. */
  const visitSeen = seenKey && seenKey.at === (scrollKey ?? '') ? seenKey.key : null;
  const readTill =
    visitSeen === null ? (feedWindow?.readKey ?? null) : Math.max(visitSeen, feedWindow?.readKey ?? Number.NEGATIVE_INFINITY);
  /** Непрочитанное в ленте — число на «Вниз» (G26): видно и при входе, убывает по мере чтения. */
  const unreadInFeed = onSeen ? unreadCountAfter(messages, meId, readTill) : 0;
  function firstUnreadRow(): HTMLElement | null {
    const at = firstUnreadIndex(messages, meId, readTill);
    return at < 0 ? null : rowOf(messages[at].id);
  }
  // Повторный клик по уже открытой беседе в списке — как «Вниз» (G26, Telegram ПК 03·3.1.2; `store.feedDownAsk`).
  const goLatestRef = useRef(goLatest);
  goLatestRef.current = goLatest;
  const downAsk = useStore((s) => (feedId && s.feedDownAsk?.id === feedId ? s.feedDownAsk.n : 0));
  useEffect(() => {
    if (downAsk > 0) void goLatestRef.current();
  }, [downAsk]);

  // Догоняем «сейчас» только тому, кто и так в него смотрит; правило целиком — в stickToBottom.ts.
  useEffect(() => {
    /* Операция окна (подгрузка нового снизу) — это не «пришло новое»: ни прыжка вниз, ни счётчика, якорь держит место.
       Лента — ответ на переход (цитата, «Назад», место, «Вниз»): тоже не «новое» (🔴 02.10, телефон: последнее в окне
       перехода — моё, и правило «своё — вниз» уводило ленту в самый низ мимо цели). */
    if (heldAnchor.current || pendingScroll.current || navMessages.current === messages) {
      prevLastId.current = messages[messages.length - 1]?.id;
      return;
    }
    const added = addedBelow(
      messages.map((m) => m.id),
      prevLastId.current,
    );
    const last = messages[messages.length - 1];
    prevLastId.current = last?.id;
    // Своё — только ДОБАВЛЕННОЕ снизу. Последнее сообщение моё — ещё не повод: удалили строку выше, пока человек читает
    // историю, — и лента уезжала в самый низ (стенд 02.10: −14 → −914 px).
    const ownMessage = added > 0 && !!last && last.author.id === meId;
    // Моё пришло снизу (с другого устройства, отложенное, ответ сервера на отправку) — черте «Новые сообщения» конец.
    if (ownMessage) dropUnreadLine();
    // Чужое пришло, пока человек внизу (G26, Telegram ПК 03·3.2.2 б; tdesktop `history_widget.cpp: newItemAdded`:
    // `destroyUnreadBar` при `showNotification` у самого низа): оно сразу на глазах — черте конец; в канале так же.
    else if (added > 0 && nearBottomRef.current) setDividerOffAt(scrollKey ?? '');
    if (shouldAutoScroll({ wasNearBottom: nearBottomRef.current, ownMessage, switchedFeed: false })) {
      // Открыто меню у пузыря (раунд 12) — к низу, когда его закроют: иначе пузырь уехал бы из-под меню.
      if (holdFeedRef.current) stickAfterMenu.current = true;
      else stickDown();
      setUnseenBelow(0);
    } else if (added > 0) {
      setUnseenBelow((n) => n + added);
    }
  }, [messages.length]);

  // Открыли ДРУГУЮ ленту — показываем её снизу, как будто зашли впервые. Эффект стоит после
  // предыдущего намеренно: он перебивает его решение, принятое по старому положению прокрутки.
  useEffect(() => {
    // Беседа открыта на месте (шаг 2г) — ни низа, ни черты: место уже поставил эффект выше.
    if (restoringPlace.current) {
      const box = listRef.current;
      nearBottomRef.current = !!box && isNearBottom(box);
      setNearBottom(nearBottomRef.current);
      setFarFromEnd(!!box && isFarFromBottom(box));
      setUnseenBelow(0);
      prevLastId.current = messages[messages.length - 1]?.id;
      hasOlder.current = true;
      olderBusy.current = false;
      wantUnreadJump.current = false;
      return;
    }
    nearBottomRef.current = true;
    setNearBottom(true);
    setUnseenBelow(0);
    prevLastId.current = messages[messages.length - 1]?.id;
    // Новая лента — история у неё своя: прошлый «конец истории» к ней не относится.
    hasOlder.current = true;
    olderBusy.current = false;
    // Куда вставать, решим, когда появится черта: сейчас ни ленты, ни метки ещё нет.
    wantUnreadJump.current = true;
    /* ⚠️ Когда перестать ждать черту.
       Первая попытка ждала три секунды — и это оказалось мало: первый заход на сервер тянет
       список каналов, права и историю, и метка визита появляется позже срока. Правильный признак
       не время, а ЧЕЛОВЕК: пока он сам не тронул ленту, мы вправе поставить её к черте. Тронул —
       право потеряли, его место важнее. Таймер остаётся страховкой, но длинной. */
    const box = listRef.current;
    const drop = () => {
      wantUnreadJump.current = false;
    };
    box?.addEventListener('wheel', drop, { once: true, passive: true });
    box?.addEventListener('touchstart', drop, { once: true, passive: true });
    const giveUp = window.setTimeout(drop, 10000);
    stickDown();
    /* 🔴 Лента уже в памяти (беседа, шаг 2г): черта есть сразу, а эффект прыжка к ней отработал в этом же проходе РАНЬШЕ
       и был перебит прыжком вниз строкой выше — лента вставала под чертой. Пробуем ещё раз уже после. */
    tryUnreadJump();
    // messages здесь намеренно не в зависимостях: реагируем именно на смену ленты.
    return () => {
      window.clearTimeout(giveUp);
      box?.removeEventListener('wheel', drop);
      box?.removeEventListener('touchstart', drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  /*
   * Медиатека беседы за краем окна ленты (G11): порции истории, подтянутые просмотром (`loadMediaPage`). Живут, пока открыт
   * просмотр; `gen` — закрыли или открыли заново, пока шёл запрос, — его ответ уже не к этому просмотру.
   */
  const [mediaMore, setMediaMore] = useState<{ older: Message[]; newer: Message[] }>(NO_MEDIA_MORE);
  const mediaState = useRef({ gen: 0, busy: false, olderEnd: false, newerEnd: false });
  const mediaMoreRef = useRef(mediaMore);
  mediaMoreRef.current = mediaMore;
  const mediaCtx = useRef({ messages, loadMediaPage, hasOlder: feedWindow?.hasOlder, hasNewer: feedWindow?.hasNewer });
  mediaCtx.current = { messages, loadMediaPage, hasOlder: feedWindow?.hasOlder, hasNewer: feedWindow?.hasNewer };
  useEffect(() => {
    if (lightbox !== null) return;
    mediaState.current = { gen: mediaState.current.gen + 1, busy: false, olderEnd: false, newerEnd: false };
    setMediaMore(NO_MEDIA_MORE);
  }, [lightbox]);
  const onMediaEdge = useCallback(async (dir: -1 | 1) => {
    const { messages: feed, loadMediaPage: load, hasOlder, hasNewer } = mediaCtx.current;
    const st = mediaState.current;
    const extra = mediaMoreRef.current;
    if (!load || st.busy || (dir < 0 ? st.olderEnd : st.newerEnd)) return;
    // Окно ленты и так у края истории: старше (новее) нет — и подтягивать нечего.
    if (dir < 0 && extra.older.length === 0 && hasOlder === false) return;
    if (dir > 0 && extra.newer.length === 0 && !hasNewer) return;
    let edge = dir < 0 ? (extra.older[0] ?? feed[0]) : (extra.newer[extra.newer.length - 1] ?? feed[feed.length - 1]);
    if (!edge) return;
    const gen = st.gen;
    st.busy = true;
    let got: Message[] = [];
    let more = true;
    try {
      // Несколько порций подряд, пока не встретится фото или видео: переписка бывает длинной без вложений.
      for (let i = 0; i < MEDIA_PAGES_PER_STEP && more; i++) {
        const page = await load(dir, edge);
        more = page.more && page.messages.length > 0;
        if (page.messages.length === 0) break;
        got = dir < 0 ? [...page.messages, ...got] : [...got, ...page.messages];
        edge = dir < 0 ? page.messages[0] : page.messages[page.messages.length - 1];
        if (page.messages.some(hasMedia)) break;
      }
    } catch {
      more = false;
    } finally {
      if (mediaState.current.gen === gen) st.busy = false;
    }
    if (mediaState.current.gen !== gen) return;
    if (!more) {
      if (dir < 0) st.olderEnd = true;
      else st.newerEnd = true;
    }
    if (got.length === 0) return;
    const have = new Set([...mediaCtx.current.messages, ...mediaMoreRef.current.older, ...mediaMoreRef.current.newer].map((m) => m.id));
    const fresh = got.filter((m) => !have.has(m.id));
    if (fresh.length === 0) return;
    const added = fresh.reduce((n, m) => n + mediaCount(m), 0);
    setMediaMore((m) => (dir < 0 ? { ...m, older: [...fresh, ...m.older] } : { ...m, newer: [...m.newer, ...fresh] }));
    // Подтянули старше — текущий файл сдвинулся в наборе на столько, сколько медиа пришло перед ним.
    if (dir < 0 && added > 0) setLightbox((i) => (i === null ? i : i + added));
  }, []);

  // Flat list of every image in the view, for the lightbox (prev/next across all of them).
  // С 06.10 и видео: просмотр играет его на весь экран (как у Telegram — фото и видео одним рядом).
  // С 07.10 (G11) — и подтянутые просмотром порции за краем окна (`mediaMore`); те, что лента уже показала, не дублируются.
  const allImages = useMemo(() => {
    const list: (LightboxImage & { size: number; downloadUrl: string; att: Attachment; msg: Message })[] = [];
    const inFeed = new Set(messages.map((m) => m.id));
    const extraOlder = mediaMore.older.filter((m) => !inFeed.has(m.id));
    const extraNewer = mediaMore.newer.filter((m) => !inFeed.has(m.id));
    for (const m of [...extraOlder, ...messages, ...extraNewer])
      for (const a of m.attachments ?? []) {
        const video = isVideo(a.contentType);
        // Э3 (#141): вложение, чья копия с инстанса автора ещё едет, просмотру не показывается — файла у нас пока нет.
        // Одноразовое фото/видео (#226) в общий просмотр не попадает — у него свой просмотр с отсчётом (`openOnce`).
        if (isOnceMedia(a)) continue;
        if (!a.asFile && a.fedState !== 'copying' && (isImage(a.contentType) || video))
          list.push({
            url: a.url,
            name: a.name,
            size: a.size,
            downloadUrl: api.attachmentDownloadUrl(a),
            type: a.contentType,
            video,
            att: a,
            // Ход «Скачать» на ПК — общий с карточкой и «⬇» в ленте (G31).
            jobKey: attachmentKey(a),
            // G10 (волна 6): строка «отправитель · дата» и подпись к фото в просмотрщике, как у Telegram.
            from: nameOf(m.author.id, m.author.displayName),
            at: m.createdAt,
            caption: m.content.trim() || undefined,
            msg: m,
          });
      }
    return list;
  }, [messages, mediaMore, nameOf]);
  function openImage(a: Attachment) {
    if (isOnceMedia(a)) return void openOnce(a);
    const i = allImages.findIndex((x) => x.att === a);
    if (i >= 0) setLightbox(i);
  }
  /**
   * Одноразовое фото/видео (19.10, #226): сервер ставит отметку открытия (`once-open`; от неё таймер) — только потом просмотр;
   * закрыли или вышел таймер — `once-spent`, сообщение сгорает у обоих (событие `conv.change`). Уже сгорело (410) — молча.
   */
  async function openOnce(a: Attachment) {
    const m = messages.find((x) => x.attachments?.includes(a));
    if (!m || onceView) return;
    try {
      const r = await api.convOnceOpen(m.channelId, m.id);
      // Срок — от МОМЕНТА ПОЛУЧЕНИЯ ответа по своим часам: серверные `openedAt`/`serverNow` дают только уже прошедшее (повторное
      // открытие), с `Date.now()` устройства их не сравниваем — часы ПК бывают на секунды в стороне.
      const receivedAt = Date.now();
      setOnceView({ att: a, msg: m, deadline: onceDeadlineLocal(a, Date.parse(r.openedAt), Date.parse(r.serverNow ?? ''), receivedAt) });
    } catch (e) {
      if ((e as { status?: number }).status !== 410) toastError(e);
    }
  }
  function closeOnce() {
    const v = onceView;
    setOnceView(null);
    if (v) void api.convOnceSpent(v.msg.channelId, v.msg.id).catch(() => {});
  }
  // Удалили показанное (меню просмотрщика) — просмотр остаётся на соседнем файле, пусто — закрывается.
  useEffect(() => {
    setLightbox((i) => (i === null ? i : allImages.length === 0 ? null : Math.min(i, allImages.length - 1)));
  }, [allImages.length]);
  /**
   * Меню «⋯» / ПКМ просмотрщика (G10, волна 6; tdesktop `media_view_overlay_widget.cpp`): «Перейти к сообщению»,
   * «Копировать» (фото — тем же путём, что пункт меню фото), «Переслать» (там, где оно есть в меню сообщения), «Удалить»
   * (своё / по праву — `canDelete`, то же окно подтверждения). К сообщению и «Переслать» закрывают просмотр.
   */
  function lightboxActions(_img: LightboxImage, i: number): LightboxAction[] {
    const x = allImages[i];
    if (!x) return [];
    const m = x.msg;
    const list: LightboxAction[] = [
      {
        id: 'goto',
        icon: 'eye',
        label: 'Перейти к сообщению',
        run: () => {
          setLightbox(null);
          void jumpToMessage(m.id);
        },
      },
    ];
    if (!x.video && canCopyImage()) list.push({ id: 'copy', icon: 'copy', label: 'Копировать', run: () => copyPhoto(x.att) });
    /* G56: элемент альбома — «Переслать» и «Удалить» берут ЕГО одного (Telegram: в просмотрщике действия текущего элемента
       группы — Android `PhotoViewer`, tdesktop `OverlayWidget`). */
    if (batchOn?.forwardItem && batchOn.deleteItem && isAlbumItem(m.attachments, x.att)) {
      const att = x.att;
      list.push({
        id: 'forward',
        icon: 'forward',
        label: 'Переслать',
        run: () => {
          setLightbox(null);
          openForwardItem(m, att);
        },
      });
      if (canDelete(m)) list.push({ id: 'delete', icon: 'trash', label: 'Удалить', danger: true, run: () => void delItem(m, att) });
      return list;
    }
    if (batchOn)
      list.push({
        id: 'forward',
        icon: 'forward',
        label: 'Переслать',
        run: () => {
          setLightbox(null);
          openForward([m.id]);
        },
      });
    if (canDelete(m)) list.push({ id: 'delete', icon: 'trash', label: 'Удалить', danger: true, run: () => void del(m) });
    return list;
  }
  /** Имя отправителя в просмотрщике — карточка профиля у курсора, просмотр закрывается (как у Telegram). */
  function lightboxAuthor(i: number, e: React.MouseEvent) {
    const x = allImages[i];
    if (!x) return;
    setLightbox(null);
    openUserMenu(e, { userId: x.msg.author.id, name: x.from ?? x.msg.author.displayName, avatarUrl: x.msg.author.avatarUrl }, 'profile');
  }

  // Autocomplete suggestions for the active @/# token (users + roles, or channels).
  const acItems = useMemo<AcItem[]>(() => {
    if (!ac) return [];
    const q = ac.query.toLowerCase();
    // Команды бота (#230): по началу имени, все (у бота их до 100 — список прокручивается), как tdesktop `field_autocomplete.cpp`.
    if (ac.trigger === '/' && channelCmds) {
      return filterChannelCommands(channelCmds, ac.query).map((c) => ({
        kind: 'command' as const,
        id: `${c.bot.id}:${c.command}`,
        insert: channelCommandInsert(c, channelCmds),
        label: `/${c.command}`,
        hint: c.description,
        bot: c.bot,
      }));
    }
    if (ac.trigger === '/') {
      return filterBotCommands(botCommands ?? [], ac.query).map((c) => ({
        kind: 'command' as const,
        id: c.command,
        insert: `/${c.command}`,
        label: `/${c.command}`,
        hint: c.description,
      }));
    }
    // Emoji works everywhere, including DMs — it needs no server-provided candidates, unlike @ and #.
    if (ac.trigger === ':') {
      // «Слово целиком» (G53): только точные совпадения, подпись — первый код эмодзи.
      return (ac.exact ? exactEmojiEntries(q) : searchEmoji(q)).map((e) => ({
        kind: 'emoji' as const,
        id: e.emoji,
        insert: e.emoji,
        label: `:${ac.exact ? e.codes[0] : primaryCode(e, q)}:`,
        emoji: e.emoji,
      }));
    }
    if (ac.trigger === '#' && hashtagsOn) {
      return matchHashtags(loadRecentHashtags(meId), ac.query).map((t) => ({ kind: 'hashtag' as const, id: t, insert: `#${t}`, label: `#${t}` }));
    }
    if (!autocomplete) return [];
    if (ac.trigger === '@') {
      const users: AcItem[] = autocomplete.users
        .filter((u) => u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q))
        .slice(0, 6)
        .map((u) => ({
          kind: 'user',
          id: u.id,
          insert: `@${u.username}`,
          label: u.displayName,
          handle: `@${u.username}`,
          avatarUrl: u.avatarUrl,
          online: u.online,
        }));
      const roles: AcItem[] = autocomplete.roles
        .filter((r) => r.name.toLowerCase().includes(q))
        .slice(0, 4)
        .map((r) => ({ kind: 'role', id: r.id, insert: `@${r.name}`, label: `@${r.name}` }));
      /**
       * `@everyone` и `@here` (#76, мегаприёмка 23.09): правило упоминаний их знало давно (звук и значок у
       * всех), но набрать их можно было только вслепую. Что каждое делает — подписью: `@everyone` будит
       * ещё и пушем всех, кто видит канал, `@here` — только тех, кто сейчас в приложении (`push.ts`).
       */
      const broadcast: AcItem[] = (autocomplete.noBroadcast ? [] : BROADCAST_MENTIONS).filter((n) => n.startsWith(q)).map((n) => ({
        kind: 'broadcast',
        id: n,
        insert: `@${n}`,
        label: `@${n}`,
        hint: n === 'everyone' ? 'всем в канале' : 'кто сейчас в сети',
      }));
      return [...users, ...broadcast, ...roles].slice(0, 8);
    }
    return autocomplete.channels
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((c) => ({ kind: 'channel', id: c.id, insert: `#${c.name}`, label: c.name }));
  }, [ac, autocomplete, hashtagsOn, botCommands, channelCmds]);

  // Recompute the active trigger token from the input value + caret position.
  function refreshAc(value: string, caret: number | null) {
    if (acExactTimer.current) window.clearTimeout(acExactTimer.current);
    acExactTimer.current = 0;
    // «Подсказывать эмодзи» выключено (G53) — ни `:слова`, ни слова целиком; `@` и `#` — как были.
    // Беседа с ботом (#230): «/» первым символом поля — его команды; старый список тихо перезапрашивается (кэш 60 с).
    const cmd = botPeer && feedId && botCommands?.length ? commandTokenAt(value, caret) : null;
    // Канал с ботами (#231): то же, `/cmd@ник` — тоже команда.
    const chCmd = !cmd && botChannelId && channelCmds?.length ? commandTokenAt(value, caret, true) : null;
    if (chCmd) {
      refreshChannelBots(botChannelId!);
      setAc(chCmd);
      setAcIndex(0);
      return;
    }
    if (cmd) {
      refreshBotCommands(feedId!);
      setAc(cmd);
      setAcIndex(0);
      return;
    }
    const suggest = emojiSuggestEnabled();
    const found = acTokenAt(value, caret, !!autocomplete, hashtagsOn);
    const token = found && found.trigger === ':' && !suggest ? null : found;
    if (token) {
      setAc(token);
      setAcIndex(0);
      return;
    }
    // Слово целиком (tdesktop `kShowExactDelay`): через 300 мс после последней буквы, а если полоса уже стоит — сразу; ни одна
    // подсказка не выбрана (`acIndex` −1): Enter отправляет, Tab и стрелки выбирают.
    const exact = suggest ? acExactAt(value, caret) : null;
    if (!exact) return setAc(null);
    const show = () => {
      setAc(exact);
      setAcIndex(-1);
    };
    if (ac?.exact) return show();
    setAc(null);
    acExactTimer.current = window.setTimeout(show, EXACT_SUGGEST_DELAY_MS);
  }

  /**
   * Выбор подсказки. Команда бота (#230) из списка — щелчок или Enter — уходит СРАЗУ, если в поле только она (как Telegram:
   * tdesktop шлёт команду по выбору); `insert` (Tab, →) — только подставить в поле, дописать аргументы.
   */
  function acceptAc(item: AcItem, insert = false) {
    if (!ac) return;
    if (
      (item.kind === 'command' && !insert && onlyCommandInField(text)) ||
      // Канал (#231): `/cmd@ник` тоже «одна команда в поле».
      (item.kind === 'command' && !insert && !!channelCmds && onlyCommandInField(text, true))
    ) {
      if (inputRef.current) inputRef.current.value = '';
      setText('');
      setAc(null);
      sendBotCommand(item.insert);
      return;
    }
    const { text: next, caret: pos } = applyAc(text, ac, item.insert);
    setText(next);
    setAc(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }

  /** Последняя автозамена (`--` → «—», G51): Backspace сразу после неё возвращает набранное (`fieldFormat.revertReplacement`). */
  const replUndo = useRef<Replacement['undo'] | null>(null);

  /** Правило замены `:code:` → эмодзи — в `messagePaneRules.ts`; здесь только состояние и каретка. */
  function substituteEmoji(value: string, caret: number | null): boolean {
    const sub = emojiSubstitution(value, caret);
    if (!sub) return false;
    setText(sub.text);
    setAc(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(sub.caret, sub.caret);
      }
    });
    return true;
  }

  // "Упомянуть" from a user context menu bumps mentionRequest; insert `@name ` into this
  // (the active) composer once per new value. Ignore any request that predates mount.
  const mentionRequest = useStore((s) => s.mentionRequest);
  const lastMentionN = useRef(useStore.getState().mentionRequest?.n ?? 0);
  useEffect(() => {
    if (!mentionRequest || mentionRequest.n === lastMentionN.current) return;
    lastMentionN.current = mentionRequest.n;
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${mentionRequest.name} `);
    inputRef.current?.focus();
  }, [mentionRequest]);

  /**
   * Сообщение берёт не больше `ATTACH_MAX` файлов (лишние отсекает `slice` в `addFiles`). Раньше они пропадали МОЛЧА: человек
   * выбирал 12, видел 10 и не знал почему (06.10, сверка с Telegram) — теперь тост. Считаем по `pendingNow` и по КОПИИ списка, а
   * не в обновителе `setPending`: из обновителя тост не показать (его могут вызвать дважды), а живой `FileList` к его вызову
   * уже пуст. `pendingNow` двигаем сразу: два выбора в одном такте React (вставка и перетаскивание) видят друг друга.
   */
  function noteOverflow(incoming: File[]) {
    const { taken, dropped } = fitAttachments(pendingNow.current.length, incoming);
    if (dropped > 0) toast('warn', droppedAttachText());
    pendingNow.current = [...pendingNow.current, ...taken];
  }

  /**
   * 🔴 Файлы копируем СРАЗУ, а не в функции-обновителе (05.10, APK на S25: «выбрал файлы — ничего не добавилось»).
   * `input.files` — живой список: `value = ''` в обработчике выбора очищает тот же объект, а обновитель React зовёт позже,
   * при отрисовке, — и видел пустой список. Сразу его зовёт только при пустой очереди обновлений ленты (так бывало на ПК),
   * поэтому ломалось не всегда.
   */
  function addFiles(list: FileList | File[] | null, opts?: { box?: boolean; way?: Partial<SendWay>; caption?: string }) {
    if (!list || list.length === 0) return;
    if (filesBlocked) return void toast('info', filesBlocked);
    // Правка меняет только текст (#212): новое вложение к ней не прицепить (Telegram Desktop `lng_edit_caption_attach`).
    if (composerEdit) return void toast('info', 'Во время правки сообщения вложения не добавить');
    // ЛС на ПК: файлы идут в окно отправки (G48), а не на полосу у поля — как у Telegram Desktop.
    if (outbox && !phoneLayout && !composerEdit && opts?.box !== false) return openBox(Array.from(list), opts);
    noteOverflow(Array.from(list));
    const files = Array.from(list);
    setPending((p) => [...p, ...files].slice(0, 10));
    /* Курсор — в поле, как у Telegram (подпись к вложению): после окна выбора фокус оставался на «скрепке», и Enter вместо
       отправки открывал выбор файла заново (замечание владельца 05.10). На телефоне клавиатуру не поднимаем. */
    refocusComposer();
  }

  /**
   * Текст из поля уходит файлом `message.txt` (G22, Telegram Desktop `history_widget.cpp: sendTextAsFile`): кнопка у поля при
   * тексте длиннее предела и вставка, после которой в поле ≥ 8 пределов. Поле очищается, файл встаёт в очередь вложений (как
   * после «Прикрепить»); убрал файл крестиком — текст возвращается в поле, как у Desktop при «Отмена» (`setCancelledCallback`).
   * Файл не влез в десять вложений — тост, текст остаётся в поле.
   */
  const textFileBackup = useRef<{ file: File; text: string } | null>(null);
  function sendTextAsFile(full: string): boolean {
    if (!full.trim()) return false;
    const file = new File([full], TEXT_FILE_NAME, { type: TEXT_FILE_MIME });
    if (fitAttachments(pendingNow.current.length, [file]).dropped > 0) {
      toast('warn', droppedAttachText());
      return false;
    }
    textFileBackup.current = { file, text: full };
    if (inputRef.current) inputRef.current.value = '';
    setText('');
    addFiles([file], { box: false });
    return true;
  }

  /**
   * Paste an image straight into the chat (Ctrl+V after a screenshot) — it used to do nothing at all:
   * the clipboard carried a file, the composer only looked at text, so the picture silently vanished.
   *
   * Clipboard images arrive as a nameless (or uniformly "image.png") blob, so they'd pile up in the
   * downloads folder as image.png, image (1).png… — name them by the moment they were pasted instead.
   */
  function onPasteFiles(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault(); // otherwise the browser also pastes the file NAME as text
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    // Картинка вместе с текстом (G37, Telegram Desktop `history_widget.cpp`): текст из буфера становится подписью окна отправки
    // (и возвращается в поле при «Отмене»). Имя файла в тексте (копия из проводника) подписью не бывает.
    const pastedText = e.clipboardData?.getData('text/plain') ?? '';
    const caption = files.some((f) => f.name && pastedText.trim() === f.name) ? '' : pastedText;
    addFiles(
      files.map((f, i) => {
        if (f.name && f.name !== 'image.png') return f;
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const n = files.length > 1 ? `-${i + 1}` : '';
        return new File([f], `screenshot-${stamp}${n}.${ext}`, { type: f.type });
      }),
      { caption },
    );
  }

  /**
   * Окно отправки файлов (G48): первый выбор открывает его, следующие (бросок, вставка, «Добавить») дописывают файлы в него.
   * Подпись — текст поля (и вставленный вместе с картинкой, `captionAfterPaste`); выбор способа — запомненный, а бросок в
   * зону и «Фото или видео» / «Файл» его задают (`opts.way`). Лишние сверх `ATTACH_MAX` отсекаются с тостом. Файлы, что уже
   * лежали на полосе, переезжают в окно.
   */
  function openBox(incoming: File[], opts?: { way?: Partial<SendWay>; caption?: string }) {
    const cur = boxNow.current;
    const have = cur ? cur.files : pendingNow.current;
    const { taken, dropped } = fitAttachments(have.length, incoming);
    if (dropped > 0) toast('warn', droppedAttachText());
    if (taken.length === 0) return;
    let next: NonNullable<typeof box>;
    if (cur) {
      next = { ...cur, files: [...cur.files, ...taken], way: { ...cur.way, ...opts?.way } };
    } else {
      const saved = parseWay(localStorage.getItem(SEND_WAY_KEY));
      next = {
        files: [...pendingNow.current, ...taken],
        way: { ...saved, ...opts?.way },
        caption: captionAfterPaste(text, opts?.caption ?? ''),
        saved,
      };
      pendingNow.current = [];
      setPending([]);
    }
    boxNow.current = next;
    setBox(next);
  }

  function patchBox(fn: (b: NonNullable<typeof box>) => NonNullable<typeof box>) {
    const cur = boxNow.current;
    if (!cur) return;
    const next = fn(cur);
    boxNow.current = next;
    setBox(next);
  }

  /** «Отмена» и Esc: файлы уходят, подпись (с вставленным текстом) возвращается в поле. */
  function closeBox(caption: string) {
    boxNow.current = null;
    setBox(null);
    setText(caption);
    refocusComposer();
  }

  /**
   * «Отправить» в окне (G48; Telegram Desktop `PrepareFilesBundle`): сжатие фото (если не «как файлы»), разбивка по сообщениям
   * (`planSend`), подпись и ответ — у первого, «без звука» — как у меню кнопки «Отправить», «без превью» — по крестику полосы
   * над полем. «Позже» кладёт файлы на полосу и открывает выбор времени: отложенное — одно сообщение, способ не применяется.
   */
  async function sendFromBox(r: SendFilesResult) {
    if (!outbox) return;
    const content = r.caption.trim();
    const textPlan = sendTextPlan(content, true);
    if (textPlan.kind === 'too-long') return void toast('error', tooLongText(textPlan.over, textPlan.caption));
    if (r.remember) localStorage.setItem(SEND_WAY_KEY, JSON.stringify(r.way));
    boxNow.current = null;
    setBox(null);
    const files = r.way.asFile ? r.files : await compressPhotos(r.files, photoSideFor(r.way, !!mediaFlags));
    if (r.how === 'later') {
      setPending(files);
      pendingNow.current = files;
      setText(content);
      laterFlags.current = {
        files,
        spoiled: new Set(mediaFlags ? spoilerIndexes(r.files, r.spoilers, r.way).map((i) => files[i]!) : []),
        captionAbove: !!mediaFlags && r.captionAbove && captionMoveVisible(r.files, r.way),
        asFile: !!sendFlags && r.way.asFile && files.some((f) => sendKind(f) !== 'file'),
      };
      openLater({ content, replyTo: replyingTo, files: sendOn?.media ? files : [] });
      return;
    }
    dropUnreadLine();
    const replyTo = replyingTo;
    if (inputRef.current) inputRef.current.value = '';
    setText('');
    setReplyingTo(null);
    requestAnimationFrame(() => stickDown());
    if (fwRef.current?.hasNewer) void goLatest();
    const noPreview = sendNoPreview(previewOff, previewLink, !!sendFlags && linkPreviewsEnabled());
    // Спойлер (G48, `media2`): индексы в списке окна → файлы после сжатия (порядок и число те же) → индексы в сообщении плана.
    const spoilered = new Set(mediaFlags ? spoilerIndexes(r.files, r.spoilers, r.way).map((i) => files[i]!) : []);
    // Одноразовые фото/видео (#226): индексы окна → файлы после сжатия; каждое уходит своим сообщением (`splitOncePlan`).
    const onceFiles = new Map<File, number>();
    if (mediaOnce && !r.way.asFile) r.once.forEach((ttl, i) => files[i] && onceFiles.set(files[i]!, ttl));
    splitOncePlan(planSend(files, content, r.way), onceFiles).forEach((p, i) =>
      outbox.enqueue({
        ...(p.onceTtl !== undefined ? { onceTtl: p.onceTtl } : {}),
        ...(spoilered.size && p.files.some((f) => spoilered.has(f))
          ? { spoilers: p.files.flatMap((f, k) => (spoilered.has(f) ? [k] : [])) }
          : {}),
        ...(mediaFlags && r.captionAbove && p.content && captionMoveVisible(r.files, r.way) ? { captionAbove: true } : {}),
        key: newClientId(),
        content: p.content,
        files: p.files,
        replyToId: i === 0 ? (replyTo?.id ?? null) : null,
        ...(r.how === 'silent' ? { silent: true } : {}),
        ...(sendFlags && r.way.asFile && p.files.some((f) => sendKind(f) !== 'file') ? { asFile: true } : {}),
        ...(noPreview && p.content ? { noPreview: true } : {}),
      }),
    );
  }

  /**
   * «Фото или видео» (05.10, «как в Telegram»): своя галерея в приложении Android, лист с камерой в браузере телефона,
   * системный выбор с `accept` фото и видео на ПК (`attachRules.attachMode`). Зовётся в нажатии — окну выбора нужен живой жест.
   */
  function mediaMode() {
    return attachMode({
      nativeGallery: nativeMediaAvailable(),
      coarse: window.matchMedia('(pointer: coarse)').matches,
      camera: cameraSupported(),
      desktopShell: isDesktop(),
    });
  }

  function openMediaPicker() {
    setAttachAnchor(null);
    setPlusAnchor(null);
    if (mediaMode() !== 'input') {
      setMediaOpen(true);
      return;
    }
    mediaCompress.current = true;
    mediaRef.current?.click();
  }

  /** Предел одного файла этой ленты, байт (`bigfile1`): беседы ЛС — по серверу, каналы — 25 МБ. */
  const fileMaxBytes = bigFiles ? dmAttachMaxBytes() : ATTACH_MAX_BYTES;

  /** «Файл»: в приложении Android — системное приложение «Файлы» (натив), иначе — выбор любого файла. */
  function openFilePicker() {
    setAttachAnchor(null);
    setPlusAnchor(null);
    if (!nativeMediaAvailable()) {
      fileRef.current?.click();
      return;
    }
    void pickDocumentsNative({ limit: Math.max(1, attachRoom(pending.length)), maxBytes: fileMaxBytes })
      .then((res) => {
        const note = skippedText(res.skipped, fileMaxBytes);
        if (note) toast('warn', note);
        if (res.files.length) addFiles(res.files);
      })
      .catch(() => toast('error', 'Не удалось открыть «Файлы»'));
  }

  /** Системный выбор из листа вложений (браузер; запасной путь без доступа к галерее). */
  function onSystemPick(kind: SystemPickKind) {
    setMediaOpen(false);
    if (kind === 'files') {
      fileRef.current?.click();
      return;
    }
    mediaCompress.current = kind === 'photos';
    mediaRef.current?.click();
  }

  /**
   * Лист вложений отправляет сразу сообщением — тем же путём, что обычная отправка с вложениями: подпись становится текстом
   * поля, файлы ложатся в `pending`, отправку делает эффект ниже, когда они уже в состоянии. «Отправить позже» и «Когда
   * будет в сети» (06.10, сервер с `conv10` — `sendOn.media`) — отложенным с этими файлами (и теми, что уже лежали в поле, —
   * как и у «Отправить»), подпись — его текст (`scheduleDraft`). Без признака пункты в листе серые и сюда не приходят.
   */
  function onMediaSend(files: File[], caption: string, how: MediaSendHow) {
    // Одноразовое фото/видео (#226, меню удержания «Отправить» галереи): одно сообщение с одним файлом, мимо поля ввода.
    if (typeof how === 'object' && 'once' in how) {
      if (!outbox || files.length !== 1) return;
      dropUnreadLine();
      outbox.enqueue({ key: newClientId(), content: caption.trim(), files, replyToId: replyingTo?.id ?? null, onceTtl: how.once });
      setReplyingTo(null);
      requestAnimationFrame(() => stickDown());
      return;
    }
    if (how !== 'now' && how !== 'silent') {
      if (!sendOn?.media) {
        toast('warn', 'Отложенные с вложениями этот сервер не принимает');
        return;
      }
      scheduleDraft(caption.trim(), replyingTo, how === 'online' ? null : how.at, [...pending, ...files].slice(0, ATTACH_MAX));
      return;
    }
    setText(caption);
    sendAfterAdd.current = how;
    addFiles(files);
  }

  useEffect(() => {
    const how = sendAfterAdd.current;
    if (!how || pending.length === 0) return;
    sendAfterAdd.current = null;
    if (how === 'silent' && sendOn?.silent) sendSilent();
    else inputRef.current?.form?.requestSubmit();
    // Срабатывает на появление файлов в поле; остальное читается на момент отправки.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  /**
   * Очередь отправки: сообщения уходят по одному, но НАБИРАТЬ их можно не дожидаясь ответа.
   *
   * 🔴 **Повод (19.09, поймано живой проверкой).** Условие `if (… || sending) return` отбивало
   * второй Enter, пока летел первый запрос: человек печатал три сообщения подряд, уходило одно, а
   * остальные оставались в поле и слипались в кашу («граница 2граница 3заливаю ленту 1»). На
   * медленной сети это происходило буквально всегда.
   *
   * ⚠️ Почему очередь, а не просто параллельные запросы: порядок сообщений в переписке — не
   * мелочь, а смысл. Цепочка промисов гарантирует, что второе уйдёт после первого.
   */
  const sendQueue = useRef<Promise<void>>(Promise.resolve());

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (composerEdit) return void saveComposerEdit();
    const content = text.trim();
    if (!content && pending.length === 0) {
      // Пустое поле и полоса «Пересылка» (08.10) — Enter отправляет одну пересылку, как у Telegram.
      const fwd = takeFwdDraft();
      if (fwd) {
        dropUnreadLine();
        requestAnimationFrame(() => stickDown());
        void sendFwdDraft(fwd, [], false);
      }
      return;
    }
    /* Длинный текст (07.10, Telegram 10.3): без вложений — режется на несколько сообщений по абзацам и предложениям; с
       вложениями (подпись не режется) и длиннее 8 пределов — отказ словами Telegram, поле не трогаем. */
    const plan = sendTextPlan(content, pending.length > 0);
    if (plan.kind === 'too-long') {
      toast('error', tooLongText(plan.over, plan.caption));
      return;
    }
    const parts = plan.kind === 'split' ? plan.parts : [plan.text];
    // Черновик пересылки уходит СЛЕДОМ за текстом (Telegram `ApiWrap::finishForwarding` после `sendMessage`).
    const fwd = takeFwdDraft();
    if (hashtagsOn) rememberSentHashtags(content, meId);
    dropUnreadLine();
    /* ⚠️ Кнопка «отправить» больше НЕ выключается на время запроса (23.09, #194). Enter в поле — это
       неявная отправка формы, а она не срабатывает, пока кнопка выключена: следующее сообщение не
       уходило, пока летело предыдущее, — вопреки очереди ниже. Что сообщение в пути, теперь видно по
       строке «отправляется…» в ленте, а счётчик «в полёте» не нужен вовсе. Поймано проверкой на проде:
       в первой версии #194 счётчик считался дважды и застревал ненулевым — кнопка навсегда «…». */
    // 🔴 Поле пустеет СРАЗУ, не дожидаясь сервера. Отклик на собственное нажатие — единственное,
    // что человек имеет право получить мгновенно; раньше текст висел в поле всё время запроса
    // (а с вложениями это ещё и их загрузка), и отправка ощущалась залипшей на плохой сети.
    const files = pending;
    const replyTo = replyingTo;
    /* ⚠️ Поле чистим И напрямую в DOM: `setText` применится только к следующей отрисовке, а человек
       (или автотест) успевает начать печатать раньше — тогда новый текст допишется к старому, и два
       сообщения уедут одним слипшимся. Поймано живой проверкой: «очередь 2очередь 3». */
    if (inputRef.current) inputRef.current.value = '';
    setText('');
    // Полоса подсказок (эмодзи по слову, @, #) уходит вместе с текстом — иначе на телефоне висела над пустым полем (приёмка 25.10).
    setAc(null);
    // Caps Lock экранной клавиатуры сбрасывается после отправки, как в Telegram (`keyboardReset.ts`).
    resetKeyboardShift(inputRef.current);
    setPending([]);
    setReplyingTo(null);
    /* 🔴 Сообщение встаёт в ленту СРАЗУ бледной строкой «отправляется» (#194) и сменяется настоящим по
       ответу сервера. Отказ не прячем и не возвращаем молча в поле (раньше текст возвращался, только
       если поле было пустым, иначе уезжал в тост) — строка остаётся «не отправлено» с «Повторить» /
       «Удалить». Своё действие — лента едет вниз всегда, как и при ответе сервера. */
    // Куски длинного текста — по порядку отдельными строками очереди; ответ — у первого (как у Telegram), файлов нет.
    const at = Date.now();
    const noPreview = sendNoPreview(previewOff, previewLink, !!outbox && !!sendFlags && linkPreviewsEnabled());
    const items = parts.map((part, i) => ({
      key: newClientId(),
      content: part,
      files: i === 0 ? files : [],
      replyToId: i === 0 ? (replyTo?.id ?? null) : null,
      status: 'sending' as const,
      error: null,
      feedId,
      // Последнее сообщение ленты в момент отправки — по нему узнаём, что настоящее уже пришло (ниже).
      afterId: messages[messages.length - 1]?.id,
      /* Момент отправки — время в пузыре и группировка с соседями (`outSentAt`), как у очереди бесед. Один раз, а не
         «сейчас» на каждой отрисовке: иначе первая строка «в пути» перерисовывала бы ленту на каждую букву (`memo`). */
      createdAt: at,
    }));
    requestAnimationFrame(() => stickDown());
    // Окно беседы не у хвоста — своё сообщение встанет внизу беседы, туда и уходим (как Telegram).
    if (fwRef.current?.hasNewer) void goLatest();
    for (const item of items) {
      if (outbox) {
        outbox.enqueue({
          key: item.key,
          content: item.content,
          files: item.files,
          replyToId: item.replyToId,
          ...(noPreview ? { noPreview: true } : {}),
        });
        continue;
      }
      setOutgoing((o) => addOutgoing(o, item));
      enqueueSend(item);
    }
    if (fwd) void sendFwdDraft(fwd, items.map((x) => x.key), false);
  }

  /**
   * Отправить команду боту одним сообщением (#230): выбор из списка «/», кнопка-команда в тексте бота. Поле, ответ и вложения не
   * трогает (кроме случая выбора из списка — там поле чистит `acceptAc`); строка «в пути» — как у обычной отправки.
   */
  function sendBotCommand(cmd: string) {
    const content = cmd.trim();
    if (!content || !(botPeer || botChannelId)) return;
    dropUnreadLine();
    requestAnimationFrame(() => stickDown());
    if (fwRef.current?.hasNewer) void goLatest();
    const key = newClientId();
    if (outbox) {
      outbox.enqueue({ key, content, files: [], replyToId: null });
      return;
    }
    const item = {
      key,
      content,
      files: [] as File[],
      replyToId: null,
      status: 'sending' as const,
      error: null,
      feedId,
      afterId: messages[messages.length - 1]?.id,
      createdAt: Date.now(),
    };
    setOutgoing((o) => addOutgoing(o, item));
    enqueueSend(item);
  }

  /** Кнопка «Меню» у поля в беседе с ботом (#230, tdesktop `_botCommandStart` — кладёт «/» в поле): «/» и список его команд. */
  function openBotMenu() {
    // Повторное нажатие — закрыть список (набранное остаётся).
    if (ac?.trigger === '/') return setAc(null);
    const el = inputRef.current;
    if (el) el.value = '/';
    setText('/');
    setAc({ trigger: '/', query: '', start: 0 });
    setAcIndex(0);
    if (botChannelId && channelCmds) refreshChannelBots(botChannelId);
    else if (feedId) refreshBotCommands(feedId);
    requestAnimationFrame(() => {
      const f = inputRef.current;
      if (f) {
        f.focus();
        f.setSelectionRange(1, 1);
      }
    });
  }

  /** Снять черновик пересылки этой беседы и вернуть его (отправка); нет черновика или пачки — `null`. */
  function takeFwdDraft(): FwdDraft | null {
    if (!fwdDraft || !batchOn || !feedId) return null;
    useStore.getState().setFwdDraft(feedId, null);
    return fwdDraft;
  }

  /**
   * Отправить черновик пересылки в эту беседу (08.10, решение владельца п.9): сперва дождаться строк очереди с текстом,
   * ушедших этим же нажатием (`keys`), — пересланное встаёт ПОСЛЕ текста, как у Telegram; затем пересылка из беседы
   * `d.from`. Не вышло — тост, а черновик возвращается в полосу (если новый не поставили), и Enter повторит.
   */
  async function sendFwdDraft(d: FwdDraft, keys: string[], silent: boolean) {
    const b = batchOn;
    const to = feedId;
    if (!b || !to) return;
    if (keys.length > 0) await outboxSettled(to, keys);
    try {
      await b.forward(
        d.messages.map((m) => m.id),
        to,
        silent,
        { hideSender: d.hideSender, hideCaptions: d.hideCaptions, from: d.from },
      );
    } catch (err) {
      toastError(err, 'Не удалось переслать');
      const st = useStore.getState();
      if (!st.fwdDrafts[to]) st.setFwdDraft(to, d);
    }
  }

  /**
   * Черновик пересылки в беседу `to` (08.10; Telegram `MainWidget::setForwardDraft`): «Переслать» → одна беседа или
   * бросок выделенного на строку списка. Выделение снимается, беседа открывается (своя — курсор в поле), над полем —
   * полоса «Пересылка». `src` — пересылка уже из черновика («Изменить получателя»): сообщения и опции берутся оттуда,
   * а черновик этой беседы снимается.
   */
  function startFwdDraft(to: string, ids: readonly string[], src: FwdDraft | null) {
    const b = batchOn;
    if (!b || !feedId) return;
    const idSet = new Set(ids);
    const list = src ? src.messages : messages.filter((m) => idSet.has(m.id));
    if (list.length === 0) return;
    setPicked(NO_PICKS);
    const st = useStore.getState();
    if (src && to !== feedId) st.setFwdDraft(feedId, null);
    st.setFwdDraft(to, {
      from: src?.from ?? feedId,
      messages: list,
      hideSender: src?.hideSender ?? false,
      hideCaptions: src?.hideCaptions ?? false,
    });
    if (to === feedId) requestAnimationFrame(() => inputRef.current?.focus());
    else b.open(to);
  }

  /** Поставить сообщение в очередь отправки; исход — в строку «в пути», а не в тост. */
  /** Загрузки строк «в пути» без очереди ЛС (каналы): «Отменить отправку» обрывает их (07.10). */
  const localUploads = useRef(new Map<string, AbortController>());
  /** Отменённые, пока ждали своей очереди: до отправки дело не дойдёт. */
  const localCancelled = useRef(new Set<string>());

  function enqueueSend(item: OutgoingMessage & { feedId: string | undefined; afterId: string | undefined }) {
    sendQueue.current = sendQueue.current.then(async () => {
      if (localCancelled.current.delete(item.key)) return;
      const ctrl = new AbortController();
      localUploads.current.set(item.key, ctrl);
      try {
        setUploadSignal(item.key, ctrl.signal);
        await onSend(item.content, item.files, item.replyToId, item.key);
        setOutgoing((o) => outgoingSent(o, item.key));
      } catch (err) {
        // Отменил сам человек — строку уже убрали, «не отправлено» не ставим.
        if (ctrl.signal.aborted || isUploadAborted(err)) return;
        const why = sendErrorText(err);
        setOutgoing((o) => (why === null ? outgoingSent(o, item.key) : outgoingFailed(o, item.key, why)));
      } finally {
        localUploads.current.delete(item.key);
        setUploadSignal(item.key, null);
        clearUploadProgress(item.key);
      }
    });
  }

  /**
   * «Отменить отправку» (07.10, Telegram 1.24/2.35/6.22): строка уходит сразу; идёт загрузка — обрывается, ждала
   * очереди — не уйдёт. Очередь ЛС делает то же у себя (`outboxDiscard`).
   */
  function cancelSending(key: string) {
    if (outbox) {
      outbox.discard(key);
      return;
    }
    const live = localUploads.current.get(key);
    if (live) live.abort();
    else localCancelled.current.add(key);
    clearUploadProgress(key);
    setOutgoing((l) => outgoingSent(l, key));
  }
  /** Та же функция на всё время жизни ленты — для `memo`-вложений строки «в пути». */
  const cancelSendingRef = useRef(cancelSending);
  cancelSendingRef.current = cancelSending;
  const onCancelRow = useRef((key: string) => cancelSendingRef.current(key)).current;

  function retryOutgoing(key: string) {
    const item = outgoing.find((o) => o.key === key);
    if (!item || item.status !== 'failed') return;
    setOutgoing((o) => outgoingRetry(o, key));
    enqueueSend({ ...item, status: 'sending', error: null });
  }

  function startReply(m: Message, quote: ReplyQuoteDraft | null = null, ev?: { ctrlKey?: boolean; metaKey?: boolean }) {
    if (readOnly) return;
    // Ctrl + «Ответить» (Telegram Desktop `replyToMessage(forceAnotherChat)`, 7.02) — ответ в другой беседе.
    if (quoteOn && (ev?.ctrlKey || ev?.metaKey)) return void setReplyElsewhere({ m, quote });
    // Идёт правка: ответ ложится в черновик, отложенный на время правки, и появится после неё (Telegram Desktop
    // `processReply` при `_editMsgId`) — правку он не сбрасывает.
    if (composerEdit) {
      if (draftBeforeEdit.current) draftBeforeEdit.current = { ...draftBeforeEdit.current, replyingTo: m };
      setReplyExtra(quote ? { id: m.id, quote, foreign: false } : null);
      return;
    }
    setReplyingTo(m);
    setReplyExtra(quote ? { id: m.id, quote, foreign: false } : null);
    /* Ответ поднимает клавиатуру всегда (аудит S20+ 10.10, B8). Поле уже в фокусе, а клавиатуру убрали «назад» — повторный
       `focus()` её не зовёт: фокус надо снять и поставить заново, как TG Android `ChatActivityEnterView.openKeyboard`
       (`ChatActivityEnterView.java:13123`: `clearFocus()` + `requestFocus()`), который ответ зовёт, когда клавиатуры и панели
       нет (`showTopView`, `:6339`: `!(keyboardVisible || isPopupShowing())`). Клавиатура на месте (`data-kbspace`) или открыта
       панель эмодзи — не трогаем: иначе клавиатура мигнула бы, а панель сменилась бы клавиатурой. */
    const field = inputRef.current;
    if (
      field &&
      phoneTaps() &&
      document.activeElement === field &&
      !exprUnderRef.current &&
      !document.documentElement.hasAttribute('data-kbspace')
    )
      field.blur();
    field?.focus();
  }

  /**
   * Выделенный мышью текст ВНУТРИ этого сообщения → цитата (G55, Telegram 1.30 «Ответить с цитатой»). Нет выделения, оно
   * выходит за пузырь или не совпадает с сырым текстом дословно — `null`; длиннее 1024 — `too-long`.
   */
  function selectionQuote(m: Message): ReplyQuoteDraft | 'too-long' | null {
    if (!quoteOn || !m.content) return null;
    const sel = window.getSelection();
    const row = rowOf(m.id);
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !row) return null;
    const range = sel.getRangeAt(0);
    const body = row.querySelector('.message-body');
    if (!body || !body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
    const before = document.createRange();
    before.selectNodeContents(body);
    before.setEnd(range.startContainer, range.startOffset);
    return quoteFromSelection(m.content, sel.toString(), before.toString().length);
  }

  /** «Ответить с цитатой» из меню: длинная — тост Telegram «Слишком длинная цитата», ответ не ставится. */
  function replyWithQuote(m: Message, q: ReplyQuoteDraft | 'too-long', ev?: { ctrlKey?: boolean; metaKey?: boolean }) {
    if (q === 'too-long') return void toast('error', 'Слишком длинная цитата', `Выбран слишком длинный фрагмент: не больше ${REPLY_QUOTE_MAX} знаков.`);
    window.getSelection()?.removeAllRanges();
    startReply(m, q, ev);
  }

  /** «Цитировать» у выделения пальцем (G55, Telegram 7.21): сообщение — по строке, где выделение. */
  function quoteFromBody(body: HTMLElement, t: string, start: number) {
    const id = body.closest<HTMLElement>('[data-mid]')?.dataset.mid;
    const m = id ? messages.find((x) => x.id === id) : undefined;
    if (!m) return;
    const q = quoteFromSelection(m.content, t, start);
    if (!q) return void toast('error', 'Этот фрагмент не процитировать', 'Выделите текст без оформления — цитата берётся из текста дословно.');
    replyWithQuote(m, q);
  }

  /** Беседа выбрана в «Ответить в…»: ответ ждёт её ленту (`crossReply`), беседа открывается. */
  function pickReplyChat(convId: string, m: Message, quote: ReplyQuoteDraft | null) {
    if (convId === feedId) return startReply(m, quote);
    if (replyingTo?.id === m.id) setReplyingTo(null);
    useStore.getState().setCrossReply({ convId, message: m, quote });
    void useStore.getState().selectDm(convId);
  }

  /** Тайм-код голосового `m`, если оно сейчас загружено в плеер (играет или на паузе); иначе `null`. */
  function voiceTimecodeOf(m: Message): string | null {
    const st = getVoicePlayerState();
    const src = st.track?.source;
    return src && src.messageId === m.id && src.conversationId === feedId ? voiceTimecode(st.at) : null;
  }

  /**
   * «Ответить с тайм-кодом» (G54, Telegram Desktop `menu/menu_timecode_action.cpp` + `InsertTextAtCursor`): ответ на
   * голосовое и тайм-код текущего места в поле у каретки — пробел перед ним, если нужно, и пробел после.
   */
  function replyWithTimecode(m: Message) {
    const tc = voiceTimecodeOf(m);
    if (!tc) return;
    const base = composerEdit ? (draftBeforeEdit.current?.text ?? '') : text;
    const el = inputRef.current;
    const pos = !composerEdit && el ? Math.min(el.selectionStart ?? base.length, base.length) : base.length;
    const before = base.slice(0, pos);
    const ins = (before && !/\s$/.test(before) ? ' ' : '') + tc + ' ';
    startReply(m);
    setText(before + ins + base.slice(pos));
    requestAnimationFrame(() => {
      const f = inputRef.current;
      if (!f) return;
      f.focus();
      f.setSelectionRange(pos + ins.length, pos + ins.length);
    });
  }

  function startComposerEdit(m: Message) {
    // Идёт запись или лежит записанное голосовое — правку не открываем (Telegram Desktop `editMessage`, `lng_edit_caption_voice`):
    // поле занято голосовым, а правка его бы спрятала.
    if (recording || preview) return void toast('info', 'Нельзя изменить сообщение, пока не отправлено голосовое');
    if (!composerEdit) draftBeforeEdit.current = { text, replyingTo };
    setReplyingTo(null);
    setComposerEdit(m);
    setText(m.content);
    /* Фокус — сразу, не только в кадре ниже: до кадра поле было не в фокусе, и Ctrl+A выделял страницу, а набранное затем
       дописывалось к старому тексту. Кадр остаётся: меню/кнопка, из которых вошли в правку, могут вернуть фокус себе. */
    inputRef.current?.focus();
    // Каретка — в конец: правят чаще всего хвост («опечатка в последнем слове»).
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      /* Кадр мог прийти ПОСЛЕ того, как человек уже нажал Ctrl+A или начал печатать (кадр запаздывает под нагрузкой и в
         фоновой вкладке): сворачивать выделение в каретку нельзя — набранное поверх «выделить всё» дописывалось к
         старому тексту. Каретку ставим, только если поле нетронуто. */
      if (el.selectionStart !== el.selectionEnd || el.value !== m.content) return;
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  /** Выйти из правки и вернуть черновик, который был до неё (и после отмены, и после сохранения). */
  function finishComposerEdit() {
    const draft = draftBeforeEdit.current;
    draftBeforeEdit.current = null;
    setComposerEdit(null);
    setText(draft?.text ?? '');
    setReplyingTo(draft?.replyingTo ?? null);
  }

  async function saveComposerEdit() {
    const m = composerEdit;
    if (!m) return;
    const content = text.trim();
    // Ничего не поменял — просто выходим: пустая правка поставила бы «(изм.)» на нетронутое сообщение. Пустая подпись у
    // сообщения с вложениями — допустимая правка (убрать подпись): `editDecision`.
    const what = editDecision({ draft: content, original: m.content, hasAttachments: (m.attachments?.length ?? 0) > 0 });
    if (what === 'close') return finishComposerEdit();
    if (what === 'ignore') return;
    // Правку не режем (Telegram 10.3): сверх предела — не сохранять, сказать, на сколько сократить.
    if (content.length > MESSAGE_TEXT_MAX) return void toast('error', tooLongText(content.length - MESSAGE_TEXT_MAX));
    try {
      await onEdit(m, content);
      finishComposerEdit();
    } catch (err) {
      toastError(err);
    }
  }

  /* «Назад» на Android сначала отменяет правку или ответ (#212): иначе она уводила в список, а режим правки
     оставался висеть до возвращения. Окно поверх ленты (настройки, профиль, участники) закрывается раньше —
     порядок держит `androidBack.stepBack`, а здесь мы просто не берём шаг, пока ленту не видно. */
  useEffect(() => {
    if (!composerEdit && !replyingTo) return;
    return pushBackHandler(() => {
      const s = useStore.getState();
      if (s.adminOpen || s.settingsOpen || s.mobileProfileOpen || s.mobileMembersOpen || s.mobilePane !== 'content')
        return false;
      /* Правка — как Esc и ✕ полосы (решение 37): текст менялся — окно «Отменить изменения?», иначе выйти сразу. Зовём
         через реф: обработчик живёт от смены правки, а `text` в нём устарел бы. Пока окно открыто, «назад» — слой
         `.confirm-overlay`, его закрывает `stepBack` раньше этого перехватчика. */
      if (composerEdit) cancelEditRef.current();
      else setReplyingTo(null);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelEditRef всегда свежий, сеттеры стабильны
  }, [composerEdit, replyingTo]);

  /**
   * Кнопки у поля ввода не забирают фокус (#212, 28.09, S25): после «отправить» клавиатура закрывалась — фокус
   * уходил на кнопку, — и следующее сообщение начиналось с нового нажатия в поле. У Telegram клавиатура
   * остаётся. Нажатие при этом срабатывает как обычно: гасим только перенос фокуса.
   */
  const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  /**
   * Клик по полосе «Ответ» / «Редактирование» над полем — к этому сообщению (07.10, сверка 02·3.6 / 01·7.11–7.12). У Telegram
   * Desktop обычный клик по полосе ответа открывает окно параметров (цитата, «Показать в чате», «Убрать ответ»), а Ctrl+клик,
   * средняя и правая кнопка ведут прямо к сообщению; окна параметров у нас нет (ярус 3) — все пути ведут в ленту
   * (`jumpToMessage`: место перехода — в стек «Назад»). Крестик полосы — своё дело.
   */
  function stripJump(e: React.MouseEvent, targetId: string) {
    if ((e.target as Element).closest('.rs-close')) return;
    if (e.type === 'auxclick' && e.button !== 1) return;
    e.preventDefault();
    void jumpToMessage(targetId);
  }

  /** Отменить правку в поле (Esc, ✕ полосы «Редактирование»): текст менялся — сперва вопрос, иначе выйти сразу. */
  function cancelComposerEdit() {
    const m = composerEdit;
    if (!m) return;
    if (fieldEscape({ editing: true, replying: false, draft: text, original: m.content }) !== 'ask') return finishComposerEdit();
    void askDiscardEdit().then((ok) => {
      if (ok) finishComposerEdit();
      // «Продолжить правку»: фокус окно не возвращает — обратно в поле.
      else requestAnimationFrame(() => inputRef.current?.focus());
    });
  }
  const cancelEditRef = useRef(cancelComposerEdit);
  cancelEditRef.current = cancelComposerEdit;

  /** «Отменить изменения?» — Esc в правке с изменённым текстом (07.10, сверка 02·3.3). Опасное: Enter не подтверждает. */
  function askDiscardEdit(): Promise<boolean> {
    return confirmAction({
      title: 'Отменить изменения?',
      body: 'Правка не сохранена — набранный текст пропадёт.',
      tone: 'danger',
      confirmLabel: 'Отбросить',
      cancelLabel: 'Продолжить правку',
    });
  }

  // Mobile long-press on a message body → open the action sheet (design-step8 C2). Ignore presses
  // that land on interactive children (avatar/author open the user menu; links/images/buttons keep
  // their own behaviour — кроме фото в раунде 12, см. `startLongPress`), multi-touch, and cancel if
  // the finger moves (a scroll, not a press).
  function onMsgTouchStart(e: React.TouchEvent, m: Message) {
    // Быстрая реакция (07.10): касание пузыря, пока первый тап ждёт, — второе касание двойного тапа или конец ожидания.
    tapDown(m);
    // Раунд 12, порция 6: может стать свайп-ответом — решит движение пальца (`swipeMove`).
    swipeStart(e, m);
    /* 10.10 (#218), как Telegram Android `ChatActivity.onItemLongClickListener`: долгое нажатие — то же меню у пузыря, что и
       тап (`createMenu`), а в ЛС с действиями пачкой ещё и протяжка (`startMultiselect` → `startMenuRange`): повёл палец —
       меню закрылось, выбор диапазоном. Раньше (раунд 12) долгое нажатие в ЛС сразу входило в выделение. В самом выделении
       удержание переключает строку и ведёт диапазон (ниже), тап переключает строку. */
    const row = e.currentTarget as HTMLElement;
    const target = e.target as Element;
    /* G43, Telegram `ChatActivity.startMultiselect`: удержание в самом выделении переключает строку и сразу ведёт диапазон
       (тап — по-прежнему переключает). Ссылка, фото и прочее своё в выделении не делают: нажатие гасит `onPick`. */
    if (selecting) {
      if (batchOn) startLongPress(e, m.id, () => startTouchRange(m), true);
      return;
    }
    /* Удержание по аватарке отправителя (G43, Telegram `didLongPressUserAvatar`): меню человека, а не тап-карточка. */
    if (target.closest('.msg-ava') && isMobile() && e.touches.length === 1) {
      startAvatarPress(e, m);
      return;
    }
    /* Удержание по ссылке в тексте (07.10, Telegram 2.21 / 10.03) — своё меню ссылки «Открыть · Скопировать ссылку»,
       не выделение и не меню сообщения. */
    const link = target.closest<HTMLAnchorElement>('a.msg-link');
    const url = link?.getAttribute('href');
    if (link && url) {
      startLongPress(e, m.id, () => openLinkMenu(m, url, link.getBoundingClientRect()), true);
      return;
    }
    // Какое фото (файл, видео, голосовое) под пальцем — узнаём сразу, на касании: к срабатыванию удержания палец мог уже уйти.
    const photo = photoFromTouch(m.attachments, target);
    const file = fileFromTarget(m.attachments, target);
    startLongPress(e, m.id, batchOn ? () => startMenuRange(m, row, photo, { file }) : () => openMsgMenuAt(m, row, photo, { file }), true);
  }
  /**
   * Долгое нажатие на строку «в пути» — её действия: у неотправленного — повторить/скопировать/удалить, у отправляемого
   * (07.10) — скопировать/«Отменить отправку».
   */
  function onOutTouchStart(e: React.TouchEvent, key: string) {
    // Неотправленное свайпом не отвечается (порция 6): прежний жест, если висит, — долой.
    swipeDrop();
    // Раунд 12: вместо листа — меню у пузыря; в режиме выделения — ничего (неотправленное в нём не участвует).
    if (selecting) return;
    const row = e.currentTarget as HTMLElement;
    startLongPress(e, key, () => openOutMenuAt(key, row), true);
  }
  /**
   * `menu` — раунд 12: долгое нажатие открывает меню у пузыря или выделение, а не лист под пальцем
   * (`swallowNativeLongPress`: системное долгое нажатие и клик того же касания до строки не доходят).
   */
  function startLongPress(e: React.TouchEvent, id: string, open: () => void, menu = false) {
    if (!isMobile() || e.touches.length !== 1) return;
    const target = e.target as Element;
    /* Раунд 12 (05.10, как в Telegram): удержание пальцем на фото и ячейке альбома (`.att-img-link`) — как на пузыре:
       выделение или меню. Тап по фото по-прежнему открывает просмотр — клик гасит только сработавшее удержание
       (`swallowNativeLongPress`). Ссылки, кнопки, поля, аватар и имя — своё, как было. */
    if (
      target.closest('a, img, button, input, textarea, .msg-ava, .author') &&
      // 07.10: и на ссылке в тексте (меню ссылки), и на файле, видео, голосовом (`[data-att]`) — как на пузыре.
      /* D15 (S20+, 08.10, решение 40): и на кружке (`.round-msg-btn` — кнопка с видео внутри). Кольцо перемотки сюда не
         доходит: его касание гасит `RoundVideo.onTouchStart`; короткий тап — по-прежнему play/пауза/звук (клик гасит только
         сработавшее удержание, `swallowNativeLongPress`). */
      !target.closest('.att-img-link, a.msg-link, [data-att], .message-sticker, .round-msg-btn')
    )
      return;
    const t = e.touches[0];
    lpStart.current = { x: t.clientX, y: t.clientY };
    lpTouch.current = { id: t.identifier, x: t.clientX, y: t.clientY };
    // Цель касания — по ней `swallowNativeLongPress` узнаёт `touchend` ИМЕННО этого пальца.
    const from = e.target;
    /* Отклик пузыря (раунд 10) — не сразу: касание, с которого начинается прокрутка, иначе мигало бы сжатием. Сдвиг
       пальца гасит и его, и само долгое нажатие (`onMsgTouchMove`). */
    if (bubbles) pressTimer.current = window.setTimeout(() => setPressingId(id), 120);
    /* Сработать — по нашему таймеру или раньше, по системному долгому нажатию (`lpFire`, `openMsgMenu`): у Android оно
       приходит через 400–500 мс от касания (Samsung — 500), а наш таймер стартует, когда касание дошло до страницы, — кто
       первый, неизвестно. Второй уже ничего не делает: таймер снят, `contextmenu` гасит `swallowNativeLongPress`. */
    const fire = () => {
      if (lpTimer.current != null) window.clearTimeout(lpTimer.current);
      lpTimer.current = null;
      lpFire.current = null;
      // Долгое нажатие сработало — это касание свайпом уже не станет (порция 6).
      swipeDrop();
      navigator.vibrate?.(8);
      swallowNativeLongPress(from, menu);
      stopPressing();
      /* Удержание в ЛЮБОМ месте пузыря, и по тексту тоже, — выделение сообщения или меню, как в Telegram Android (решение 41→37
         владельца 08.10: раньше на тексте открывалось выделение слова с «Копировать · Цитировать · Выделить всё»). Выделить
         текст — пункт «Выделить текст» меню сообщения (`selectMessageText`). */
      open();
    };
    // Прежний таймер (его касание потерялось, конца не было) — долой: иначе его `fire` снял бы таймер этого касания.
    if (lpTimer.current != null) window.clearTimeout(lpTimer.current);
    lpFire.current = fire;
    lpTimer.current = window.setTimeout(fire, 480);
  }
  /**
   * «Выделить текст» в меню сообщения на телефоне (решение 37 владельца 08.10, как пункт Telegram Android): весь текст тела
   * сообщения выделен — подсветка, маркеры (тянутся пальцем), панель «Копировать · Цитировать». `false` — текста нет.
   */
  function selectMessageText(m: Message): boolean {
    const body = rowOf(m.id)?.querySelector<HTMLElement>('.message-body');
    const sel = body && allTextSel(body);
    if (!sel) return false;
    setTextSel(sel);
    return true;
  }
  function stopPressing() {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    setPressingId(null);
  }
  /**
   * 🔴 Системное долгое нажатие WebView срабатывает чуть ПОЗЖЕ нашего (28.09, поймано на S25): к этому
   * моменту под пальцем уже открытая шторка, и Android выделял ближайший текст в ней (👍 из ряда
   * реакций) и показывал своё «Перевести / Копировать / Выбрать все» поверх нашего меню. До конца этого
   * жеста гасим `contextmenu` (его действие по умолчанию и есть выделение) и снимаем выделение.
   * 🔴 Отпускание пальца — тоже не нажатие (ревью раунда 10, 03.10): лист открылся ПОД пальцем, и `click` после
   * `touchend` попадал в его строку — на стенде с касаниями CDP так сработало копирование текста. На телефоне клик
   * обычно гасит само системное долгое нажатие, но наш лист открывается на 480 мс, раньше его порога. Поэтому
   * `touchend` этого пальца (цель — та же, что у его `touchstart`, `from`) — `preventDefault()`: браузер не синтезирует
   * ни мышь, ни `click`. Слушатель на окне, в захвате и явно не пассивный (по умолчанию пассивными бывают только
   * `touchstart` и `touchmove`; у React `touchend` тоже не пассивный). Запасной вариант — проглотить один `click`
   * (`swallowNextClick`). Чужой `touchend` (другой палец, следующее касание, если этот потерялся) только снимает
   * слушатели — как раньше.
   * 🔴 Раунд 12 (`menu`): меню встаёт у пузыря, а НЕ под пальцем, — системное долгое нажатие приходит в саму строку. Его
   * `contextmenu` гасим целиком (и дальше не пускаем): иначе меню закрыло бы его как «правый клик мимо», а строка открыла
   * бы меню заново по точке. Запасной глоток клика — с открытия меню (`holdNextClick`): слушатель «клик мимо» у меню
   * встаёт раньше, чем поднимут палец.
   */
  function swallowNativeLongPress(from: EventTarget | null, menu = false) {
    const stop = (e: Event) => {
      e.preventDefault();
      if (menu) e.stopImmediatePropagation();
    };
    const release = menu ? holdNextClick() : null;
    const done = (e: TouchEvent) => {
      if (e.type === 'touchend' && e.target === from) {
        if (e.cancelable) e.preventDefault();
        if (!release) swallowNextClick();
      }
      window.removeEventListener('contextmenu', stop, true);
      window.removeEventListener('touchend', done, true);
      window.removeEventListener('touchcancel', done, true);
      /* Выделение, которое могло начать системное долгое нажатие, — снять. Но не каретку поля ввода (05.10, долгое нажатие
         по «Отправить» на S25): без выделения в поле у страницы нет поля для клавиатуры, и Android её прячет. */
      if (!fieldFocused()) window.getSelection()?.removeAllRanges();
      release?.();
    };
    window.addEventListener('contextmenu', stop, true);
    window.addEventListener('touchend', done, { capture: true, passive: false });
    window.addEventListener('touchcancel', done, true);
  }
  function onMsgTouchMove(e: React.TouchEvent) {
    if (lpTimer.current == null || !lpStart.current) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - lpStart.current.x) > 10 || Math.abs(t.clientY - lpStart.current.y) > 10) {
      window.clearTimeout(lpTimer.current);
      lpTimer.current = null;
      lpFire.current = null;
      stopPressing();
    }
  }
  function cancelLongPress() {
    if (lpTimer.current != null) {
      window.clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
    lpFire.current = null;
    stopPressing();
  }

  /**
   * Удержание сработало вне текста, в ЛС с выделением (G43): сообщение выбрано, а палец, не отрываясь, ведёт диапазон — как
   * `RecyclerListView.startMultiselect` у Telegram для Android (правила и цифры — `dmSelection.ts`, «Выделение пальцем»).
   * Строку выбирает тот же `selTrack`, что и у мыши (диапазон от строки нажатия, назад сжимается, `SELECT_MAX`), автопрокрутка —
   * `selScrollKick` с зоной 56 px у края. Лента под пальцем не листается: `touchmove` окна не пассивный и гасит прокрутку. В
   * самом выделении удержание на строке переключает её: выбрана была — диапазон снимает, не была — добавляет (`add`).
   */
  function startTouchRange(m: Message) {
    const lp = lpTouch.current;
    const list = listRef.current;
    if (!selecting) startSelection(m);
    if (!lp || !list || selMouse.current) return;
    const base = pickedRef.current;
    const g: SelGesture = {
      list,
      pointerId: -1,
      x: lp.x,
      y: lp.y,
      from: m.id,
      base,
      add: !base.includes(m.id),
      on: true,
      held: true,
      dead: false,
      px: lp.x,
      py: lp.y,
      at: m.id,
      timer: null,
      frame: 0,
      tick: 0,
      rest: 0,
      off: () => {},
      touch: true,
      moved: false,
    };
    selMouse.current = g;
    selNoText(true);
    if (selecting) selApply(g, m.id);
    const mine = (l: TouchList | undefined) => (l ? Array.from(l).find((t) => t.identifier === lp.id) : undefined);
    const move = (ev: TouchEvent) => {
      const t = mine(ev.touches);
      if (!t) return;
      if (ev.cancelable) ev.preventDefault();
      g.px = t.clientX;
      g.py = t.clientY;
      if (g.dead) return;
      if (!g.moved) {
        if (Math.abs(g.py - g.y) <= SELECT_TOUCH_SLOP_PX) return;
        g.moved = true;
      }
      selTrack(g);
      selScrollKick(g);
    };
    const end = (ev: TouchEvent) => {
      // Событие без списка изменённых касаний (синтетическое) — всё равно конец: жест не должен зависнуть.
      if (!ev.changedTouches || mine(ev.changedTouches)) selEnd(g, false);
    };
    window.addEventListener('touchmove', move, { capture: true, passive: false });
    window.addEventListener('touchend', end, true);
    window.addEventListener('touchcancel', end, true);
    g.off = () => {
      window.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', end, true);
      window.removeEventListener('touchcancel', end, true);
    };
  }

  /**
   * Долгое нажатие вне выделения в ЛС с пачкой (10.10, #218), как Telegram Android `ChatActivity.onItemLongClickListener`:
   * меню у пузыря (`createMenu`) и сразу `startMultiselect` — палец, не отрываясь, ушёл по вертикали дальше порога
   * (`SELECT_TOUCH_SLOP_PX`, у Telegram `touchSlop` в `RecyclerListView.onTouchEvent`): меню закрывается, сообщение выбрано и
   * диапазон ведёт тот же палец (`startTouchRange`). Отпустил на месте — меню остаётся. Пока палец держит меню, лента под
   * ним не листается (`touchmove` не пассивный, гасит прокрутку) — как у Telegram, где жест забирает список.
   */
  function startMenuRange(m: Message, row: HTMLElement, photo?: Attachment, more?: MenuMore) {
    openMsgMenuAt(m, row, photo, more);
    menuRangeOff.current?.();
    const lp = lpTouch.current;
    if (!lp) return;
    const mine = (l: TouchList | undefined) => (l ? Array.from(l).find((t) => t.identifier === lp.id) : undefined);
    const off = () => {
      window.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', end, true);
      window.removeEventListener('touchcancel', end, true);
      if (menuRangeOff.current === off) menuRangeOff.current = null;
    };
    menuRangeOff.current = off;
    const move = (ev: TouchEvent) => {
      const t = mine(ev.touches);
      if (!t) return;
      if (ev.cancelable) ev.preventDefault();
      if (Math.abs(t.clientY - lp.y) <= SELECT_TOUCH_SLOP_PX) return;
      off();
      startTouchRange(m);
    };
    // Событие без списка изменённых касаний (синтетическое) — тоже конец: слушатели не должны пережить жест.
    const end = (ev: TouchEvent) => {
      if (!ev.changedTouches || mine(ev.changedTouches)) off();
    };
    window.addEventListener('touchmove', move, { capture: true, passive: false });
    window.addEventListener('touchend', end, true);
    window.addEventListener('touchcancel', end, true);
  }

  /**
   * Удержание по аватарке отправителя (G43, Telegram `ChatActivity.didLongPressUserAvatar`): меню человека — «Профиль»,
   * «Написать в ЛС», «Упомянуть» (у Telegram то же меню рядом с крупным предпросмотром фото; предпросмотра у нас нет — решение
   * владельца). Тап по аватарке, как раньше, — карточка профиля. Сдвиг пальца дальше 10 px — это прокрутка, не удержание.
   */
  function startAvatarPress(e: React.TouchEvent, m: Message) {
    const t = e.touches[0];
    const from = e.target;
    const x0 = t.clientX;
    const y0 = t.clientY;
    let x = x0;
    let y = y0;
    const off = () => {
      window.clearTimeout(timer);
      window.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', off, true);
      window.removeEventListener('touchcancel', off, true);
    };
    const move = (ev: TouchEvent) => {
      const p = ev.touches ? Array.from(ev.touches).find((q) => q.identifier === t.identifier) : undefined;
      if (!p) return;
      x = p.clientX;
      y = p.clientY;
      if (Math.abs(x - x0) > 10 || Math.abs(y - y0) > 10) off();
    };
    const timer = window.setTimeout(() => {
      off();
      swipeDrop();
      navigator.vibrate?.(8);
      swallowNativeLongPress(from, true);
      const target: UserMenuTarget = { userId: m.author.id, name: nameOf(m.author.id, m.author.displayName), avatarUrl: m.author.avatarUrl };
      openUserMenu({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} } as unknown as React.MouseEvent, target);
    }, 480);
    window.addEventListener('touchmove', move, true);
    window.addEventListener('touchend', off, true);
    window.addEventListener('touchcancel', off, true);
  }

  // ─── Раунд 12, порция 6: свайп-ответ (телефон) ─────────────────────────────────────────────────────────────────────

  /**
   * Касание сохранённого пузыря: запомнить, откуда пошёл палец; свайп это или нет, решит `swipeMove`. Не начинаем: у
   * правого края экрана (жест «назад» Android), в поле правки и на коде, который сам листается вбок (их жест), вторым
   * пальцем, при открытом меню. Тап, долгое нажатие и нажатия внутри пузыря (ссылка, фото, голосовое) идут как раньше:
   * пока палец не ушёл на `SWIPE_LOCK_PX`, здесь только запись.
   */
  function swipeStart(e: React.TouchEvent, m: Message) {
    swipeDrop();
    if (!swipeReply || e.touches.length !== 1 || msgMenu || outMenu) return;
    // Телефон — то же условие, что у тап-меню: палец и раскладка ≤ 760 px (решение владельца 05.10; планшет в широкой
    // ленте — без свайпа). Касание и есть палец (или перо): про указатель устройства не спрашиваем (05.10, `phoneTaps`).
    if (!phoneTaps(true)) return;
    const t = e.touches[0];
    if (swipeFromEdge(t.clientX, window.innerWidth)) return;
    const target = e.target as Element;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    const code = target.closest('.md-pre');
    if (code && code.scrollWidth > code.clientWidth) return;
    swipe.current = {
      id: m.id,
      row: e.currentTarget as HTMLElement,
      x: t.clientX,
      y: t.clientY,
      top: listRef.current?.scrollTop ?? 0,
      on: false,
      armed: false,
      off: null,
      lim: SWIPE_TOUCH,
      base: 0,
      buzzed: false,
    };
  }

  /**
   * Движение пальца: решить направление (`swipeIntent`), дальше — вести пузырь. Состояние React — только в момент решения
   * (`swipingId`: строке `.swiping` и значок); каждое движение пишет в DOM строки сдвиг, долю пути и взвод (+ вибро-отклик,
   * как у долгого нажатия).
   */
  function swipeMove(e: React.TouchEvent) {
    const s = swipe.current;
    if (!s) return;
    const t = e.touches[0];
    if (!t || e.touches.length !== 1) {
      swipeDrop();
      return;
    }
    const dx = t.clientX - s.x;
    if (!s.on) {
      const intent = swipeIntent(dx, t.clientY - s.y);
      if (intent === 'wait') return;
      /* По вертикали (или ленту уже повёл браузер — он решает на своём пороге) — это прокрутка, до конца касания. Сдвиг
         меньше пикселя — не прокрутка пальцем: у телефона с плотностью 3.5 позиция ленты дробная, и подгонка кодом (низ
         ленты, догрузка картинки) двигает её на доли пикселя. */
      if (intent === 'scroll' || Math.abs((listRef.current?.scrollTop ?? s.top) - s.top) >= 1) {
        swipe.current = null;
        return;
      }
      s.on = true;
      s.base = dx;
      cancelLongPress();
      s.off = onSwipeEnd(s);
      setSwipingId(s.id);
    }
    swipePaint(s, swipeOffset(s.base - dx, s.lim));
  }

  /**
   * Нарисовать сдвиг пузыря `off` (px, уже по кривой `swipeOffset`): сдвиг, долю пути и взвод — прямо в DOM строки (общее
   * у пальца и тачпада). Класс — и здесь: перерисовка строки посреди жеста (пришла реакция, поправили текст) переписала бы
   * её `class`. Только если его нет: запись того же `class` — тоже изменение атрибута (пересчёт стилей) на каждом движении.
   */
  function swipePaint(s: SwipeGesture, off: number) {
    const armed = swipeArmed(off, s.armed, s.lim);
    if (!s.row.classList.contains('swiping')) s.row.classList.add('swiping');
    s.row.style.setProperty('--swipe-x', `${-off}px`);
    s.row.style.setProperty('--swipe-p', swipeProgress(off, s.lim).toFixed(3));
    if (armed !== s.armed) {
      s.armed = armed;
      if (armed && !s.buzzed) {
        s.buzzed = true;
        navigator.vibrate?.(8);
      }
      s.row.querySelector('.swipe-reply')?.classList.toggle('armed', armed);
    }
  }

  /**
   * Конец жеста — слушателем на окне (в захвате, не пассивным), а не у строки: строка могла пропасть посреди жеста, и её
   * `touchend` до React уже не дошёл бы. Отпустил за порогом — ответ (`swipeAnswer`: цитата над полем и фокус в поле —
   * клавиатура поднимается, фокус дан в самом касании); до порога, касание сорвалось или поднят не последний палец
   * (второй коснулся экрана мимо строк) — без ответа. `preventDefault` — ни мыши, ни `click` из этого касания: тап по
   * пузырю открыл бы меню.
   */
  function onSwipeEnd(s: SwipeGesture): () => void {
    const end = (e: TouchEvent) => {
      off();
      if (swipe.current !== s) return;
      swipe.current = null;
      if (e.cancelable) e.preventDefault();
      swipeClear(s);
      if (e.type === 'touchend' && e.touches.length === 0 && s.armed && s.row.isConnected) swipeAnswer.current(s.id);
    };
    const off = () => {
      window.removeEventListener('touchend', end, true);
      window.removeEventListener('touchcancel', end, true);
    };
    window.addEventListener('touchend', end, { capture: true, passive: false });
    window.addEventListener('touchcancel', end, true);
    return off;
  }

  /** Снять сдвиг и значок: без `.swiping` пузырь возвращается за `--t-fast` (переход у `.bubble`), значок уходит сразу. */
  function swipeClear(s: SwipeGesture) {
    s.row.classList.remove('swiping');
    delete s.row.dataset.swipe;
    s.row.style.removeProperty('--swipe-x');
    s.row.style.removeProperty('--swipe-p');
    setSwipingId(null);
  }

  /** Бросить жест без ответа: новое касание или второй палец, сработало долгое нажатие, лента уходит. */
  function swipeDrop() {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    s.off?.();
    if (s.on) swipeClear(s);
  }

  /** Касание кончилось, свайпом так и не став (тап, долгое нажатие, прокрутка), — забыть его. */
  function swipeForget() {
    if (swipe.current && !swipe.current.on) swipe.current = null;
  }

  /* Значок встаёт перерисовкой — чуть позже первого движения: взвод, случившийся раньше, переносим на него сразу. */
  useLayoutEffect(() => {
    const s = swipe.current;
    if (s?.on && s.id === swipingId) s.row.querySelector('.swipe-reply')?.classList.toggle('armed', s.armed);
  }, [swipingId]);
  // Лента уходит посреди жеста — снять слушатели конца с окна.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- swipeDrop читает только ref и сеттер
  useEffect(() => () => swipeDrop(), []);

  // ─── G23: свайп-ответ тачпадом в широкой ленте (веб и десктоп-приложение; правила — `messagePaneRules.wheel*`) ───────────────────

  /**
   * Горизонтальный жест тачпада (`wheel`, `deltaX`) по строке широкой ленты ЛС ведёт пузырь влево со значком и взводом,
   * как палец на телефоне (`swipePaint`), но с порогами Telegram Desktop (`SWIPE_WHEEL`); отпустил за порогом — ответ
   * (`swipeAnswer`). Решение владельца 07.10: и в браузере, и в десктоп-приложении (Tauri) — как Telegram Desktop; только в широкой
   * ленте (`bubLeft`, на ≤ 760 px — палец и `swipeStart`). Мышью (перетаскивание по строке) не ведём: нажатие по пузырю —
   * это выделение текста, рядом с ним — выделение строк (`dmSelection`).
   * У жеста нет «отпустил»: конец — тишина колеса или спад инерции (`wheelReleased`); серия событий решает свою судьбу по
   * первым значимым (`wheelBurstIntent`): вертикальная прокрутка, код/таблица со своей горизонтальной прокруткой
   * (`scrollsSideways`), поле, открытое меню — не наше, `preventDefault` не зовём. Слушатель — на ленте, не пассивный
   * (иначе браузер на Windows и Mac перелистнул бы историю тем же жестом).
   */
  const wheelSwipeOn = swipeReply && bubLeft;
  const wheel = useRef<{
    last: number;
    burst: 'wait' | 'swipe' | 'other';
    dir: 0 | 1 | -1;
    pull: number;
    prev: number;
    run: number;
    timer: number | null;
    g: SwipeGesture | null;
  }>({ last: -1e9, burst: 'other', dir: 0, pull: 0, prev: 0, run: 0, timer: null, g: null });
  const wheelGo = useRef((_e: WheelEvent) => {});
  wheelGo.current = (e) => {
    const w = wheel.current;
    if (e.timeStamp - w.last >= WHEEL_SWIPE_IDLE_MS) {
      // Тишина — это новая серия: путь с нуля, судьба — по первым значимым событиям.
      w.burst = 'wait';
      w.dir = 0;
      w.pull = 0;
      w.prev = 0;
      w.run = 0;
    }
    w.last = e.timeStamp;
    if (w.burst === 'wait') {
      const intent = wheelBurstIntent(e.deltaX, e.deltaY, e.deltaMode, e.shiftKey);
      if (intent === 'wait') return;
      w.burst = intent === 'swipe' && wheelBegin(e) ? 'swipe' : 'other';
    }
    if (w.burst !== 'swipe') return;
    const s = w.g;
    if (!s || swipe.current !== s || !s.row.isConnected) {
      wheelFinish(false);
      return;
    }
    if (e.cancelable) e.preventDefault();
    const r = wheelSwipePull(w.pull, w.dir, e.deltaX);
    w.pull = r.pull;
    w.dir = r.dir;
    w.run = wheelDecayRun(w.run, w.prev, e.deltaX);
    w.prev = e.deltaX;
    swipePaint(s, swipeOffset(w.pull, s.lim));
    if (wheelReleased(s.armed, w.run, e.deltaX)) {
      wheelFinish(true);
      return;
    }
    if (w.timer != null) window.clearTimeout(w.timer);
    w.timer = window.setTimeout(() => wheelFinish(true), WHEEL_SWIPE_IDLE_MS);
  };

  /** Серия событий стала свайпом: строка под указателем, ей — жест (общий с пальцем `swipe.current`). Не наше — `false`. */
  function wheelBegin(e: WheelEvent): boolean {
    if (msgMenu || outMenu) return false;
    const t = e.target;
    if (!(t instanceof Element)) return false;
    const row = t.closest<HTMLElement>('.message.bub[data-mid]');
    if (!row || t.closest('input, textarea, select, [contenteditable]') || scrollsSideways(t, row)) return false;
    swipeDrop();
    const g: SwipeGesture = { id: row.dataset.mid ?? '', row, x: 0, y: 0, top: 0, on: true, armed: false, off: null, lim: SWIPE_WHEEL, base: 0, buzzed: false };
    g.off = () => {
      const w = wheel.current;
      if (w.timer != null) window.clearTimeout(w.timer);
      w.timer = null;
    };
    row.dataset.swipe = 'wheel';
    swipe.current = g;
    wheel.current.g = g;
    setSwipingId(g.id);
    return true;
  }

  /** Конец жеста тачпада: тишина, спад инерции или строка пропала. `answer` и взвод — ответ; иначе пузырь возвращается. */
  function wheelFinish(answer: boolean) {
    const w = wheel.current;
    if (w.timer != null) window.clearTimeout(w.timer);
    w.timer = null;
    // Хвост инерции этой же серии нового жеста не заведёт — до тишины.
    w.burst = 'other';
    const s = w.g;
    w.g = null;
    if (!s || swipe.current !== s) return;
    swipe.current = null;
    swipeClear(s);
    if (answer && s.armed && s.row.isConnected) swipeAnswer.current(s.id);
  }

  useEffect(() => {
    const el = listRef.current;
    if (!wheelSwipeOn || !el) return;
    const on = (e: WheelEvent) => wheelGo.current(e);
    el.addEventListener('wheel', on, { passive: false });
    // Жест вбок не листает историю браузера (то же событие, до `preventDefault` первого значимого, и инерция тачпада).
    el.style.overscrollBehaviorX = 'contain';
    return () => {
      el.removeEventListener('wheel', on);
      el.style.overscrollBehaviorX = '';
      wheelFinish(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wheelFinish читает только ref и сеттер
  }, [wheelSwipeOn]);

  /**
   * «⚠ Не отправлено» нажата (ревью раунда 10, 03.10) — действия неотправленного, как красный «!» у Telegram: в
   * приложении на телефоне — тот же лист, что по долгому нажатию, иначе — то же меню, что по правому клику, но у кнопки.
   * Без неё неотправленное не удалить с клавиатуры и в Safari на iPhone: там нет ни `contextmenu`, ни нашего долгого
   * нажатия (оно только в приложении, `isMobile`).
   */
  function openOutActions(key: string, btn: HTMLButtonElement) {
    outActionsFrom.current = { key, btn };
    // Раунд 12: на телефоне и в узком окне — меню у пузыря, а не лист (кнопка стоит в строке сразу под ним).
    const row = btn.closest('.bub-fail')?.previousElementSibling;
    if ((isMobile() || narrowWindow()) && row instanceof HTMLElement) {
      openOutMenuAt(key, row);
      return;
    }
    if (isMobile()) {
      setOutSheet(key);
      return;
    }
    /* Строка «в пути» — в самом низу ленты, над полем ввода: точка меню — верх кнопки, чтобы оно встало НАД ней, а не
       накрыло её; край — со стороны строки (свои справа, в широкой ленте «все слева» — слева). */
    const r = btn.getBoundingClientRect();
    setOutMenu({ key, pos: { x: bubLeft ? r.left : r.right, y: r.top } });
  }
  /* Действия открыты кнопкой «Не отправлено» — фокус на первый пункт: меню и лист — порталы в конце страницы, Tab от
     кнопки до них не дойдёт. Таймером, а не в самом эффекте: до раскладки меню скрыто (`visibility: hidden`), а скрытое
     фокус не берёт (и не `requestAnimationFrame` — в невидимом окне кадров нет). Закрылись — фокус обратно на кнопку,
     если пропал вместе с ними (кнопки может уже не быть: «Повторить» и «Удалить» убирают строку); ушёл туда, куда
     щёлкнули, — не трогаем. */
  const outMenuKey = outMenu?.key ?? null;
  useEffect(() => {
    const key = outMenuKey ?? outSheet;
    const from = outActionsFrom.current;
    if (!key || !from || from.key !== key) return;
    const popup = outMenuKey ? '.ctx-menu[role="menu"]' : '.sheet[role="dialog"]';
    const enter = window.setTimeout(() => {
      const open = document.querySelectorAll<HTMLElement>(popup);
      open[open.length - 1]?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    }, 0);
    return () => {
      window.clearTimeout(enter);
      if (outActionsFrom.current === from) outActionsFrom.current = null;
      window.setTimeout(() => {
        const a = document.activeElement;
        if ((!a || a === document.body) && from.btn.isConnected) from.btn.focus();
      }, 0);
    };
  }, [outMenuKey, outSheet]);

  // ─── Раунд 12: меню сообщения у пузыря ─────────────────────────────────

  /**
   * Где встать меню у строки: якорь — пузырь (в канале — тело сообщения рядом с аватаром, тот же `.message-main`),
   * яркая полоса — вся строка (у неотправленного — вместе со строкой «Не отправлено · Повторить» под ним, она часть
   * сообщения), край — со стороны автора: своё в ЛС справа, остальное (и всё в широкой ленте «все слева») — слева.
   */
  function bubbleSpot(row: HTMLElement, mine: boolean): BubbleSpot {
    const anchor = (row.querySelector<HTMLElement>('.message-main') ?? row).getBoundingClientRect();
    const band = row.getBoundingClientRect();
    const fail = row.nextElementSibling?.classList.contains('bub-fail') ? row.nextElementSibling : null;
    const bottom = fail ? Math.max(band.bottom, fail.getBoundingClientRect().bottom) : band.bottom;
    // Яркая только видимая часть строки: что уехало за край ленты (под шапку, под поле ввода), приглушено вместе с ними.
    const feed = listRef.current?.getBoundingClientRect();
    const top = Math.max(band.top, feed?.top ?? band.top);
    return {
      anchor,
      spotlight: { top, bottom: Math.max(top, Math.min(bottom, feed?.bottom ?? bottom)) },
      align: bubbles && mine && !bubLeft ? 'end' : 'start',
    };
  }

  function openMsgMenuAt(m: Message, row: HTMLElement, photo?: Attachment, more?: MenuMore) {
    const bubble = bubbleSpot(row, m.author.id === meId);
    /* Телефон: палец не указал ни на картинку, ни на файл (тап по подписи, по времени) — единственное фото сообщения и
       единственный файл / видео / голосовое (07.10); альбом и несколько файлов без указания — без пунктов. */
    const guess = isMobile() && !photo && !more?.file;
    const shown = photo ?? (guess ? photoFromTouch(m.attachments, null) : undefined);
    const file = more?.file ?? (guess ? fileFromTarget(m.attachments, null, true) : undefined);
    setMsgMenu({ m, pos: { x: bubble.anchor.left, y: bubble.anchor.top }, bubble, photo: shown, file, link: more?.link, item: more?.item, quote: selectionQuote(m) ?? undefined });
  }

  /** Меню ссылки у самой ссылки (телефон, 07.10): удержание пальцем; `anchor` — где ссылка. */
  function openLinkMenu(m: Message, url: string, anchor: DOMRect) {
    setLinkMenu({ m, url, anchor });
  }

  /** «Открыть ссылку» из меню — как нажатие на неё (`MessageLink`): опасная — окно предупреждения, подозрительный адрес — сперва окно «Открыть ссылку?». */
  function openMessageLink(m: Message, url: string) {
    // Опасная ссылка (`linkthreats1`) — всегда через окно предупреждения.
    if (serverLinkThreats(useStore.getState().serverFeatures) && isDangerousLink(url, m.dangerousLinks)) {
      void openDangerousLink(url);
      return;
    }
    if (shouldWarnAboutLink(url)) {
      setLinkAsk({ url });
    } else {
      openLink(url);
    }
  }

  /** «Скопировать ссылку» (ссылка в тексте): адрес — в буфер обмена. */
  function copyLinkUrl(url: string) {
    navigator.clipboard
      ?.writeText(url)
      .then(() => toastCopied('Ссылка скопирована'))
      .catch(() => toast('error', 'Не удалось скопировать'));
  }

  /**
   * Правый клик по сообщению: меню у точки; раунд 12 в узком окне (там оно было бы листом) — у пузыря. В режиме выделения
   * (07.10) мышью — меню выделения у точки (`selMenu`), пальцем меню нет: действия над выбранным в шапке и внизу.
   */
  function openMsgMenu(m: Message, x: number, y: number, touch = false, photo?: Attachment, more?: MenuMore) {
    // Идёт запись голосового — меню сообщения не открываем (Telegram Android `ChatActivity.createMenu`: `isRecordingAudioVideo`).
    if (recording) return;
    if (selecting) {
      // Только мышь: палец (`touch`), приложение на телефоне и раскладка телефона — меню в выделении нет, как было.
      if (!touch && !isMobile() && !phoneTaps()) setSelMenu({ m, pos: { x, y } });
      return;
    }
    /* 🔴 Приложение, раунд 12: `contextmenu` от пальца — системное долгое нажатие WebView, а не правый клик (05.10, APK на
       S25: долгое нажатие открывало меню, как тап, и выделения не было). Оно и есть наше долгое нажатие: ждёт таймер —
       сработать сейчас (`lpFire`); таймера нет (касание до ленты не дошло или его сняли) — то же, что сделал бы он:
       меню у пузыря (10.10: и в ЛС с пачкой; протяжки тогда нет — касание не наше). В браузере телефона долгого нажатия у
       ленты нет — меню, как было. */
    /* Удержание пальцем по ссылке в тексте (07.10) — меню ссылки: ждёт таймер — сработать сейчас (`lpFire` уже знает про
       ссылку); нет — открыть самим. И в браузере телефона: там это было бы меню браузера. */
    if (touch && more?.link && more.linkRect) {
      const fire = lpFire.current;
      if (fire) return fire();
      swipeDrop();
      openLinkMenu(m, more.link, more.linkRect);
      return;
    }
    if (touch && isMobile()) {
      const fire = lpFire.current;
      if (fire) return fire();
      swipeDrop();
      navigator.vibrate?.(8);
      const at = rowOf(m.id);
      // 10.10: и в ЛС с пачкой — меню у пузыря (выбор — пунктом «Выбрать» или протяжкой, `startMenuRange`).
      if (at) openMsgMenuAt(m, at, photo, more);
      return;
    }
    const row = narrowWindow() ? rowOf(m.id) : null;
    if (row) openMsgMenuAt(m, row, photo, more);
    else setMsgMenu({ m, pos: { x, y }, photo, file: more?.file, link: more?.link, item: more?.item, quote: selectionQuote(m) ?? undefined });
  }

  /**
   * Тап по сообщению на телефоне (раунд 12, HANDOFF §5) — меню у пузыря. Открываем по `click`, а не по `touchend`: меню
   * слушает «клик мимо», и клик того же касания пришёл бы уже к открытому меню. Тап по ссылке, цитате, фото, аватару,
   * чипу реакции, голосовому, файлу, «Переслано от» делает своё (`TAP_OWN`); в ЛС меню открывает только сам пузырь, в
   * канале — всё сообщение.
   */
  function onRowTap(e: React.MouseEvent<HTMLElement>, m: Message) {
    if (recording) return; // см. openMsgMenu
    if (selecting || e.defaultPrevented) return;
    const t = e.target as Element;
    // Палец ли — по самому нажатию (у `click` в Chromium есть `pointerType`), не сказано — по указателю устройства.
    if (!phoneTaps(pressByTouch(e.nativeEvent))) {
      /* Мышь (07.10, сверка 01·4.02): щелчок по ВРЕМЕНИ сообщения выделяет его — быстрый вход в режим выделения, как у
         Telegram Desktop; дальше щелчки по другим строкам добавляют (`onPick`). Только где выделение есть (`batchOn`).
         Время поверх фото на ПК «прозрачно» для мыши (`pointer-events: none`, клик идёт к фото) — тут не срабатывает. */
      if (batchOn && t.closest('.bub-meta')) startSelection(m);
      return;
    }
    if (t.closest(TAP_OWN) || (bubbles && !t.closest('.message-main'))) return;
    const row = e.currentTarget;
    /* Быстрая реакция двойным тапом (07.10, Telegram Android 3.06 / GA-10): где она возможна, меню по одиночному тапу
       ждёт окно двойного тапа (`DOUBLE_TAP_MS`) — второй тап по тому же пузырю ставит или снимает быструю реакцию, и меню
       не открывается. Где невозможна (каналы, правка этой строки) — меню сразу, как было. Сразу и тогда, когда клику не
       предшествовало касание этого пузыря (`fingerTap`): клавиатура, TalkBack, программный клик двойного тапа не дают —
       ждать им нечего. */
    if (!quickReactable(m) || !fingerTap(m)) {
      dropTap();
      openMsgMenuAt(m, row);
      return;
    }
    const step = doubleTapStep(tapWait.current, { kind: 'tap', id: m.id, at: performance.now() });
    dropTap();
    if (step.act === 'double' || !step.pending) {
      quickReact(m);
      return;
    }
    tapWait.current = { ...step.pending, m, row, timer: window.setTimeout(() => tapConfirm.current(), DOUBLE_TAP_MS) };
  }

  // ─── Быстрая реакция двойным тапом / двойным кликом и окно «кто поставил» (07.10, ЛС) ─────────────────────────────

  /**
   * Что делает двойной клик (ПК) и двойной тап (телефон) — G45, `quickReaction.ts`: «реакция» (по умолчанию), «ответ» или
   * «ничего». Живая настройка: смена в «Настройках» действует сразу, без перезагрузки ленты.
   */
  const dblAction = useDoubleClickAction();
  /** Быстрая реакция для полос реакций меню и листа сообщения: стоит в них первой (`quickBarOrder`). */
  const quickNow = useQuickReaction();

  /**
   * Сработает ли двойной клик по сообщению: лента ЛС с пузырями (раунд 12), не выделение и не правка этой строки; «реакция» —
   * ещё и реакции разрешены, «ответ» — вместо поля нет плашки (`composerReplacement`), «ничего» — нигде (одиночный тап на
   * телефоне открывает меню сразу, двойной клик на ПК выделяет слово как обычно).
   */
  function quickReactable(m: Message): boolean {
    if (!bubbles || selecting) return false;
    if (dblAction === 'react') return !!onReact;
    if (dblAction === 'reply') return !composerReplacement;
    return false;
  }

  /** Двойной клик: «реакция» — поставить быструю или снять, если моя такая уже стоит (`quickReactOp`); «ответ» — ответить на сообщение. */
  function quickReact(m: Message) {
    if (getDoubleClickAction() === 'reply') {
      startReply(m);
      return;
    }
    const quick = getQuickReaction();
    onReact?.(m.id, quick, quickReactOp(m.reactions, quick));
  }

  /** Первый тап по пузырю ждёт второго (`doubleTapStep`): сообщение и строка — чтобы открыть меню, если второго не будет. */
  const tapWait = useRef<(PendingTap & { m: Message; row: HTMLElement; timer: number | null }) | null>(null);
  function dropTap() {
    const p = tapWait.current;
    if (p?.timer != null) window.clearTimeout(p.timer);
    tapWait.current = null;
  }
  /** Последнее касание пузыря пальцем (`touchstart`): клик без него — не палец (клавиатура, TalkBack, программный). */
  const lastTouch = useRef<{ id: string; at: number } | null>(null);
  /** Клик — конец касания этого же пузыря: палец лёг на него недавно (короче долгого нажатия с запасом — 1 с). */
  function fingerTap(m: Message): boolean {
    const t = lastTouch.current;
    return !!t && t.id === m.id && performance.now() - t.at < 1000;
  }
  /** Палец коснулся пузыря, пока первый тап ждёт: второе касание — меню по таймеру не открывать; другое — первый тап гаснет. */
  function tapDown(m: Message) {
    lastTouch.current = { id: m.id, at: performance.now() };
    const p = tapWait.current;
    if (!p) return;
    const step = doubleTapStep(p, { kind: 'down', id: m.id, at: performance.now() });
    if (!step.pending) return dropTap();
    if (p.timer != null) window.clearTimeout(p.timer);
    tapWait.current = { ...p, ...step.pending, timer: null };
  }
  /** Окно двойного тапа вышло без второго касания — одиночный тап: меню у пузыря (свежие состояния — через ref). */
  const tapConfirm = useRef<() => void>(() => {});
  tapConfirm.current = () => {
    const p = tapWait.current;
    tapWait.current = null;
    if (!p || p.second || selecting || !p.row.isConnected) return;
    openMsgMenuAt(p.m, p.row);
  };
  useEffect(() => () => dropTap(), []);

  /** Второе нажатие двойного клика мышью (`e.detail === 2`) мимо текста пузыря — реакцию готовим, слово не выделяем. */
  const dblArm = useRef<string | null>(null);
  function onRowPress(e: React.MouseEvent<HTMLElement>, m: Message) {
    if (e.detail !== 2 || e.button !== 0) {
      if (e.detail < 2) dblArm.current = null;
      return;
    }
    dblArm.current = null;
    if (pressByTouch(e.nativeEvent) === true || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || !quickReactable(m)) return;
    const t = e.target as Element;
    // Ссылка, кнопка, фото, поле — своё (у Telegram — «не по ссылке и не по кнопке»); по тексту — выделение слова.
    if (t.closest(TAP_OWN) || !t.closest('.message-main') || overMessageText(e.clientX, e.clientY, e.currentTarget)) return;
    e.preventDefault();
    dblArm.current = m.id;
  }
  /** Двойной клик мышью мимо текста пузыря (07.10, ПК; Telegram Desktop MS-07, «Реакция по двойному нажатию»). */
  function onRowDouble(e: React.MouseEvent<HTMLElement>, m: Message) {
    const armed = dblArm.current === m.id;
    dblArm.current = null;
    if (!armed || e.button !== 0 || !quickReactable(m)) return;
    quickReact(m);
  }

  /**
   * Окно «кто поставил» (07.10; Telegram 3.30 — ПКМ по чипу на ПК, 3.31 — долгий тап по чипу на Android): правый клик —
   * у точки; палец (системное долгое нажатие приходит `contextmenu`) и узкое окно — у чипа. Клик того же касания, если
   * браузер его соберёт, глотаем до подъёма пальца (`holdNextClick`): иначе он переключил бы реакцию чипа.
   */
  function openWho(e: React.MouseEvent<HTMLElement>, m: Message, r: ReactionGroup) {
    e.preventDefault();
    e.stopPropagation();
    if (selecting || !r.reactors?.length) return;
    const touch = pressByTouch(e.nativeEvent) === true;
    if (touch) {
      const release = holdNextClick();
      const lift = () => {
        window.removeEventListener('touchend', lift, true);
        window.removeEventListener('touchcancel', lift, true);
        release();
      };
      window.addEventListener('touchend', lift, true);
      window.addEventListener('touchcancel', lift, true);
      navigator.vibrate?.(8);
    }
    dropTap();
    setMsgMenu(null);
    const chip = e.currentTarget.getBoundingClientRect();
    setWho(
      touch || narrowWindow()
        ? { id: m.id, emoji: r.emoji, anchor: chip }
        : { id: m.id, emoji: r.emoji, pos: { x: e.clientX, y: e.clientY } },
    );
  }
  // Сообщение ушло из ленты или вошли в выделение — окно «кто прочитал» долой.
  useEffect(() => {
    if (seen && (selecting || !messages.some((x) => x.id === seen.id))) setSeen(null);
  }, [seen, messages, selecting]);
  // Реакцию сняли (у обоих — некого показать), сообщение ушло из ленты, вошли в выделение — окно «кто поставил» долой.
  useEffect(() => {
    if (!who) return;
    const m = messages.find((x) => x.id === who.id);
    if (selecting || !m?.reactions?.some((x) => x.emoji === who.emoji && x.reactors?.length)) setWho(null);
  }, [who, messages, selecting]);

  function openOutMenuAt(key: string, row: HTMLElement) {
    outMenuRow.current = row;
    const bubble = bubbleSpot(row, true);
    setOutMenu({ key, pos: { x: bubble.anchor.left, y: bubble.anchor.top }, bubble });
  }

  /** Правый клик по неотправленному: меню у точки, как было; раунд 12 в узком окне — у пузыря; в выделении — ничего. */
  function openOutMenu(key: string, e: React.MouseEvent<HTMLElement>) {
    if (selecting) return;
    if (narrowWindow()) openOutMenuAt(key, e.currentTarget);
    else setOutMenu({ key, pos: { x: e.clientX, y: e.clientY } });
  }

  /**
   * Тап по неотправленному пузырю на телефоне (раунд 12) — его меню у пузыря, как у остальных сообщений. В режиме
   * выделения меню по тапу нет (HANDOFF §6), а неотправленное не выбирается.
   */
  function onOutTap(e: React.MouseEvent<HTMLElement>, key: string) {
    if (selecting || e.defaultPrevented || !phoneTaps(pressByTouch(e.nativeEvent)) || (e.target as Element).closest(TAP_OWN))
      return;
    openOutMenuAt(key, e.currentTarget);
  }

  /** «Изменить» (меню, кнопка у строки, клавиша E): правка в основном поле ввода — везде, и пальцем, и мышью (решение 31, как Telegram). */
  function editFromMenu(m: Message) {
    if (readOnly) return;
    startComposerEdit(m);
  }

  /**
   * 🔴 «Приложить к жалобе» — только у сообщений ГОСТЯ и только тому, кто вправе банить. Жалоба уходит держателю ЧУЖОГО
   * инстанса, и прикладывать к ней переписку своих людей незачем и не за что. Сообщения выбираются руками по одному:
   * сервер сам чужому инстансу чат не отдаёт (§5.11).
   */
  function attachToReport(m: Message) {
    const ok = addEvidence(m.author.id, {
      messageId: m.id,
      text: m.content,
      at: new Date(m.createdAt).getTime(),
      // Название канала — это `title` панели: у соседа наших каналов нет, и строка «#общий» — единственное, что ему о них
      // скажет.
      channel: typeof title === 'string' ? title : '',
    });
    toast(
      ok ? 'info' : 'error',
      ok ? 'Сообщение приложено к жалобе' : `Больше ${EVIDENCE_MAX} сообщений приложить нельзя`,
      ok ? 'Отправится, когда вы забаните этого человека с галочкой «Пожаловаться».' : undefined,
    );
  }

  /* Меню у пузыря держится за свою строку (раунд 12): лента сдвинулась кодом (подгрузка, переход, своё отправленное) или
     окно сменило размер (на телефоне спряталась клавиатура — от того же тапа) — меню НЕ закрывается, а встаёт заново у
     того же пузыря: якорь и полоса пересчитываются от элемента строки. Закрывает его только прокрутка человеком
     (`ContextMenu`). Строки больше нет (сообщение удалили, ушли в другую ленту) — меню закрываем. */
  const bubbleMenuKey = msgMenu?.bubble ? `m:${msgMenu.m.id}` : outMenu?.bubble ? `o:${outMenu.key}` : null;
  const followBubble = useRef<() => void>(() => {});
  followBubble.current = () => {
    if (msgMenu?.bubble) {
      const row = rowOf(msgMenu.m.id);
      if (!row) return setMsgMenu(null);
      const next = bubbleSpot(row, msgMenu.m.author.id === meId);
      if (!sameSpot(msgMenu.bubble, next)) setMsgMenu({ ...msgMenu, bubble: next });
    } else if (outMenu?.bubble) {
      const row = outMenuRow.current;
      if (!row?.isConnected) return setOutMenu(null);
      const next = bubbleSpot(row, true);
      if (!sameSpot(outMenu.bubble, next)) setOutMenu({ ...outMenu, bubble: next });
    }
  };
  useEffect(() => {
    if (!bubbleMenuKey) return;
    const list = listRef.current;
    let frame = 0;
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        followBubble.current();
      });
    };
    window.addEventListener('resize', soon);
    window.visualViewport?.addEventListener('resize', soon);
    list?.addEventListener('scroll', soon, { passive: true });
    // Строка выросла (пришла чужая реакция, догрузилась картинка) или лента сменила высоту (поле ввода, клавиатура).
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
    if (list) ro?.observe(list);
    const row = bubbleMenuKey.startsWith('m:') ? rowOf(bubbleMenuKey.slice(2)) : outMenuRow.current;
    if (row) ro?.observe(row);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', soon);
      window.visualViewport?.removeEventListener('resize', soon);
      list?.removeEventListener('scroll', soon);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- строку ищем заново на каждое событие (followBubble)
  }, [bubbleMenuKey]);

  // Меню у пузыря закрыли — лента прилипает к низу, если просила, пока оно было открыто (`holdFeedRef`).
  const holdFeed = !!(msgMenu?.bubble || outMenu?.bubble);
  holdFeedRef.current = holdFeed;
  useEffect(() => {
    if (holdFeed || !stickAfterMenu.current) return;
    stickAfterMenu.current = false;
    if (nearBottomRef.current) stickDown();
  }, [holdFeed]);
  /* Строка меню у пузыря пропала из ленты (сообщение удалили, неотправленное ушло повтором с другого места) — меню
     закрываем: иначе его состояние висело бы и дальше держало ленту от прилипания к низу. Событий прокрутки при этом может
     и не быть, поэтому — по смене ленты, после того как разметка уже обновлена. */
  useEffect(() => {
    if (msgMenu?.bubble && !rowOf(msgMenu.m.id)) setMsgMenu(null);
    else if (outMenu?.bubble && !outMenuRow.current?.isConnected) setOutMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowOf читает DOM ленты
  }, [messages, outbox?.items, outgoing, msgMenu, outMenu]);

  /* Клавиши меню сообщения нового вида (раунд 12): подсказок R / E / Del в пунктах больше нет, как в макете, а сами клавиши
     работают — R ответить, E изменить своё, Del удалить. По месту клавиши (`code`): в русской раскладке R — это «к». В
     поле ввода это буквы, не команды. */
  const keyedMenu = msgMenu;
  useEffect(() => {
    if (!keyedMenu) return;
    const m = keyedMenu.m;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
      const what = e.code === 'KeyR' ? 'reply' : e.code === 'KeyE' ? 'edit' : e.code === 'Delete' ? 'delete' : null;
      if (!what) return;
      if (what === 'edit' && (m.author.id !== meId || m.forwardedFrom)) return;
      if (what === 'delete' && !canDelete(m)) return;
      e.preventDefault();
      setMsgMenu(null);
      if (what === 'reply') startReply(m);
      else if (what === 'edit') editFromMenu(m);
      else void del(m);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- одно меню — одно сообщение; обработчики берём при открытии
  }, [keyedMenu?.m]);

  // ─── Раунд 12, порция 5: выделение, пересылка, удаление пачкой (только с действиями пачкой — `batchOn`) ───────────────

  /** Войти в режим выделения с этим сообщением: долгое нажатие (телефон) или «Выделить» в меню (ПК). */
  function startSelection(m: Message) {
    keepRowOnSelect(m.id);
    setMsgMenu(null);
    setPicker(null);
    setPicked([m.id]);
  }

  /* Вход в выделение прячет поле ввода вместе с полосой ответа, прикреплённым и записью — на их месте панель выделения,
     и лента внизу вырастает на разницу (с полосой ответа — на 33 px). У низа ленты прокручивать дальше некуда: браузер
     прижимал прокрутку, строки съезжали под неподвижным указателем, и удержание или протяжка мышью брали лишнюю строку
     (общая проверка 05.10). Держим строку входа на её месте: до входа запоминаем, где она, после — возвращаем прокруткой, а
     недостающее у низа добирает пустое место под последней строкой (`bottomRef`) на время выделения. */
  const selKeep = useRef<{ id: string; top: number } | null>(null);
  function keepRowOnSelect(id: string) {
    if (selecting) return;
    const row = rowOf(id);
    selKeep.current = row ? { id, top: row.getBoundingClientRect().top } : null;
  }
  useLayoutEffect(() => {
    const keep = selKeep.current;
    selKeep.current = null;
    const list = listRef.current;
    const pad = bottomRef.current;
    if (!list || !pad) return;
    if (!selecting) {
      pad.style.height = '';
      return;
    }
    const row = keep ? rowOf(keep.id) : null;
    if (!keep || !row) return;
    const shift = row.getBoundingClientRect().top - keep.top;
    if (Math.abs(shift) < 1) return;
    const want = list.scrollTop + shift;
    const room = list.scrollHeight - list.clientHeight;
    if (want > room) pad.style.height = `${Math.ceil(want - room)}px`;
    list.scrollTop = want;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowOf читает только DOM ленты
  }, [selecting]);

  /* «⋯» в шапке выделения (`menuPicked`): меню сообщения — когда выделение уже снято, поле вернулось и строка встала на
     место (эффект выше уже отработал, кадр ещё не нарисован). */
  const menuAfterSelect = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = menuAfterSelect.current;
    if (selecting || !id) return;
    menuAfterSelect.current = null;
    const m = messages.find((x) => x.id === id);
    const row = rowOf(id);
    // Одно фото в сообщении — и пункты фото («Копировать изображение», «Сохранить…»), как у тапа по подписи.
    if (m && row) openMsgMenuAt(m, row, photoFromTouch(m.attachments, null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сообщение и строку ищем в момент выхода из выделения
  }, [selecting]);

  function dropPicks() {
    setPicked(NO_PICKS);
  }

  /**
   * Нажатие по строке в режиме выделения (или пробел / Enter на самой строке) — переключить её; снято последнее —
   * выделение кончилось. Нажатие гасим целиком: ссылка, цитата, фото, чип реакции в строке своего не делают.
   */
  /** Встряска счётчика «Выбрано N» на попытке добавить 101-е (`.sel-count.shake`), пока играет — ставится заново. */
  const [selShake, setSelShake] = useState(0);
  const selShakeTimer = useRef<number | undefined>(undefined);
  function shakeSelCount() {
    navigator.vibrate?.(200);
    setSelShake(1);
    window.clearTimeout(selShakeTimer.current);
    selShakeTimer.current = window.setTimeout(() => setSelShake(0), SEL_SHAKE_MS);
  }
  useEffect(() => () => window.clearTimeout(selShakeTimer.current), []);
  function onPick(e: React.MouseEvent | React.KeyboardEvent, m: Message) {
    if (!selecting) return;
    // С клавиатуры — только на самой строке: Enter на кнопке внутри неё нажимает кнопку, а её нажатие уже переключит строку.
    if ('key' in e && ((e.key !== ' ' && e.key !== 'Enter') || e.target !== e.currentTarget)) return;
    e.preventDefault();
    e.stopPropagation();
    // 101-е не добавляем: счётчик встряхивается и телефон вибрирует 200 мс (Telegram Android `ChatActivity` при `selectedMessagesIds ≥ 100`).
    if (picked.length >= SELECT_MAX && !picked.includes(m.id)) {
      shakeSelCount();
      return;
    }
    setPicked((p) => {
      // Больше `SELECT_MAX` не выбрать (предел пачки сервера; Telegram молча не добавляет — и мы).
      if (!p.includes(m.id)) return p.length < SELECT_MAX ? [...p, m.id] : p;
      const rest = p.filter((x) => x !== m.id);
      return rest.length ? rest : NO_PICKS;
    });
  }

  /* ─── Выделение мышью (замечание владельца 05.10): удержание ЛКМ и протяжка рядом с сообщениями ─────────────────────────
     Правила и пороги — `dmSelection.ts` (`selectPress` — что начинает нажатие, `selectRowAt` / `selectRange` — диапазон,
     `selectScrollStep` — автопрокрутка у края). По самому пузырю жеста нет — там браузер выделяет текст (второе замечание
     05.10). Жест живёт в ref и слушателях окна; React трогаем, только когда сменилась строка под указателем. Только мышь и
     только там, где есть выделение (`batchOn`: пузыри ЛС за переключателем, `conv5`). */
  const selMouse = useRef<SelGesture | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  /** Действия над выбранным для клавиш (Ctrl+C, Delete): слушатель окна живёт от входа до выхода из выделения, а выбранное меняется. */
  const selActs = useRef({ copy: () => {}, del: () => {} });

  /* ─── Перетаскивание сообщений (G76; Telegram Desktop `HistoryInner::performDrag`) ───────────────────────────────────────
     Сообщение тянут мышью за пузырь вне текста, ссылки и картинки (там браузер сам: выделение текста, адрес, файл) или, в
     режиме выделения, за любую выбранную строку — тогда уходит всё выбранное. Строка становится `draggable` только на время
     нажатия, иначе мышь не выделяла бы текст. В `DataTransfer` — текст, файл (`DownloadURL`, Chromium) и свой тип для броска
     на строку беседы (`dragOut.ts`). Выделение протяжкой по невыбранным строкам и по полям вокруг — прежнее. */

  /**
   * Нажатие, с которого может начаться перетаскивание: строка взводится (`draggable`). Жест выделения (ниже) при этом начинается
   * как обычно — его `dragstart`-страж (`drag`) пропускает взведённую строку и сам отменяет жест.
   */
  function armMsgDrag(e: React.PointerEvent<HTMLDivElement>, t: Element): void {
    if (!batchOn || e.pointerType !== 'mouse' || e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (msgMenu || selMenu || outMenu || picker || fwdIds || selMouse.current) return;
    const row = t.closest<HTMLElement>('.message[data-mid]');
    const id = row?.dataset.mid;
    if (!row || !id) return;
    const own = !!t.closest('.msg-actions, .bub-ava, .msg-ava, input, textarea, select, [contenteditable], .bub-fail, button:not(.att-img-link), .reactions');
    if (selecting ? !pickedRef.current.includes(id) || own : !t.closest('.message-main') || !grabsMessage({ text: !!t.closest('.message-body') && !t.closest('.bub-meta'), link: !!t.closest('a[href]'), image: !!t.closest('img'), own }))
      return;
    row.draggable = true;
    const off = () => {
      row.removeAttribute('draggable');
      window.removeEventListener('pointerup', off, true);
      window.removeEventListener('pointercancel', off, true);
      window.removeEventListener('dragend', off, true);
    };
    window.addEventListener('pointerup', off, true);
    window.addEventListener('pointercancel', off, true);
    window.addEventListener('dragend', off, true);
  }

  /** `dragstart` в ленте: наполнить `DataTransfer`. Выделенный текст (цель — текстовый узел) браузер кладёт сам. */
  function onMsgDragStart(e: React.DragEvent<HTMLDivElement>) {
    const t = e.target;
    if (!batchOn || !(t instanceof Element) || selMouse.current) return;
    const row = t.closest<HTMLElement>('.message[data-mid]');
    const rid = row?.dataset.mid;
    if (!row || !rid) return;
    const ownRow = t === row;
    const media = t.closest('img, a[href]');
    if (!ownRow && !media) return;
    const ids = dragIds(rid, pickedRef.current, messages.map((x) => x.id), selecting);
    if (!ids) {
      e.preventDefault();
      return;
    }
    const idSet = new Set(ids);
    const list = messages.filter((x) => idSet.has(x.id));
    if (list.length === 0) return;
    const dt = e.dataTransfer;
    // Файл наружу: ровно одно сообщение; вложение — то, на которое нажали (картинка, карточка файла), либо единственное.
    let att = list.length === 1 && list[0].attachments?.length === 1 ? list[0].attachments[0] : undefined;
    if (list.length === 1 && media && (list[0].attachments?.length ?? 0) > 0) {
      const abs = (u: string) => new URL(u, location.href).href;
      const src = media instanceof HTMLImageElement ? media.currentSrc || media.src : (media as HTMLAnchorElement).href;
      att = list[0].attachments?.find((a) => a.url && (abs(a.url) === src || abs(api.attachmentDownloadUrl(a)) === src));
    }
    // Э3 (#141): вложение, чья копия ещё едет, наружу не тащится — отдача ответила бы 503.
    const dl = att?.url && att.fedState !== 'copying' ? downloadUrlValue(att.contentType, att.name, api.attachmentDownloadUrl(att), location.href) : null;
    const text = pickedCopyText(list, idSet);
    // Обычная ссылка из текста: адрес как текст кладёт браузер (так же у Telegram — ссылка тащится ссылкой), мы лишь добавляем свой тип.
    const plainLink = !ownRow && !att && media instanceof HTMLAnchorElement;
    if (text && !plainLink) dt.setData('text/plain', text);
    if (dl && att) {
      dt.setData('DownloadURL', dl);
      dt.setData('text/uri-list', new URL(api.attachmentDownloadUrl(att), location.href).href);
    }
    dt.setData(DRAG_MSG_MIME, encodeMsgDrag({ conv: list[0].channelId, ids }));
    dt.effectAllowed = 'copy';
    const bub = row.querySelector<HTMLElement>('.message-main');
    if (ownRow && bub) {
      const r = bub.getBoundingClientRect();
      dt.setDragImage(bub, Math.max(0, e.clientX - r.left), Math.max(0, e.clientY - r.top));
    }
  }

  /** Бросок сообщений на строку беседы в списке (`DmSidebar`): черновик пересылки в эту беседу (08.10). */
  useEffect(
    () =>
      onForwardDrop((p, to) => {
        if (!batchOn || !p.ids.every((id) => messages.some((x) => x.id === id))) return;
        // Как у Telegram Desktop (`DialogsInner::dropEvent` → `setForwardDraft`): беседа с черновиком пересылки.
        startFwdDraft(to, p.ids, null);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- обработчик читает ленту и пересылку на момент броска
    [messages, batchOn],
  );

  /** Нажатие в ленте (`.messages`): начать ли выделение мышью и какое (`selectPress`); дальше жест ведут слушатели окна. */
  function onSelPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const list = e.currentTarget;
    const t = e.target as Element;
    // Порталы строк (окно «Открыть ссылку?» у ссылки) всплывают сюда по дереву React, а в ленте их нет.
    if (!list.contains(t)) return;
    armMsgDrag(e, t);
    const kind = selectPress({
      mouse: e.pointerType === 'mouse' && e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey,
      // Открыто меню, пикер или окно — нажатие только закрывает их (как у Telegram).
      canSelect: !!batchOn && !msgMenu && !selMenu && !outMenu && !picker && !fwdIds && !selMouse.current,
      selecting,
      // По самому пузырю — выделение текста браузером, жеста нет (вне режима выделения).
      bubble: !!t.closest('.message[data-mid] .message-main'),
      own:
        !!t.closest('.msg-actions, .bub-ava, input, textarea, select, [contenteditable], .bub-fail') ||
        // Строка «в пути»: у неё ещё нет id, выбрать её нельзя.
        (!!t.closest('.message') && !t.closest('.message[data-mid]')) ||
        // Полоса прокрутки ленты: нажатие по ней приходит в саму ленту.
        (t === list && e.clientX >= list.getBoundingClientRect().left + list.clientLeft + list.clientWidth),
    });
    if (!kind) return;
    const rows = rowsOf(list);
    const row = t.closest<HTMLElement>('.message[data-mid]');
    // Рядом со строками (поле ленты, дневная метка) — ближайшая строка.
    const at = row ? [...rows].indexOf(row) : selectRowAt(rows.length, (i) => rows[i].getBoundingClientRect(), e.clientY, -1);
    const from = at >= 0 ? rows[at].dataset.mid : undefined;
    if (!from) return;
    const g: SelGesture = {
      list,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from,
      base: pickedRef.current,
      add: true,
      on: false,
      held: false,
      dead: false,
      px: e.clientX,
      py: e.clientY,
      at: null,
      timer: null,
      frame: 0,
      tick: 0,
      rest: 0,
      off: () => {},
      touch: false,
      moved: true,
    };
    selMouse.current = g;
    // Строки тянут — текст не выделяется (и прежнее выделение текста снимается, как от щелчка).
    selNoText(true);
    // Удержание — только вне выделения: в нём щелчок и так переключает строку.
    if (!selecting) g.timer = window.setTimeout(() => selHold(g), SELECT_HOLD_MS);
    const move = (ev: PointerEvent) => selMove(g, ev);
    const up = (ev: PointerEvent) => {
      if (ev.pointerType === 'mouse') selEnd(g, ev.type === 'pointerup');
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') selEscape(g, ev);
    };
    const lose = () => selEnd(g, false);
    // Картинку и ссылку не тащить: протяжка выделяет строки.
    // Исключение — строка, взведённая под перетаскивание (`armMsgDrag`: выбранная строка в выделении): тянется пачка, жест кончается.
    const drag = (ev: DragEvent) => {
      if (ev.target instanceof Element && ev.target.matches('.message[data-mid][draggable="true"]')) selEnd(g, false);
      else ev.preventDefault();
    };
    const scroll = () => {
      if (g.on && !g.dead) selTrack(g);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', lose);
    window.addEventListener('dragstart', drag, true);
    list.addEventListener('scroll', scroll, { passive: true });
    g.off = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', lose);
      window.removeEventListener('dragstart', drag, true);
      list.removeEventListener('scroll', scroll);
    };
  }

  /**
   * Текст на время жеста не выделяется нигде (класс `gv-sel-drag` на `<html>`, CSS — блок «Раунд 12» §3): иначе браузер
   * вёл бы своё выделение текста за указателем. Уже выделенный текст снимается — как от обычного щелчка мимо.
   */
  function selNoText(on: boolean) {
    document.documentElement.classList.toggle('gv-sel-drag', on);
    const s = on ? window.getSelection() : null;
    if (s && !s.isCollapsed) s.removeAllRanges();
  }

  /** Протяжка (или удержание) началась: выбранные до неё — основа, а строка нажатия решает, добавлять или снимать. */
  function selStart(g: SelGesture) {
    g.on = true;
    if (g.timer !== null) window.clearTimeout(g.timer);
    g.timer = null;
    g.base = pickedRef.current;
    g.add = !g.base.includes(g.from);
    selNoText(true);
    try {
      g.list.setPointerCapture(g.pointerId);
    } catch {
      // Указатель уже отпущен — захватывать нечего.
    }
    // Вход в выделение — как из меню «Выделить»: меню и пикер закрываются (правка в поле ждёт выхода из выделения).
    if (!g.base.length) {
      keepRowOnSelect(g.from);
      setMsgMenu(null);
      setPicker(null);
    }
  }

  /** Удержание сработало (`SELECT_HOLD_MS` без сдвига): строка нажатия выбрана, отпускание уже не щелчок. */
  function selHold(g: SelGesture) {
    g.timer = null;
    if (selMouse.current !== g || g.on) return;
    g.held = true;
    selStart(g);
    g.at = g.from;
    selApply(g, g.from);
  }

  /** Выбранные — заново от основы: диапазон от строки нажатия до `to` (`selectRange`). */
  function selApply(g: SelGesture, to: string | null) {
    const list = listRef.current;
    if (!list) return;
    const order = [...rowsOf(list)].map((r) => r.dataset.mid ?? '');
    const next = selectRange(order, g.base, g.from, to, g.add);
    setPicked(next.length ? next : NO_PICKS);
  }

  /** Строка под указателем (за краем ленты — крайняя видимая, как у Telegram); сменилась — пересчитать выбранные. */
  function selTrack(g: SelGesture) {
    const list = listRef.current;
    if (!list) return;
    const rows = rowsOf(list);
    let start = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].dataset.mid === g.from) {
        start = i;
        break;
      }
    }
    // Строка нажатия ушла из окна ленты — диапазон больше не считаем, выбранное остаётся.
    if (start < 0) return;
    const box = list.getBoundingClientRect();
    const y = Math.min(Math.max(g.py, box.top + 1), box.bottom - 1);
    const at = selectRowAt(rows.length, (i) => rows[i].getBoundingClientRect(), y, start);
    const to = at >= 0 && (g.held || selectStartIn(at, start, g.py - g.y)) ? (rows[at].dataset.mid ?? null) : null;
    if (to === g.at) return;
    g.at = to;
    selApply(g, to);
  }

  function selMove(g: SelGesture, ev: PointerEvent) {
    if (selMouse.current !== g || ev.pointerType !== 'mouse') return;
    // Кнопку отпустили там, где отпускание не дошло, или нажали ещё одну — жест кончился.
    if (ev.buttons !== 1) {
      selEnd(g, ev.buttons === 0);
      return;
    }
    g.px = ev.clientX;
    g.py = ev.clientY;
    if (g.dead) return;
    if (!g.on) {
      if (!selectSlopPassed(g.px - g.x, g.py - g.y)) return;
      selStart(g);
    }
    selTrack(g);
    selScrollKick(g);
  }

  /** Шаг автопрокрутки: мышь — за краем ленты, палец (G43) — в зоне 56 px у края (`selectTouchScrollStep`). */
  function scrollStepOf(g: SelGesture, box: DOMRect): number {
    return g.touch ? selectTouchScrollStep(g.py, box.top, box.bottom) : selectScrollStep(g.py, box.top, box.bottom);
  }

  /** Указатель за краем ленты — автопрокрутка кадрами (`selectScrollStep`, шаг — на такт Telegram 15 мс). */
  function selScrollKick(g: SelGesture) {
    const list = listRef.current;
    if (!list || g.frame || g.dead) return;
    const box = list.getBoundingClientRect();
    if (!scrollStepOf(g, box)) return;
    g.tick = performance.now();
    g.rest = 0;
    g.frame = requestAnimationFrame(() => selScrollFrame(g));
  }

  function selScrollFrame(g: SelGesture) {
    g.frame = 0;
    const list = listRef.current;
    if (selMouse.current !== g || !g.on || g.dead || !list) return;
    const box = list.getBoundingClientRect();
    const step = scrollStepOf(g, box);
    if (!step) return;
    const now = performance.now();
    // Шаг — на такт 15 мс, кадр бывает и 7 мс (144 Гц): копим долю пикселя, а не теряем её на округлении.
    g.rest += step * Math.min(4, (now - g.tick) / SELECT_SCROLL_TICK_MS);
    g.tick = now;
    const whole = Math.trunc(g.rest);
    g.rest -= whole;
    if (whole) list.scrollTop += whole;
    selTrack(g);
    g.frame = requestAnimationFrame(() => selScrollFrame(g));
  }

  /** Esc посреди протяжки — вернуть выбранное, как было до неё; дальше жест молчит до отпускания (щелчок проглотится). */
  function selEscape(g: SelGesture, ev: KeyboardEvent) {
    if (selMouse.current !== g) return;
    if (!g.on) {
      selEnd(g, false);
      return;
    }
    if (g.dead) return;
    ev.preventDefault();
    ev.stopPropagation();
    g.dead = true;
    if (g.frame) cancelAnimationFrame(g.frame);
    g.frame = 0;
    setPicked(g.base.length ? g.base : NO_PICKS);
  }

  /** Конец жеста. Отпустили кнопку (`released`) после удержания или протяжки — щелчок этого нажатия глотаем. */
  function selEnd(g: SelGesture, released: boolean) {
    if (selMouse.current !== g) return;
    selMouse.current = null;
    g.off();
    if (g.timer !== null) window.clearTimeout(g.timer);
    g.timer = null;
    if (g.frame) cancelAnimationFrame(g.frame);
    g.frame = 0;
    selNoText(false);
    try {
      if (!g.touch && g.list.hasPointerCapture(g.pointerId)) g.list.releasePointerCapture(g.pointerId);
    } catch {
      // Ленты уже нет — и захвата тоже.
    }
    if (released && g.on) swallowNextClick();
  }

  // Лента уходит посреди жеста — снять слушатели окна и класс с <html>.
  useEffect(
    () => () => {
      const g = selMouse.current;
      if (g) selEnd(g, false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selEnd читает только ref и DOM
    [],
  );

  /* В выделении (HANDOFF §6): выйти — «назад» на Android, крестик на месте «назад» в шапке телефона (`MainLayout`, через
     `dmSelection.ts`), Esc на ПК. Esc молчит, если поверх ленты окно или слой («Переслать в…», подтверждение удаления):
     его закрывает их Esc. Выбранные — только сохранённые сообщения, их меню и долгое нажатие на это время выключены. */
  useEffect(() => {
    if (!selecting) return;
    const release = holdSelection(() => setPicked(NO_PICKS));
    const back = pushBackHandler(() => {
      const s = useStore.getState();
      if (s.adminOpen || s.settingsOpen || s.mobileProfileOpen || s.mobileMembersOpen || s.mobilePane !== 'content')
        return false;
      setPicked(NO_PICKS);
      return true;
    });
    const onKey = (e: KeyboardEvent) => {
      /* Ctrl+C — скопировать выбранные, Delete / Backspace — «Удалить N?» (07.10, сверка 01·4.06 / 6.01; Telegram Desktop). */
      const what = selectionKey(e);
      if ((e.key !== 'Escape' && !what) || e.defaultPrevented) return;
      // Поверх ленты окно или слой — клавиши его, не наши (у Esc, Ctrl+C и Delete одно правило).
      if (document.querySelector(`[aria-modal="true"], ${TOP_LAYERS}`)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setPicked(NO_PICKS);
        return;
      }
      // Фокус в поле ввода, поиске или другом редактируемом — это буквы и штатное копирование, не команды; выделенный
      // браузером текст копируется как обычно.
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (what === 'copy' && window.getSelection()?.toString()) return;
      e.preventDefault();
      if (what === 'copy') selActs.current.copy();
      else selActs.current.del();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      release();
      back();
      window.removeEventListener('keydown', onKey);
    };
  }, [selecting]);

  /* Выбранное пропало из ленты (удалили — собеседник у обоих или я сам, окно ленты ушло дальше 300 сообщений) — из
     выделения его долой: переслать или скопировать его уже нельзя. Ничего не осталось — выделение кончилось. */
  useEffect(() => {
    if (!picked.length) return;
    const have = new Set(messages.map((x) => x.id));
    if (picked.every((id) => have.has(id))) return;
    setPicked((p) => {
      const rest = p.filter((id) => have.has(id));
      return rest.length ? rest : NO_PICKS;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сверяем по смене ленты
  }, [messages]);

  // Действий пачкой не стало (сервер без `conv5` после перехода) — и выделения нет.
  useEffect(() => {
    if (!batchOn) setPicked(NO_PICKS);
  }, [batchOn]);

  // Выделение кончилось — меню выделения (правый клик) закрывается вместе с ним.
  useEffect(() => {
    if (!selecting) setSelMenu(null);
  }, [selecting]);

  /** Плашка «Переслано» гаснет сама (HANDOFF §9); новый показ заводит таймер заново. */
  useEffect(() => {
    if (!fwdDone) return;
    const t = window.setTimeout(() => setFwdDone(null), FWD_DONE_MS);
    return () => window.clearTimeout(t);
  }, [fwdDone]);

  /** «Переслать» — из меню одного сообщения или из выделения: окно «Переслать в…» (`ForwardPicker`). */
  function openForward(ids: string[]) {
    if (!batchOn || ids.length === 0) return;
    setMsgMenu(null);
    setFwdIds(ids);
    setFwdItem(null);
  }

  /** G56: «Переслать» одного элемента альбома — то же окно «Переслать в…», без черновика и «позже». */
  function openForwardItem(m: Message, att: Attachment) {
    if (!batchOn?.forwardItem || !att.id) return;
    setMsgMenu(null);
    setFwdIds([m.id]);
    setFwdItem({ messageId: m.id, attachmentId: att.id });
  }

  /**
   * Беседа выбрана в «Переслать в…» — переслать сразу, без подтверждения (HANDOFF §9): окно закрывается само, выделение
   * снимается; дошло — плашка «Переслано: <имя>» с «Открыть», нет — тост, как у прочих ошибок. Пересылать можно и в эту
   * же беседу: она в списке остаётся, как у Telegram.
   */
  async function forwardMany(
    ids: string[],
    targets: string[],
    o: { silent: boolean; at: Date | null; comment: string; hideSender: boolean; hideCaptions: boolean },
    src: FwdDraft | null = null,
    item: { messageId: string; attachmentId: string } | null = null,
  ) {
    const b = batchOn;
    if (!b || targets.length === 0) return;
    setPicked(NO_PICKS);
    // Отложенное — только тексты, по порядку ленты (кнопка «Отправить позже» окна есть лишь при выборе одного текста).
    // `src` — «Изменить получателя» черновика пересылки: сообщения другой беседы, из снимка черновика.
    const idSet = new Set(ids);
    const texts = o.at ? (src?.messages ?? messages).filter((m) => idSet.has(m.id)).map((m) => m.content) : [];
    const done: string[] = [];
    // Беседы — по очереди, как Telegram (`ShareBox`: комментарий первым, затем пересланное): порядок в каждой беседе сохраняется.
    for (const to of targets) {
      try {
        if (o.at) {
          if (!b.later) throw new Error('Отправка позже недоступна');
          await b.later(to, o.comment ? [o.comment, ...texts] : texts, o.at, o.silent);
        } else {
          if (o.comment && b.comment) await b.comment(to, o.comment, o.silent);
          if (item && b.forwardItem) await b.forwardItem(item.messageId, item.attachmentId, to, o.silent, { hideSender: o.hideSender });
          else await b.forward(ids, to, o.silent, {
            hideSender: o.hideSender,
            hideCaptions: o.hideCaptions,
            ...(src ? { from: src.from } : {}),
          });
        }
        done.push(to);
      } catch (err) {
        toastError(err, targets.length > 1 ? `Не удалось переслать: ${b.peerName(to)}` : 'Не удалось переслать');
      }
    }
    if (done.length === 0) return;
    // Черновик, отправленный из «Изменить получателя», из полосы этой беседы уходит.
    if (src && feedId) useStore.getState().setFwdDraft(feedId, null);
    // «Переслано: Имя», «Имя и Имя», «3 беседы» — как `lng_share_messages_to_*` у Telegram.
    const name =
      done.length <= 2
        ? done.map((to) => b.peerName(to)).join(' и ')
        : `${done.length} ${plural(done.length, 'беседа', 'беседы', 'бесед')}`;
    setFwdDone((d) => ({ to: done.length === 1 ? done[0] : null, name, n: (d?.n ?? 0) + 1, ...(o.at ? { later: true } : {}) }));
  }

  /** «Открыть» на плашке — к беседе получателя. */
  function openForwarded(to: string) {
    setFwdDone(null);
    batchOn?.open(to);
  }

  /** «Скопировать» выделенного: тексты по порядку ленты (`pickedText`); выделение после этого снимается. */
  function copyPicked(list: readonly Message[]) {
    const text = pickedCopyText(list, pickedSet);
    if (!text) return;
    copyMessageText(text);
    setPicked(NO_PICKS);
  }

  /** Текст сообщений для буфера и для перетаскивания (G76): тот же, что даёт «Скопировать» выделенного. */
  function pickedCopyText(list: readonly Message[], pickedSet: ReadonlySet<string>): string {
    // ПК — «[дата время] Имя: текст» с метками вложений и «в ответ», телефон — как Android у Telegram (одни тексты, имя при
    // смене автора): `pickedText`, 01·4.30 / 4.32.
    return pickedText(
      list.map((x) => ({
        id: x.id,
        content: x.content,
        author: nameOf(x.author.id, x.author.displayName),
        createdAt: x.createdAt,
        label: copyMediaLabel(x),
        reply: x.replyTo
          ? {
              author: x.replyTo.authorName,
              text: replyQuoteLook(
                x.replyTo,
                list.find((o) => o.id === x.replyTo!.id),
              ).text,
            }
          : undefined,
      })),
      pickedSet,
      (iso) => (phoneLayout ? TIME_FMT : COPY_STAMP_FMT).format(new Date(iso)),
      { style: phoneLayout ? 'phone' : 'desktop' },
    );
  }

  /** «Изменить» в шапке выделения (одно своё, не пересланное): выйти из выделения и править — как из меню. */
  function editPicked(m: Message) {
    setPicked(NO_PICKS);
    editFromMenu(m);
  }

  /** «Ответить» внизу (только при одном): выйти из выделения и ответить. Поле ещё спрятано — фокус кадром позже. */
  function replyPicked(m: Message) {
    setPicked(NO_PICKS);
    startReply(m);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  /**
   * «⋯» в шапке (только при одном, приёмка 06.10, п. 1): выйти из выделения и открыть меню этого сообщения у пузыря — то
   * же, что тап по сообщению: реакции, «Закрепить», «Скопировать текст», пункты фото. 🔴 У сообщения только с фото или видео
   * иначе меню нет совсем: тап по кадру (и по времени поверх него) — просмотр, удержание — выделение (решение владельца —
   * так и остаётся), а «Закрепить» в шапке выделения нет (макет раунда 12, HANDOFF §6). Как «⋮» в шапке выделения Telegram.
   */
  function menuPicked(m: Message) {
    menuAfterSelect.current = m.id;
    setPicked(NO_PICKS);
  }

  /**
   * «Удалить» выделенного (HANDOFF §6, решения владельца 04.10): одно — то же окно, что у одиночного (`del`); несколько —
   * «Удалить N сообщений?» с галочкой «Также удалить для собеседника». С С1 (`othersForBoth`) галочка — на все выбранные,
   * без него — только на мои (чужие уходят «у меня»: сервер отказал бы всей пачке); моих нет — галочки нет вовсе.
   */
  async function deletePicked(list: readonly Message[]) {
    const b = batchOn;
    if (!b || list.length === 0) return;
    if (list.length === 1) {
      if (await del(list[0])) setPicked(NO_PICKS);
      return;
    }
    const n = list.length;
    const title = `Удалить ${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}?`;
    const peer = deletePeerName ?? '';
    const all = list.map((x) => x.id);
    const mine = list.filter((x) => x.author.id === meId).map((x) => x.id);
    const theirs = list.filter((x) => x.author.id !== meId).map((x) => x.id);
    let steps: { ids: string[]; scope: 'me' | 'both' }[];
    if (mine.length > 0 || othersForBoth) {
      const r = await confirmWithOption({
        title,
        body: `Без галочки они исчезнут только у вас, а ${peer} их по-прежнему увидит. Вернуть удалённое нельзя.`,
        tone: 'danger',
        confirmLabel: 'Удалить',
        option: { label: 'Также удалить для собеседника', checked: delBothDefault(), remember: delRemember },
      });
      if (!r) return;
      if (r.remember) rememberDeleteChoice(r.option);
      steps = !r.option
        ? [{ ids: all, scope: 'me' }]
        : othersForBoth
          ? [{ ids: all, scope: 'both' }]
          : [
              { ids: mine, scope: 'both' },
              { ids: theirs, scope: 'me' },
            ];
    } else {
      const ok = await confirmAction({
        title,
        body: `Сообщения пропадут только у вас — ${peer} их по-прежнему увидит.`,
        tone: 'danger',
        confirmLabel: 'Удалить',
      });
      if (!ok) return;
      steps = [{ ids: all, scope: 'me' }];
    }
    try {
      for (const step of steps) if (step.ids.length > 0) await b.deleteMany(step.ids, step.scope);
      setPicked(NO_PICKS);
    } catch (err) {
      toastError(err);
    }
  }

  // ─── Раунд 12, порция 7: закреп в ЛС (только с закрепом от беседы — `pinsOn`) ─────────────────────────────────────

  /**
   * «Закрепить» из меню (HANDOFF §10): окно с галочкой «Также закрепить для собеседника» — по умолчанию стоит; без неё —
   * только у меня. Имя в тексте — в именительном (косвенный падеж из имени не собрать). Закреплённое полоса сразу и
   * показывает. Предел списка (409) — тост словами, а не кодом сервера.
   */
  async function pinMessage(m: Message) {
    const p = pinsOn;
    if (!p) return;
    if (groupChat) {
      await pinInGroup(p, m);
      return;
    }
    const r = await confirmWithOption({
      title: 'Закрепить сообщение?',
      body: `Оно появится над лентой беседы. Без галочки сообщение будет закреплено только у вас — ${deletePeerName ?? 'собеседник'} его там не увидит.`,
      confirmLabel: 'Закрепить',
      option: { label: 'Также закрепить для собеседника', checked: true },
    });
    if (!r) return;
    try {
      await p.pin(m.id, r.option ? 'both' : 'me');
      setPinShown(m.id);
    } catch (err) {
      if (isPinLimit(err)) {
        toast('error', 'Не удалось закрепить', `Закреплено уже ${DM_PINS_MAX} сообщений — больше нельзя. Открепите какое-нибудь и попробуйте снова.`);
      } else toastError(err, 'Не удалось закрепить');
    }
  }

  /**
   * G4 (приёмка 13.10): закреп в ГРУППЕ — как Telegram (Android `ChatActivity` OPTION_PIN → `PinMessageAlert` + галочка `PinNotify`,
   * tdesktop `PinMessageBox`): закрепляется у всех участников, «только у себя» в группе нет; галочка «Уведомить всех участников»
   * стоит по умолчанию — участникам пуш «закрепил(а) «…»», без неё строка закрепа ложится «без звука».
   */
  async function pinInGroup(p: MessagePins, m: Message) {
    const r = await confirmWithOption({
      title: 'Закрепить сообщение?',
      body: 'Закрепить это сообщение для всех участников группы?',
      confirmLabel: 'Закрепить',
      option: { label: 'Уведомить всех участников', checked: true },
    });
    if (!r) return;
    try {
      await p.pin(m.id, 'both', r.option);
      setPinShown(m.id);
    } catch (err) {
      if (isPinLimit(err)) {
        toast('error', 'Не удалось закрепить', `Закреплено уже ${DM_PINS_MAX} сообщений — больше нельзя. Открепите какое-нибудь и попробуйте снова.`);
      } else toastError(err, 'Не удалось закрепить');
    }
  }

  /**
   * «Открепить» — из меню, крестиком полосы (одно закреплённое) или в списке всех. Закреплённое «для обоих» (`forBoth` у
   * моего закрепа) спрашивает «Открепить сообщение?» с галочкой «Также открепить для собеседника» (по умолчанию стоит, как
   * у закрепа); закреплённое только у меня — сразу, без окна (HANDOFF §10 окна для него не просит).
   */
  async function unpinMessage(id: string) {
    const p = pinsOn;
    if (!p) return;
    // Крестик полосы и крестик строки списка — всегда с вопросом (G28, Telegram `ToggleMessagePinned` → `lng_pinned_unpin_sure`);
    // закреп «для обоих» — с галочкой «Также открепить для собеседника».
    const ans = await askUnpin([id]);
    if (!ans) return;
    const scope: 'me' | 'both' = ans.both ? 'both' : 'me';
    try {
      await p.unpin(id, scope);
    } catch (err) {
      toastError(err, 'Не удалось открепить');
    }
  }

  /**
   * К закреплённому (полоса или строка списка): тем же переходом, что к цитате (`jumpToMessage`: нет в загруженном окне —
   * окно подгружается вокруг него, строка вспыхивает `.jump-hit`, место ухода — в «Назад»). Полоса затем показывает
   * предыдущее закреплённое, по кругу (HANDOFF §2.3).
   */
  function openPinned(id: string) {
    const i = pinList.findIndex((p) => p.message.id === id);
    if (i < 0) return;
    setPinShown(pinList[(i - 1 + pinList.length) % pinList.length].message.id);
    pinClicked.current = pinList[i].message.sortKey;
    void jumpToMessage(id);
  }

  /**
   * Полоса идёт за прокруткой (G27, `pinBarRules.pinTrack`): нижнее видимое сообщение ленты → ближайшее закреплённое не ниже
   * него. Не измерили (лента не нарисована, у строк нет ключа порядка) — полоса стоит как стояла (ведёт нажатие).
   * Один расчёт за кадр. Последнее (самое новое) показываем как «по умолчанию» (`null`) — новое закреплённое тогда подхватится.
   */
  const pinTrackLast = useRef({ list: pinList, byId: msgById });
  pinTrackLast.current = { list: pinList, byId: msgById };
  const pinTrackRaf = useRef(0);
  /** Закреплённое, к которому перешли нажатием (ключ порядка): пока лента не пролистана выше, полоса показывает предыдущее. */
  const pinClicked = useRef<number | null>(null);
  function trackPinned() {
    if (pinCount < 2 || pinTrackRaf.current) return;
    pinTrackRaf.current = requestAnimationFrame(() => {
      pinTrackRaf.current = 0;
      const box = listRef.current;
      const { list, byId } = pinTrackLast.current;
      if (!box || list.length < 2) return;
      const bottom = box.getBoundingClientRect().bottom;
      const rows = box.querySelectorAll<HTMLElement>('[data-mid]');
      let key: number | null = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i].getBoundingClientRect();
        if (r.height <= 0 || r.top >= bottom) continue;
        const k = (byId.get(rows[i].dataset.mid ?? '') as { sortKey?: number } | undefined)?.sortKey;
        if (typeof k === 'number') {
          key = k;
          break;
        }
      }
      const res = pinTrack({ keys: list.map((p) => p.message.sortKey), bottomKey: key, clickedKey: pinClicked.current });
      pinClicked.current = res.clickedKey;
      if (res.index >= 0) setPinShown(res.index === list.length - 1 ? null : list[res.index].message.id);
    });
  }

  /** Правый щелчок по полосе (Telegram `barRightClicks`): к следующему, более новому закреплённому; от самого нового — по кругу. */
  function nextPinned() {
    if (pinCount < 2) return;
    const keys = pinList.map((p) => p.message.sortKey);
    const i = pinNextIndex(keys, pinClicked.current ?? keys[pinIndex]);
    if (i < 0) return;
    pinClicked.current = null;
    setPinShown(pinList[i].message.id);
    void jumpToMessage(pinList[i].message.id);
  }

  /** Подтверждение открепления с вопросом, как у Telegram (`lng_pinned_unpin_sure`): окно перед КАЖДЫМ нажатием на крестик. */
  async function askUnpin(ids: readonly string[]): Promise<{ both: boolean } | null> {
    const many = ids.length > 1;
    const anyBoth = ids.some((id) => rawPinList.find((x) => x.message.id === id)?.forBoth);
    const title = many
      ? ids.length === pinCount
        ? 'Открепить все сообщения?'
        : `Открепить ${ids.length} ${plural(ids.length, 'сообщение', 'сообщения', 'сообщений')}?`
      : 'Открепить сообщение?';
    // G4: в группе закреп общий — открепляется у всех без галочки «для собеседника» (Telegram `UnpinMessageAlert`).
    if (anyBoth && groupChat) {
      const ok = await confirmAction({
        title,
        body: many ? 'Они пропадут из полосы закрепа у всех участников группы.' : 'Оно пропадёт из полосы закрепа у всех участников группы.',
        confirmLabel: 'Открепить',
      });
      return ok ? { both: true } : null;
    }
    if (anyBoth) {
      const r = await confirmWithOption({
        title,
        body: `Без галочки ${many ? 'они откреплены' : 'оно откреплено'} только у вас — ${deletePeerName ?? 'собеседник'} по-прежнему увидит ${many ? 'их' : 'его'} над лентой беседы.`,
        confirmLabel: 'Открепить',
        option: { label: 'Также открепить для собеседника', checked: true },
      });
      return r ? { both: r.option } : null;
    }
    const ok = await confirmAction({
      title,
      body: many ? 'Они пропадут из полосы закрепа.' : 'Оно пропадёт из полосы закрепа.',
      confirmLabel: 'Открепить',
    });
    return ok ? { both: false } : null;
  }

  /** «Открепить все N» в списке закреплённых (Telegram `UnpinAllMessages`): по одному, закреп «для обоих» — по галочке окна. */
  async function unpinAll() {
    const p = pinsOn;
    if (!p) return;
    const items = [...myPinList];
    const ans = await askUnpin(items.map((x) => x.message.id));
    if (!ans) return;
    setPinsListOpen(false);
    try {
      for (const x of items) await p.unpin(x.message.id, x.forBoth && ans.both ? 'both' : 'me');
    } catch (err) {
      toastError(err, 'Не удалось открепить');
    }
  }

  /** «Открепить» в панели выделения (Telegram `UnpinMessages`): только закреплённые из выбранных; окно с вопросом. */
  async function unpinPicked(list: readonly Message[]) {
    const p = pinsOn;
    if (!p) return;
    const ids = list.filter((x) => pinnedIds.has(x.id)).map((x) => x.id);
    if (ids.length === 0) return;
    const ans = await askUnpin(ids);
    if (!ans) return;
    setPicked(NO_PICKS);
    try {
      for (const id of ids) await p.unpin(id, rawPinList.find((x) => x.message.id === id)?.forBoth && ans.both ? 'both' : 'me');
    } catch (err) {
      toastError(err, 'Не удалось открепить');
    }
  }

  /** «Скрыть закреплённые» (Telegram `HidePinnedBar`): полоса скрыта только у меня, пока не появится новое закреплённое. */
  async function hidePins() {
    if (!feedId || myPinList.length === 0) return;
    const ok = await confirmAction({
      title: 'Скрыть закреплённые?',
      body: 'Полоса скроется только у вас. Она вернётся, когда в беседе появится новое закреплённое сообщение.',
      confirmLabel: 'Скрыть',
    });
    if (!ok) return;
    writePinHidden(feedId, myPinList.map((p) => p.message.id));
    setPinsListOpen(false);
    setPinHideTick((n) => n + 1);
  }

  /**
   * «Открепить» из меню сообщения (Telegram Android: тост с «ОТМЕНА», запрос уходит позже): сообщение сразу пропадает из полосы,
   * плашка «Сообщение откреплено» с «Отменить» 5 с; не отменили — запрос уходит (закреп «для обоих» — у обоих, как у Telegram).
   * Ушли из беседы раньше срока — запрос уходит сразу (`flushUnpin` в очистке эффекта).
   */
  const [unpinUndo, setUnpinUndo] = useState<{ n: number; count: number } | null>(null);
  const unpinPending = useRef<{ id: string; scope: 'me' | 'both'; run: MessagePins['unpin'] }[]>([]);
  const unpinTimer = useRef<number | null>(null);
  function flushUnpin() {
    if (unpinTimer.current !== null) window.clearTimeout(unpinTimer.current);
    unpinTimer.current = null;
    const todo = unpinPending.current;
    unpinPending.current = [];
    setUnpinUndo(null);
    for (const t of todo) {
      void t
        .run(t.id, t.scope)
        .catch((err) => toastError(err, 'Не удалось открепить'))
        .finally(() =>
          setPinUndoHidden((s) => {
            const next = new Set(s);
            next.delete(t.id);
            return next;
          }),
        );
    }
  }
  function unpinSoon(id: string) {
    const p = pinsOn;
    if (!p) return;
    const forBoth = !!rawPinList.find((x) => x.message.id === id)?.forBoth;
    unpinPending.current = [...unpinPending.current, { id, scope: forBoth ? 'both' : 'me', run: p.unpin }];
    setPinUndoHidden((s) => new Set(s).add(id));
    setUnpinUndo((u) => ({ n: (u?.n ?? 0) + 1, count: unpinPending.current.length }));
    if (unpinTimer.current !== null) window.clearTimeout(unpinTimer.current);
    unpinTimer.current = window.setTimeout(flushUnpin, UNPIN_UNDO_MS);
  }
  function undoUnpin() {
    if (unpinTimer.current !== null) window.clearTimeout(unpinTimer.current);
    unpinTimer.current = null;
    const ids = new Set(unpinPending.current.map((t) => t.id));
    unpinPending.current = [];
    setUnpinUndo(null);
    setPinUndoHidden((s) => new Set([...s].filter((x) => !ids.has(x))));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `flushUnpin` читает только ref'ы и сеттеры
  useEffect(() => () => flushUnpin(), [feedId]);

  /** Когда открыт список закреплённых: щелчок, дошедший до подложки сразу после открытия (палец, державший полосу, отпущен), не закрывает его. */
  const pinsOpenedAt = useRef(0);
  function togglePinsList() {
    if (pinsListOpen) {
      setPinsListOpen(false);
      return;
    }
    pinsOpenedAt.current = Date.now();
    pinsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPinsListOpen(true);
  }

  /* ─── Клавиши беседы (07.10, G36 и G15; Telegram Desktop `history/history_widget.cpp`: `eventFilter`, `keyPressEvent`,
     `escape`; `history/history_inner_widget.cpp`: `keyPressEvent`) ─────────────────────────────────────────────────────
     Один слушатель окна, а не поля: у Telegram эти клавиши работают и с фокусом в ленте. Правила — `chatKeysRules.ts`.
     - Esc по слоям (`chatEscape`): меню, окна, просмотрщик и подсказки поля гасят Esc сами раньше (слой поверх —
       не наше, `preventDefault` — уже снят); выделение снимает свой слушатель; дальше правка → ответ при пустом поле →
       запись голосового (вопрос) → закрыть беседу (`onEscapeClose`).
     - Ctrl+↑ / Ctrl+↓ — ответ на предыдущее / следующее (`replyNavTarget`): лента едет к сообщению и подсвечивает его;
       ↓ после последнего снимает ответ. Не в правке. Поля нет (блокировка) — только переход с подсветкой.
     - Shift+↑ / Shift+↓ в выделении — выбранные тянутся диапазоном от последнего выбранного (как протяжка мышью,
       `selectRange`); назад диапазон сжимается.
     - Печатный знак с фокусом в ленте (или нигде) — фокус в поле, знак набирается там (`isTypingKey`).
     Слушатель один на всё время жизни ленты; свежее состояние — через `chatKeys.current`, переписываемый на рендере. */
  const chatKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  const kbSel = useRef<{ base: readonly string[]; anchor: string; focus: string; result: readonly string[] } | null>(null);
  const replyNavHi = useRef<string | null>(null);
  chatKeys.current = (e: KeyboardEvent) => {
    const box = listRef.current;
    // Ctrl+O глушит общий запрет браузерных сочетаний (`main.tsx` → `browserShortcuts.ts`, ловит окно раньше нас): тут оно наше.
    if (!box || (e.defaultPrevented && !attachKey(e))) return;
    // Окно, лист, меню, просмотрщик, настройки, шпаргалка поверх — клавиши их.
    if (document.querySelector(`[aria-modal="true"], .modal-overlay, ${TOP_LAYERS}`)) return;
    const t = e.target instanceof Element ? e.target : null;
    const field = inputRef.current;
    const inField = !!t && !!field && t === field;
    // Другое поле (правка на месте, поиск, подпись) — его клавиши.
    if (t && !inField && t.closest('input, textarea, select, [contenteditable]')) return;
    // Фокус в другой части окна (список бесед, рейл) — не наша лента. Нет фокуса (`body`) — наша.
    const root = box.closest('.content') ?? box.parentElement;
    const outside = !!t && t !== document.body && t !== document.documentElement && !root?.contains(t);
    if (outside) return;

    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const step = chatEscape({
        selecting,
        editing: !!composerEdit,
        draft: text,
        original: composerEdit?.content ?? '',
        replying: !!replyingTo,
        recording: recording || !!preview,
        canClose: !!onEscapeClose,
        forwarding: !!fwdDraft && !composerEdit && !composerReplacement && !readOnly,
      });
      // Выделение снимает его собственный слушатель (`selectionKey`), ему и отдаём.
      if (step === 'none' || step === 'selection') return;
      e.preventDefault();
      if (step === 'edit' || step === 'ask-edit') {
        return cancelComposerEdit();
      }
      if (step === 'forward') return void (feedId && useStore.getState().setFwdDraft(feedId, null));
      if (step === 'reply') return setReplyingTo(null);
      if (step === 'voice') {
        // Telegram: `showDiscardBox` — «остановить запись и удалить голосовое?». Опасное: Enter не подтверждает.
        void confirmAction({
          title: 'Удалить голосовое сообщение?',
          body: 'Запись остановится, записанное пропадёт.',
          tone: 'danger',
          confirmLabel: 'Удалить',
          cancelLabel: 'Продолжить',
        }).then((ok) => {
          if (!ok) return;
          if (voice.getState().preview) voice.discardPreview();
          else voice.cancel();
        });
        return;
      }
      onEscapeClose?.();
      return;
    }

    // Ctrl+O — «Файл» (Telegram Desktop `chooseAttach`). Нет поля, правка или запись — прикреплять некуда.
    if (attachKey(e)) {
      if (!field || field.disabled || composerEdit || recording || preview) return;
      e.preventDefault();
      if (!e.repeat) openFilePicker();
      return;
    }

    const nav = replyNavKey(e);
    if (nav) {
      if (selecting || composerEdit) return;
      const order = messages.map((x) => x.id);
      const current = field ? (replyingTo?.id ?? null) : replyNavHi.current;
      const to = replyNavTarget(order, current, nav);
      if (!to) return;
      e.preventDefault();
      if (to === 'cancel') {
        replyNavHi.current = null;
        setReplyingTo(null);
        return;
      }
      scrollToRow(to.reply);
      const m = messages.find((x) => x.id === to.reply);
      if (field && m) startReply(m);
      else replyNavHi.current = to.reply;
      return;
    }

    if (selecting && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const order = [...rowsOf(box)].map((r) => r.dataset.mid ?? '');
      let kb = kbSel.current;
      if (!kb || kb.result !== picked) {
        const last = picked[picked.length - 1];
        kb = { base: picked, anchor: last, focus: last, result: picked };
      }
      const i = order.indexOf(kb.focus);
      if (i < 0) return;
      e.preventDefault();
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= order.length) return;
      const next = selectRange(order, kb.base, kb.anchor, order[j], true);
      kbSel.current = { ...kb, focus: order[j], result: next };
      setPicked(next.length ? next : NO_PICKS);
      rowOf(order[j])?.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (!inField && field && !field.disabled && !selecting && isTypingKey(e)) {
      // Ни кнопок, ни ссылок: пробел и буквы на них — их нажатие, а не набор.
      if (t && t.closest('button, a, [role="button"], [role="menuitem"]')) return;
      field.focus();
      const end = field.value.length;
      field.setSelectionRange(end, end);
      // Знак не перехватываем: фокус уже в поле, браузер наберёт его там.
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => chatKeys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Список всех закреплённых: Esc и «назад» Android закрывают его (Esc — с фокусом обратно на кнопку списка). Поповер —
     `aria-modal` (под ним подложка на весь экран): Esc выделения при нём молчит, как при окне. Окно поверх списка
     (открепить «для обоих») гасит Esc само — захватом и `preventDefault`, список остаётся. */
  useEffect(() => {
    if (!pinsListShown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setPinsListOpen(false);
      pinsOpener.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    const back = pushBackHandler(() => {
      setPinsListOpen(false);
      return true;
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      back();
    };
  }, [pinsListShown]);

  // Закреплённых стало меньше двух — списка нет; при новых двух он не должен открыться сам.
  useEffect(() => {
    if (pinsListOpen && pinCount < 2) setPinsListOpen(false);
  }, [pinsListOpen, pinCount]);

  /* Полоса встала над лентой или ушла: лента стала ниже или выше на её высоту. Человек был у низа — у низа и остаётся
     (иначе последние сообщения ушли бы под поле ввода); читал выше — его строки не трогаем (верх ленты на месте). */
  const pinBar = !!pinCur;
  const pinBarWas = useRef(pinBar);
  useLayoutEffect(() => {
    if (pinBarWas.current === pinBar) return;
    pinBarWas.current = pinBar;
    if (!nearBottomRef.current || pendingScroll.current || heldAnchor.current) return;
    if (holdFeedRef.current) stickAfterMenu.current = true;
    else stickDown();
  }, [pinBar]);

  /** Удалить одно сообщение — с подтверждением. `true` — удалено. */
  async function del(m: Message): Promise<boolean> {
    let scope: 'me' | 'both' | undefined;
    if (deletePeerName === undefined) {
      // Самое частое подтверждение в приложении — поэтому короткое: без тела, одним вопросом.
      if (!(await confirmAction({ title: 'Удалить сообщение?', tone: 'danger', confirmLabel: 'Удалить' }))) return false;
    } else if (m.author.id === meId || othersForBoth) {
      /* ЛС, своё (#212, «как в Telegram»): галочка по умолчанию стоит — так удаление вело себя всегда, и
         человек, не читающий окно, получает прежнее. Сняв её, удаляет только у себя.
         Раунд 12 (за переключателем пузырей): галочка — «Также удалить для собеседника», имя не склоняем (решение
         владельца 04.10); и у ЧУЖОГО, если сервер удаляет его у обоих (С1, `conv6` — `othersForBoth`). */
      const r = await confirmWithOption({
        title: 'Удалить сообщение?',
        // Раунд 10: что значит галочка — словами (имя в именительном: косвенный падеж из имени не собрать).
        body: `Без галочки оно исчезнет только у вас, а ${deletePeerName} его по-прежнему увидит. Вернуть удалённое нельзя.`,
        tone: 'danger',
        confirmLabel: 'Удалить',
        option: {
          label: 'Также удалить для собеседника',
          checked: delBothDefault(),
          remember: delRemember,
        },
      });
      if (!r) return false;
      if (r.remember) rememberDeleteChoice(r.option);
      scope = r.option ? 'both' : 'me';
    } else {
      // ЛС, чужое: стереть у собеседника его же слова нельзя — только убрать у себя, и окно говорит это прямо.
      const ok = await confirmAction({
        title: 'Удалить у себя?',
        body: `Сообщение пропадёт только у вас — ${deletePeerName} его по-прежнему увидит.`,
        tone: 'danger',
        confirmLabel: 'Удалить',
      });
      if (!ok) return false;
      scope = 'me';
    }
    try {
      await onDelete(m, scope);
      return true;
    } catch (err) {
      toastError(err);
      return false;
    }
  }
  /**
   * G56: удалить ОДИН элемент альбома — с подтверждением (Telegram `lng_delete_photo_sure`, галочка «у обоих» — как у сообщения,
   * Р-1): своё — «Также удалить для собеседника» (без неё — только у себя), чужое — только у себя. `true` — удалено.
   */
  async function delItem(m: Message, att: Attachment): Promise<boolean> {
    const run = batchOn?.deleteItem;
    if (!run || !att.id) return false;
    const noun = albumItemNoun(att);
    const peer = deletePeerName ?? '';
    let scope: 'me' | 'both';
    if (m.author.id === meId) {
      const r = await confirmWithOption({
        title: `Удалить ${noun}?`,
        body: `Без галочки ${noun} исчезнет только у вас${peer ? `, а ${peer} по-прежнему увидит его` : ''}. Остальное в альбоме останется. Вернуть удалённое нельзя.`,
        tone: 'danger',
        confirmLabel: 'Удалить',
        option: { label: 'Также удалить для собеседника', checked: delBothDefault(), remember: delRemember },
      });
      if (!r) return false;
      if (r.remember) rememberDeleteChoice(r.option);
      scope = r.option ? 'both' : 'me';
    } else {
      const ok = await confirmAction({
        title: `Удалить ${noun} у себя?`,
        body: `${noun === 'фото' ? 'Фото' : 'Видео'} пропадёт только у вас${peer ? ` — ${peer} по-прежнему увидит его` : ''}.`,
        tone: 'danger',
        confirmLabel: 'Удалить',
      });
      if (!ok) return false;
      scope = 'me';
    }
    try {
      await run(m.id, att.id, scope);
      return true;
    } catch (err) {
      // 409 `album_item_peer_old`: дом собеседника не понимает меньший список вложений — подсказать, что делать.
      if (err instanceof Error && err.message === ALBUM_ITEM_PEER_OLD_ERROR) toast('error', ALBUM_ITEM_PEER_OLD_TEXT);
      else toastError(err);
      return false;
    }
  }
  /** Можно ли удалить: своё, модератору — любое, в ЛС — любое (чужое — только у себя). */
  const canDelete = (m: Message) => !readOnly && (m.author.id === meId || !!canModerate || deletePeerName !== undefined);

  // Тикаем, пока идёт запись: и таймер, и уровень. 100 мс — глазу достаточно, процессору не жалко.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => voice.tick(), 100);
    return () => clearInterval(t);
  }, [recording, voice]);

  /* «Записывает голосовое…» (G21, 02·11.1): пока идёт запись (микрофон открыт), раз в 2,5 с. Отмена/конец записи — сигнал
     просто перестаёт приходить и гаснет сам (явной «отмены» нет: старый клиент принял бы её за «печатает»). */
  useEffect(() => {
    if (!recording || roundRec) return; // кружок — своё действие, ниже
    signalActionRef.current('voice');
    const t = setInterval(() => signalActionRef.current('voice'), 2500);
    return () => clearInterval(t);
  }, [recording, roundRec]);
  /* «Записывает видеосообщение…» (кружок; tdesktop `lng_send_action_record_round`): пишется кружок — вид `round`; сервер без признака
     `typing2` получает прежнее `voice` (`sendTyping`), соединения без `typing2` — тоже (шлюз, `typingActionFor`). */
  useEffect(() => {
    if (!recording || !roundRec) return;
    signalActionRef.current('round');
    const t = setInterval(() => signalActionRef.current('round'), 2500);
    return () => clearInterval(t);
  }, [recording, roundRec]);

  /* «Отправляет фото/видео/файл…» (G21): пока строка «в пути» с файлами грузится — раз в 2,5 с, вид по типам файлов. */
  const uploadAction = (() => {
    let best: TypingAction | null = null;
    for (const o of outbox ? outbox.items : outgoing) {
      if (o.status !== 'sending') continue;
      const a = uploadTypingAction(o.files.map((f) => f.type));
      if (a && (!best || typingActionRank(a) > typingActionRank(best))) best = a;
    }
    // Голосовое грузится прямым вызовом, а не строкой очереди: у него свой вид, и он главнее файла.
    return voiceSending > 0 ? 'voice_upload' : best;
  })();
  useEffect(() => {
    if (!uploadAction) return;
    signalActionRef.current(uploadAction);
    const t = setInterval(() => signalActionRef.current(uploadAction), 2500);
    return () => clearInterval(t);
  }, [uploadAction]);

  // Уходим со страницы посреди записи — глушим микрофон и отпускаем прослушивание (см. `dispose`).
  useEffect(() => () => voice.dispose(), [voice]);

  /* Черновик голосового (08.10, G54; tdesktop: запись в прослушивании переживает смену беседы). Прослушивание
     кладётся черновиком ленты СРАЗУ (память + IndexedDB, `voiceDrafts.ts`) и обновляется с ручками и «один раз»; уход
     (`leaveGuard` → `detachPreview`) лишь отпускает микрофон. Отправил, выбросил или продолжил запись — черновик уходит.
     Открыл ленту с черновиком — прослушивание восстановлено. */
  /** Прослушивание отпущено уходом из беседы — черновик не трогать. */
  const voiceDetachRef = useRef(false);
  /** Черновик этой ленты положен из прослушивания (уход прослушивания без отпускания — удалить). */
  const voiceDraftLiveRef = useRef(false);
  const restoringRef = useRef<{ trim: { from: number; to: number; totalMs: number } | null; once: boolean } | null>(null);
  const previewUrl = preview?.url ?? null;
  useEffect(() => {
    if (!feedId) return;
    let alive = true;
    void loadVoiceDraft(feedId).then((d) => {
      if (!alive || !d) return;
      const take: VoiceTake = { file: d.file, durationMs: d.durationMs, waveform: d.waveform };
      const sel = d.trim
        ? {
            from: d.trim.fromMs / d.durationMs,
            to: d.trim.toMs === null ? 1 : d.trim.toMs / d.durationMs,
            totalMs: d.durationMs,
          }
        : null;
      restoringRef.current = { trim: sel, once: d.once };
      if (!voice.restorePreview(take)) restoringRef.current = null;
    });
    return () => {
      alive = false;
    };
  }, [feedId, voice]);
  useEffect(() => {
    if (!preview) {
      setTrimOk(false);
      // Записи больше нет (отправлена — после загрузки, выброшена) — ручки и «один раз» к следующей не переходят.
      if (!recording && !recBusy) {
        setTrimSel(null);
        setVoiceOnceOn(false);
      }
      return;
    }
    const restored = restoringRef.current;
    restoringRef.current = null;
    setTrimSel(restored?.trim ?? null);
    if (restored) setVoiceOnceOn(restored.once);
    let alive = true;
    setTrimOk(false);
    if (!preview.take.round && preview.take.durationMs >= VOICE_TRIM_FROM_MS) void voiceTrimmable(preview.take.file).then((ok) => alive && setTrimOk(ok));
    return () => {
      alive = false;
    };
  }, [previewUrl, previewUrl ? false : recording || recBusy]);
  useEffect(() => {
    if (!feedId) return;
    if (!preview) {
      // Ушло прослушивание: отправили, выбросили или пишут дальше — черновик уходит. Отпущенное уходом из беседы
      // (`detachPreview` в `leaveGuard`) остаётся черновиком.
      if (voiceDetachRef.current) voiceDetachRef.current = false;
      else if (voiceDraftLiveRef.current) dropVoiceDraft(feedId);
      voiceDraftLiveRef.current = false;
      return;
    }
    // Кружок в черновик не кладём: черновик — голосовое (восстанавливается полосой с огибающей).
    if (preview.take.round) return;
    voiceDraftLiveRef.current = true;
    const sel = trimSel ? voiceTrimFromRatios(trimSel.from, trimSel.to, trimSel.totalMs) : null;
    saveVoiceDraft(feedId, {
      file: preview.take.file,
      durationMs: preview.take.durationMs,
      waveform: preview.take.waveform,
      once: voiceOnceOn,
      trim: sel,
      at: new Date().toISOString(),
    });
  }, [previewUrl, trimSel, voiceOnceOn]);

  /**
   * Выбросить запись — только с подтверждением (Telegram Desktop `VoiceRecordBar::showDiscardBox`: Esc, уход из беседы):
   * сказанное не вернуть. Тексты — `lng_record_lock_cancel_sure` / `lng_record_listen_cancel_sure`, кнопка «Удалить».
   */
  const confirmDiscardVoice = useCallback(async (): Promise<boolean> => {
    const listening = !!voice.getState().preview;
    // Кружок (`circles1`) — «видеосообщение» (ревью №4, 08.10: окно говорило «голосовое» и над записью с камеры).
    const what = roundLiveRef.current || voice.getState().preview?.take.round ? 'видеосообщение' : 'голосовое сообщение';
    const ok = await confirmAction({
      title: listening ? 'Удалить запись?' : 'Остановить запись?',
      body: listening ? `Записанное ${what} будет удалено.` : `Запись остановится, ${what} будет удалено.`,
      tone: 'danger',
      confirmLabel: 'Удалить',
    });
    if (!ok) return false;
    if (voice.getState().preview) voice.discardPreview();
    else voice.cancel();
    return true;
  }, [voice]);

  /* Уход из беседы и закрытие окна во время записи — с подтверждением (Telegram Desktop: `HistoryWidget` зовёт
     `showDiscardBox` перед сменой беседы). Беседу меняют `openChannel` / `selectDm` / `openServer` стора (`leaveGuard` в `store.ts`). */
  useEffect(() => {
    const off = useStore.getState().setLeaveGuard((target) => {
      if (!voice.active() || target === feedId) return true;
      // Прослушивание (пауза или «стоп») уходит черновиком беседы (G54, tdesktop): спрашивать нечего — оно сохранено.
      // Кроме кружка: черновиком он не хранится, и уход молча терял записанное (ревью №4, 08.10) — спрашиваем, как над записью.
      if (feedId && !voice.getState().preview?.take.round) {
        voiceDetachRef.current = true;
        if (voice.detachPreview()) return true;
        voiceDetachRef.current = false;
      }
      return confirmDiscardVoice();
    });
    const onUnload = (e: BeforeUnloadEvent) => {
      // Прослушивание уже лежит черновиком в базе устройства (эффект ниже) — переживёт и перезагрузку.
      // Кружок черновиком не лежит — его прослушивание перезагрузка потеряла бы: спрашиваем.
      const st = voice.getState();
      if (!voice.active() || (feedId && st.preview && !st.recording && !st.preview.take.round)) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      off();
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [voice, feedId, confirmDiscardVoice]);

  /* Клавиши во время записи без рук и прослушивания (Telegram Desktop `VoiceRecordBar`: Enter — отправить, Space в
     прослушивании — играть/пауза, Esc — `showDiscardBox`). Слушатель на окне в фазе захвата — раньше обработчика поля
     ввода, поэтому клавиши поля в это время сюда не доходят и правки там не нужны. */
  const voiceKeysOn = (recording && !holdUi) || !!preview;
  /** Ручки обрезки у прослушивания (G13): от двух секунд и только у файла, который режется (`voiceTrim.ts`). */
  const voiceTrimProp =
    preview && trimOk
      ? {
          from: trimSel?.from ?? 0,
          to: trimSel?.to ?? 1,
          onChange: (from: number, to: number) => setTrimSel({ from, to, totalMs: preview.take.durationMs }),
        }
      : undefined;
  /** «1» — «Прослушать один раз» (G54, tdesktop `TTLButton`, тексты `lng_record_once_*`): в записи без рук и прослушивании. */
  const voiceOnceBtn = (cls: string) =>
    voiceOnceAllowed && !holdUi && ((recording && !recBusy) || preview) ? (
      <button
        type="button"
        className={`${cls}${voiceOnceOn ? ' on' : ''}`}
        aria-pressed={voiceOnceOn}
        title={
          voiceOnceOn ? 'Получатель сможет прослушать сообщение только один раз' : 'Нажмите, чтобы сообщение исчезло после прослушивания'
        }
        onClick={() => {
          const on = !voiceOnceOn;
          setVoiceOnceOn(on);
          if (on) toast('info', 'Получатель сможет прослушать сообщение только один раз');
        }}
      >
        1
      </button>
    ) : null;
  useEffect(() => {
    if (!voiceKeysOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role="alertdialog"], [role="dialog"]')) return;
      const st = voice.getState();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void (st.preview ? voice.sendPreview() : voice.finish());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void confirmDiscardVoice();
      } else if (e.key === ' ' && st.preview && !e.repeat && !inputRef.current?.value) {
        e.preventDefault();
        e.stopPropagation();
        const p = st.preview;
        toggleVoice({ key: voiceTrackKey(undefined, undefined, p.url), url: p.url, durationMs: p.take.durationMs });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [voiceKeysOn, voice, confirmDiscardVoice]);

  // Какие действия есть в этом чате. Одни и те же условия у кнопок строки ввода (компьютер) и у
  // пунктов шторки «+» (телефон) — иначе на одном из экранов всплыло бы действие, которого тут нет.
  const micAvailable = !!onSendVoice && voiceRecordingSupported();
  const canVoice = micAvailable && !recording && !preview;
  phoneLayoutRef.current = phoneLayout;

  /* Ctrl+R — записать голосовое без рук, как в Telegram Desktop (`Shortcuts::Command::RecordVoice`). Только в десктопе
     (решение владельца Р-4): в браузере Ctrl+R — перезагрузка, единственное спасение подвисшей вкладки. */
  const canVoiceRef = useRef(false);
  canVoiceRef.current = canVoice && !recBusy && !phoneLayout;
  useEffect(() => {
    if (!isTauri()) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.code !== 'KeyR' || e.repeat) return;
      if (!canVoiceRef.current) return;
      e.preventDefault();
      void voice.start();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [voice]);
  const canSticker = !!onSendSticker && (!!stickerPacks?.length || !!stickerCatalog);
  /** С2 порция 2: избранные стикеры ЛС (`stickers3`) — для «Избранных» панели и меню плитки. */
  const dmFaved = useDmStickers((s) => s.faved);
  /*
   * G21 «выбирает стикер…» (tdesktop `lng_send_action_choose_sticker`, `SendProgressType::ChooseSticker`): пока в строке
   * ввода открыта вкладка «Стикеры», собеседнику раз в `TYPING_SEND_MS` уходит вид действия `sticker`.
   */
  const choosingSticker = !docked && !!picker && picker.kind === 'composer' && canSticker && exprTab === 'stickers';
  useEffect(() => {
    if (!choosingSticker) return;
    signalActionRef.current('sticker');
    const t = window.setInterval(() => signalActionRef.current('sticker'), TYPING_SEND_MS + 50);
    return () => window.clearInterval(t);
  }, [choosingSticker]);
  /* Закреплённая колонка (G61) открыта всё время, пока открыта беседа: «выбирает стикер» по таймеру горел бы у собеседника
     и тогда, когда человек отошёл от ПК. Здесь — только по действию в колонке стикеров (мышь, колесо, прокрутка), как у
     tdesktop (`StickersListWidget` шлёт `choosingStickerUpdated` по сдвигу списка); частоту режет `signalAction`. */
  const dockChoosingSticker = docked && canSticker && exprTab === 'stickers';
  useEffect(() => {
    if (!dockChoosingSticker) return;
    const onAct = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.sticker-pop.docked')) signalActionRef.current('sticker');
    };
    const kinds = ['pointermove', 'wheel', 'scroll'] as const;
    for (const k of kinds) window.addEventListener(k, onAct, { capture: true, passive: true });
    return () => {
      for (const k of kinds) window.removeEventListener(k, onAct, { capture: true });
    };
  }, [dockChoosingSticker]);

  /* ─── Раунд 12, порция 8: меню кнопки «Отправить» и «Отложенные» (HANDOFF §8; только за переключателем пузырей) ───
     ПК — правый клик по кнопке, телефон — долгое нажатие (кнопка видна, пока в поле есть что отправить). Меню без полосы
     реакций и подвала: на ПК — от точки клика, на телефоне — у кнопки (`anchor`), яркой остаётся полоса поля. Слушатели —
     на форме поля (по цели — кнопке), а не на самой кнопке: разметку кнопки держат стражи Codex. */
  const sendOn = bubbles ? sendMenu : undefined;
  const [sendMenuAt, setSendMenuAt] = useState<{ pos?: MenuPos; spot?: BubbleSpot } | null>(null);
  /** «Отправить позже» открыто: что уйдёт (текст и ответ — на момент выбора пункта). */
  const [laterDraft, setLaterDraft] = useState<{ content: string; replyTo: Message | null; files: File[] } | null>(null);
  /**
   * Фокус вокруг окна «Отправить позже» (приёмка 06.10, п. 3): `field` — поле было в фокусе, когда окно открылось (на
   * телефоне — клавиатура была открыта), `sent` — время выбрали. Открытие снимает фокус: иначе клавиатура закрывала часы и
   * кнопку «Отправить …» внизу листа. Закрыли без отправки — фокус обратно, как было.
   */
  const laterFocus = useRef<{ field: boolean; sent: boolean } | null>(null);
  /**
   * Пометки окна отправки файлов («Скрыть под спойлером», «подпись над медиа», «как файл») для «Отправить позже»: файлы после
   * окна лежат на полосе без пометок, а отложенное должно уйти с ними (хвост `tails2`). Спойлер — сами `File` (по ним же
   * считаются индексы к моменту отправки: человек мог убрать файл с полосы); остальное действует, пока файлы окна на месте.
   */
  const laterFlags = useRef<{ files: File[]; spoiled: Set<File>; captionAbove: boolean; asFile: boolean } | null>(null);
  // G46: подсказка «Удерживайте кнопку отправки…» — телефон, меню «Отправить» есть, в поле ≥ 5 знаков, до трёх раз и не чаще
  // раза в сутки (`sendHint.ts`, Telegram Android `showScheduledOrNoSoundHint`).
  const [holdHint, setHoldHint] = useState(false);
  const holdHintOn = phoneLayout && !!sendOn && (sendOn.silent || sendOn.later) && !composerEdit;
  const holdHintChars = text.trim().length;
  useEffect(() => {
    if (!holdHintOn || !sendHintDue(readSendHint(), Date.now(), holdHintChars)) return;
    const t = window.setTimeout(() => {
      if (!sendHintDue(readSendHint(), Date.now(), holdHintChars)) return;
      noteSendHintShown(Date.now());
      setHoldHint(true);
    }, 800);
    return () => window.clearTimeout(t);
  }, [holdHintOn, holdHintChars]);
  // Подсказка — пузырь над кнопкой отправки (как `HintView` у Telegram), сама гаснет через 5 с и кнопку не закрывает.
  useEffect(() => {
    if (!holdHint) return;
    const t = window.setTimeout(() => setHoldHint(false), SEND_HINT_MS);
    return () => window.clearTimeout(t);
  }, [holdHint]);
  useEffect(() => {
    if (holdHint && !holdHintOn) setHoldHint(false);
  }, [holdHint, holdHintOn]);
  function openLater(draft: { content: string; replyTo: Message | null; files: File[] }) {
    const field = inputRef.current;
    const focused = !!field && document.activeElement === field;
    laterFocus.current = { field: focused, sent: false };
    if (focused) field.blur();
    setLaterDraft(draft);
  }
  function closeLater() {
    const lf = laterFocus.current;
    laterFocus.current = null;
    setLaterDraft(null);
    // Без отправки — как было до окна (на телефоне и клавиатура вернётся); после отправки — как раньше (`refocusComposer`).
    if (lf && !lf.sent) {
      if (lf.field) requestAnimationFrame(() => inputRef.current?.focus());
    } else refocusComposer();
  }
  /** Палец держит кнопку «Отправить»: таймер долгого нажатия, откуда пошёл палец и цель касания. */
  const sendPress = useRef<{ timer: number; x: number; y: number; from: EventTarget | null } | null>(null);
  const sendMenuReady =
    !!sendOn &&
    (sendOn.silent || sendOn.later || sendOn.whenOnline) &&
    !composerEdit &&
    !recording &&
    !preview &&
    !holdUi &&
    (!!text.trim() || pending.length > 0);
  /** В поле файлы, а сервер отложенных с вложениями не принимает (нет `conv10`, `sendOn.media`): «позже» и «когда в сети» серые. */
  const schedFilesBlocked = pending.length > 0 && !sendOn?.media;

  function dropSendPress() {
    const p = sendPress.current;
    if (p) window.clearTimeout(p.timer);
    sendPress.current = null;
  }
  useEffect(() => dropSendPress, []);

  /** Кнопка, у которой стоит меню «Отправить» (телефон, узкое окно): за ней меню и следит (эффект ниже). */
  const sendBtn = useRef<Element | null>(null);
  /** Меню у кнопки: блок прижат к её правому краю, яркой остаётся полоса поля — по тому, где они сейчас. */
  function sendSpot(btn: Element): BubbleSpot {
    const anchor = btn.getBoundingClientRect();
    const band = (btn.closest('.composer') ?? btn).getBoundingClientRect();
    return { anchor, spotlight: { top: band.top, bottom: band.bottom }, align: 'end' };
  }
  function openSendMenuAtButton(btn: Element) {
    sendBtn.current = btn;
    setHoldHint(false); // подсказка «Удерживайте…» уже не нужна: человек держит кнопку (и она лежала бы под меню)
    setSendMenuAt({ spot: sendSpot(btn) });
  }

  /** Долгое нажатие сработало: системное меню и `click` отпускания гасим (иначе ушло бы обычной отправкой). */
  function fireSendPress() {
    const p = sendPress.current;
    if (!p) return;
    dropSendPress();
    const btn = p.from instanceof Element ? p.from.closest('.send-btn') : null;
    if (!btn || !sendMenuReady) return;
    navigator.vibrate?.(8);
    swallowNativeLongPress(p.from, true);
    openSendMenuAtButton(btn);
  }

  function onComposerTouchStart(e: React.TouchEvent<HTMLFormElement>) {
    const btn = (e.target as Element).closest('.send-btn');
    dropSendPress();
    if (!btn || !sendMenuReady || e.touches.length !== 1) return;
    const t = e.touches[0];
    sendPress.current = { x: t.clientX, y: t.clientY, from: e.target, timer: window.setTimeout(fireSendPress, 480) };
  }
  function onComposerTouchMove(e: React.TouchEvent<HTMLFormElement>) {
    const p = sendPress.current;
    const t = e.touches[0];
    if (p && t && (Math.abs(t.clientX - p.x) > 10 || Math.abs(t.clientY - p.y) > 10)) dropSendPress();
  }
  function onComposerContextMenu(e: React.MouseEvent<HTMLFormElement>) {
    const btn = (e.target as Element).closest('.send-btn');
    if (!btn || !sendMenuReady) return;
    e.preventDefault();
    // Системное долгое нажатие пришло раньше нашего таймера — открыть то же меню у кнопки сразу.
    if (sendPress.current) return fireSendPress();
    // Узкое окно — у кнопки, как на телефоне; с клавиатуры (Shift+F10, клавиша меню: точки нет) — тоже у кнопки.
    if (narrowWindow() || (e.clientX === 0 && e.clientY === 0)) openSendMenuAtButton(btn);
    else setSendMenuAt({ pos: { x: e.clientX, y: e.clientY } });
  }

  /* 🔴 Меню «Отправить» держится за кнопку (05.10, APK на S25): клавиатура спряталась или выехала, поле выросло — блок и
     яркая полоса встают заново по живой кнопке, как меню у пузыря (`followBubble`). Раньше меню оставалось там, где кнопка
     была до смены раскладки, — посреди экрана, а само поле уезжало под подложку и гасло. Кнопки не стало — меню долой. */
  const sendSpotOpen = !!sendMenuAt?.spot;
  useEffect(() => {
    if (!sendSpotOpen) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const btn = sendBtn.current;
        if (!btn?.isConnected || btn.getClientRects().length === 0) return setSendMenuAt(null);
        const next = sendSpot(btn);
        setSendMenuAt((cur) => (!cur?.spot || sameSpot(cur.spot, next) ? cur : { spot: next }));
      });
    };
    const form = sendBtn.current?.closest('.composer');
    const watch = form && typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null;
    if (form) watch?.observe(form);
    window.addEventListener('resize', follow);
    window.visualViewport?.addEventListener('resize', follow);
    return () => {
      cancelAnimationFrame(frame);
      watch?.disconnect();
      window.removeEventListener('resize', follow);
      window.visualViewport?.removeEventListener('resize', follow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendSpot читает только кнопку из рефа
  }, [sendSpotOpen]);

  /* Пальцем по меню «Отправить» (пункт или подложка мимо) фокус у поля не забираем (05.10): клавиатура остаётся, как после
     обычной отправки (`keepFocus` у самой кнопки). Нажатие при этом срабатывает — гасим только перенос фокуса. Мышь — как
     было (фокус вернёт `refocusComposer`). */
  const sendMenuOpen = !!sendMenuAt;
  useEffect(() => {
    if (!sendMenuOpen) return;
    const keep = (e: PointerEvent) => {
      if (pressByTouch(e) !== true || !(e.target instanceof Element) || !e.target.closest('.ctx-stack, .ctx-spot')) return;
      e.preventDefault();
    };
    window.addEventListener('pointerdown', keep, true);
    return () => window.removeEventListener('pointerdown', keep, true);
  }, [sendMenuOpen]);

  /**
   * После пункта меню, окна «Отправить позже» и выбора файлов — курсор обратно в поле (ПК: набирать дальше; на телефоне —
   * без клавиатуры).
   */
  function refocusComposer() {
    if (!phoneTaps()) requestAnimationFrame(() => inputRef.current?.focus());
  }

  /** «Отправить без звука» (С3): как обычная отправка, строка очереди — с `silent`. */
  function sendSilent() {
    if (!outbox || composerEdit) return;
    const content = text.trim();
    if (!content && pending.length === 0) {
      // Пустое поле и черновик пересылки — уходит одна пересылка (без звука).
      const fwd = takeFwdDraft();
      if (fwd) void sendFwdDraft(fwd, [], true);
      return;
    }
    // Длинный текст — как у обычной отправки (`send`): куски, ответ у первого; подпись не режется.
    const plan = sendTextPlan(content, pending.length > 0);
    if (plan.kind === 'too-long') {
      toast('error', tooLongText(plan.over, plan.caption));
      return;
    }
    const parts = plan.kind === 'split' ? plan.parts : [plan.text];
    const fwd = takeFwdDraft();
    const keys = parts.map(() => newClientId());
    if (hashtagsOn) rememberSentHashtags(content, meId);
    dropUnreadLine();
    const files = pending;
    const replyTo = replyingTo;
    const noPreview = sendNoPreview(previewOff, previewLink, !!sendFlags && linkPreviewsEnabled());
    if (inputRef.current) inputRef.current.value = '';
    setText('');
    setPending([]);
    setReplyingTo(null);
    requestAnimationFrame(() => stickDown());
    if (fwRef.current?.hasNewer) void goLatest();
    parts.forEach((part, i) =>
      outbox.enqueue({
        key: keys[i]!,
        content: part,
        files: i === 0 ? files : [],
        replyToId: i === 0 ? (replyTo?.id ?? null) : null,
        silent: true,
        ...(noPreview ? { noPreview: true } : {}),
      }),
    );
    if (fwd) void sendFwdDraft(fwd, keys, true);
  }

  /**
   * Отложить (С4): «Отправить позже» (`at`) или «Когда будет в сети» (`null`). Поле пустеет сразу, как при отправке;
   * сервер отказал — текст и ответ возвращаются в поле (если человек там уже не набрал другое) и тост. С вложениями (06.10,
   * `conv10`, только при `sendOn.media`) — так же, и файлы тоже возвращаются в поле, если оно к тому времени без файлов.
   */
  function scheduleDraft(content: string, replyTo: Message | null, at: Date | null, files: File[] = [], silent = false) {
    const withFiles = files.length > 0 && !!sendOn?.media;
    if (!sendOn || (!content && !withFiles)) return;
    // Отложенное не режем (одно сообщение на время): сверх предела — словами, поле остаётся как есть.
    if (content.length > MESSAGE_TEXT_MAX) return void toast('error', tooLongText(content.length - MESSAGE_TEXT_MAX, withFiles));
    if (inputRef.current) inputRef.current.value = '';
    setText('');
    setReplyingTo(null);
    if (withFiles) setPending([]);
    // Пометки окна отправки файлов — только если в отложенное идут его файлы (хоть один; сняли все — пометки пропадают).
    const lf = laterFlags.current;
    laterFlags.current = null;
    const fromBox = withFiles && !!lf && files.some((f) => lf.files.includes(f));
    const spoilers = fromBox ? files.flatMap((f, i) => (lf.spoiled.has(f) ? [i] : [])) : [];
    // G46 (Telegram Web K `ChatInput.scheduleSending` → `openScheduled`): поставил — сразу вид «Отложенные», где видно, что
    // встало в очередь; «Сообщение отложено» отдельной плашкой не нужно.
    sendOn
      // Ответ из другой беседы (G55) отложенные не умеют — уйдёт без ответа; цитата фрагмента — обычным ответом.
      .schedule({
        content,
        replyToId: replyTo && !(replyExtraRef.current?.id === replyTo.id && replyExtraRef.current.foreign) ? replyTo.id : null,
        at,
        ...(withFiles ? { files } : {}),
        ...(silent ? { silent: true } : {}),
        ...(fromBox && lf.asFile ? { asFile: true } : {}),
        ...(spoilers.length > 0 ? { spoilers } : {}),
        ...(fromBox && lf.captionAbove && content ? { captionAbove: true } : {}),
      })
      .then(() => sendOn.openScheduled())
      .catch((err: unknown) => {
      setText((cur) => (cur.trim() ? cur : content));
      if (replyTo) setReplyingTo((cur) => cur ?? replyTo);
      if (withFiles) setPending((cur) => (cur.length > 0 ? cur : files));
      toastError(err, 'Не удалось отложить сообщение');
    });
  }

  function onMicDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Не забираем фокус у поля: открытая клавиатура не должна схлопываться под пальцем.
    e.preventDefault();
    const path = voiceCancelPath(window.innerWidth);
    const st = voice.getState();
    // Задержка — только перед НОВОЙ записью: касание кнопки при идущей/слушаемой записи («отправить») ждать не должно.
    if (roundOkRef.current && !phonePressRef.current && !st.recording && !st.preview && !st.recBusy && !st.holdUi) {
      // С кружками (Android `hasRecordVideo`): запись — после VOICE_HOLD.startDelayMs удержания; координаты — от касания.
      const pend = { id: e.pointerId, x: e.clientX, y: e.clientY, path, timer: 0 };
      pend.timer = window.setTimeout(() => {
        if (phonePressRef.current !== pend) return;
        phonePressRef.current = null;
        voice.press({ id: pend.id, x: pend.x, y: pend.y }, { path: pend.path });
      }, VOICE_HOLD.startDelayMs);
      phonePressRef.current = pend;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* без захвата жест доведётся, пока палец над кнопкой */
      }
      return;
    }
    if (voice.press({ id: e.pointerId, x: e.clientX, y: e.clientY }, { path }) !== 'hold') return;
    // Захват — чтобы палец, уехавший с кнопки вверх или влево, продолжал вести жест.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* без захвата жест доведётся, пока палец над кнопкой */
    }
  }

  function onMicMove(e: React.PointerEvent<HTMLButtonElement>) {
    voice.move({ id: e.pointerId, x: e.clientX, y: e.clientY });
  }

  function onMicUp(e: React.PointerEvent<HTMLButtonElement>) {
    const pend = phonePressRef.current;
    if (pend && pend.id === e.pointerId) {
      // Отпустил до начала записи — только смена режима (Android: `onSwitchRecordMode`), ни камеры, ни микрофона.
      phonePressRef.current = null;
      clearTimeout(pend.timer);
      toggleRoundMode();
      return;
    }
    voice.release({ id: e.pointerId });
  }

  /** Жест оборвала система (входящий звонок, запрос разрешения) — сказанное не отправляем. */
  function onMicAbort(e: React.PointerEvent<HTMLButtonElement>) {
    const pend = phonePressRef.current;
    if (pend && pend.id === e.pointerId) {
      phonePressRef.current = null;
      clearTimeout(pend.timer);
      return;
    }
    voice.abort({ id: e.pointerId });
  }

  /**
   * Компьютер, кнопка микрофона в строке ввода (Telegram Desktop `VoiceRecordBar`): держишь дольше 120 мс — пишет, пока
   * держишь; отпустил над полосой записи или строкой ввода — отправил, вне их — отмена; вверх — запись без рук. Клик
   * короче 120 мс — запись без рук сразу (как Telegram Web K: клик по микрофону начинает запись).
   */
  function onDeskMicDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const prev = micPressRef.current;
    if (prev) {
      if (!prev.held || voice.getState().holdUi) return;
      // Прошлый жест кончился замком: кнопка пропала из-под курсора, и событие потери захвата до неё не дошло.
      micPressRef.current = null;
    }
    e.preventDefault();
    const id = e.pointerId;
    const x = e.clientX;
    const y = e.clientY;
    try {
      e.currentTarget.setPointerCapture(id);
    } catch {
      /* без захвата жест доведётся, пока курсор над кнопкой */
    }
    const press = { id, held: false, timer: 0 };
    press.timer = window.setTimeout(() => {
      press.held = true;
      if (voice.press({ id, x, y }, { desktop: true }) !== 'hold') micPressRef.current = null;
    }, VOICE_DESKTOP.holdDelayMs);
    micPressRef.current = press;
  }

  function onDeskMicMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (micPressRef.current?.held) voice.move({ id: e.pointerId, x: e.clientX, y: e.clientY });
  }

  function onDeskMicUp(e: React.PointerEvent<HTMLButtonElement>) {
    const press = micPressRef.current;
    if (!press || press.id !== e.pointerId) return;
    micPressRef.current = null;
    if (!press.held) {
      clearTimeout(press.timer);
      void voice.start();
      return;
    }
    // «В поле» — полоса записи или строка ввода под курсором (у Telegram Desktop — полоса записи, `_inField`).
    const under = document.elementFromPoint(e.clientX, e.clientY);
    voice.release({ id: e.pointerId, outside: !under?.closest('.voice-rec, .composer') });
  }

  /**
   * С кружками (`roundOk`, G68) клик короче 120 мс — переключатель «микрофон ↔ камера» (tdesktop `VoiceRecordBar`: клик по кнопке
   * меняет режим), а не запись без рук; удержание — как раньше (`onDeskMicUp`).
   */
  function onDeskMicUpRound(e: React.PointerEvent<HTMLButtonElement>) {
    const press = micPressRef.current;
    if (roundOkRef.current && press && press.id === e.pointerId && !press.held) {
      micPressRef.current = null;
      clearTimeout(press.timer);
      toggleRoundMode();
      return;
    }
    onDeskMicUp(e);
  }

  function onDeskMicAbort(e: React.PointerEvent<HTMLButtonElement>) {
    const press = micPressRef.current;
    if (!press || press.id !== e.pointerId) return;
    micPressRef.current = null;
    clearTimeout(press.timer);
    if (press.held) voice.abort({ id: e.pointerId });
  }

  /** Клик без указателя — только клавиатура (у настоящего касания `detail` ≥ 1): запись без рук. */
  function onMicClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (e.detail !== 0) return;
    voice.keyboardClick();
  }

  /** Отправить стикер. Открытый пикер закрываем СРАЗУ: ждать сети с раскрытой панелью — это залипание. */
  async function sendSticker(s: Sticker) {
    setPicker(null);
    try {
      await onSendSticker?.(s.id);
      onStickerUsed?.(s);
    } catch (err) {
      toastError(err);
    }
  }

  function onEmojiPick(emoji: string, customEmoji?: ServerEmoji) {
    if (!picker) return;
    // В композер уходит `:имя:` — текст сообщения хранится как есть, а картинка подставляется
    // при отрисовке. В реакцию уходит `custom:<id>`: имя переименуемо, id — нет (#18).
    if (picker.kind === 'composer') insertIntoComposer(emoji);
    else onReact?.(picker.messageId, customEmoji ? customReactionKey(customEmoji.id) : emoji, 'add');
    setPicker(null);
  }

  /**
   * Эмодзи из панели — в поле ввода НА МЕСТО КАРЕТКИ, поверх выделенного (07.10, сверка 02·6.1; раньше дописывался в
   * конец). Каретка встаёт за вставленным; фокус — как после пунктов меню у поля (`refocusComposer`): на ПК в поле, на
   * телефоне без клавиатуры (решение приёмки 05.10).
   */
  function insertIntoComposer(piece: string) {
    const el = inputRef.current;
    const r = insertAtCaret(text, piece, el ? el.selectionStart : null, el ? el.selectionEnd : null);
    setText(r.text);
    requestAnimationFrame(() => {
      const f = inputRef.current;
      if (!f) return;
      if (!phoneTaps()) f.focus();
      f.setSelectionRange(r.caret, r.caret);
    });
  }

  function copyMessageText(content: string) {
    navigator.clipboard
      ?.writeText(content)
      // Android 13+ сам показывает «скопировано» — наш тост там второй, поверх поля (`copyConfirm.ts`).
      .then(() => toastCopied('Текст скопирован'))
      .catch(() => toast('error', 'Не удалось скопировать'));
  }

  /**
   * «Копировать изображение» (меню фото, раунд 12): картинка в буфер обмена (`imageActions.copyImage`). Приложение на
   * телефоне: `systemNotice` от натива — Android 13+ уже показал свою плашку «Скопировано», второго подтверждения не нужно.
   */
  function copyPhoto(a: Attachment) {
    copyImage(a).then(
      (r) => {
        if (!r.systemNotice) toastCopied('Изображение скопировано');
      },
      () => toast('error', 'Не удалось скопировать изображение'),
    );
  }

  /** «Сохранить как…» / «Сохранить в галерею» (меню фото): файл с исходным именем — путём «Скачать» у вложения, на телефоне — натив (`imageActions.saveImage`). */
  function savePhoto(a: Attachment) {
    saveImage(a).catch(() => toast('error', 'Не удалось сохранить изображение'));
  }

  /* Строки «в пути» под лентой. Событие шлюза с настоящим сообщением часто приходит РАНЬШЕ ответа на запрос — тогда на
     время пинга в ленте стояли бы два одинаковых. Своё сообщение с тем же текстом после момента отправки = это оно,
     строку «в пути» уже не рисуем. */
  const inFlight = (outbox ? outbox.items : outgoing.filter((o) => o.feedId === feedId)).filter((o) => {
    // Беседы ЛС (этап 2): сообщение несёт id отправки — узнаём своё точно, и с одними файлами тоже.
    if (messages.some((m) => (m as { clientId?: string | null }).clientId === o.key)) return false;
    if (outbox || o.status !== 'sending' || !o.content) return true;
    const from = 'afterId' in o && o.afterId ? messages.findIndex((m) => m.id === o.afterId) + 1 : 0;
    return !messages.slice(from).some((m) => m.author.id === meId && m.content === o.content);
  });
  /* Пузыри: строки «в пути» группируются тем же правилом, что сохранённые (`isGrouped` / `endsGroup` — автор, пауза,
     ответ, день), и с последним сохранённым тоже: серия своих — одна группа, хвостик у последнего в ней (ревью раунда
     10). Время у строки «в пути» — момент отправки; его нет (не бывает, страховка) — «сейчас». */
  // Размер фото «в пути» стал известен (меряется на устройстве) — перерисовать: пузырь встаёт кадром (`OutgoingAttachments`).
  useLocalDims();
  /* Счётчик у кнопки (07.10, Telegram 10.3): только где текст не режется — правка и подпись к вложениям; с остатка 100,
     сверх предела «−N». Новое сообщение без вложений режется само — счётчика нет. */
  const sendCounter = composerCounter(text.trim().length, !!composerEdit || pending.length > 0);
  const outAts = bubbles ? inFlight.map((o) => outSentAt(o) ?? Date.now()) : [];
  const outRows: ListMessage[] = outAts.map((at, j) => ({
    createdAt: new Date(at).toISOString(),
    authorId: meId ?? '',
    hasReply: false, // строки «в пути» есть только у пузырей, а там ответ серию не рвёт (`MessageList`)
  }));
  const lastMsg = messages[messages.length - 1];
  const lastRow: ListMessage | undefined = lastMsg
    ? { createdAt: lastMsg.createdAt, authorId: lastMsg.author.id, hasReply: !bubbles && !!lastMsg.replyTo }
    : undefined;
  /* Строка «в пути» стала «не отправлено» — под пузырём встаёт строка «Не отправлено · Повторить». У низа ленты её надо
     показать: она уходила под поле ввода, и неотправленное замечали не сразу (стенд 05.10, к замечанию владельца «„Не
     отправлено“ появилось очень нескоро»). Читает выше — не трогаем. */
  const outFailed = bubbles ? inFlight.filter((o) => o.status !== 'sending').length : 0;
  useLayoutEffect(() => {
    if (!outFailed || !nearBottomRef.current) return;
    if (holdFeedRef.current) stickAfterMenu.current = true;
    else stickDown();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stickDown читает только ref ленты
  }, [outFailed]);
  // Мой аватар у строки «в пути» (широкая лента пузырей): имя — тем же резолвером, что у сообщений.
  const myName = meId ? nameOf(meId, me?.displayName ?? '') : '';
  const myCard = (): UserMenuTarget => ({ userId: meId ?? '', name: myName, avatarUrl: me?.avatarUrl ?? null });
  /* Выделение (раунд 12): выбранные по порядку ленты; одно — «Ответить» внизу, а своё и не пересланное — ещё «Изменить» в
     шапке; «Скопировать» — если в выбранном есть текст. */
  const pickedList = selecting ? messages.filter((x) => pickedSet.has(x.id)) : [];
  const pickedOne = pickedList.length === 1 ? pickedList[0] : undefined;
  const pickedEdit = pickedOne && pickedOne.author.id === meId && !pickedOne.forwardedFrom && !pickedOne.sticker ? pickedOne : undefined;
  const pickedHasText = pickedList.some((x) => !!x.content.trim());
  const pickedIds = pickedList.map((x) => x.id);
  // Подписи панели выбора не режутся многоточием при крупном системном шрифте (textZoom WebView мимо `@container`) — `useSelBarFit.ts`.
  const selBarRef = useRef<HTMLDivElement>(null);
  useSelBarFit(selBarRef, `${selecting ? 1 : 0}|${pickedIds.length}|${pickedOne && !composerReplacement ? 1 : 0}`);
  // Клавиши Ctrl+C / Delete берут выбранное отсюда (слушатель окна живёт дольше одной отрисовки). «Скопировать» без текста
  // у выбранных молчит — как кнопка в шапке, которой тогда нет.
  selActs.current = {
    copy: () => {
      if (pickedHasText) copyPicked(pickedList);
    },
    del: () => void deletePicked(pickedList),
  };

  /**
   * Панель эмодзи / стикеров / GIF: всплывающая у якоря (`isDocked` = false) или закреплённая колонкой (G61, `exprDock.ts`) —
   * тогда закрывать её нечем (кнопка смайлика в строке ввода), а выбор эмодзи не закрывает панель.
   */
  const renderExpr = (pk: NonNullable<typeof picker>, isDocked: boolean) => {
    const closePk = () => {
      if (!isDocked) setPicker(null);
    };
    // Вкладки — только в строке ввода и только если стикеры тут есть. Реакции остаются
    // эмодзи: стикер реакцией не бывает, а в ЛС наборов нет вовсе.
    // Вкладка «GIF» (`gifs1`, Р-7): как у Telegram «Эмодзи | Стикеры | GIF» (`tabbed_selector.cpp`).
    const tabs =
      pk.kind === 'composer' && (canSticker || !!onSendGif) ? (
        <ExprTabs tab={exprTab} onTab={setExprTabState} stickers={canSticker} gifs={!!onSendGif} />
      ) : undefined;
    if (tabs && exprTab === 'gifs' && onSendGif)
      return (
        <GifPicker
          anchor={pk.anchor}
          docked={isDocked}
          onPick={(g) => {
            closePk();
            void onSendGif(g).catch(toastError);
          }}
          onClose={() => closePk()}
          footer={tabs}
        />
      );
    return tabs && exprTab === 'stickers' && canSticker ? (
      <StickerPicker
        anchor={pk.anchor}
        docked={isDocked}
        packs={stickerPacks ?? []}
        onPick={(st) => void sendSticker(st)}
        onClose={() => closePk()}
        footer={tabs}
        recent={stickerRecent}
        catalog={stickerCatalog}
        faved={stickerCatalog ? dmFaved : undefined}
        onFave={stickerCatalog ? (st, on) => void faveSticker(st, on) : undefined}
        onOpenSet={
          stickerCatalog
            ? (st) => {
                const ds = useDmStickers.getState();
                closePk();
                ds.openSet({ sticker: st, send: ds.sender ?? undefined });
              }
            : undefined
        }
      />
    ) : (
      <EmojiPicker
        anchor={pk.anchor}
        anchorEl={pk.kind === 'composer' ? pk.el : undefined}
        docked={isDocked}
        onPick={isDocked ? insertIntoComposer : onEmojiPick}
        onClose={() => closePk()}
        custom={customEmojis}
        footer={tabs}
      />
    );
  };

  return (
    /* «Данные и память» (G32): вложения ленты спрашивают у правила автозагрузки, откуда они — ЛС, группа или канал. */
    <AutoDownloadSource.Provider value={serverId ? 'channel' : groupChat ? 'group' : 'dm'}>
    <div
      ref={setChatEl}
      className={`chat${dragOver ? ' drag-over' : ''}${docked ? ' has-expr-dock' : ''}${exprUnder ? ' has-expr-under' : ''}${
        liftUp ? ' expr-up' : ''
      }${exprLift.drag !== null ? ' expr-dragging' : ''}`}
      style={exprUnder ? ({ '--expr-lift': `${liftExtra}px` } as CSSProperties) : undefined}
      onDragEnter={(e) => {
        // Текст из другого поля тоже «перетаскивается» — рамку показываем только для файлов.
        if (![...e.dataTransfer.types].includes('Files') || filesBlocked) return;
        dragDepth.current += 1;
        setDragOver(true);
        // Две зоны броска (G37): в `dragenter` видны только типы файлов, по ним и выбираем вид (`dropKind`).
        if (dragDepth.current === 1 && outbox && !phoneLayout && !composerEdit && !boxNow.current) {
          const kinds = [...e.dataTransfer.items].filter((it) => it.kind === 'file').map((it) => it.type);
          setDropInfo({ kind: dropKind(kinds), zone: 'top' });
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dropInfo || dropInfo.kind === 'files') return;
        const r = e.currentTarget.getBoundingClientRect();
        const zone = zoneAt(e.clientY, r.top, r.height, true);
        if (zone !== dropInfo.zone) setDropInfo({ ...dropInfo, zone });
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setDragOver(false);
          setDropInfo(null);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        // Верхняя зона — без сжатия, нижняя — быстро (`wayForZone`); одна зона и бросок в уже открытое окно способ не задают.
        const way = dropInfo && dropInfo.kind !== 'files' ? wayForZone(dropInfo.zone) : undefined;
        setDropInfo(null);
        // Папка (ровно одна) собирается в `<папка>.zip` и встаёт в окно отправки как один файл (`folderZip.ts`); без папок — как раньше.
        const dropFeed = feedId;
        const got = filesBlocked || composerEdit ? Array.from(e.dataTransfer.files) : collectDrop(e.dataTransfer);
        if (Array.isArray(got)) addFiles(got, way ? { way } : undefined);
        else
          void got.then((zip) => {
            if (feedNow.current === dropFeed) addFiles(zip, way ? { way } : undefined);
            else if (zip.length > 0) toast('info', 'Архив собран, но беседа уже другая — бросьте папку заново');
          });
      }}
    >
      {dragOver &&
        (dropInfo ? (
          <div className="drop-zones" aria-hidden>
            {(() => {
              const t = dropTexts(dropInfo.kind);
              return (
                <>
                  <div className={`drop-zone${dropInfo.zone === 'top' ? ' on' : ''}`} data-zone="top">
                    <Icon name="paperclip" size={28} />
                    <b>{t.top.title}</b>
                    <span>{t.top.hint}</span>
                  </div>
                  {t.bottom && (
                    <div className={`drop-zone${dropInfo.zone === 'bottom' ? ' on' : ''}`} data-zone="bottom">
                      <Icon name="paperclip" size={28} />
                      <b>{t.bottom.title}</b>
                      <span>{t.bottom.hint}</span>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        ) : (
          !box && (
            <div className="drop-hint" aria-hidden>
              <Icon name="paperclip" size={28} />
              <span>Отпустите — прикрепим к сообщению</span>
            </div>
          )
        ))}
      {box && (
        <SendFilesBox
          files={box.files}
          caption={box.caption}
          way={box.way}
          saved={box.saved}
          menu={{ silent: !!sendOn?.silent, later: !!sendOn?.later && !!sendOn.media }}
          media2={!!mediaFlags}
          onceItems={
            mediaOnce ? (current, choose, back) => <OnceTimerItems current={current} onChoose={choose} onBack={back} /> : undefined
          }
          onFiles={(files) => patchBox((b) => ({ ...b, files }))}
          onAdd={() => fileRef.current?.click()}
          onCancel={closeBox}
          onSend={(r) => void sendFromBox(r)}
        />
      )}
      {/* Верх беседы (tg3, #218): шапка и верхние полосы одним слоем. ПК — `display: contents`, раскладка прежняя (Telegram
          Desktop: полоса закрепа во всю ширину под шапкой). Телефон — слой поверх ленты, лента идёт под ним, как у Telegram Android
          12.x: `ChatActivity.java:7784` (`topPanelLayout` поверх `contentView`), отступ ленты `:11943-11953`. Высоту слоя
          меряет `chatTopRef` → `--chat-top-h` у `.chat`. */}
      <div className="chat-top" ref={chatTopRef}>
      {selecting ? (
        /* Раунд 12, выделение (HANDOFF §6, макеты `*-select-*`): «Выбрано N» и действия над выбранным. ПК — крестик первой
           кнопкой шапки (и Esc); телефон — крестик на месте «назад» (`MainLayout`). */
        <div className="channel-topbar sel-head">
          {!phoneLayout && (
            <button
              type="button"
              className="topbar-btn"
              aria-label="Выйти из выделения"
              title="Выйти из выделения · Esc"
              onClick={dropPicks}
            >
              <Icon name="close" size={18} />
            </button>
          )}
          <div className="topbar-title">
            <strong className={selShake ? 'sel-count shake' : 'sel-count'}>Выбрано {picked.length}</strong>
          </div>
          <div className="topbar-actions">
            {pickedEdit && (
              <button
                type="button"
                className="topbar-btn"
                aria-label="Изменить"
                title="Изменить"
                onClick={() => editPicked(pickedEdit)}
              >
                <Icon name="edit" size={18} />
              </button>
            )}
            {pickedHasText && (
              <button
                type="button"
                className="topbar-btn"
                aria-label="Скопировать"
                title="Скопировать"
                onClick={() => copyPicked(pickedList)}
              >
                <Icon name="copy" size={18} />
              </button>
            )}
            {pinsOn && pickedList.some((x) => pinnedIds.has(x.id)) && (
              <button
                type="button"
                className="topbar-btn"
                aria-label="Открепить"
                title="Открепить"
                onClick={() => void unpinPicked(pickedList)}
              >
                <Icon name="pin-off" size={18} />
              </button>
            )}
            <button
              type="button"
              className="topbar-btn"
              aria-label="Переслать"
              title={`Переслать ${picked.length}`}
              onClick={() => openForward(pickedIds)}
            >
              <Icon name="forward" size={18} />
            </button>
            {/* «Удалить» из шапки убрано (решение владельца 08.10): удаление — «Удалить N» в нижней панели выделения. */}
            {/* Одно выбранное — «⋯»: его меню целиком (`menuPicked`). */}
            {pickedOne && (
              <button
                type="button"
                className="topbar-btn"
                aria-label="Меню сообщения"
                title="Ещё"
                onClick={() => menuPicked(pickedOne)}
              >
                <Icon name="more" size={18} />
              </button>
            )}
          </div>
        </div>
      ) : cs.open ? (
        <ChatSearchHead cs={cs} />
      ) : (
        <div className="channel-topbar">
          {title}
          {headerActions ? <span className="topbar-actions">{headerActions}</span> : null}
        </div>
      )}
      {/* Капсула верхних полос (телефон): плашка незнакомца, плеер, закреп — одним стеклом с полями 7 px и радиусом до 18 px
          (`ChatActivityTopPanelLayout.java:65-79`, поля — `ChatActivity.java:46505`). Пустая — не видна (`:empty`). */}
      <div className="top-capsule">
      {topBar}
      {/* Плашка «Вы транслируете геопозицию · Остановить» (`geolive1`) — только в беседе, где трансляция идёт. */}
      <GeoLiveBar conversationId={feedId} />
      {/* Полоса плеера голосовых (07.10): над закрепом, как у Telegram; живёт, пока играет, в любой ленте. */}
      <VoiceTopBar feedId={feedId} onJump={(id) => void jumpToMessage(id)} />
      {pinCur && (
        /* Раунд 12, порция 7 — полоса закрепа под шапкой (HANDOFF §2.3, §10; макеты `*-pins-*`): одно закреплённое —
           справа «Открепить», несколько — «Все закреплённые» (поповер `.pins-pop` раунда 7, строки без аватаров, новые
           сверху). Подложка под поповером — наша: щелчок мимо закрывает список (и по кнопке полосы — тоже). */
        <PinnedBar
          count={pinCount}
          index={pinIndex}
          text={pinPreview(pinCur.message)}
          thumb={pinCur.thumb}
          thumbSpoiler={pinCur.thumbSpoiler === true}
          onOpen={() => openPinned(pinCur.message.id)}
          onUnpin={pinCount === 1 ? () => void unpinMessage(pinCur.message.id) : undefined}
          onList={pinCount > 1 ? togglePinsList : undefined}
          onNext={pinCount > 1 ? nextPinned : undefined}
          onLongPress={pinCount > 1 ? togglePinsList : undefined}
          listOpen={pinsListShown}
        >
          {pinsListShown && (
            <>
              <div
                className="pins-backdrop"
                onClick={() => {
                  if (Date.now() - pinsOpenedAt.current < 450) return;
                  setPinsListOpen(false);
                }}
              />
              <DmPinsList
                items={[...pinList].reverse().map((p) => ({
                  id: p.message.id,
                  author: p.message.authorId === meId ? myName : (deletePeerName ?? ''),
                  when: pinWhenLabel(p.message.createdAt),
                  text: pinPreview(p.message, true),
                }))}
                onOpen={(id) => {
                  setPinsListOpen(false);
                  openPinned(id);
                }}
                onUnpin={(id) => void unpinMessage(id)}
                onUnpinAll={() => void unpinAll()}
                onHide={() => void hidePins()}
              />
            </>
          )}
        </PinnedBar>
      )}
      </div>
      </div>
      {/* Обёртка ленты — ВСЕГДА, и в каналах: её класс меняется с пузырями, а сама она — нет. Пересоздай ленту при
          переключении пузырей — отвалились бы слушатели, которые эффекты вешают на неё один раз (`wheel`, `load`). */}
      <div className={bubbles ? 'feed-frame bub-feed' : 'feed-frame'}>
        <div
          // `sel-mode` — режим выделения (раунд 12): кружки слева, пузыри отъезжают на колонку кружков (CSS «Раунд 12» §3).
          // `swipes` — у пузырей есть свайп-ответ (порция 6): на телефоне браузер сам ведёт по ним только вертикаль (§4).
          className={`${bubbles ? (bubLeft ? 'messages bubbles bub-left' : 'messages bubbles') : 'messages'}${selecting ? ' sel-mode' : ''}${
            swipeReply ? ' swipes' : ''
          }${chatSearch ? ' day-pick' : ''}`}
          ref={listRef}
          // Выделение мышью (замечание владельца 05.10): удержание над сообщением и протяжка рядом с сообщениями.
          onPointerDown={onSelPointerDown}
          onDragStart={onMsgDragStart}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = isNearBottom(el);
            nearBottomRef.current = near;
            setNearBottom(near);
            setFarFromEnd(isFarFromBottom(el));
            if (near) setUnseenBelow(0);
            scheduleSeen();
            trackPinned();
            const fw = fwRef.current;
            if (fw) {
              followHeld();
              savePlaceSoon();
              dropReachedJumps();
              // Окно не у хвоста и человек у его низа — тянем новее (якорь держит место, верх окна обрежется).
              if (near && fw.hasNewer) loadNewer();
            } else if (chanHeld.current) {
              // Без окна: человек листает, пока идёт подгрузка, — держим его новое место, а не то, где она началась.
              chanHeld.current = captureChanAnchor() ?? chanHeld.current;
            }
            // Долистали почти до начала загруженного — тянем следующую порцию.
            if (!onLoadOlder) return;
            const more = fw ? fw.hasOlder : hasOlder.current;
            if (!shouldLoadOlder({ scrollTop: el.scrollTop, loading: olderBusy.current, hasMore: more })) return;
            if (fw) {
              loadOlderWindowed();
              return;
            }
            olderBusy.current = true;
            /* Строку у кромки — сейчас, в событии прокрутки: подсказки ещё нет, это то, что человек видит. Держат её два
               эффекта выше («встала подсказка», «пришла порция»); прежняя поправка разницей высот кадром позже — не нужна. */
            const op = ++chanOp.current;
            chanHeld.current = captureChanAnchor();
            setShowOlderHint(true);
            void onLoadOlder()
              .then((more) => {
                hasOlder.current = more;
              })
              .catch(() => {
                // Не вышло — просто перестаём просить, чтобы не долбить сервер на каждом пикселе.
                hasOlder.current = false;
              })
              .finally(() => {
                olderBusy.current = false;
                setShowOlderHint(false);
                // Порция уже в ленте (стор обновляется синхронно) — отпускаем после кадра, когда её разметка точно применена.
                requestAnimationFrame(() => {
                  if (chanOp.current === op) chanHeld.current = null;
                });
              });
          }}
        >
          {showOlderHint && <div className="older-hint">Подтягиваем историю…</div>}
          {messages.length === 0 &&
            (loading ? (
              <MessageSkeletons />
            ) : (
              emptyState ?? (
                <div className="empty-goose">
                  <Goose pose="head-sleepy" size={120} />
                  <div className="eg-title">Тут пока тихо</div>
                  <div className="eg-sub">Напишите первое сообщение — гусь подождёт.</div>
                </div>
              )
            ))}
          <MessageList
            messages={messages}
            meId={meId}
            // Черта «Новые сообщения» — до моего первого сообщения в этом визите (`unreadDropped`).
            newSince={unreadDropped ? null : newSince}
            readKey={feedWindow ? (unreadDropped ? null : feedWindow.readKey) : undefined}
            menuId={msgMenu?.m.id}
            pickerId={picker?.kind === 'msg' ? picker.messageId : undefined}
            // Телефон: шторка действий и правка в поле — видно, к какому сообщению они относятся (#212).
            composerEditId={composerEdit?.id}
            nameOf={nameOf}
            animatedOf={animatedOf}
            guestHomeOf={guestHomeOf}
            viaNames={viaNames}
            crownId={crownId}
            canReact={!!onReact}
            canBig={!!onReact && !!onReactBig}
            kbChannel={botChannelId}
            canDeleteOthers={deletePeerName !== undefined}
            onEmoji={onEmoji}
            emojiById={emojiById}
            act={rowActs}
            bubbles={bubbles}
            avatars={bubLeft}
            groupChat={groupChat}
            quoteNames={quoteNames}
            pressingId={pressingId}
            byId={msgById}
            pinTails={pinTails}
            onRedial={onRedial}
            outAt={outAts[0] ?? null}
            outReply={false}
            peerReadKey={bubbles ? peerReadKey : null}
            selecting={selecting}
            picked={pickedSet}
            forwards={bubbles}
            swipingId={swipingId}
          />
          {inFlight.map((o, j) => {
            const files = outgoingFilesLabel(('fileNames' in o && o.fileNames) || o.files.map((f) => f.name));
            if (bubbles) {
              /* Пузыри (раунд 10): состояние — отметкой у времени, как у отправленного: часы (если сервер молчит
                 дольше секунды) или красный кружок; под неотправленным — строка «Не отправлено · Повторить» (причина —
                 в подсказке и в листе). «Удалить» и «Повторить отправку» — в листе (телефон) и в меню (ПК); открывают
                 их долгое нажатие, правый клик и сама «Не отправлено» — кнопка (`openOutActions`). Эмодзи без
                 текста и файлов — крупно уже в пути: иначе на ответе сервера пузырь со смайликом превращался бы в
                 крупный смайлик без пузыря — заметный прыжок. */
              const jumbo = !files && o.content ? emojiOnlyCount(o.content) : 0;
              /* Вложения «в пути» (07.10): фото и видео — миниатюрой с устройства, файлы — карточкой; поверх — кольцо загрузки с
                 крестиком «Отменить отправку» (Telegram FA-01). Пузырь — того же вида, что будет у сообщения (`bubbleLook`).
                 Файлов уже нет (строка с диска после перезапуска) — прежняя подпись со скрепкой. */
              const local = o.files.length > 0 ? localAttachments(o.files) : null;
              const look = local
                ? bubbleLook(
                    { content: o.content, attachments: local, replyTo: null, poll: null, sticker: null, forwardedFrom: null } as Pick<
                      Message,
                      'content' | 'attachments' | 'replyTo' | 'poll' | 'sticker' | 'forwardedFrom'
                    >,
                    ATT_IMG_MAX_W,
                    ATT_IMG_MAX_H,
                  )
                : null;
              const media = look?.kind === 'media';
              // «Подпись над медиа» (G48): у строки «в пути» — тот же порядок, что будет у сообщения; время — поверх фото.
              const capUp = media && !!o.content && 'captionAbove' in o && o.captionAbove === true;
              const metaOver = media && (!o.content || capUp);
              const failed = o.status !== 'sending';
              // Подсказка «Не отправлено»: причина (раньше висела на тексте) и что в меню; «скопировать» — если есть текст.
              const failHint = `${o.error ? `Не отправлено: ${o.error}. ` : ''}${
                o.content ? 'Повторить, скопировать или удалить' : 'Повторить или удалить'
              }`;
              const sentMs = outSentAt(o);
              const sentAt = sentMs === null ? '' : TIME_FMT.format(new Date(sentMs));
              const meta = <BubbleMeta time={sentAt} over={metaOver} status={failed ? 'failed' : 'sending'} />;
              const metaInBody = !!o.content && !jumbo && (!files || media) && !capUp;
              /* Группа — как у сохранённых (ревью раунда 10): после чужого — с отступом группы, серия своих — одна
                 группа и с последним сохранённым, хвостик (а в широкой ленте и мой аватар) — у последнего в ней. День
                 сменился (отправка после полуночи, пустая беседа) — пилюля дня, как будет у сохранённого: без
                 прыжка. */
              const row = outRows[j];
              const prevRow = j ? outRows[j - 1] : lastRow;
              const tail = endsGroup(row, outRows[j + 1]);
              const myAvatar =
                tail && meId ? (
                  <span
                    className="msg-ava"
                    onClick={(e) => openUserMenu(e, myCard(), 'profile')}
                    onContextMenu={(e) => openUserMenu(e, myCard())}
                  >
                    <Avatar url={me?.avatarUrl ?? null} animatedUrl={animatedOf(meId)} name={myName} size={34} />
                  </span>
                ) : null;
              const attNode = local ? (
                <div
                  className={look?.album ? albumClass(look.album) : 'attachments'}
                  style={look?.album && local ? (albumStyleOf(local, ATT_IMG_MAX_W, ATT_IMG_MAX_H) as React.CSSProperties | undefined) : undefined}
                >
                  <OutgoingAttachments
                    rowKey={o.key}
                    files={o.files}
                    uploaded={'uploaded' in o ? (o as { uploaded?: readonly unknown[] }).uploaded : undefined}
                    spoilers={'spoilers' in o ? (o as { spoilers?: readonly number[] }).spoilers : undefined}
                    sending={!failed}
                    fill={!!look?.album}
                    onCancel={onCancelRow}
                  />
                  {metaOver ? meta : null}
                </div>
              ) : null;
              const bodyNode = o.content ? (
                <div className="message-body">
                  {renderContent(o.content, meId ?? null, '', onEmoji)}
                  {metaInBody ? meta : null}
                </div>
              ) : null;
              return (
                <Fragment key={o.key}>
                  {isNewDay(row, prevRow) && <DayDivider label={dayLabel(row.createdAt)} pill />}
                  <MessageBubble
                    side="out"
                    grouped={isGrouped(row, prevRow)}
                    tail={tail}
                    avatar={bubLeft ? myAvatar : undefined}
                    kind={media ? 'media' : jumbo ? 'emoji' : 'text'}
                    jumbo={jumbo}
                    mediaWidth={media ? look?.mediaWidth : undefined}
                    mediaEnd={metaOver}
                    active={outSheet === o.key || outMenu?.key === o.key}
                    className={`outgoing ${o.status}${pressingId === o.key ? ' pressing' : ''}`}
                    aria-live="polite"
                    /* Меню строки — и у отправляемой (07.10): «Скопировать текст» и «Отменить отправку» (Telegram 1.24, 2.35);
                       у неотправленной — как было. */
                    onContextMenu={(e) => {
                      if ((e.target as Element).closest('a, button')) return;
                      e.preventDefault();
                      openOutMenu(o.key, e);
                    }}
                    // Раунд 12: на телефоне тап по строке «в пути» — её меню у пузыря, как у остальных.
                    onClick={(e) => onOutTap(e, o.key)}
                    onTouchStart={(e) => onOutTouchStart(e, o.key)}
                    onTouchMove={onMsgTouchMove}
                    onTouchEnd={cancelLongPress}
                    onTouchCancel={cancelLongPress}
                  >
                    {capUp ? bodyNode : null}
                    {attNode}
                    {capUp ? null : bodyNode}
                    {files && !local && (
                      <div className="outgoing-files muted">
                        <Icon name="paperclip" size={13} /> {files}
                      </div>
                    )}
                    {metaInBody || metaOver ? null : <div className="bub-meta-row">{meta}</div>}
                  </MessageBubble>
                  {failed && (
                    <div className="outgoing-state bub-fail">
                      {/* «⚠ Не отправлено» — кнопка действий (повторить, скопировать, удалить): с виду тот же текст. */}
                      <button
                        type="button"
                        className="bub-fail-btn"
                        // Раунд 12: листа неотправленного нет — и на телефоне меню (у пузыря).
                        aria-haspopup="menu"
                        aria-expanded={outMenu?.key === o.key || outSheet === o.key}
                        aria-label="Не отправлено — действия с сообщением"
                        title={failHint}
                        onClick={(e) => openOutActions(o.key, e.currentTarget)}
                      >
                        <Icon name="alert-circle" size={14} />
                        <span>Не отправлено</span>
                      </button>
                      <button type="button" className="link" onClick={() => (outbox ? outbox.retry(o.key) : retryOutgoing(o.key))}>
                        Повторить
                      </button>
                    </div>
                  )}
                </Fragment>
              );
            }
            const inner = (
              <>
                {o.content && <div className="message-body">{renderContent(o.content, meId ?? null, '', onEmoji)}</div>}
                {/* Вложения «в пути» — миниатюрой и карточкой с кольцом загрузки (07.10), без файлов (с диска) — подписью. */}
                {o.files.length > 0 ? (
                  <div className="attachments">
                    <OutgoingAttachments
                      rowKey={o.key}
                      files={o.files}
                      uploaded={'uploaded' in o ? (o as { uploaded?: readonly unknown[] }).uploaded : undefined}
                      sending={o.status === 'sending'}
                      fill={false}
                      onCancel={onCancelRow}
                    />
                  </div>
                ) : (
                  files && (
                    <div className="outgoing-files muted">
                      <Icon name="paperclip" size={13} /> {files}
                    </div>
                  )
                )}
                {o.status === 'sending' ? (
                  <div className="outgoing-state muted">
                    отправляется…
                    <button type="button" className="link" onClick={() => cancelSending(o.key)}>
                      Отменить
                    </button>
                  </div>
                ) : (
                  <div className="outgoing-state error">
                    Не отправлено: {o.error}
                    <button type="button" className="link" onClick={() => (outbox ? outbox.retry(o.key) : retryOutgoing(o.key))}>
                      Повторить
                    </button>
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => (outbox ? outbox.discard(o.key) : setOutgoing((l) => outgoingSent(l, o.key)))}
                    >
                      Удалить
                    </button>
                  </div>
                )}
              </>
            );
            return (
              <div
                key={o.key}
                className={`message grouped outgoing ${o.status}`}
                aria-live="polite"
                // Меню строки «в пути» (07.10): ПКМ на ПК, удержание на телефоне — как у пузырей (плоская лента каналов).
                onContextMenu={(e) => {
                  if ((e.target as Element).closest('a, button')) return;
                  e.preventDefault();
                  openOutMenu(o.key, e);
                }}
                onTouchStart={(e) => onOutTouchStart(e, o.key)}
                onTouchMove={onMsgTouchMove}
                onTouchEnd={cancelLongPress}
                onTouchCancel={cancelLongPress}
              >
                <div className="msg-gutter" />
                <div className="message-main">{inner}</div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
        {/* Плавающая дата пузырей (раунд 10) — сосед ленты, не её содержимое: разделители в ленте остаются обычными. */}
        {bubbles && (
          <FloatingDay
            key={feedId ?? ''}
            listRef={listRef}
            dayOf={dayOfMessage}
            onPick={chatSearch ? (mid) => dayPickRef.current(mid) : undefined}
          />
        )}
        {/* 🔴 Плавающие «Вниз», «Назад» и «Переслано» — внутри обёртки ленты, от ЕЁ низа (приёмка 06.10, п. 2): раньше они
            стояли от низа всего чата на 76 px — под это число было рассчитано одно поле ввода, и полоса «Ответ…» (35 px),
            правка, прикреплённое (106 px) или строка «печатает» оказывались под кнопкой. Теперь кнопка всегда над тем, что
            под лентой. */}
        {/* Обратная сторона прилипания: лента больше не дёргается — значит о новом надо сказать. */}
        {/* Окно беседы: «Вниз» — круглая кнопка в колонке у правого края, как у Telegram (`tdesktop
            history/view/history_view_corner_buttons.cpp`: снизу вверх «вниз» → «@» → «♥», число — кружок над иконкой;
            Android `ChatActivity` `pagedownButton`), видна, когда не у низа. Переход по цитате делает её «назад» по стеку
            (TD `pushReplyReturn` / `downClick`, Android `returnToMessageId`): клик возвращает к месту перехода, Ctrl+клик —
            сразу к новым; отдельной пилюли «Назад» нет. Пока видна плашка «Переслано» (раунд 12) — кнопки нет, как было.
            Колесо над колонкой листает ленту (TD: кнопка «прозрачна» для прокрутки). */}
        {(() => {
          const back = !!feedWindow && jumpStack.length > 0;
          // G26: у хвоста — непрочитанное в ленте (видно и при входе), не у хвоста — счётчик сервера.
          const n = !feedWindow ? 0 : feedWindow.hasNewer ? feedWindow.unreadBelow : onSeen ? unreadInFeed : unseenBelow;
          // Порог — как у Telegram Desktop: 480 px от низа, раньше — только если внизу непрочитанное (`shouldShowCornerDown`).
          const downShown =
            !!feedWindow &&
            shouldShowCornerDown({ far: farFromEnd, nearBottom, hasNewer: feedWindow.hasNewer, back, unread: n }) &&
            !fwdDone &&
            !unpinUndo;
          if (!downShown && cornerBtns.length === 0) return null;
          const downTitle = back ? 'Назад к месту перехода' : n > 0 ? `Перейти в конец: ${jumpDownLabel(n)}` : 'Перейти в конец';
          const wheel = (e: React.WheelEvent) => listRef.current?.scrollBy({ top: e.deltaY });
          // «Вниз» — прямой ребёнок обёртки ленты (как была пилюля), «@» / «♥» — колонкой над ним (`.corner-things.over-down`).
          return (
            <>
              {downShown && (
                <button
                  type="button"
                  className={`corner-btn corner-down jump-down${back ? ' jump-back' : ''}`}
                  title={downTitle}
                  aria-label={downTitle}
                  onClick={(e) => void (back && !(e.ctrlKey || e.metaKey) ? goBack() : goLatest())}
                  onWheel={wheel}
                >
                  <Icon name="chevron-down" size={22} stroke={1.8} />
                  {n > 0 && <span className="corner-count">{n > 99 ? '99+' : n}</span>}
                </button>
              )}
              {cornerBtns.length > 0 && (
            <div
              className={`corner-things${downShown ? ' over-down' : ''}`}
              role="group"
              aria-label="Непрочитанное в беседе"
              onWheel={wheel}
            >
              {cornerBtns.map((b) => (
              <button
                key={b.kind}
                type="button"
                className={`corner-btn ${b.kind}`}
                title={b.title}
                aria-label={b.title}
                onClick={() => void cornerJump(b.kind)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (b.kind === 'reactions' && cornerThings?.onReactionsRead) setCornerMenu({ x: e.clientX, y: e.clientY });
                }}
              >
                <Icon name={b.kind === 'reactions' ? 'heart' : 'at'} size={20} stroke={1.8} />
                <span className="corner-count">{b.label}</span>
              </button>
              ))}
            </div>
              )}
            </>
          );
        })()}
        {cornerMenu && (
          <ContextMenu pos={cornerMenu} onClose={() => setCornerMenu(null)} width={248}>
            <MenuItem
              icon="checks"
              label="Прочитать все реакции"
              onClick={() => {
                setCornerMenu(null);
                cornerThings?.onReactionsRead?.(null);
              }}
            />
          </ContextMenu>
        )}
        {!feedWindow && !fwdDone && !unpinUndo && shouldShowJumpDown({ nearBottom, unseenBelow }) && (
          <button
            type="button"
            className="jump-down"
            onClick={() => {
              const el = listRef.current;
              el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              nearBottomRef.current = true;
              setNearBottom(true);
              setUnseenBelow(0);
            }}
          >
            <Icon name="chevron-down" size={15} />
            {jumpDownLabel(unseenBelow)}
          </button>
        )}
        {/* Раунд 12: «Переслано: <имя>» с «Открыть» — на месте «Вниз», 4 с (HANDOFF §9, макеты `*-fwd-done`). */}
        {/* G28: «Сообщение откреплено» с «Отменить» 5 с (Telegram Android: тост с «ОТМЕНА»); на месте «Вниз», как «Переслано». */}
        {unpinUndo && !fwdDone && (
          <div className="fwd-done" role="status" key={`unpin${unpinUndo.n}`}>
            <Icon name="pin-off" size={16} />
            <span>{unpinUndo.count > 1 ? `Откреплено: ${unpinUndo.count}` : 'Сообщение откреплено'}</span>
            <button type="button" className="link" onClick={undoUnpin}>
              Отменить
            </button>
          </div>
        )}
        {fwdDone && (
          <div className="fwd-done" role="status" key={fwdDone.n}>
            <Icon name="check" size={16} />
            <span>
              {fwdDone.later ? 'Отложено' : 'Переслано'}: <b>{fwdDone.name}</b>
            </span>
            {fwdDone.to && (
              <button type="button" className="link" onClick={() => openForwarded(fwdDone.to!)}>
                Открыть
              </button>
            )}
          </div>
        )}
      </div>
      {typingUsers && typingUsers.length > 0 && (
        <div className="typing-row">
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
          <span className="typing-text">{typingLabel(typingUsers.map((u) => u.name))}</span>
        </div>
      )}
      {/* Раунд 12, выделение: внизу только панель выделения — прикреплённое, ответ, правка и запись ждут выхода из него. */}
      {pending.length > 0 && !selecting && !composerEdit && (
        // Плитки переставляют удержанием и протяжкой пальцем (G49) — свайп «назад» экрана с полосы не начинается.
        <div className="pending-atts" data-no-swipe-back="">
          {pending.map((f, i) => {
            const url = previewUrls.get(f);
            const drop = () => {
              setPending((p) => p.filter((_, j) => j !== i));
              const back = textFileBackup.current;
              if (back && back.file === f) {
                textFileBackup.current = null;
                setText((cur) => (cur.trim() ? cur : back.text));
              }
            };
            const dr = attReorder.drag;
            const lift = dr && dr.from === i;
            const reo = {
              ...attReorder.bind(i),
              onContextMenu: (e: React.MouseEvent) => {
                e.preventDefault();
                if (!phoneLayout) setAttMenu({ file: f, pos: { x: e.clientX, y: e.clientY } });
              },
              style: lift ? { transform: `translate(${dr.dx}px, ${dr.dy}px) scale(0.92)`, zIndex: 2 } : undefined,
            };
            const reoCls = `${lift ? ' lifted' : ''}${dr && dr.over === i && dr.from !== i ? ' over' : ''}`;
            const more = phoneLayout && (
              <button
                type="button"
                className="pt-more"
                data-no-reorder=""
                title="Ещё"
                aria-label={`Ещё: ${f.name}`}
                onClick={(e) => setAttMenu({ file: f, anchor: e.currentTarget.getBoundingClientRect() })}
              >
                <Icon name="more" size={14} />
              </button>
            );
            // Картинка — миниатюрой: при десяти скриншотах по именам вида
            // «screenshot-2026-07-20-12-28-27.png» не понять, какой лишний.
            return url ? (
              <span className={`pending-thumb${reoCls}`} key={i} {...reo}>
                <button
                  type="button"
                  className="pt-open"
                  title={`${f.name} — открыть`}
                  onClick={() => setPendingBox(pendingImages.indexOf(f))}
                >
                  <img src={url} alt={f.name} />
                </button>
                <button type="button" className="pt-x" title="Убрать" data-no-reorder="" onClick={drop}>
                  <Icon name="close" size={12} />
                </button>
                {more}
                <span className="pt-size">{kb(f.size)}</span>
              </span>
            ) : (
              <span className={`pending-att${reoCls}`} key={i} {...reo}>
                <Icon name="paperclip" size={14} />{' '}
                {attRename === f ? (
                  <input
                    className="pa-rename"
                    defaultValue={f.name}
                    aria-label="Имя файла"
                    autoFocus
                    data-no-reorder=""
                    onFocus={(e) => {
                      const dot = e.currentTarget.value.lastIndexOf('.');
                      e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setAttRename(null);
                      }
                    }}
                    onBlur={(e) => {
                      if (attRename !== f) return;
                      setAttRename(null);
                      const name = renameTarget(f.name, e.currentTarget.value);
                      if (name) swapPending(f, new File([f], name, { type: f.type, lastModified: f.lastModified }));
                    }}
                  />
                ) : (
                  f.name
                )}
                {more}
                <button type="button" title="Убрать" data-no-reorder="" onClick={drop}>
                  <Icon name="close" size={13} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {pollOpen && pollChannelId && <PollComposer channelId={pollChannelId} onClose={() => setPollOpen(false)} />}
      {mediaPick === 'geo' && onSendMedia && <GeoPickDialog onSend={onSendMedia} live={geoLive} system={geoSystemHooks} map={GeoPickMapLazy} onClose={() => setMediaPick(null)} />}
      {mediaPick === 'poll' && onSendMedia && <ConvPollCreate onSend={onSendMedia} onClose={() => setMediaPick(null)} />}
      {mediaPick === 'contact' && onSendMedia && (
        <ContactSendFlow onSend={onSendMedia} onClose={() => setMediaPick(null)} />
      )}
      {pendingBox !== null && pendingImages.length > 0 && (
        <Lightbox
          images={pendingImages.map((f) => ({ url: previewUrls.get(f) ?? '', name: f.name, size: f.size }))}
          index={Math.min(pendingBox, pendingImages.length - 1)}
          onClose={() => setPendingBox(null)}
          onIndex={setPendingBox}
        />
      )}
      {attMenu && (
        <ContextMenu
          {...(attMenu.anchor ? { anchor: attMenu.anchor } : { pos: attMenu.pos ?? { x: 0, y: 0 } })}
          onClose={() => setAttMenu(null)}
          width={232}
        >
          {attMenu.file.type.startsWith('image/') && photoEditable(attMenu.file.type) && (
            <MenuItem
              icon="photo"
              label="Изменить фото"
              onClick={() => {
                setAttMenu(null);
                setAttEdit(attMenu.file);
              }}
            />
          )}
          <MenuItem
            icon="repeat"
            label="Заменить файл"
            onClick={() => {
              setAttReplace(attMenu.file);
              setAttMenu(null);
            }}
          />
          {!previewUrls.get(attMenu.file) && (
            <MenuItem
              icon="edit"
              label="Переименовать"
              onClick={() => {
                setAttMenu(null);
                setAttRename(attMenu.file);
              }}
            />
          )}
          <MenuItem
            icon="trash"
            label="Удалить"
            danger
            onClick={() => {
              const f = attMenu.file;
              setAttMenu(null);
              attOrigins.current.delete(f);
              const list = pendingNow.current.filter((x) => x !== f);
              pendingNow.current = list;
              setPending(list);
            }}
          />
        </ContextMenu>
      )}
      {attReplace && (
        <input
          ref={attReplaceRef}
          type="file"
          hidden
          onChange={(e) => {
            const next = e.currentTarget.files?.[0];
            setAttReplace(null);
            if (next) swapPending(attReplace, next);
          }}
        />
      )}
      {attEdit && (
        <PhotoEditor
          file={attOrigins.current.get(attEdit)?.src ?? attEdit}
          initial={attOrigins.current.get(attEdit)?.edit}
          onCancel={() => setAttEdit(null)}
          onDone={(out, edit) => {
            const cur = attEdit;
            const src = attOrigins.current.get(cur)?.src ?? cur;
            setAttEdit(null);
            if (out === src) swapPending(cur, src);
            else swapPending(cur, out, { src, edit });
          }}
        />
      )}
      {/* Черновик пересылки (08.10, решение владельца п.9; Telegram Desktop `ForwardPanel`, Android панель над полем):
          «Пересылка <имена>» и превью одного сообщения или «N пересланных сообщений»; нажатие и правый щелчок — меню
          (скрыть имя / подписи, изменить получателя, не пересылать), × — не пересылать. Уходит с отправкой поля. */}
      {/* Вместо поля плашка («Вы заблокировали…», только чтение) — полосы нет: черновик ждёт, пока поле вернётся. */}
      {!selecting && !composerEdit && !composerReplacement && !readOnly && fwdDraft && (
        <div
          className="reply-strip fwd-strip"
          title="Параметры пересылки"
          onClick={(e) => {
            if ((e.target as Element).closest('.rs-close')) return;
            setFwdMenu({ x: e.clientX, y: e.clientY });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setFwdMenu({ x: e.clientX, y: e.clientY });
          }}
          onMouseDown={keepFocus}
        >
          <Icon name="forward" size={14} />
          <span className="rs-label">
            Пересылка <b>{fwdDraft.hideSender ? 'без имени отправителя' : fwdSenders(fwdDraft.messages, nameOf)}</b>
            {/* Файлы в беседу с человеком другого инстанса сервер не примет (Э2 часть Б): предупреждаем до отправки. */}
            {filesBlocked && fwdDraft.messages.some((m) => (m.attachments?.length ?? 0) > 0) && (
              <span className="rs-warn" role="note">
                {' · '}файлы не уйдут
              </span>
            )}
          </span>
          {fwdDraft.messages.length === 1 ? (
            <StripText
              m={
                fwdDraft.hideCaptions && (fwdDraft.messages[0]!.attachments?.length ?? 0) > 0
                  ? { ...fwdDraft.messages[0]!, content: '' }
                  : fwdDraft.messages[0]!
              }
              thumb
            />
          ) : (
            <span className="rs-text">
              {fwdDraft.messages.length}{' '}
              {plural(fwdDraft.messages.length, 'пересланное сообщение', 'пересланных сообщения', 'пересланных сообщений')}
            </span>
          )}
          <button
            type="button"
            className="rs-close"
            title="Не пересылать"
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={() => feedId && useStore.getState().setFwdDraft(feedId, null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {fwdMenu && fwdDraft && (
        <ContextMenu pos={fwdMenu} onClose={() => setFwdMenu(null)} width={240}>
          {batchOn?.hideOptions && (
            <MenuItem
              icon="user"
              label={fwdDraft.hideSender ? 'Показать имя отправителя' : 'Скрыть имя отправителя'}
              onClick={() => {
                setFwdMenu(null);
                // Telegram 5.21: показать имя — показать и подписи (подписи без имени не скрываются отдельно).
                const hide = !fwdDraft.hideSender;
                if (feedId) useStore.getState().setFwdDraft(feedId, { ...fwdDraft, hideSender: hide, hideCaptions: hide && fwdDraft.hideCaptions });
              }}
            />
          )}
          {batchOn?.hideOptions && fwdDraft.messages.some((m) => !!m.content && (m.attachments?.length ?? 0) > 0) && (
            <MenuItem
              icon="photo"
              label={fwdDraft.hideCaptions ? 'Показать подписи' : 'Скрыть подписи'}
              onClick={() => {
                setFwdMenu(null);
                // Telegram 5.21: скрыть подписи — скрыть и имя.
                const hide = !fwdDraft.hideCaptions;
                if (feedId) useStore.getState().setFwdDraft(feedId, { ...fwdDraft, hideCaptions: hide, hideSender: hide || fwdDraft.hideSender });
              }}
            />
          )}
          <MenuItem
            icon="forward"
            label="Изменить получателя"
            onClick={() => {
              setFwdMenu(null);
              setMsgMenu(null);
              setFwdSrc(fwdDraft);
              setFwdIds(fwdDraft.messages.map((m) => m.id));
            }}
          />
          <MenuItem
            icon="close"
            label="Не пересылать"
            danger
            onClick={() => {
              setFwdMenu(null);
              if (feedId) useStore.getState().setFwdDraft(feedId, null);
            }}
          />
        </ContextMenu>
      )}
      {selecting ? null : composerEdit ? (
        /* Правка в поле (#212; с решения 31 — и на ПК) — плашка на месте строки ответа: исходный текст перед глазами одной
           строкой, нажатие — к сообщению, ✕ отменяет (изменённый текст — с вопросом). */
        <div
          className="reply-strip edit-strip"
          data-jump=""
          title="Перейти к сообщению"
          onClick={(e) => stripJump(e, composerEdit.id)}
          onAuxClick={(e) => stripJump(e, composerEdit.id)}
          onContextMenu={(e) => stripJump(e, composerEdit.id)}
          onMouseDown={keepFocus}
        >
          <Icon name="edit" size={14} />
          <span className="rs-label">
            <b>Редактирование</b>
          </span>
          <StripText m={composerEdit} thumb />
          <button
            type="button"
            className="rs-close"
            title="Отменить правку"
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={cancelComposerEdit}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : (
        replyingTo && (
          <div
            className="reply-strip"
            data-jump=""
            // С `quote1` (G55, Telegram 7.11): нажатие — окно параметров ответа, Ctrl + нажатие и правый щелчок — к сообщению.
            title={quoteOn && outbox ? 'Параметры ответа' : 'Перейти к сообщению'}
            onClick={(e) => {
              if (quoteOn && outbox && !e.ctrlKey && !e.metaKey && !(e.target as Element).closest('.rs-close')) {
                e.preventDefault();
                setReplyOpts(true);
                return;
              }
              if (replyNow?.foreign) return;
              stripJump(e, replyingTo.id);
            }}
            onAuxClick={(e) => !replyNow?.foreign && stripJump(e, replyingTo.id)}
            onContextMenu={(e) => (replyNow?.foreign ? e.preventDefault() : stripJump(e, replyingTo.id))}
            onMouseDown={keepFocus}
          >
            <Icon name="reply" size={14} />
            <span className="rs-label">
              Ответ <b>{nameOf(replyingTo.author.id, replyingTo.author.displayName)}</b>
            </span>
            {replyNow?.quote ? (
              <span className="rs-text rs-quote">{replyNow.quote.text}</span>
            ) : (
              <StripText m={replyingTo} thumb />
            )}
            <button
              type="button"
              className="rs-close"
              title="Отменить ответ"
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => setReplyingTo(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )
      )}
      {/* Превью ссылки над полем (G19, `linkprev1`): через секунду после набора адреса; крестик — отправить без превью. */}
      {outbox && sendFlags && !composerEdit && !selecting && !recording && !preview && (
        <ComposerLinkPreview text={text} dismissed={previewOff} onDismiss={() => setPreviewOff(true)} />
      )}
      {/* Полоса записи (#20) — над композером, как строка ответа: сам ввод остаётся на месте,
          и запись не выглядит как «приложение переключилось в другой режим». */}
      {/* Кружок (G68): круглое окно с камерой (или записанным, на паузе) поверх ленты; полоса записи ниже — та же. */}
      {(roundRec || roundPreview) && !selecting && (
        <RoundRecOverlay
          live={roundLive}
          previewUrl={roundPreview?.url ?? null}
          previewMs={roundPreview?.take.durationMs ?? 0}
          recMs={recMs}
          maxMs={ROUND_MAX_MS}
        />
      )}
      {(recording || preview) && !selecting && (
        <div className="voice-rec">
          {preview ? (
            roundPreview ? (
              <span className="voice-rec-round">Видеосообщение · {formatDuration(preview.take.durationMs)}</span>
            ) : (
              <VoicePlayer url={preview.url} waveform={preview.take.waveform} durationMs={preview.take.durationMs} trim={voiceTrimProp} />
            )
          ) : (
            <>
              <span className="voice-rec-dot" />
              <span className="voice-rec-time">{formatDuration(recMs)}</span>
              <div className="voice-rec-level" aria-hidden>
                {/* Полоска живого уровня: видно, что микрофон реально слышит, ещё до отправки. */}
                <span style={{ width: `${Math.round(Math.min(1, recLevel * 1.6) * 100)}%` }} />
              </div>
              {holdUi ? (
                // Telegram Desktop `lng_record_cancel`: пока кнопку держат — как отменить.
                <span className="voice-rec-limit muted">Отпустите за пределами поля для отмены</span>
              ) : (
                <>
                  <span className="voice-rec-limit muted">до {formatDuration(roundLive ? ROUND_MAX_MS : VOICE_MAX_MS)}</span>
                  <button
                    type="button"
                    className="rs-close stop-ico"
                    title="Пауза — прослушать"
                    onClick={() => void voice.stop()}
                  >
                    <Icon name="pause" size={15} />
                  </button>
                </>
              )}
            </>
          )}
          {paused && (
            <button type="button" className="rs-close" title="Продолжить запись" onClick={voice.resume}>
              <Icon name="mic" size={15} />
            </button>
          )}
          {voiceOnceBtn('rs-close voice-once')}
          {!holdUi && (
            <>
              <button
                type="button"
                className="rs-close"
                title={preview ? 'Выбросить запись' : 'Отменить запись'}
                onClick={preview ? voice.discardPreview : voice.cancel}
              >
                <Icon name="trash" size={15} />
              </button>
              <button
                type="button"
                className="voice-rec-send"
                title="Отправить"
                onClick={() => void (preview ? voice.sendPreview() : voice.finish())}
              >
                <Icon name="send" size={15} />
              </button>
            </>
          )}
        </div>
      )}
      {/* Раунд 12, выделение (HANDOFF §6): на месте поля ввода — панель в его же рамке, ничего не прыгает. «Ответить» —
          только при одном (и где поле есть: у заблокированного вместо него плашка). */}
      {selecting && (
        <div className="composer sel-bar" ref={selBarRef}>
          {pickedOne && !composerReplacement && (
            <button type="button" className="sel-bar-btn" onClick={() => replyPicked(pickedOne)}>
              <Icon name="reply" size={phoneLayout ? 20 : 18} />
              <span className="sel-bar-label">Ответить</span>
            </button>
          )}
          <button type="button" className="sel-bar-btn" onClick={() => openForward(pickedIds)}>
            <Icon name="forward" size={phoneLayout ? 20 : 18} />
            {/* Как «ПЕРЕСЛАТЬ N» у Telegram: сколько сообщений уйдёт. Число — отдельно (D17, S20+ 08.10): на узком телефоне его
                прячет CSS — счёт и так в шапке «Выбрано N», а подписи не переносятся и не вылезают за экран. */}
            <span className="sel-bar-label">
              Переслать
              {pickedIds.length > 0 && <span className="sel-bar-n">{` ${pickedIds.length}`}</span>}
            </span>
          </button>
          {/* «УДАЛИТЬ N» у Telegram Android (`ChatActivity` панель выделения: FORWARD 3 / DELETE 3); окно подтверждения то же. */}
          {pickedList.length > 0 && (
            <button type="button" className="sel-bar-btn danger" onClick={() => void deletePicked(pickedList)}>
              <Icon name="trash" size={phoneLayout ? 20 : 18} />
              <span className="sel-bar-label">
                Удалить
                <span className="sel-bar-n">{` ${pickedList.length}`}</span>
              </span>
            </button>
          )}
        </div>
      )}
      {/* Поле ввода можно заменить плашкой (#212: «Вы заблокировали собеседника · Разблокировать»). В выделении поле
          спрятано, но не снято (`COMPOSER_HIDDEN`), плашка — снята. */}
      {/* Поиск на телефоне (G05): «N из M» и стрелки — на месте поля ввода, как выделение. */}
      {searchFoot && !selecting && <ChatSearchFoot cs={cs} />}
      {cs.calendarAt && <JumpDateDialog at={cs.calendarAt} onPick={cs.pickDay} onClose={cs.closeCalendar} />}
      {!selecting && !searchFoot && !composerReplacement && composerNote}
      {!composerReplacement && !selecting && !searchFoot && composerNotice}
      {(selecting || searchFoot) && composerReplacement ? null : (composerReplacement ?? (
      <form
        className={`composer${text.trim() || pending.length || composerEdit || fwdDraft ? '' : ' empty'}${
          micAvailable && !composerEdit ? ' has-mic' : ''
        }${recording || holdUi || preview ? ' rec-on' : ''}${holdUi ? ' rec-hold' : ''}${multiline ? ' multiline' : ''}${
          composerEdit ? ' editing' : ''
        }`}
        style={selecting || searchFoot ? COMPOSER_HIDDEN : undefined}
        onSubmit={send}
        // Раунд 12, порция 8: меню кнопки «Отправить» — правый клик и долгое нажатие по ней (цель — `.send-btn`).
        onContextMenu={sendOn ? onComposerContextMenu : undefined}
        onTouchStart={sendOn ? onComposerTouchStart : undefined}
        onTouchMove={sendOn ? onComposerTouchMove : undefined}
        onTouchEnd={sendOn ? dropSendPress : undefined}
        onTouchCancel={sendOn ? dropSendPress : undefined}
      >
        {!ac && canSticker && !!stickerCatalog && !composerEdit && !pending.length && (
          // С2 порция 2: один эмодзи в поле — лента стикеров над полем; нажатие шлёт стикер и очищает поле (как Telegram).
          <StickerSuggest
            text={text}
            packs={stickerPacks ?? []}
            onPick={(st) => {
              if (inputRef.current) inputRef.current.value = '';
              setText('');
              void sendSticker(st);
            }}
          />
        )}
        {/* E4 (эмулятор 08.10): пока открыта полоса подсказок (эмодзи, @, #), подсказка про удержание не рисуется — слои лежали друг на друге. */}
        {holdHint && !(ac && acItems.length > 0) && (
          <div className="send-hint" role="status">
            {SEND_HINT_TEXT}
          </div>
        )}
        {ac && acItems.length > 0 && (
          // Эмодзи (G53) — полоса в строку, как у Telegram Desktop (`EmojiSuggestions`): ←/→ выбирают, Tab и Enter подставляют, Esc закрывает.
          <div className={ac.trigger === ':' ? 'ac-pop ac-strip' : 'ac-pop'} data-testid={ac.trigger === ':' ? 'emoji-suggest' : undefined}>
            {ac.trigger !== ':' && (
              <div className="ac-head">
                {ac.trigger === '/'
                  ? channelBots && channelBots.length > 1
                    ? 'Команды ботов'
                    : 'Команды бота'
                  : ac.trigger === '#'
                    ? `${hashtagsOn ? 'Хэштеги' : 'Каналы'} · #${ac.query}`
                    : `Участники · @${ac.query}`}
              </div>
            )}
            {acItems.map((it, i) => (
              <button
                type="button"
                key={`${it.kind}:${it.id}`}
                title={it.kind === 'emoji' ? it.label : undefined}
                className={`ac-item${it.kind === 'command' ? ' ac-cmd' : ''} ${i === acIndex ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptAc(it);
                }}
                onMouseEnter={() => setAcIndex(i)}
              >
                {it.kind === 'user' ? (
                  <span className="ac-ava-wrap">
                    <Avatar url={it.avatarUrl} name={it.label} size={28} fallback="icon" />
                    {it.online ? <span className="ac-dot" /> : null}
                  </span>
                ) : it.kind === 'emoji' ? (
                  <span className="ac-emoji">{it.emoji}</span>
                ) : it.kind === 'command' && it.bot ? (
                  // Канал (#231): чья команда — аватар бота (tdesktop `field_autocomplete.cpp:722` `userpic`).
                  <span className="ac-role-ico">
                    <Avatar url={it.bot.avatarUrl} name={it.bot.displayName || it.bot.username} size={16} />
                  </span>
                ) : (
                  <span className="ac-role-ico">
                    <Icon name={it.kind === 'command' ? 'bot' : it.kind === 'role' || it.kind === 'broadcast' ? 'users' : 'hash'} size={15} />
                  </span>
                )}
                {it.kind === 'emoji' ? null : <span className="ac-name">{it.label}</span>}
                {it.kind === 'user' ? (
                  <span className="ac-handle">{it.handle}</span>
                ) : it.kind === 'role' ? (
                  <span className="ac-handle">роль</span>
                ) : it.kind === 'broadcast' || it.kind === 'command' ? (
                  <span className="ac-handle">{it.hint}</span>
                ) : null}
                {it.kind === 'command' && it.bot ? <span className="ac-bot">@{it.bot.username}</span> : null}
              </button>
            ))}
          </div>
        )}
        {/* Телефон (#159, порядок кнопок с #218 — как Telegram Android): файл, голосовое, стикеры и опрос уезжают под скрепку справа, иначе поле ввода
            сжималось до 128 px из 387 — места под текст было меньше, чем под ряд кнопок. Кнопка
            есть в разметке всегда, а показывает её только мобильная раскладка (styles.css) — она
            же прячет четыре кнопки ниже. На компьютере строка остаётся прежней. */}
        {/* Правка меняет только текст: вложения, голосовое и опрос к ней не относятся (#212). */}
        {/* Беседа с ботом (#230): кнопка «Меню» слева от поля. ПК — пока поле пусто или в нём команда (tdesktop `_botCommandStart`,
            `history_widget.cpp:7093`); телефон — всегда, как Telegram Android (владелец 26.10: «делай как тг»). */}
        {botCommands?.length && !composerEdit && (isMobile() || !text || text.startsWith('/')) ? (
          <button type="button" className="att-btn botcmd" title="Команды бота" aria-label="Команды бота" aria-haspopup="listbox" onClick={openBotMenu}>
            <Icon name="list" size={20} />
          </button>
        ) : null}
        {!composerEdit && !filesBlocked && (
        <button
          type="button"
          className="att-btn plus"
          title="Прикрепить"
          aria-haspopup="dialog"
          aria-expanded={!!plusAnchor || mediaOpen}
          // Телефон с камерой или своей галереей — сразу лист вложений, как скрепка Telegram (05.10); иначе прежняя шторка.
          onClick={(e) => (mediaMode() !== 'input' ? setMediaOpen(true) : setPlusAnchor(e.currentTarget.getBoundingClientRect()))}
        >
          <Icon name="paperclip" size={22} />
        </button>
        )}
        {!composerEdit && !filesBlocked && (
        <button
          type="button"
          className="att-btn attach"
          title="Прикрепить"
          aria-haspopup="menu"
          aria-expanded={!!attachAnchor}
          onMouseEnter={attachHover.onMouseEnter}
          onMouseLeave={attachHover.onMouseLeave}
          onClick={(e) => setAttachAnchor(e.currentTarget.getBoundingClientRect())}
        >
          <Icon name="paperclip" size={19} />
        </button>
        )}
        {/* Вложения закрыты (`filesBlocked`, Э2 часть Б): те же две кнопки, но неактивные — подсказка в title и тосте (разметка выше — прежняя; порядок кнопок в строке задаёт `order` в styles.css). */}
        {!composerEdit && filesBlocked && (
          <>
            <button type="button" className="att-btn plus blocked" title={filesBlocked} aria-disabled onClick={() => toast('info', filesBlocked)}>
              <Icon name="paperclip" size={22} />
            </button>
            <button type="button" className="att-btn attach blocked" title={filesBlocked} aria-disabled onClick={() => toast('info', filesBlocked)}>
              <Icon name="paperclip" size={19} />
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            // «Файл» — как документы (Telegram Desktop: выбор «Файл» открывает окно с «Отправить как файлы»); в уже открытое
            // окно файлы добавляет «Добавить» — выбор способа не трогаем.
            addFiles(e.target.files, boxNow.current ? undefined : { way: { asFile: true } });
            e.target.value = '';
          }}
        />
        {/* «Фото или видео» системным выбором (ПК, браузер телефона): фото сжимаются, как у Telegram, — кроме «Файл →
            Галерея без сжатия» (`mediaCompress`). Список копируем до очистки поля: `files` — живой. */}
        <input
          ref={mediaRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (!picked.length) return;
            // ПК, ЛС: оригиналы идут в окно отправки, сжатие — при отправке (`sendFromBox`, «как файлы» его отключает).
            if (outbox && !phoneLayout && !composerEdit) addFiles(picked, boxNow.current ? undefined : { way: { asFile: !mediaCompress.current } });
            else if (!mediaCompress.current) addFiles(picked);
            else void compressPhotos(picked).then(addFiles);
          }}
        />
        <button
          type="button"
          className="att-btn emoji"
          title={exprUnder ? 'Клавиатура' : canSticker && !composerEdit ? 'Эмодзи и стикеры' : 'Эмодзи'}
          onMouseEnter={emojiHover.onMouseEnter}
          onMouseLeave={emojiHover.onMouseLeave}
          onClick={(e) => {
            // Telegram Desktop: щелчок закрепляет панель колонкой, если она помещается, а у закреплённой — убирает колонку (G61).
            if (docked) dock.setPinned(false);
            else if (dock.canPin && hoverPanelsAvailable()) {
              setPicker(null);
              dock.setPinned(true);
            } else if (exprUnder) {
              // Телефон, панель под полем: кнопка — «клавиатура» (Telegram Android меняет смайлик на клавиатуру).
              inputRef.current?.focus();
              keyboardFromPanel();
            } else {
              // Телефон: клавиатура уходит, панель встаёт на её место (`exprUnder`).
              if (dockPhone && document.activeElement instanceof HTMLElement) document.activeElement.blur();
              setPicker({ kind: 'composer', anchor: e.currentTarget.getBoundingClientRect(), el: e.currentTarget });
            }
          }}
        >
          <Icon name={exprUnder ? 'keyboard' : 'reaction'} size={19} />
        </button>
        {micAvailable && !composerEdit && (canVoice || !!holdUi) && (
          <button
            type="button"
            className="att-btn voice"
            title={
              roundOkNow
                ? roundMode
                  ? 'Удерживайте для записи видеосообщения, клик — голосовое'
                  : 'Удерживайте для записи голосового, клик — видеосообщение'
                : 'Удерживайте для записи, клик — запись без рук'
            }
            disabled={recBusy}
            onPointerDown={onDeskMicDown}
            onPointerMove={onDeskMicMove}
            onPointerUp={onDeskMicUpRound}
            onPointerCancel={onDeskMicAbort}
            onLostPointerCapture={onDeskMicAbort}
            // Клавиатура (Enter/пробел на кнопке): `detail === 0` — запись без рук; клик мышью ведут pointer-события.
            onClick={(e) => {
              if (e.detail === 0) void voice.start();
            }}
          >
            <Icon name={roundMode && roundOkNow ? 'camera' : 'mic'} size={19} />
          </button>
        )}
        {pollChannelId && !composerEdit && (
          <button type="button" className="att-btn poll" title="Создать опрос" onClick={() => setPollOpen(true)}>
            <Icon name="activity" size={19} />
          </button>
        )}
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          data-fmt="1"
          onFocus={() => {
            // Панель эмодзи под полем: касание поля — клавиатура вместо панели (Telegram Android, `ChatActivityEnterView`).
            if (exprUnderRef.current) keyboardFromPanel();
          }}
          onPaste={(e) => {
            onPasteFiles(e);
            // Огромная вставка (≥ 8 пределов в поле) уходит файлом `message.txt`, как у Telegram Desktop (G22, `CheckLargeTextPaste`).
            if (!e.defaultPrevented && !composerEdit) {
              const pasted = e.clipboardData?.getData('text/plain') ?? '';
              const el = e.currentTarget;
              if (pastedTextBecomesFile(text.length, el.selectionStart, el.selectionEnd, pasted.length)) {
                const all = textAfterPaste(text, el.selectionStart, el.selectionEnd, pasted);
                if (sendTextAsFile(all)) e.preventDefault();
              }
            }
            // Не файлы — текст: HTML с форматом становится маркерами, Ctrl+Shift+V — простой текст (G52, `fieldFormatDom`).
            if (!e.defaultPrevented) handleFormatPaste(e);
          }}
          onChange={(e) => {
            replUndo.current = null;
            if (substituteEmoji(e.target.value, e.target.selectionStart)) return;
            setText(e.target.value);
            refreshAc(e.target.value, e.target.selectionStart);
            if (e.target.value) signalAction('typing');
            /* Автозамены при НАБОРЕ (02·4.7, Telegram Desktop): `--` → «—», `<<` → «, `>>` → ». Вставка и правка из кода
               (`insertFromPaste`, данные длиннее знака) не заменяются. Пишем сразу после обработчика (микрозадача, а не кадр:
               следующий знак успел бы раньше) — через историю отмены поля, Ctrl+Z тоже откатывает. */
            const ne = e.nativeEvent as InputEvent;
            const rep = ne.inputType === 'insertText' ? textReplacement(e.target.value, e.target.selectionStart, ne.data) : null;
            if (rep) {
              const el = e.target;
              const seen = el.value;
              queueMicrotask(() => {
                if (el.value !== seen) return;
                applyEditToField(el, { value: rep.value, start: rep.caret, end: rep.caret });
                replUndo.current = rep.undo;
              });
            }
          }}
          onBlur={() => setTimeout(() => setAc(null), 120)}
          onKeyDown={(e) => {
            // Backspace сразу после автозамены — вернуть набранное (02·4.7).
            if (e.key === 'Backspace' && replUndo.current) {
              const el = e.currentTarget;
              const back = revertReplacement(el.value, el.selectionStart, el.selectionEnd, replUndo.current);
              replUndo.current = null;
              if (back) {
                e.preventDefault();
                applyEditToField(el, { value: back.value, start: back.caret, end: back.caret });
                replUndo.current = null;
                return;
              }
            }
            // Форматирование выделения: Ctrl+B / I / U, Ctrl+Shift+X / M / P / . / N (G20, Telegram Desktop 02·4.2).
            if (handleFormatKey(e)) return;
            // Autocomplete navigation takes priority while the popover is open.
            if (ac && acItems.length > 0) {
              // Эмодзи-полоса (G53): ←/→ как ↓/↑; из «ничего не выбрано» → выбирает первую (←, пока ничего не выбрано, уходит в поле).
              const strip = ac.trigger === ':';
              if (e.key === 'ArrowDown' || (strip && e.key === 'ArrowRight')) {
                e.preventDefault();
                setAcIndex((i) => (i + 1) % acItems.length);
                return;
              }
              if (e.key === 'ArrowUp' || (strip && e.key === 'ArrowLeft')) {
                if (acIndex < 0 && strip) return;
                e.preventDefault();
                setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
                return;
              }
              // Enter забирает только выбранная подсказка («слово целиком» не выбрано — Enter отправляет, как у Telegram); Tab выбирает первую.
              // Команды бота (#230): Tab и → подставляют команду в поле (дописать аргументы), Enter — отправляет её.
              if (ac.trigger === '/' && (e.key === 'Tab' || e.key === 'ArrowRight')) {
                e.preventDefault();
                acceptAc(acItems[Math.max(acIndex, 0)], true);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && acIndex >= 0)) {
                e.preventDefault();
                acceptAc(acItems[Math.max(acIndex, 0)]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setAc(null);
                return;
              }
            }
            /* Esc поля — не здесь: правка, ответ, запись и закрытие беседы снимаются по слоям в слушателе окна
               (`chatKeys`, порядок — `chatEscape`), чтобы тот же Esc работал и с фокусом в ленте, как у Telegram. */
            // Enter: отправить или перенос строки — правило в `messagePaneRules.enterSends` (и режим «Отправка по Ctrl+Enter»).
            if (e.key === 'Enter') {
              const sends = enterSends({
                shift: e.shiftKey,
                composing: e.nativeEvent.isComposing,
                /* 🔴 По ОСНОВНОМУ указателю, а не «есть ли хоть один точный» (28.09, S25 Ultra): у телефона
                   со стилусом `any-pointer: fine` истинно, и Enter отправлял вместо переноса. */
                touchOnly: window.matchMedia('(pointer: coarse)').matches,
                ctrl: e.ctrlKey || e.metaKey,
                mode: getSendMode(),
              });
              if (sends) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              } else if (enterBreaksLine({ shift: e.shiftKey, composing: e.nativeEvent.isComposing, ctrl: e.ctrlKey || e.metaKey, mode: getSendMode() })) {
                // Режим «Enter»: Ctrl+Enter — перенос строки, как у Telegram Desktop.
                e.preventDefault();
                insertLineBreak(e.currentTarget);
              }
              return;
            }
            /* ↑ в пустом поле — править своё последнее; ↑/↓ на краю поля и PgUp/PgDn — листать ленту (07.10, G36; Telegram
               Desktop `HistoryWidget::keyPressEvent`: клавишу, которую поле не съело, получает лента). Пересланное правке
               не подлежит (403). */
            const el = e.currentTarget;
            const lastOwn =
              e.key === 'ArrowUp' && text === ''
                ? [...messages].reverse().find((m) => m.author.id === meId && !m.forwardedFrom && !m.sticker)
                : undefined;
            const fkey = fieldKeyAction({
              key: e.key,
              mods: e.ctrlKey || e.altKey || e.shiftKey || e.metaKey,
              composing: e.nativeEvent.isComposing,
              value: el.value,
              selStart: el.selectionStart,
              selEnd: el.selectionEnd,
              replying: !!replyingTo,
              editing: !!composerEdit,
              hasOwnEditable: !!lastOwn,
            });
            if (!fkey) return;
            e.preventDefault();
            if (fkey === 'edit-last' && lastOwn) {
              startComposerEdit(lastOwn);
              return;
            }
            const box = listRef.current;
            if (!box) return;
            // Шаг строки — как стрелка браузера (40 px), шаг страницы — экран ленты без строки (как PgUp/PgDn браузера).
            const page = Math.max(40, box.clientHeight - 40);
            const dy = fkey === 'line-up' ? -40 : fkey === 'line-down' ? 40 : fkey === 'page-up' ? -page : page;
            // Листает человек — пилюля с днём появляется, как при колесе (`FloatingDay`: «ввод на ленте»).
            box.dispatchEvent(new Event(FEED_KEY_SCROLL));
            box.scrollBy({ top: dy, behavior: 'smooth' });
          }}
          placeholder={composerHint}
        />
        {/* Телефон: пункты форматирования над полем, пока в нём выделен текст (G20, как меню выделения Telegram Android). */}
        <FieldFormatBar fieldRef={inputRef} />
        {/* Раунд 12, порция 8 — вход «Отложенные» (HANDOFF §8.4): есть, только пока отложенные есть. Справа от поля, как в
            макетах (на телефоне — перед эмодзи, CSS `order`). */}
        {sendOn && sendOn.scheduledCount > 0 && !composerEdit && (
          <button
            type="button"
            className="att-btn sched"
            aria-label={`Отложенные сообщения: ${sendOn.scheduledCount}`}
            title={`Отложенные сообщения: ${sendOn.scheduledCount}`}
            onClick={sendOn.openScheduled}
          >
            <Icon name="calendar-time" size={19} />
          </button>
        )}
        {/* G22 (Telegram Desktop `updateSendAsFileVisibility`): текст длиннее предела — рядом с полем кнопка «текстом-файлом». */}
        {textFileOffer(text.length, !!composerEdit) && (
          <button
            type="button"
            className="att-btn textfile"
            aria-label="Отправить текстом-файлом"
            title="Отправить текстом-файлом (message.txt)"
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={() => void sendTextAsFile(text)}
          >
            <Icon name="file" size={19} />
          </button>
        )}
        {sendCounter && (
          <span
            className={sendCounter.over ? 'send-count over' : 'send-count'}
            aria-live="polite"
            title={sendCounter.over ? tooLongText(text.trim().length - MESSAGE_TEXT_MAX, !composerEdit) : undefined}
          >
            {sendCounter.text}
          </span>
        )}
        <button
          type="submit"
          className="send-btn"
          title={composerEdit ? 'Сохранить' : 'Отправить'}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
        >
          <Icon name={composerEdit ? 'check' : 'send'} size={18} />
        </button>
        {/* Телефон (#159): пока поле пустое, на месте «отправить» — микрофон. Плашка записи ложится
            ПОВЕРХ строки, а не вместо неё: спрятанное поле потеряло бы фокус, и клавиатура
            схлопнулась бы прямо под пальцем. На компьютере всё это скрыто — там своя полоса записи. */}
        {preview && (
          <div className="rec-inline">
            <button type="button" className="rec-trash" title="Выбросить запись" onClick={voice.discardPreview}>
              <Icon name="trash" size={19} />
            </button>
            {roundPreview ? (
              <span className="voice-rec-round">Видеосообщение · {formatDuration(preview.take.durationMs)}</span>
            ) : (
              <VoicePlayer url={preview.url} waveform={preview.take.waveform} durationMs={preview.take.durationMs} trim={voiceTrimProp} />
            )}
          </div>
        )}
        {(recording || holdUi) && !preview && (
          <div className="rec-inline" aria-live="polite">
            {!holdUi && (
              <button type="button" className="rec-trash" title="Выбросить запись" onClick={voice.cancel}>
                <Icon name="trash" size={19} />
              </button>
            )}
            <span className="voice-rec-dot" />
            <span className="voice-rec-time">{formatDuration(recMs)}</span>
            {holdUi ? (
              <span
                className="rec-slide"
                style={{
                  transform: `translateX(${Math.max(-voiceCancelPath(window.innerWidth), Math.min(0, holdUi.dx))}px)`,
                  opacity: 1 - voiceHoldProgress(holdUi.dx, holdUi.dy, voiceCancelPath(window.innerWidth)).cancel * 0.8,
                }}
              >
                <Icon name="chevron-left" size={16} />
                Влево — отмена
              </span>
            ) : (
              <div className="voice-rec-level" aria-hidden>
                <span style={{ width: `${Math.round(Math.min(1, recLevel * 1.6) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {holdUi && (
          <div
            className="rec-lock"
            aria-hidden
            style={{ transform: `translateY(${-voiceHoldProgress(holdUi.dx, holdUi.dy).lock * 28}px)` }}
          >
            <Icon name="lock" size={16} />
            <Icon name="chevron-up" size={14} />
          </div>
        )}
        {/* Подписи «Вверх — продолжать запись» над замком нет (#218): у Telegram замок — пилюля со стрелкой без текста. */}
        {/* «1» над «стопом» (Android: кнопка «один раз» над замком в записи без рук). */}
        {voiceOnceBtn(((recording && !holdUi) || (paused && preview)) ? 'rec-once up' : 'rec-once')}
        {/* Замок над кнопкой становится «стопом», как в Telegram: запись встаёт, её можно послушать. */}
        {recording && !holdUi && (
          <button type="button" className="rec-stop" title="Пауза — прослушать" onClick={() => void voice.stop()}>
            <Icon name="pause" size={18} />
          </button>
        )}
        {/* Прослушивание записи на паузе: над кнопкой — «продолжить запись» (Telegram: замок становится микрофоном). */}
        {paused && preview && (
          <button type="button" className="rec-stop" title="Продолжить запись" onClick={voice.resume}>
            <Icon name="mic" size={18} />
          </button>
        )}
        {micAvailable && !composerEdit && (
          <button
            type="button"
            className="mic-btn"
            title={
              (recording && !holdUi) || preview
                ? roundLive
                  ? 'Отправить видеосообщение'
                  : 'Отправить голосовое'
                : roundMode && roundOkNow
                  ? 'Держи, чтобы записать видеосообщение; нажми — голосовое'
                  : roundOkNow
                    ? 'Держи, чтобы записать голосовое; нажми — видеосообщение'
                    : 'Держи, чтобы записать голосовое'
            }
            disabled={recBusy}
            style={
              holdUi
                ? ({
                    /* Кнопка едет за пальцем, как круг записи Telegram (`RecordCircle`): влево — отмена, вверх — замок. */
                    '--rx': `${Math.max(-voiceCancelPath(window.innerWidth), Math.min(0, holdUi.dx))}px`,
                    '--ry': `${Math.max(-VOICE_HOLD.lockDy, Math.min(0, holdUi.dy))}px`,
                  } as React.CSSProperties)
                : undefined
            }
            onPointerDown={onMicDown}
            onPointerMove={onMicMove}
            onPointerUp={onMicUp}
            onPointerCancel={onMicAbort}
            onLostPointerCapture={onMicAbort}
            onContextMenu={(e) => e.preventDefault()}
            onClick={onMicClick}
          >
            {/* Большой круг под пальцем с живыми кляксами вокруг (Telegram `ChatActivityEnterView.RecordCircle` + `BlobDrawable`,
                #218) — холст `RecordBlob.tsx`, после удержания доигрывает уход (замок / отправка / отмена). */}
            <RecordCircle
              hold={!!holdUi}
              level={Math.min(1, recLevel * 1.6)}
              slide={holdUi ? voiceHoldProgress(holdUi.dx, holdUi.dy, voiceCancelPath(window.innerWidth)).cancel : 0}
              recording={recording}
              recBusy={recBusy}
            />
            <Icon name={(recording && !holdUi) || preview ? 'send' : roundMode && roundOkNow ? 'camera' : 'mic'} size={20} />
          </button>
        )}
      </form>
      ))}
      {/* #211: выделенный пальцем текст — подсветка, маркеры и панель «Копировать · Выделить всё» (порталом в body).
          В режиме выделения сообщений его нет: там тап переключает строки. */}
      {textSel && !selecting && (
        <TextSelLayer
          sel={textSel}
          onChange={setTextSel}
          onClose={() => setTextSel(null)}
          onCopy={copyMessageText}
          onQuote={quoteOn && outbox && !readOnly && !composerReplacement ? (t, start) => quoteFromBody(textSel.body, t, start) : undefined}
        />
      )}
      {/* «Переслать в…» — несколько бесед галочками, «Комментарий», «⋯» (без звука / позже), «Скрыть имя отправителя»
          (G71, `forwardMany`); окно закрывается само. «Позже» — только если выбраны одни тексты (вложения не откладываются). */}
      {fwdIds && batchOn && (
        <ForwardPicker
          count={fwdIds.length}
          canSilent={!!batchOn.silentForward}
          canHide={!!batchOn.hideOptions}
          hasFiles={(fwdSrc?.messages ?? messages).some((m) => fwdIds.includes(m.id) && (m.attachments?.length ?? 0) > 0)}
          hasCaptions={
            !fwdItem &&
            (fwdSrc?.messages ?? messages).some((m) => fwdIds.includes(m.id) && !!m.content && (m.attachments?.length ?? 0) > 0)
          }
          canLater={
            !fwdItem &&
            !!batchOn.later &&
            (fwdSrc?.messages ?? messages)
              .filter((m) => fwdIds.includes(m.id))
              .every(
                (m) =>
                  !!m.content && (m.attachments?.length ?? 0) === 0 && !m.sticker && m.content.length <= MESSAGE_TEXT_MAX,
              )
          }
          onSend={(to, o) => void forwardMany(fwdIds, to, o, fwdSrc, fwdItem)}
          // Одна беседа — черновик пересылки в ней (08.10, решение владельца п.9; Telegram 5.11 / 5.15). Один элемент альбома
          // (G56) — без черновика: черновик пересылает сообщения целиком.
          onDraft={fwdItem ? undefined : (to) => startFwdDraft(to, fwdIds, fwdSrc)}
          onClose={() => (setFwdIds(null), setFwdSrc(null), setFwdItem(null))}
        />
      )}
      {/* «Ответить в…» (G55, Telegram `ShowReplyToChatBox`, `lng_reply_in_another_title`): то же окно, одна беседа. */}
      {replyElsewhere && (
        <ForwardPicker
          count={1}
          pickOne={{
            title: 'Ответить в…',
            what: 'Выберите беседу — ответ с цитатой встанет в её поле',
            onPick: (convId) => pickReplyChat(convId, replyElsewhere.m, replyElsewhere.quote),
          }}
          onSend={() => {}}
          onClose={() => setReplyElsewhere(null)}
        />
      )}
      {/* Окно параметров ответа (G55, Telegram Desktop `DraftOptionsBox`, Android `MessagePreviewView`). */}
      {replyOpts && replyingTo && (
        <ReplyOptions
          author={nameOf(replyingTo.author.id, replyingTo.author.displayName)}
          content={replyingTo.content}
          body={renderContent(replyingTo.content, replyingTo.author.id, replyingTo.author.displayName, onEmoji)}
          quote={replyNow?.quote ?? null}
          onApply={(q) => {
            setReplyExtra(q || replyNow?.foreign ? { id: replyingTo.id, quote: q, foreign: !!replyNow?.foreign } : null);
            setReplyOpts(false);
            inputRef.current?.focus();
          }}
          // Ответ уже из другой беседы — «в другом чате» он и так; «Показать в чате» — только у своей беседы.
          onAnotherChat={
            replyNow?.foreign
              ? undefined
              : (q) => {
                  setReplyOpts(false);
                  setReplyElsewhere({ m: replyingTo, quote: q });
                }
          }
          onShow={
            replyNow?.foreign
              ? undefined
              : () => {
                  setReplyOpts(false);
                  void jumpToMessage(replyingTo.id);
                }
          }
          onRemove={() => {
            setReplyOpts(false);
            setReplyingTo(null);
          }}
          onClose={() => setReplyOpts(false)}
        />
      )}
      {/* Раунд 12, порция 8 — меню кнопки «Отправить» (HANDOFF §8.1, макеты `*-send-menu`): без полосы реакций и подвала.
          «Позже» и «когда в сети» с файлами в поле — только у сервера с `conv10` (`sendOn.media`, 06.10); у прежнего —
          серые «Только текст, без вложений»: вложений у отложенных он не принимает. */}
      {sendMenuAt && sendOn && (
        <ContextMenu
          {...(sendMenuAt.spot
            ? { anchor: sendMenuAt.spot.anchor, spotlight: sendMenuAt.spot.spotlight, align: sendMenuAt.spot.align }
            : { pos: sendMenuAt.pos ?? { x: 0, y: 0 } })}
          onClose={() => setSendMenuAt(null)}
          width={248}
          // G47: на телефоне над меню — предпросмотр будущего пузыря (текст, ответ, вложения), как `MessageSendPreview` у Telegram.
          reactions={
            sendMenuAt.spot && phoneLayout ? (
              <SendPreview
                text={text}
                replyTo={replyingTo}
                replyName={replyingTo ? nameOf(replyingTo.author.id, replyingTo.author.displayName) : ''}
                files={pending}
                onEmoji={onEmoji}
              />
            ) : undefined
          }
        >
          {sendOn.silent && (
            <MenuItem
              icon="bell-off"
              label="Отправить без звука"
              onClick={() => {
                setSendMenuAt(null);
                sendSilent();
                refocusComposer();
              }}
            />
          )}
          {sendOn.later && (
            <MenuItem
              icon="calendar-time"
              label="Отправить позже"
              disabled={schedFilesBlocked || (!text.trim() && pending.length === 0)}
              sub={schedFilesBlocked ? 'Только текст, без вложений' : undefined}
              onClick={() => {
                setSendMenuAt(null);
                openLater({ content: text.trim(), replyTo: replyingTo, files: sendOn.media ? pending : [] });
              }}
            />
          )}
          {sendOn.whenOnline && (
            <MenuItem
              icon="alarm"
              label="Когда будет в сети"
              disabled={schedFilesBlocked || (!text.trim() && pending.length === 0)}
              sub={schedFilesBlocked ? 'Только текст, без вложений' : undefined}
              onClick={() => {
                setSendMenuAt(null);
                scheduleDraft(text.trim(), replyingTo, null, sendOn.media ? pending : []);
                refocusComposer();
              }}
            />
          )}
        </ContextMenu>
      )}
      {laterDraft && sendOn && (
        <SchedPick
          text={laterDraft.content}
          silentToggle={!!sendOn.silent}
          onPick={(at, silent) => {
            if (laterFocus.current) laterFocus.current.sent = true;
            scheduleDraft(laterDraft.content, laterDraft.replyTo, at, laterDraft.files, !!silent);
          }}
          onClose={closeLater}
        />
      )}
      {/* Вид «Отложенные» (порция 8) — поверх ленты, внутри `.chat`: лента под ним не пересоздаётся. */}
      {sendOn?.view}
      {picker && !exprUnder && renderExpr(picker, false)}
      {exprUnder && picker && (
        <>
          {/* Затемнение ленты над полем при раскрытии (`ScrimDrawable`, `ChatActivityEnterView.java:13963-13968`: чёрный, альфа 102 × доля). */}
          <div className="expr-scrim" style={{ opacity: exprLift.max > 0 ? liftExtra / exprLift.max : 0 }} aria-hidden="true" />
          <div
            className="expr-under"
            style={{ height: exprUnderH + liftExtra, marginTop: -liftExtra }}
            aria-label="Эмодзи, стикеры и GIF"
            onTouchStart={onLiftStart}
            onTouchMove={onLiftMove}
            onTouchEnd={onLiftEnd}
            onTouchCancel={onLiftEnd}
          >
            {renderExpr(picker, true)}
          </div>
        </>
      )}
      {docked && (
        <aside className="expr-dock" aria-label="Эмодзи, стикеры и GIF">
          {renderExpr({ kind: 'composer', anchor: new DOMRect() }, true)}
        </aside>
      )}
      {plusAnchor && (
        <BottomSheet onClose={() => setPlusAnchor(null)}>
          {/* Выбор файла открываем прямо в этом нажатии, а не после закрытия шторки: без живого
              жеста пользователя браузер диалог выбора файла не покажет. */}
          <SheetRow icon="photo" label="Фото или видео" onClick={openMediaPicker} />
          <SheetRow icon="file" label="Файл" onClick={openFilePicker} />
          {mediaActions.map((a) => (
            <SheetRow
              key={a.key}
              icon={a.icon}
              label={a.label}
              onClick={() => {
                setPlusAnchor(null);
                a.run();
              }}
            />
          ))}
          {canVoice && (
            <SheetRow
              icon="mic"
              label="Голосовое сообщение"
              onClick={() => {
                setPlusAnchor(null);
                if (!recBusy) void voice.start();
              }}
            />
          )}
          {pollChannelId && (
            <SheetRow
              icon="activity"
              label="Опрос"
              onClick={() => {
                setPlusAnchor(null);
                setPollOpen(true);
              }}
            />
          )}
        </BottomSheet>
      )}
      {/* Скрепка на ПК (05.10): маленькое меню у кнопки, как у Telegram Desktop. Пункты открывают выбор в том же нажатии. */}
      {attachAnchor && (
        <ContextMenu anchor={attachAnchor} onClose={() => setAttachAnchor(null)} width={208}>
          <MenuItem icon="photo" label="Фото или видео" onClick={openMediaPicker} />
          <MenuItem icon="file" label="Файл" onClick={openFilePicker} />
          {mediaActions.map((a) => (
            <MenuItem
              key={a.key}
              icon={a.icon}
              label={a.label}
              onClick={() => {
                setAttachAnchor(null);
                a.run();
              }}
            />
          ))}
        </ContextMenu>
      )}
      {mediaOpen && (
        <MediaSheet
          native={nativeMediaAvailable()}
          room={attachRoom(pending.length)}
          maxBytes={fileMaxBytes}
          caption={text}
          sendMenu={
            sendOn && (sendOn.silent || sendOn.later)
              ? { silent: sendOn.silent, later: sendOn.later, whenOnline: sendOn.whenOnline, scheduleMedia: !!sendOn.media }
              : undefined
          }
          actions={
            pollChannelId || mediaActions.length > 0
              ? [
                  ...(pollChannelId
                    ? [
                        {
                          key: 'poll',
                          icon: 'activity' as const,
                          label: 'Опрос',
                          run: () => {
                            setMediaOpen(false);
                            setPollOpen(true);
                          },
                        },
                      ]
                    : []),
                  // G69: «Геопозиция» и «Контакт» — вкладками листа после «Галерея / Файл», как у Telegram Android.
                  ...mediaActions.map((a) => ({
                    ...a,
                    run: () => {
                      setMediaOpen(false);
                      a.run();
                    },
                  })),
                ]
              : undefined
          }
          onceItems={mediaOnce && outbox ? (choose, back) => <OnceTimerItems current={null} onChoose={choose} onBack={back} /> : undefined}
          onSend={onMediaSend}
          onAttach={addFiles}
          onSystemPick={onSystemPick}
          onClose={() => setMediaOpen(false)}
        />
      )}
      {lightbox !== null && (
        <Lightbox
          images={allImages}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
          onNearEdge={loadMediaPage ? onMediaEdge : undefined}
          actions={lightboxActions}
          onAuthor={lightboxAuthor}
        />
      )}
      {onceView && (
        <Lightbox
          images={[
            {
              url: onceView.att.url,
              name: isVideo(onceView.att.contentType) ? 'Одноразовое видео' : 'Одноразовое фото',
              type: onceView.att.contentType,
              video: isVideo(onceView.att.contentType),
              from: nameOf(onceView.msg.author.id, onceView.msg.author.displayName),
              at: onceView.msg.createdAt,
              caption: onceView.msg.content.trim() || undefined,
            },
          ]}
          index={0}
          onClose={closeOnce}
          onIndex={() => {}}
          once={{ deadline: onceView.deadline, protect: protectScreen }}
        />
      )}
      {userMenu}
      {outMenu &&
        !outMenu.bubble &&
        (() => {
          /* Неотправленное (раунд 10), ПК: правый клик по пузырю или кнопка «Не отправлено» — то, что раньше стояло
             ссылками в строке ошибки. Раунд 12 в широком окне ПК — так же; у пузыря — свой блок ниже. */
          const o = (outbox ? outbox.items : outgoing).find((x) => x.key === outMenu.key);
          if (!o) return null;
          const close = () => setOutMenu(null);
          // Ещё отправляется (07.10, Telegram 1.24/2.35/6.22): «Скопировать текст» и «Отменить отправку» вместо «Удалить».
          if (o.status === 'sending') {
            return (
              <ContextMenu pos={outMenu.pos} onClose={close} width={232}>
                {o.content && (
                  <MenuItem
                    icon="copy"
                    label="Скопировать текст"
                    onClick={() => {
                      copyMessageText(o.content);
                      close();
                    }}
                  />
                )}
                <MenuItem
                  icon="close"
                  label="Отменить отправку"
                  danger
                  onClick={() => {
                    cancelSending(o.key);
                    close();
                  }}
                />
              </ContextMenu>
            );
          }
          return (
            <ContextMenu pos={outMenu.pos} onClose={close} width={232}>
              <MenuItem
                icon="reset"
                label="Повторить отправку"
                onClick={() => {
                  if (outbox) outbox.retry(o.key);
                  else retryOutgoing(o.key);
                  close();
                }}
              />
              {o.content && (
                <MenuItem
                  icon="copy"
                  label="Скопировать текст"
                  onClick={() => {
                    copyMessageText(o.content);
                    close();
                  }}
                />
              )}
              <MenuDivider />
              <MenuItem
                icon="trash"
                label="Удалить"
                danger
                onClick={() => {
                  if (outbox) outbox.discard(o.key);
                  else setOutgoing((l) => outgoingSent(l, o.key));
                  close();
                }}
              />
            </ContextMenu>
          );
        })()}
      {outSheet &&
        (() => {
          // Неотправленное (раунд 10), телефон: первой строкой — повтор, «Изменить» нет (сообщения на сервере ещё нет).
          const o = (outbox ? outbox.items : outgoing).find((x) => x.key === outSheet);
          if (!o) return null;
          const close = () => setOutSheet(null);
          if (o.status === 'sending') {
            return (
              <BottomSheet onClose={close} title="Ваше сообщение" subtitle="Отправляется…">
                {o.content && (
                  <SheetRow
                    icon="copy"
                    label="Скопировать текст"
                    onClick={() => {
                      copyMessageText(o.content);
                      close();
                    }}
                  />
                )}
                <SheetRow
                  icon="close"
                  label="Отменить отправку"
                  danger
                  onClick={() => {
                    cancelSending(o.key);
                    close();
                  }}
                />
              </BottomSheet>
            );
          }
          return (
            <BottomSheet
              onClose={close}
              title="Ваше сообщение"
              // Наведения на телефоне нет — причина словами здесь, а не во всплывающей подсказке строки.
              subtitle={o.error ? `Не отправлено: ${o.error}` : 'Не отправлено'}
            >
              <SheetRow
                icon="reset"
                label="Повторить отправку"
                onClick={() => {
                  if (outbox) outbox.retry(o.key);
                  else retryOutgoing(o.key);
                  close();
                }}
              />
              {o.content && (
                <SheetRow
                  icon="copy"
                  label="Скопировать текст"
                  onClick={() => {
                    copyMessageText(o.content);
                    close();
                  }}
                />
              )}
              <SheetRow
                icon="trash"
                label="Удалить"
                danger
                onClick={() => {
                  if (outbox) outbox.discard(o.key);
                  else setOutgoing((l) => outgoingSent(l, o.key));
                  close();
                }}
              />
            </BottomSheet>
          );
        })()}
      {/* ── Меню в режиме выделения (07.10, сверка 01·1.31 / 1.32): правый клик мышью, пока что-то выбрано. Выбранное
          сообщение — как у Telegram Desktop: Ответить (на него) · Скопировать выбранное · Переслать выбранное · Удалить
          выбранное · Отменить выбор; не выбранное — Ответить · Выделить · Выделить до этого сообщения (пункта нет, если всего
          вышло бы больше `SELECT_MAX`). Вид — тот же `ContextMenu`, без полосы реакций и подвала (в выделении их нет). ── */}
      {selMenu &&
        selecting &&
        (() => {
          const m = selMenu.m;
          const close = () => setSelMenu(null);
          const on = pickedSet.has(m.id);
          const upTo = on ? null : selectUpTo(messages.map((x) => x.id), picked, m.id);
          return (
            <ContextMenu pos={selMenu.pos} onClose={close} width={248}>
              {!composerReplacement && (
                <MenuItem
                  icon="reply"
                  label="Ответить"
                  onClick={() => {
                    close();
                    replyPicked(m);
                  }}
                />
              )}
              {on ? (
                <>
                  {pickedHasText && (
                    <MenuItem
                      icon="copy"
                      label="Скопировать выбранное"
                      onClick={() => {
                        close();
                        copyPicked(pickedList);
                      }}
                    />
                  )}
                  <MenuItem
                    icon="forward"
                    label="Переслать выбранное"
                    onClick={() => {
                      close();
                      openForward(pickedIds);
                    }}
                  />
                  <MenuItem
                    icon="trash"
                    label="Удалить выбранное"
                    danger
                    onClick={() => {
                      close();
                      void deletePicked(pickedList);
                    }}
                  />
                  <MenuItem
                    icon="close"
                    label="Отменить выбор"
                    onClick={() => {
                      close();
                      dropPicks();
                    }}
                  />
                </>
              ) : (
                <>
                  {picked.length < SELECT_MAX && (
                    <MenuItem
                      icon="circle-check"
                      label="Выделить"
                      onClick={() => {
                        close();
                        setPicked((p) => (p.includes(m.id) || p.length >= SELECT_MAX ? p : [...p, m.id]));
                      }}
                    />
                  )}
                  {upTo && (
                    <MenuItem
                      icon="circle-check"
                      label="Выделить до этого сообщения"
                      onClick={() => {
                        close();
                        setPicked(upTo);
                      }}
                    />
                  )}
                </>
              )}
            </ContextMenu>
          );
        })()}
      {/* ── Раунд 12: меню сообщения (с 09.10 единственное — старое меню и лист сообщения сняты вместе с переключателем) ── */}
      {msgMenu &&
        (() => {
          /* ПК — правый клик: карточка у точки, полоса реакций над ней. Телефон (тап; в каналах и долгое нажатие) и узкое
             окно — у пузыря, экран приглушён, кроме строки. Пункты — один порядок (HANDOFF §3): Ответить · Изменить (своё,
             не пересланное) · Закрепить / Открепить (канал — по праву; ЛС — `conv7`, порция 7) · Скопировать текст ·
             Копировать изображение · Сохранить как… (правый клик по фото, 05.10) · Скопировать ссылку (канал) · Приложить
             к жалобе (канал) · Переслать (ЛС, `conv5`) · Удалить · Выделить (ЛС, `conv5`, ПК); без разделителей и подсказок
             клавиш (сами R / E / Del работают — эффект выше). Подвал — когда отправлено, у своего в ЛС перед временем ✓ / ✓✓ —
             как отметка в пузыре. */
          const m = msgMenu.m;
          const photo = msgMenu.photo;
          /* G56: правый клик мышью по ячейке альбома (ПК) — «Переслать»/«Удалить» для неё одной, как tdesktop по
             `PointState::GroupPart`; альбом целиком — «Выделить». Телефон — альбом целиком, как Telegram Android
             (`ChatActivity`, `selectedObjectGroup`); один элемент там — из просмотра. */
          const item =
            !isMobile() && msgMenu.item && batchOn?.forwardItem && batchOn.deleteItem && isAlbumItem(m.attachments, msgMenu.item)
              ? msgMenu.item
              : undefined;
          const link = msgMenu.link;
          const file = msgMenu.file;
          const fileActs = file ? fileMenuActions(file, isMobile()) : [];
          const mine = m.author.id === meId;
          const close = () => setMsgMenu(null);
          const myReactions = (m.reactions ?? []).filter((r) => r.me).map((r) => r.emoji);
          const read = bubbles && mine && readByPeer((m as { sortKey?: number }).sortKey, peerReadKey);
          const fallback = msgMenu.pos;
          /* «Изменить» и «Закрепить» — по порядку Telegram своей платформы (08.10, polish-feed; `tg-research/01-message.md`
             1.05 / 2.20): на ПК сразу под «Ответить» (tdesktop `HistoryInner::showContextMenu`), в пузырях ЛС на телефоне —
             после «Переслать», перед «Удалить» (Android `ChatActivity.fillMessageMenu`: Ответить · Копировать · Переслать ·
             Закрепить · Изменить · Удалить). Каналы держат порядок ПК везде. */
          const androidOrder = bubbles && isMobile();
          const editItem =
            !readOnly && mine && !m.forwardedFrom && !m.sticker && !convMediaOf(m as { media?: unknown }) ? (
              // Пересланное правке не подлежит (сервер ответит 403) — «Изменить» у него нет.
              <MenuItem
                icon="edit"
                label="Изменить"
                onClick={() => {
                  close();
                  editFromMenu(m);
                }}
              />
            ) : null;
          /* Закреп: в ЛС — порция 7 (`pinsOn`, сервер С2: закреплено ли — по моему списку беседы, окно с галочкой);
             в канале — по праву, как было (`onPin`, `m.pinnedAt`). */
          const pinItem = pinsOn ? (
            <MenuItem
              icon={pinnedIds.has(m.id) ? 'pin-off' : 'pin'}
              label={pinnedIds.has(m.id) ? 'Открепить' : 'Закрепить'}
              onClick={() => {
                close();
                if (pinnedIds.has(m.id)) unpinSoon(m.id);
                else void pinMessage(m);
              }}
            />
          ) : onPin ? (
            <MenuItem
              icon={m.pinnedAt ? 'pin-off' : 'pin'}
              label={m.pinnedAt ? 'Открепить' : 'Закрепить'}
              onClick={() => {
                onPin(m, !m.pinnedAt);
                close();
              }}
            />
          ) : null;
          const editPin = androidOrder ? (
            <>
              {pinItem}
              {editItem}
            </>
          ) : (
            <>
              {editItem}
              {pinItem}
            </>
          );
          const reactions = onReact ? (
            <ReactionBar
              reactions={quickBarOrder(QUICK_REACTIONS, quickNow)}
              quick={quickNow}
              onSetQuick={(emoji) => {
                setQuickReaction(emoji);
                close();
              }}
              mine={myReactions}
              onPick={(emoji) => {
                close();
                onReact(m.id, emoji, myReactions.includes(emoji) ? 'remove' : 'add');
              }}
              onBig={
                onReactBig
                  ? (emoji) => {
                      close();
                      onReactBig(m.id, emoji);
                    }
                  : undefined
              }
              onMore={() => {
                // «Все реакции» — прежний пикер у полосы (полоса на месте, пока меню не закрыто).
                const bar = document.querySelector('.ctx-stack > .react-bar')?.getBoundingClientRect();
                close();
                setPicker({ kind: 'msg', messageId: m.id, anchor: bar ?? new DOMRect(fallback.x, fallback.y, 0, 0) });
              }}
            />
          ) : undefined;
          const items = (
            <>
              {!readOnly && (
                <MenuItem
                  icon="reply"
                  // Выделен текст в этом сообщении (G55, Telegram 1.30) — «Ответить с цитатой» вместо «Ответить».
                  label={msgMenu.quote ? 'Ответить с цитатой' : 'Ответить'}
                  onClick={(e?: React.MouseEvent) => {
                    close();
                    if (msgMenu.quote) replyWithQuote(m, msgMenu.quote, e);
                    else startReply(m, null, e);
                  }}
                />
              )}
              {/* Голосовое в плеере (играет или на паузе) — «Ответить с тайм-кодом», как Telegram Desktop (G54). */}
              {!readOnly && voiceTimecodeOf(m) && (
                <MenuItem
                  icon="reply"
                  label="Ответить с тайм-кодом"
                  shortcut={voiceTimecodeOf(m) ?? undefined}
                  onClick={() => {
                    close();
                    replyWithTimecode(m);
                  }}
                />
              )}
              {!androidOrder && editPin}
              {/* Опрос в ЛС (`convpoll1`): «Отменить голос» / «Остановить опрос» (автору). */}
              {!readOnly && (() => {
                const pm = convMediaOf(m as { media?: unknown });
                return pm?.kind === 'poll' ? <ConvPollMenuItems poll={pm} conversationId={m.channelId} messageId={m.id} mine={mine} onDone={close} /> : null;
              })()}
              {/* «Сохранить GIF» (`gifs1`, Р-7, tdesktop `history_view_context_menu.cpp` `lng_context_save_gif`) — у GIF в
                  сообщении: под курсором или первый в нём. */}
              {onSaveGif &&
                (() => {
                  const g = [file, photo, ...(m.attachments ?? [])].find((a): a is Attachment => !!a && a.fedState !== 'copying' && isGifAttachment(a));
                  return g ? (
                    <MenuItem
                      icon="sticker"
                      label="Сохранить GIF"
                      onClick={() => {
                        close();
                        onSaveGif(g);
                      }}
                    />
                  ) : null;
                })()}
              {m.content && (
                <MenuItem
                  icon="copy"
                  label="Скопировать текст"
                  onClick={() => {
                    copyMessageText(m.content);
                    close();
                  }}
                />
              )}
              {/* Телефон: выделять текст пальцем — пунктом меню (Telegram Android), удержание выделяет само сообщение. */}
              {isMobile() && m.content && (
                <MenuItem
                  icon="copy"
                  label="Выделить текст"
                  onClick={() => {
                    close();
                    selectMessageText(m);
                  }}
                />
              )}
              {/* С2 порция 2: у стикера — «Посмотреть набор», «В избранное» (tdesktop `history_view_context_menu.cpp`). */}
              {m.sticker && <StickerMenuItems sticker={m.sticker} close={close} />}
              {/* Меню открыто правым кликом по фото или ячейке альбома (05.10, как у Telegram Desktop): картинку — в буфер,
                  файлом — с исходным именем (`imageActions.ts`). Приложение на телефоне (06.10): долгое нажатие на фото в
                  канале или тап по подписи сообщения с одним фото (`photoFromTouch`); пункты — через натив
                  (`canCopyImage` / `canSaveImage`), «Сохранить» там кладёт файл в галерею. */}
              {photo && canCopyImage() && (
                <MenuItem
                  icon="copy"
                  label="Копировать изображение"
                  onClick={() => {
                    close();
                    copyPhoto(photo);
                  }}
                />
              )}
              {photo && canSaveImage() && (
                <MenuItem
                  icon="download"
                  label={isMobile() ? 'Сохранить в галерею' : 'Сохранить как…'}
                  onClick={() => {
                    close();
                    savePhoto(photo);
                  }}
                />
              )}
              {/* Файл, видео, голосовое (07.10, Telegram 1.13 / 2.23 / 2.24 / 2.26 / 10.05 / 10.06 / 10.10): ПК — «Сохранить
                  как…»; приложение Android — «Сохранить в загрузки» (файл) / «в галерею» (видео) и «Поделиться»
                  (`fileMenu.fileMenuActions`). */}
              {/* Пока файл качается — «Отменить загрузку» вместо пунктов сохранения (tdesktop `AddDocumentActions`, FD-03).
                  ПК: «Сохранить как…» качает страницей с кольцом на карточке (`pcDownloads.ts`, G31); «Копировать
                  название» — у файла, не у видео и голосового (tdesktop `AddCopyFilename`). */}
              {file && fileJobOf(attachmentKey(file)) ? (
                <MenuItem
                  icon="close"
                  label="Отменить загрузку"
                  onClick={() => {
                    close();
                    cancelFileJob(attachmentKey(file));
                  }}
                />
              ) : (
                file &&
                fileActs.map((action) => (
                  <MenuItem
                    key={action}
                    icon={action === 'share' ? 'share' : 'download'}
                    label={fileMenuLabel(action)}
                    onClick={() => {
                      close();
                      if (action === 'save-as' && ringDownloads()) startDownload(attachmentTarget(file));
                      else runFileMenuAction(file, action);
                    }}
                  />
                ))
              )}
              {/* «Показать в папке» (G10 / G31 / G59, tdesktop `ShowInFolder` в `history_view_context_menu.cpp`): файл или видео,
                  которое это приложение уже сохранило на диск (десктоп, путь от оболочки); фото — то же по ссылке «Скачать». */}
              {(() => {
                const folder = file ? savedFilePath(attachmentKey(file), api.attachmentDownloadUrl(file)) : photo ? savedFilePath(attachmentKey(photo), api.attachmentDownloadUrl(photo)) : undefined;
                return folder ? (
                  <MenuItem
                    icon="folder"
                    label="Показать в папке"
                    onClick={() => {
                      close();
                      showInFolder(folder);
                    }}
                  />
                ) : null;
              })()}
              {file && !isMobile() && canCopyFileName(file) && !fileJobOf(attachmentKey(file)) && (
                <MenuItem
                  icon="copy"
                  label="Копировать название"
                  onClick={() => {
                    close();
                    navigator.clipboard
                      ?.writeText(file.name)
                      .then(() => toastCopied('Название скопировано'))
                      .catch(() => toast('error', 'Не удалось скопировать'));
                  }}
                />
              )}
              {/* Правый клик по ссылке в тексте (07.10, Telegram 1.03 / 10.03): открыть — как нажатием (окно про внешнюю
                  ссылку сохраняется), скопировать адрес. */}
              {link && (
                <MenuItem
                  icon="globe"
                  label="Открыть ссылку"
                  onClick={() => {
                    close();
                    openMessageLink(m, link);
                  }}
                />
              )}
              {link && (
                <MenuItem
                  icon="link"
                  label="Скопировать ссылку"
                  onClick={() => {
                    close();
                    copyLinkUrl(link);
                  }}
                />
              )}
              {/* Ссылка на сообщение (канал). Рядом со «Скопировать ссылку» ссылки из текста — своим именем, иначе два одинаковых. */}
              {onCopyLink && (
                <MenuItem
                  icon="link"
                  label={link ? 'Ссылка на сообщение' : 'Скопировать ссылку'}
                  onClick={() => {
                    onCopyLink(m);
                    close();
                  }}
                />
              )}
              {canModerate && guestHomeOf(m.author.id) && m.content && (
                <MenuItem
                  icon="flag"
                  label="Приложить к жалобе"
                  onClick={() => {
                    attachToReport(m);
                    close();
                  }}
                />
              )}
              {/* Порция 5: «Переслать» — только ЛС с действиями пачкой (`conv5`); в каналах его нет. Одноразовое голосовое
                  (`voice3`) не пересылается — как у Telegram. */}
              {batchOn && !m.attachments?.some((a) => a.once === true) && (
                <MenuItem
                  icon="forward"
                  label={item ? `Переслать ${albumItemNoun(item)}` : 'Переслать'}
                  onClick={() => {
                    close();
                    if (item) openForwardItem(m, item);
                    else openForward([m.id]);
                  }}
                />
              )}
              {androidOrder && editPin}
              {/* «Выбрать» (приложение на телефоне, 10.10, #218): долгое нажатие теперь открывает меню, как Telegram Android, — выбор
                  отсюда или протяжкой (`startMenuRange`); слово — строка Telegram `Select`; перед «Удалить», оно у Telegram последнее. */}
              {batchOn && isMobile() && (
                <MenuItem
                  icon="circle-check"
                  label="Выбрать"
                  onClick={() => {
                    close();
                    startSelection(m);
                  }}
                />
              )}
              {canDelete(m) && (
                <MenuItem
                  icon="trash"
                  label={item ? `Удалить ${albumItemNoun(item)}` : 'Удалить'}
                  danger
                  onClick={() => {
                    close();
                    if (item) void delItem(m, item);
                    else void del(m);
                  }}
                />
              )}
              {/* «Выделить» (ПК, как Telegram Desktop: после «Удалить») — режим выбора с этим сообщением. */}
              {batchOn && !isMobile() && (
                <MenuItem
                  icon="circle-check"
                  label="Выделить"
                  onClick={() => {
                    close();
                    startSelection(m);
                  }}
                />
              )}
              {(() => {
                // Первая строка — когда отправлено; у правленного ещё «Изменено: …», у пересланного «Исходное: …» (01·1.21, 1.43).
                const [sent, ...more] = menuFootLines(m);
                // «Прочитано в 12:34» (С1): своё прочитанное в беседе 1:1 — строка ниже (Telegram Desktop: строка ✓✓ в меню).
                const readAt = readAtConvId && mine && read ? <ReadAtLine convId={readAtConvId} messageId={m.id} /> : null;
                // «N прочитали» (15.10, `readers1`): своё прочитанное в группе, не старше 7 суток — пункт над подвалом, как у
                // Telegram Web A (разделитель, пункт со стопкой аватарок, ниже — сведения о сообщении).
                const readers =
                  readersConvId && readersLineShown({ mine, read, createdAt: m.createdAt, now: Date.now() }) ? (
                    <>
                      <MenuDivider />
                      <ReadersLine
                        convId={readersConvId}
                        messageId={m.id}
                        lookup={reactorOf}
                        onOpen={(list) => {
                          const spot = msgMenu.bubble;
                          close();
                          setSeen(spot ? { id: m.id, list, anchor: spot.anchor } : { id: m.id, list, pos: msgMenu.pos });
                        }}
                      />
                    </>
                  ) : null;
                return (
                  <>
                  {readers}
                  <div className={more.length || readAt ? 'ctx-foot multi' : 'ctx-foot'} role="none">
                    <span className="ctx-foot-ico">
                      {bubbles && mine ? (
                        <Icon name={read ? 'checks' : 'check'} size={14} stroke={1.5} title={read ? 'Прочитано' : 'Отправлено'} />
                      ) : null}
                    </span>
                    <span>{sent}</span>
                    {more.map((line) => (
                      <span key={line} className="ctx-foot-line">
                        {line}
                      </span>
                    ))}
                    {readAt}
                  </div>
                  </>
                );
              })()}
            </>
          );
          const b = msgMenu.bubble;
          // С пунктами фото — шире: «Копировать изображение» в 248 px обрезалось многоточием («изображен…», телефон 06.10).
          // Пункты файла (07.10) — так же: «Сохранить в загрузки» длиннее прочих.
          const menuWidth = (photo && (canCopyImage() || canSaveImage())) || fileActs.length ? 272 : 248;
          return b ? (
            <ContextMenu anchor={b.anchor} align={b.align} spotlight={b.spotlight} reactions={reactions} onClose={close} width={menuWidth}>
              {items}
            </ContextMenu>
          ) : (
            <ContextMenu pos={msgMenu.pos} reactions={reactions} onClose={close} width={menuWidth}>
              {items}
            </ContextMenu>
          );
        })()}
      {/* Меню ссылки на телефоне (07.10, Telegram 2.21 / 10.03): удержание пальцем по ссылке в тексте — у самой ссылки,
          «Открыть» (окно про внешнюю ссылку — как у нажатия) · «Скопировать ссылку». Не меню сообщения и не выделение. */}
      {linkMenu && (
        <ContextMenu anchor={linkMenu.anchor} onClose={() => setLinkMenu(null)}>
          <MenuItem
            icon="globe"
            label="Открыть"
            onClick={() => {
              setLinkMenu(null);
              openMessageLink(linkMenu.m, linkMenu.url);
            }}
          />
          <MenuItem
            icon="link"
            label="Скопировать ссылку"
            onClick={() => {
              setLinkMenu(null);
              copyLinkUrl(linkMenu.url);
            }}
          />
        </ContextMenu>
      )}
      {linkAsk && (
        <LinkConfirmModal url={linkAsk.url} onClose={() => setLinkAsk(null)} />
      )}
      {who &&
        (() => {
          /* Окно «кто поставил» (07.10; Telegram 3.30 / 3.31, вид — тултип «кто реагировал» дизайна раунда 5): эмодзи и
             «отреагировали N», ниже люди по порядку постановки — аватар, имя (своё — «(вы)»), когда поставил; нажатие —
             карточка профиля. Реакцию сняли или сообщение ушло из ленты — окна нет (эффект ниже снимает состояние). */
          const m = messages.find((x) => x.id === who.id);
          const r = m?.reactions?.find((x) => x.emoji === who.emoji);
          const people = r?.reactors ?? [];
          if (!m || !r || people.length === 0) return null;
          const close = () => setWho(null);
          const rows = (
            <>
              <div className="who-head" role="none">
                <span className="who-emoji">{renderReaction(r.emoji, emojiById)}</span>
                <span className="who-count">
                  отреагировали <b>{r.count}</b>
                </span>
              </div>
              {people.map((p) => {
                const look = reactorOf?.(p.userId) ?? null;
                const name = look?.name ?? 'Пользователь';
                return (
                  <button
                    type="button"
                    role="menuitem"
                    className="ctx-item who-row"
                    key={p.userId}
                    onClick={(e) => {
                      close();
                      openUserMenu(e, { userId: p.userId, name, avatarUrl: look?.avatarUrl ?? null }, 'profile');
                    }}
                  >
                    <Avatar url={look?.avatarUrl ?? null} name={name} size={22} />
                    <span className="ctx-label has-sub">
                      <span className="ctx-label-main">
                        {name}
                        {p.userId === meId ? <span className="who-me"> (вы)</span> : null}
                      </span>
                      <span className="ctx-sublabel">{sentAtLabel(p.at)}</span>
                    </span>
                  </button>
                );
              })}
            </>
          );
          return who.anchor ? (
            <ContextMenu anchor={who.anchor} onClose={close} width={232}>
              {rows}
            </ContextMenu>
          ) : (
            <ContextMenu pos={who.pos ?? { x: 0, y: 0 }} onClose={close} width={232}>
              {rows}
            </ContextMenu>
          );
        })()}
      {seen &&
        (() => {
          /* Окно «кто прочитал» (15.10, `readers1`; Telegram Desktop — подменю списка у строки «N Seen», Web A `SeenByModal`):
             шапка как у окна «кто поставил» — ✓✓ и «прочитали N», ниже люди: аватар, имя, справа — реакция, если ставил
             (Telegram показывает реакцию у прочитавшего). Времени у групп нет — без подстроки (как Telegram для старых).
             Нажатие — карточка профиля. */
          const m = messages.find((x) => x.id === seen.id);
          if (!m) return null;
          const close = () => setSeen(null);
          const reactionOf = new Map<string, string>();
          for (const r of m.reactions ?? []) for (const p of r.reactors ?? []) if (!reactionOf.has(p.userId)) reactionOf.set(p.userId, r.emoji);
          const rows = (
            <>
              <div className="who-head" role="none">
                <span className="who-emoji seen-ico">
                  <Icon name="checks" size={18} />
                </span>
                <span className="who-count">
                  прочитали <b>{seen.list.length}</b>
                </span>
              </div>
              {seen.list.map((r) => {
                const look = readerLook(r, reactorOf);
                const emoji = reactionOf.get(r.userId);
                return (
                  <button
                    type="button"
                    role="menuitem"
                    className="ctx-item who-row"
                    key={r.userId}
                    onClick={(e) => {
                      close();
                      openUserMenu(e, { userId: r.userId, name: look.name, avatarUrl: look.avatarUrl }, 'profile');
                    }}
                  >
                    <Avatar url={look.avatarUrl} name={look.name} size={22} />
                    <span className="ctx-label">
                      <span className="ctx-label-main">{look.name}</span>
                    </span>
                    {emoji ? <span className="who-emoji seen-react">{renderReaction(emoji, emojiById)}</span> : null}
                  </button>
                );
              })}
            </>
          );
          return seen.anchor ? (
            <ContextMenu anchor={seen.anchor} onClose={close} width={232}>
              {rows}
            </ContextMenu>
          ) : (
            <ContextMenu pos={seen.pos ?? { x: 0, y: 0 }} onClose={close} width={232}>
              {rows}
            </ContextMenu>
          );
        })()}
      {outMenu?.bubble &&
        (() => {
          /* Неотправленное у пузыря (раунд 12; решение владельца — телефон и узкое окно, на ПК меню как было): те же
             пункты, без полосы реакций и разделителей; в подвале вместо времени — почему не ушло (было подзаголовком
             листа). */
          const o = (outbox ? outbox.items : outgoing).find((x) => x.key === outMenu.key);
          const b = outMenu.bubble;
          if (!o || !b) return null;
          const close = () => setOutMenu(null);
          if (o.status === 'sending') {
            return (
              <ContextMenu anchor={b.anchor} align={b.align} spotlight={b.spotlight} onClose={close} width={248}>
                {o.content && (
                  <MenuItem
                    icon="copy"
                    label="Скопировать текст"
                    onClick={() => {
                      copyMessageText(o.content);
                      close();
                    }}
                  />
                )}
                <MenuItem
                  icon="close"
                  label="Отменить отправку"
                  danger
                  onClick={() => {
                    cancelSending(o.key);
                    close();
                  }}
                />
                <div className="ctx-foot" role="none">
                  <span className="ctx-foot-ico" />
                  <span>Отправляется…</span>
                </div>
              </ContextMenu>
            );
          }
          return (
            <ContextMenu anchor={b.anchor} align={b.align} spotlight={b.spotlight} onClose={close} width={248}>
              <MenuItem
                icon="reset"
                label="Повторить отправку"
                onClick={() => {
                  if (outbox) outbox.retry(o.key);
                  else retryOutgoing(o.key);
                  close();
                }}
              />
              {o.content && (
                <MenuItem
                  icon="copy"
                  label="Скопировать текст"
                  onClick={() => {
                    copyMessageText(o.content);
                    close();
                  }}
                />
              )}
              <MenuItem
                icon="trash"
                label="Удалить"
                danger
                onClick={() => {
                  if (outbox) outbox.discard(o.key);
                  else setOutgoing((l) => outgoingSent(l, o.key));
                  close();
                }}
              />
              <div className="ctx-foot" role="none">
                <span className="ctx-foot-ico" />
                <span>{o.error ? `Не отправлено: ${o.error}` : 'Не отправлено'}</span>
              </div>
            </ContextMenu>
          );
        })()}
    </div>
    </AutoDownloadSource.Provider>
  );
}
