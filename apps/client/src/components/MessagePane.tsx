import {
  BROADCAST_MENTIONS,
  customReactionId,
  customReactionKey,
  formatDuration,
  isVoiceMessage,
  VOICE_MAX_MS,
  type Attachment,
  type Message,
  type ServerEmoji,
  type Sticker,
  type StickerPack,
} from '@gusvoice/shared';
import type { ReactNode } from 'react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { isMobile } from '../hotkeys';
import { useStore } from '../store';
import { primaryCode, searchEmoji } from '../emojiShortcodes';
import {
  acTokenAt,
  applyAc,
  dayLabel,
  emojiSubstitution,
  isFirstUnread,
  isGrouped,
  isNewDay,
  type AcToken,
} from '../messagePaneRules';
import { MessageLink } from '../linkGuard';
import {
  addedBelow,
  isNearBottom,
  jumpDownLabel,
  keepPositionAfterPrepend,
  shouldAutoScroll,
  shouldLoadOlder,
  shouldShowJumpDown,
} from '../stickToBottom';
import { renderMessageText, type EmojiResolver } from '../messageText';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { CrownMark, crownGlow, useCrownId } from './Crown';
import { useAnimatedAvatarUrl } from '../avatarAnimation';
import { BottomSheet, SheetRow } from './BottomSheet';
import { ContextMenu, MenuDivider, MenuItem, type MenuPos } from './ContextMenu';
import { EmojiPicker } from './EmojiPicker';
import { StickerPicker } from './StickerPicker';
import { StickerView } from './StickerView';
import { VoiceMessage, VoicePlayer } from './VoiceMessage';
import { ExprTabs, getExprTab, type ExprTab } from './ExprTabs';
import { attachmentBox } from '../imageSize';
import {
  addOutgoing,
  outgoingFailed,
  outgoingFilesLabel,
  outgoingRetry,
  outgoingSent,
  sendErrorText,
  type OutgoingMessage,
} from '../outgoingRules';
import { startVoiceRecording, voiceRecordingSupported, type VoiceTake } from '../voiceRecorder';
import { VOICE_HOLD, voiceHoldProgress } from '../voiceHold';
import { createVoiceHoldController, type VoiceHoldState } from '../voiceHoldController';
import { LinkPreviewCard, linkPreviewsEnabled, previewableLinks } from './LinkPreview';
import { PollCard } from './PollCard';
import { PollComposer } from './PollComposer';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { Lightbox } from './Lightbox';
import { GuestMark, useGuestHome } from './GuestMark';
import { addEvidence, EVIDENCE_MAX } from '../reportEvidence';
import { confirmAction } from '../confirm';
import { useUserMenu } from './UserContextMenu';

/** Candidates for @-mention / #-channel autocomplete in the composer (channels only; DMs omit it). */
export type AutocompleteData = {
  users: { id: string; username: string; displayName: string; avatarUrl?: string | null; online?: boolean }[];
  roles: { id: string; name: string; mentionable: boolean }[];
  channels: { id: string; name: string }[];
};
type AcItem =
  | { kind: 'user'; id: string; insert: string; label: string; handle: string; avatarUrl?: string | null; online?: boolean }
  | { kind: 'role'; id: string; insert: string; label: string }
  | { kind: 'broadcast'; id: string; insert: string; label: string; hint: string }
  | { kind: 'channel'; id: string; insert: string; label: string }
  | { kind: 'emoji'; id: string; insert: string; label: string; emoji: string };

const isImage = (ct: string) => ct.startsWith('image/');
/** Потолок картинки в ленте — те же числа, что в `.att-img` (styles.css): 360 × 300. */
const ATT_IMG_MAX_W = 360;
const ATT_IMG_MAX_H = 300;
const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** Emoji offered in the mobile long-press action sheet's quick-reaction strip (design-step8 C2). */
const QUICK_REACTIONS = ['👍', '🔥', '😂', '❤️', '🦆'];

function AttachmentView({ a, onOpen }: { a: Attachment; onOpen?: (a: Attachment) => void }) {
  // Real download goes through the backend (Content-Disposition: attachment) — the
  // <a download> attribute is ignored cross-origin, so a plain MinIO link just NAVIGATES.
  const dl = api.attachmentDownloadUrl(a);
  // Голосовое (#20) — плеер с полоской, а не карточка файла. Признак — огибающая на вложении;
  // просто скинутый mp3 остаётся файлом, полоски у него нет.
  if (isVoiceMessage(a)) return <VoiceMessage a={a} />;
  if (isImage(a.contentType)) {
    const box = attachmentBox(a.width, a.height, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
    return (
      <div className="att-img-wrap">
        <button type="button" className="att-img-link" title={a.name} onClick={() => onOpen?.(a)}>
          {/* data-ctxsave: это КОНТЕНТ — правый клик оставляет «Сохранить изображение» (#75). */}
          {/* Место под картинку — заранее, по размеру из вложения (#194): иначе лента прыгает, пока
              картинки догружаются. `auto` в пропорции — после загрузки верх берёт настоящий файл. */}
          <img
            className="att-img"
            data-ctxsave
            src={a.url}
            alt={a.name}
            loading="lazy"
            style={box ? { width: box.width, aspectRatio: `auto ${box.width} / ${box.height}` } : undefined}
          />
        </button>
        <a className="att-dl" href={dl} title="Скачать" onClick={(e) => e.stopPropagation()}>
          <Icon name="download" size={15} />
        </a>
      </div>
    );
  }
  return (
    <a href={dl} className="att-file" title={`Скачать ${a.name}`}>
      <span className="att-file-icon">
        <Icon name="paperclip" size={16} />
      </span>
      <span className="att-file-name">{a.name}</span>
      <span className="att-file-size">{kb(a.size)}</span>
      <span className="att-file-dl">
        <Icon name="download" size={15} />
      </span>
    </a>
  );
}

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
) {
  return renderMessageText(
    content,
    (url, key) => <MessageLink key={key} url={url} authorId={authorId} authorName={authorName} />,
    onEmoji,
  );
}

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
  onEdit,
  onDelete,
  onReact,
  onCopyLink,
  canModerate,
  onPin,
  loading,
  autocomplete,
  newSince,
  scrollKey,
  feedId,
  onLoadOlder,
  onTyping,
  typingUsers,
  pollChannelId,
  emptyState,
  headerActions,
  nameOf = (_userId, fallback) => fallback,
  onEmoji,
  customEmojis,
  emojiById = () => null,
  stickerPacks,
  onSendSticker,
  onSendVoice,
  serverId,
}: {
  title: ReactNode;
  placeholder: string;
  /**
   * Сервер, в котором открыт этот чат, — нужен ТОЛЬКО чтобы узнать носителя короны.
   * ⚠️ В личных сообщениях не передаётся, и это правильно: сезон принадлежит серверу, а не паре
   * собеседников. Нет сервера — нет короны, безо всяких условий на месте отрисовки.
   */
  serverId?: string;
  messages: Message[];
  meId: string | undefined;
  /** History still loading — show shimmer skeletons instead of the empty state. */
  loading?: boolean;
  onSend: (content: string, files: File[], replyToId?: string | null) => Promise<void>;
  onEdit: (m: Message, content: string) => Promise<void>;
  onDelete: (m: Message) => Promise<void>;
  onReact?: (messageId: string, emoji: string, op: 'add' | 'remove') => void;
  /** When provided, the message menu shows "Копировать ссылку" (channels only). */
  onCopyLink?: (m: Message) => void;
  /** Caller can delete others' messages (MANAGE_MESSAGES) — shows delete on non-own messages. */
  canModerate?: boolean;
  /** When provided, the message menu shows Закрепить/Открепить (channels, MANAGE_MESSAGES). */
  onPin?: (m: Message, pinned: boolean) => void;
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
  onTyping?: () => void;
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
  /**
   * Отправить голосовое (#20). Отдельно от `onSend`, потому что несёт огибающую и длительность —
   * их надо приложить к вложению, а `onSend` принимает голые файлы. ЛС это тоже умеют: голосовое
   * не серверная настройка, в отличие от стикеров и ников.
   */
  onSendVoice?: (take: VoiceTake) => Promise<void>;
  emptyState?: ReactNode;
  /** Optional controls rendered right-aligned in the top bar (e.g. a DM push-mute toggle). */
  headerActions?: ReactNode;
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
  const [text, setText] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  /** Свои сообщения в пути (#194) — правила в `outgoingRules.ts`. */
  const [outgoing, setOutgoing] = useState<(OutgoingMessage & { feedId: string | undefined; afterId: string | undefined })[]>([]);
  const outKey = useRef(0);
  /** Индекс картинки, открытой на просмотр ДО отправки (null — просмотр закрыт). */
  const [pendingBox, setPendingBox] = useState<number | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  // Вкладка пикера строки ввода (#159): стикеры — соседняя вкладка эмодзи, а не отдельная кнопка.
  const [exprTab, setExprTabState] = useState<ExprTab>(getExprTab);
  // Шторка «+» на телефоне (#159): где стоит кнопка — туда же встанет пикер стикеров. null = закрыта.
  const [plusAnchor, setPlusAnchor] = useState<DOMRect | null>(null);
  /**
   * Запись голосового (#20) и кнопка записи на месте «отправить» (#159, как в Telegram). Весь жизненный
   * цикл — асинхронный микрофон, мёртвые нажатия, «без рук», «стоп» с прослушиванием — живёт в
   * `voiceHoldController.ts` (без React, вынос для тестов 22.09); пороги жеста — `voiceHold.ts`. Здесь
   * только перевод событий указателя и отрисовка состояния.
   */
  const onSendVoiceRef = useRef(onSendVoice);
  onSendVoiceRef.current = onSendVoice;
  const [voiceState, setVoiceState] = useState<VoiceHoldState<VoiceTake> | null>(null);
  const voice = useMemo(
    () =>
      createVoiceHoldController<VoiceTake>({
        openMic: () => startVoiceRecording(),
        send: async (take) => {
          await onSendVoiceRef.current?.(take);
        },
        previewUrl: (take) => URL.createObjectURL(take.file),
        releasePreviewUrl: (url) => URL.revokeObjectURL(url),
        toast: (kind, title, body) => toast(kind, title, body),
        toastError: (err) => toastError(err),
        vibrate: () => navigator.vibrate?.(8),
        now: () => performance.now(),
        wallNow: () => Date.now(),
        maxMs: VOICE_MAX_MS,
        onChange: setVoiceState,
      }),
    [],
  );
  const { recording, recBusy, recMs, recLevel, preview, holdUi } = voiceState ?? voice.getState();
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [picker, setPicker] = useState<
    { kind: 'msg'; messageId: string; anchor: DOMRect } | { kind: 'composer'; anchor: DOMRect } | null
  >(null);
  const [msgMenu, setMsgMenu] = useState<{ m: Message; pos: MenuPos } | null>(null);
  // Mobile long-press: the message whose bottom-sheet action menu is open (design-step8 C2).
  const [sheetMsg, setSheetMsg] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // @mention / #channel autocomplete: the active trigger token + the highlighted suggestion.
  const [ac, setAc] = useState<AcToken | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const lastTypingSent = useRef(0);
  // Long-press bookkeeping: the pending timer + the touch start point (to cancel on scroll).
  const lpTimer = useRef<number | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * Стоял ли человек у низа ПЕРЕД приходом нового. Держим рефом, а не состоянием: значение читает
   * эффект прокрутки, и ему нужно последнее событие мыши, а не то, что было на момент отрисовки.
   */
  const nearBottomRef = useRef(true);
  const [nearBottom, setNearBottom] = useState(true);
  /** Сколько сообщений пришло, пока человек читал выше — столько и обещает кнопка «вниз». */
  const [unseenBelow, setUnseenBelow] = useState(0);
  /** Идёт ли сейчас подгрузка истории и осталось ли что тянуть (рефы — их читает обработчик прокрутки). */
  const olderBusy = useRef(false);
  const hasOlder = useRef(true);
  const [showOlderHint, setShowOlderHint] = useState(false);
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
  /** Последнее сообщение прошлой отрисовки — по нему считаем, сколько пришло именно снизу. */
  const prevLastId = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const { open: openUserMenu, menu: userMenu } = useUserMenu();
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

  /**
   * Прижать ленту к низу. Именно `scrollTop`, а не `scrollIntoView`: второй ищет ближайшего
   * прокручиваемого предка и в скрытой вкладке с `behavior: 'smooth'` не исполняется вовсе.
   */
  function stickDown() {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

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
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, []);

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
  useEffect(() => {
    if (!wantUnreadJump.current || !newSince || messages.length === 0) return;
    const box = listRef.current;
    const mark = box?.querySelector<HTMLElement>('.new-divider');
    if (!box || !mark) return;
    wantUnreadJump.current = false;
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
    setUnseenBelow(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSince, messages.length]);

  // Догоняем «сейчас» только тому, кто и так в него смотрит; правило целиком — в stickToBottom.ts.
  useEffect(() => {
    const added = addedBelow(
      messages.map((m) => m.id),
      prevLastId.current,
    );
    const last = messages[messages.length - 1];
    prevLastId.current = last?.id;
    const ownMessage = !!last && last.author.id === meId;
    if (shouldAutoScroll({ wasNearBottom: nearBottomRef.current, ownMessage, switchedFeed: false })) {
      stickDown();
      setUnseenBelow(0);
    } else if (added > 0) {
      setUnseenBelow((n) => n + added);
    }
  }, [messages.length]);

  // Открыли ДРУГУЮ ленту — показываем её снизу, как будто зашли впервые. Эффект стоит после
  // предыдущего намеренно: он перебивает его решение, принятое по старому положению прокрутки.
  useEffect(() => {
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
    // messages здесь намеренно не в зависимостях: реагируем именно на смену ленты.
    return () => {
      window.clearTimeout(giveUp);
      box?.removeEventListener('wheel', drop);
      box?.removeEventListener('touchstart', drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  // Flat list of every image in the view, for the lightbox (prev/next across all of them).
  const allImages = useMemo(() => {
    const list: { url: string; name: string; size: number; downloadUrl: string; att: Attachment }[] = [];
    for (const m of messages)
      for (const a of m.attachments ?? [])
        if (isImage(a.contentType))
          list.push({ url: a.url, name: a.name, size: a.size, downloadUrl: api.attachmentDownloadUrl(a), att: a });
    return list;
  }, [messages]);
  function openImage(a: Attachment) {
    const i = allImages.findIndex((x) => x.att === a);
    if (i >= 0) setLightbox(i);
  }

  // Autocomplete suggestions for the active @/# token (users + roles, or channels).
  const acItems = useMemo<AcItem[]>(() => {
    if (!ac) return [];
    const q = ac.query.toLowerCase();
    // Emoji works everywhere, including DMs — it needs no server-provided candidates, unlike @ and #.
    if (ac.trigger === ':') {
      return searchEmoji(q).map((e) => ({
        kind: 'emoji' as const,
        id: e.emoji,
        insert: e.emoji,
        label: `:${primaryCode(e, q)}:`,
        emoji: e.emoji,
      }));
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
      const broadcast: AcItem[] = BROADCAST_MENTIONS.filter((n) => n.startsWith(q)).map((n) => ({
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
  }, [ac, autocomplete]);

  // Recompute the active trigger token from the input value + caret position.
  function refreshAc(value: string, caret: number | null) {
    const token = acTokenAt(value, caret, !!autocomplete);
    setAc(token);
    if (token) setAcIndex(0);
  }

  function acceptAc(item: AcItem) {
    if (!ac) return;
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

  function addFiles(list: FileList | File[] | null) {
    if (!list || list.length === 0) return;
    setPending((p) => [...p, ...Array.from(list)].slice(0, 10));
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
    addFiles(
      files.map((f, i) => {
        if (f.name && f.name !== 'image.png') return f;
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const n = files.length > 1 ? `-${i + 1}` : '';
        return new File([f], `screenshot-${stamp}${n}.${ext}`, { type: f.type });
      }),
    );
  }

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
    const content = text.trim();
    if (!content && pending.length === 0) return;
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
    setPending([]);
    setReplyingTo(null);
    /* 🔴 Сообщение встаёт в ленту СРАЗУ бледной строкой «отправляется» (#194) и сменяется настоящим по
       ответу сервера. Отказ не прячем и не возвращаем молча в поле (раньше текст возвращался, только
       если поле было пустым, иначе уезжал в тост) — строка остаётся «не отправлено» с «Повторить» /
       «Удалить». Своё действие — лента едет вниз всегда, как и при ответе сервера. */
    const item = {
      key: `out-${++outKey.current}`,
      content,
      files,
      replyToId: replyTo?.id ?? null,
      status: 'sending' as const,
      error: null,
      feedId,
      // Последнее сообщение ленты в момент отправки — по нему узнаём, что настоящее уже пришло (ниже).
      afterId: messages[messages.length - 1]?.id,
    };
    setOutgoing((o) => addOutgoing(o, item));
    requestAnimationFrame(() => stickDown());
    enqueueSend(item);
  }

  /** Поставить сообщение в очередь отправки; исход — в строку «в пути», а не в тост. */
  function enqueueSend(item: OutgoingMessage & { feedId: string | undefined; afterId: string | undefined }) {
    sendQueue.current = sendQueue.current
      .then(() => onSend(item.content, item.files, item.replyToId))
      .then(() => setOutgoing((o) => outgoingSent(o, item.key)))
      .catch((err) => {
        const why = sendErrorText(err);
        setOutgoing((o) => (why === null ? outgoingSent(o, item.key) : outgoingFailed(o, item.key, why)));
      });
  }

  function retryOutgoing(key: string) {
    const item = outgoing.find((o) => o.key === key);
    if (!item || item.status !== 'failed') return;
    setOutgoing((o) => outgoingRetry(o, key));
    enqueueSend({ ...item, status: 'sending', error: null });
  }

  function startReply(m: Message) {
    setReplyingTo(m);
    inputRef.current?.focus();
  }

  // Mobile long-press on a message body → open the action sheet (design-step8 C2). Ignore presses
  // that land on interactive children (avatar/author open the user menu; links/images/buttons keep
  // their own behaviour), multi-touch, and cancel if the finger moves (a scroll, not a press).
  function onMsgTouchStart(e: React.TouchEvent, m: Message) {
    if (!isMobile() || e.touches.length !== 1) return;
    if ((e.target as Element).closest('a, img, button, input, textarea, .msg-ava, .author')) return;
    const t = e.touches[0];
    lpStart.current = { x: t.clientX, y: t.clientY };
    lpTimer.current = window.setTimeout(() => {
      lpTimer.current = null;
      navigator.vibrate?.(8);
      setSheetMsg(m);
    }, 480);
  }
  function onMsgTouchMove(e: React.TouchEvent) {
    if (lpTimer.current == null || !lpStart.current) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - lpStart.current.x) > 10 || Math.abs(t.clientY - lpStart.current.y) > 10) {
      window.clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  }
  function cancelLongPress() {
    if (lpTimer.current != null) {
      window.clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  }

  async function saveEdit(m: Message) {
    const content = editText.trim();
    if (!content) return;
    try {
      await onEdit(m, content);
      setEditingId(null);
    } catch (err) {
      toastError(err);
    }
  }

  async function del(m: Message) {
    // Самое частое подтверждение в приложении — поэтому короткое: без тела, одним вопросом.
    if (!(await confirmAction({ title: 'Удалить сообщение?', tone: 'danger', confirmLabel: 'Удалить' }))) return;
    try {
      await onDelete(m);
    } catch (err) {
      toastError(err);
    }
  }

  // Тикаем, пока идёт запись: и таймер, и уровень. 100 мс — глазу достаточно, процессору не жалко.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => voice.tick(), 100);
    return () => clearInterval(t);
  }, [recording, voice]);

  // Уходим со страницы посреди записи — глушим микрофон и отпускаем прослушивание (см. `dispose`).
  useEffect(() => () => voice.dispose(), [voice]);

  // Какие действия есть в этом чате. Одни и те же условия у кнопок строки ввода (компьютер) и у
  // пунктов шторки «+» (телефон) — иначе на одном из экранов всплыло бы действие, которого тут нет.
  const micAvailable = !!onSendVoice && voiceRecordingSupported();
  const canVoice = micAvailable && !recording && !preview;
  const canSticker = !!stickerPacks?.length && !!onSendSticker;

  function onMicDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Не забираем фокус у поля: открытая клавиатура не должна схлопываться под пальцем.
    e.preventDefault();
    if (voice.press({ id: e.pointerId, x: e.clientX, y: e.clientY }) !== 'hold') return;
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
    voice.release({ id: e.pointerId });
  }

  /** Жест оборвала система (входящий звонок, запрос разрешения) — сказанное не отправляем. */
  function onMicAbort(e: React.PointerEvent<HTMLButtonElement>) {
    voice.abort({ id: e.pointerId });
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
    } catch (err) {
      toastError(err);
    }
  }

  function onEmojiPick(emoji: string, customEmoji?: ServerEmoji) {
    if (!picker) return;
    // В композер уходит `:имя:` — текст сообщения хранится как есть, а картинка подставляется
    // при отрисовке. В реакцию уходит `custom:<id>`: имя переименуемо, id — нет (#18).
    if (picker.kind === 'composer') setText((t) => t + emoji);
    else onReact?.(picker.messageId, customEmoji ? customReactionKey(customEmoji.id) : emoji, 'add');
    setPicker(null);
  }

  function copyMessageText(content: string) {
    navigator.clipboard
      ?.writeText(content)
      .then(() => toast('success', 'Текст скопирован'))
      .catch(() => toast('error', 'Не удалось скопировать'));
  }

  return (
    <div
      className={`chat${dragOver ? ' drag-over' : ''}`}
      onDragEnter={(e) => {
        // Текст из другого поля тоже «перетаскивается» — рамку показываем только для файлов.
        if (![...e.dataTransfer.types].includes('Files')) return;
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="drop-hint" aria-hidden>
          <Icon name="paperclip" size={28} />
          <span>Отпустите — прикрепим к сообщению</span>
        </div>
      )}
      <div className="channel-topbar">
        {title}
        {headerActions ? <span className="topbar-actions">{headerActions}</span> : null}
      </div>
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = isNearBottom(el);
          nearBottomRef.current = near;
          setNearBottom(near);
          if (near) setUnseenBelow(0);
          // Долистали почти до начала загруженного — тянем следующую порцию.
          if (!onLoadOlder) return;
          if (!shouldLoadOlder({ scrollTop: el.scrollTop, loading: olderBusy.current, hasMore: hasOlder.current })) return;
          olderBusy.current = true;
          setShowOlderHint(true);
          const before = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
          void onLoadOlder()
            .then((more) => {
              hasOlder.current = more;
              /* ⚠️ Поправка прокрутки — в СЛЕДУЮЩЕМ кадре: React ещё не отрисовал приехавшие
                 сообщения, и в этот момент scrollHeight равен старому. Без поправки человека
                 утаскивает в прошлое ровно на высоту порции. */
              requestAnimationFrame(() => {
                const box = listRef.current;
                if (box) box.scrollTop = keepPositionAfterPrepend(before, box.scrollHeight);
              });
            })
            .catch(() => {
              // Не вышло — просто перестаём просить, чтобы не долбить сервер на каждом пикселе.
              hasOlder.current = false;
            })
            .finally(() => {
              olderBusy.current = false;
              setShowOlderHint(false);
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
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          // First message newer than the last visit — and not mine, since my own message isn't news
          // to me. Rendered once, above that message.
          const row = { createdAt: m.createdAt, authorId: m.author.id, hasReply: !!m.replyTo };
          const prevRow = prev ? { createdAt: prev.createdAt, authorId: prev.author.id } : undefined;
          const firstUnread = isFirstUnread(row, prevRow, meId, newSince);
          const grouped = isGrouped(row, prevRow);
          const mine = m.author.id === meId;
          const editing = editingId === m.id;
          const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          // Имя автора — через резолвер: в канале сервера это ник, в ЛС остаётся обычное имя (#73).
          const author = nameOf(m.author.id, m.author.displayName);
          const newDay = isNewDay(row, prevRow);
          return (
            <Fragment key={m.id}>
            {/* Дневная метка: без неё, чтобы понять, где кончился вчерашний разговор, приходится
                читать время у каждого сообщения по отдельности. */}
            {newDay && (
              <div className="day-divider" role="separator">
                <span>{dayLabel(m.createdAt)}</span>
              </div>
            )}
            {firstUnread && (
              <div className="new-divider" role="separator" aria-label="Новые сообщения">
                <span>Новые сообщения</span>
              </div>
            )}
            <div
              // `active` — сообщение, с которым сейчас работают: открыто его контекстное меню,
              // висит его пикер реакций или оно редактируется. Наведение даёт слабую подсветку,
              // а действие — рамку: иначе при открытом меню курсор уходит на меню, ховер
              // слетает, и непонятно, к какому сообщению это меню относится.
              className={`message ${grouped ? 'grouped' : ''} ${
                msgMenu?.m.id === m.id || (picker?.kind === 'msg' && picker.messageId === m.id) || editing
                  ? 'active'
                  : ''
              }`}
              onTouchStart={(e) => onMsgTouchStart(e, m)}
              onTouchMove={onMsgTouchMove}
              onTouchEnd={cancelLongPress}
              onTouchCancel={cancelLongPress}
              onContextMenu={(e) => {
                // Let avatar/author (user menu), links, images and controls keep their own
                // right-click behaviour; the message menu only opens over the message body.
                if ((e.target as Element).closest('a, img, button, input, textarea, .msg-ava, .author')) return;
                e.preventDefault();
                setMsgMenu({ m, pos: { x: e.clientX, y: e.clientY } });
              }}
            >
              <div className="msg-gutter">
                {grouped ? (
                  <span className="msg-hovertime">{time}</span>
                ) : (
                  <span
                    className="msg-ava"
                    onContextMenu={(e) =>
                      openUserMenu(e, { userId: m.author.id, name: author, avatarUrl: m.author.avatarUrl })
                    }
                  >
                    <Avatar url={m.author.avatarUrl} animatedUrl={animatedOf(m.author.id)} name={author} size={38} />
                    {crownId === m.author.id && <CrownMark size={13} />}
                  </span>
                )}
              </div>
              <div className="message-main">
                {m.replyTo && (
                  <div className="reply-quote">
                    <Icon name="reply" size={13} />
                    <span className="rq-author">{m.replyTo.authorName}</span>
                    <span className="rq-text">{m.replyTo.content || 'вложение'}</span>
                  </div>
                )}
                {!grouped && (
                  <div className="message-head">
                    <span
                      className={`author ${mine ? 'me' : ''}${crownGlow(crownId === m.author.id)}`}
                      onContextMenu={(e) =>
                        openUserMenu(e, {
                          userId: m.author.id,
                          name: author,
                          avatarUrl: m.author.avatarUrl,
                        })
                      }
                    >
                      {author}
                    </span>
                    <GuestMark home={guestHomeOf(m.author.id)} size={11} />{' '}
                    <span className="ts muted">{time}</span>
                  </div>
                )}
                {editing ? (
                  <div className="edit-box">
                    <textarea
                      value={editText}
                      autoFocus
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void saveEdit(m);
                        } else if (e.key === 'Escape') {
                          setEditingId(null);
                        }
                      }}
                    />
                    <div className="edit-hint muted">Enter — сохранить · Esc — отмена</div>
                  </div>
                ) : (
                  <>
                    {m.poll ? <PollCard poll={m.poll} channelId={m.channelId} messageId={m.id} /> : null}
                    {/* Стикер (#68) — крупно и без рамки сообщения. Лежит копией в самом сообщении,
                        поэтому переживает удаление набора, из которого пришёл. */}
                    {m.sticker ? (
                      <div className="message-sticker">
                        <StickerView
                          url={m.sticker.url}
                          format={m.sticker.format}
                          emoji={m.sticker.emoji}
                          size={160}
                        />
                      </div>
                    ) : null}
                    {m.content ? (
                      <div className="message-body">
                        {renderContent(m.content, m.author.id, author, onEmoji)}
                        {m.editedAt ? <span className="ts muted edited"> (изм.)</span> : null}
                      </div>
                    ) : null}
                    {/* Карточки ссылок (#64). Своим инстансом не занимаемся — предпросмотр
                        собственных страниц бессмысленен, а запрос лишний. */}
                    {m.content && linkPreviewsEnabled()
                      ? previewableLinks(m.content).map((u) => (
                          <LinkPreviewCard
                            key={u}
                            url={u}
                            authorId={m.author.id}
                            authorName={author}
                          />
                        ))
                      : null}
                    {m.attachments?.length ? (
                      <div className="attachments">
                        {m.attachments.map((a, j) => (
                          <AttachmentView key={j} a={a} onOpen={openImage} />
                        ))}
                      </div>
                    ) : null}
                    {m.reactions && m.reactions.length > 0 ? (
                      <div className="reactions">
                        {m.reactions.map((r) => (
                          <button
                            type="button"
                            key={r.emoji}
                            className={`reaction ${r.me ? 'mine' : ''}`}
                            disabled={!onReact}
                            onClick={() => onReact?.(m.id, r.emoji, r.me ? 'remove' : 'add')}
                          >
                            <span className="re-emoji">{renderReaction(r.emoji, emojiById)}</span>
                            <span className="re-count">{r.count}</span>
                          </button>
                        ))}
                        {onReact ? (
                          <button
                            type="button"
                            className="reaction add"
                            title="Добавить реакцию"
                            onClick={(e) =>
                              setPicker({ kind: 'msg', messageId: m.id, anchor: e.currentTarget.getBoundingClientRect() })
                            }
                          >
                            <Icon name="reaction" size={15} />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              {!editing && (
                <div className="msg-actions">
                  <button type="button" title="Ответить" onClick={() => startReply(m)}>
                    <Icon name="reply" size={16} />
                  </button>
                  {onReact ? (
                    <button
                      type="button"
                      title="Реакция"
                      onClick={(e) =>
                        setPicker({ kind: 'msg', messageId: m.id, anchor: e.currentTarget.getBoundingClientRect() })
                      }
                    >
                      <Icon name="reaction" size={16} />
                    </button>
                  ) : null}
                  {mine ? (
                    <>
                      <button
                        type="button"
                        title="Изменить"
                        onClick={() => {
                          setEditingId(m.id);
                          setEditText(m.content);
                        }}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      <button type="button" className="danger" title="Удалить" onClick={() => void del(m)}>
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
            </Fragment>
          );
        })}
        {outgoing
          .filter((o) => o.feedId === feedId)
          /* Событие шлюза с настоящим сообщением часто приходит РАНЬШЕ ответа на запрос — тогда на
             время пинга в ленте стояли бы два одинаковых. Своё сообщение с тем же текстом после
             момента отправки = это оно, строку «в пути» уже не рисуем. */
          .filter((o) => {
            if (o.status !== 'sending' || !o.content) return true;
            const from = o.afterId ? messages.findIndex((m) => m.id === o.afterId) + 1 : 0;
            return !messages.slice(from).some((m) => m.author.id === meId && m.content === o.content);
          })
          .map((o) => (
            <div key={o.key} className={`message grouped outgoing ${o.status}`} aria-live="polite">
              <div className="msg-gutter" />
              <div className="message-main">
                {o.content && <div className="message-body">{renderContent(o.content, meId ?? null, '', onEmoji)}</div>}
                {outgoingFilesLabel(o.files.map((f) => f.name)) && (
                  <div className="outgoing-files muted">
                    <Icon name="paperclip" size={13} /> {outgoingFilesLabel(o.files.map((f) => f.name))}
                  </div>
                )}
                {o.status === 'sending' ? (
                  <div className="outgoing-state muted">отправляется…</div>
                ) : (
                  <div className="outgoing-state error">
                    Не отправлено: {o.error}
                    <button type="button" className="link" onClick={() => retryOutgoing(o.key)}>
                      Повторить
                    </button>
                    <button type="button" className="link danger" onClick={() => setOutgoing((l) => outgoingSent(l, o.key))}>
                      Удалить
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        <div ref={bottomRef} />
      </div>
      {/* Обратная сторона прилипания: лента больше не дёргается — значит о новом надо сказать. */}
      {shouldShowJumpDown({ nearBottom, unseenBelow }) && (
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
      {pending.length > 0 && (
        <div className="pending-atts">
          {pending.map((f, i) => {
            const url = previewUrls.get(f);
            const drop = () => setPending((p) => p.filter((_, j) => j !== i));
            // Картинка — миниатюрой: при десяти скриншотах по именам вида
            // «screenshot-2026-07-20-12-28-27.png» не понять, какой лишний.
            return url ? (
              <span className="pending-thumb" key={i}>
                <button
                  type="button"
                  className="pt-open"
                  title={`${f.name} — открыть`}
                  onClick={() => setPendingBox(pendingImages.indexOf(f))}
                >
                  <img src={url} alt={f.name} />
                </button>
                <button type="button" className="pt-x" title="Убрать" onClick={drop}>
                  <Icon name="close" size={12} />
                </button>
                <span className="pt-size">{kb(f.size)}</span>
              </span>
            ) : (
              <span className="pending-att" key={i}>
                <Icon name="paperclip" size={14} /> {f.name}
                <button type="button" title="Убрать" onClick={drop}>
                  <Icon name="close" size={13} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {pollOpen && pollChannelId && <PollComposer channelId={pollChannelId} onClose={() => setPollOpen(false)} />}
      {pendingBox !== null && pendingImages.length > 0 && (
        <Lightbox
          images={pendingImages.map((f) => ({ url: previewUrls.get(f) ?? '', name: f.name, size: f.size }))}
          index={Math.min(pendingBox, pendingImages.length - 1)}
          onClose={() => setPendingBox(null)}
          onIndex={setPendingBox}
        />
      )}
      {replyingTo && (
        <div className="reply-strip">
          <Icon name="reply" size={14} />
          <span className="rs-label">
            Ответ <b>{nameOf(replyingTo.author.id, replyingTo.author.displayName)}</b>
          </span>
          <span className="rs-text">{replyingTo.content || 'вложение'}</span>
          <button type="button" className="rs-close" title="Отменить ответ" onClick={() => setReplyingTo(null)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {/* Полоса записи (#20) — над композером, как строка ответа: сам ввод остаётся на месте,
          и запись не выглядит как «приложение переключилось в другой режим». */}
      {(recording || preview) && (
        <div className="voice-rec">
          {preview ? (
            <VoicePlayer url={preview.url} waveform={preview.take.waveform} durationMs={preview.take.durationMs} />
          ) : (
            <>
              <span className="voice-rec-dot" />
              <span className="voice-rec-time">{formatDuration(recMs)}</span>
              <div className="voice-rec-level" aria-hidden>
                {/* Полоска живого уровня: видно, что микрофон реально слышит, ещё до отправки. */}
                <span style={{ width: `${Math.round(Math.min(1, recLevel * 1.6) * 100)}%` }} />
              </div>
              <span className="voice-rec-limit muted">до {formatDuration(VOICE_MAX_MS)}</span>
              <button
                type="button"
                className="rs-close stop-ico"
                title="Остановить и прослушать"
                onClick={() => void voice.stop()}
              >
                <Icon name="stop" size={15} />
              </button>
            </>
          )}
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
        </div>
      )}
      <form
        className={`composer${text.trim() || pending.length ? '' : ' empty'}${micAvailable ? ' has-mic' : ''}${
          recording || holdUi || preview ? ' rec-on' : ''
        }${holdUi ? ' rec-hold' : ''}`}
        onSubmit={send}
      >
        {ac && acItems.length > 0 && (
          <div className="ac-pop">
            <div className="ac-head">
              {ac.trigger === ':'
                ? `Эмодзи · :${ac.query}`
                : ac.trigger === '#'
                  ? `Каналы · #${ac.query}`
                  : `Участники · @${ac.query}`}
            </div>
            {acItems.map((it, i) => (
              <button
                type="button"
                key={`${it.kind}:${it.id}`}
                className={`ac-item ${i === acIndex ? 'active' : ''}`}
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
                ) : (
                  <span className="ac-role-ico">
                    <Icon name={it.kind === 'role' || it.kind === 'broadcast' ? 'users' : 'hash'} size={15} />
                  </span>
                )}
                <span className="ac-name">{it.label}</span>
                {it.kind === 'user' ? (
                  <span className="ac-handle">{it.handle}</span>
                ) : it.kind === 'role' ? (
                  <span className="ac-handle">роль</span>
                ) : it.kind === 'broadcast' ? (
                  <span className="ac-handle">{it.hint}</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
        {/* Телефон (#159): файл, голосовое, стикеры и опрос уезжают под «+», иначе поле ввода
            сжималось до 128 px из 387 — места под текст было меньше, чем под ряд кнопок. Кнопка
            есть в разметке всегда, а показывает её только мобильная раскладка (styles.css) — она
            же прячет четыре кнопки ниже. На компьютере строка остаётся прежней. */}
        <button
          type="button"
          className="att-btn plus"
          title="Добавить"
          aria-haspopup="dialog"
          aria-expanded={!!plusAnchor}
          onClick={(e) => setPlusAnchor(e.currentTarget.getBoundingClientRect())}
        >
          <Icon name="plus" size={21} />
        </button>
        <button
          type="button"
          className="att-btn attach"
          title="Прикрепить файл"
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="paperclip" size={19} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="att-btn emoji"
          title={canSticker ? 'Эмодзи и стикеры' : 'Эмодзи'}
          onClick={(e) => setPicker({ kind: 'composer', anchor: e.currentTarget.getBoundingClientRect() })}
        >
          <Icon name="reaction" size={19} />
        </button>
        {canVoice && (
          <button
            type="button"
            className="att-btn voice"
            title="Записать голосовое"
            disabled={recBusy}
            onClick={() => void voice.start()}
          >
            <Icon name="mic" size={19} />
          </button>
        )}
        {pollChannelId && (
          <button type="button" className="att-btn poll" title="Создать опрос" onClick={() => setPollOpen(true)}>
            <Icon name="activity" size={19} />
          </button>
        )}
        <input
          ref={inputRef}
          value={text}
          onPaste={onPasteFiles}
          onChange={(e) => {
            if (substituteEmoji(e.target.value, e.target.selectionStart)) return;
            setText(e.target.value);
            refreshAc(e.target.value, e.target.selectionStart);
            if (e.target.value && onTyping) {
              const now = Date.now();
              if (now - lastTypingSent.current > 2500) {
                lastTypingSent.current = now;
                onTyping();
              }
            }
          }}
          onBlur={() => setTimeout(() => setAc(null), 120)}
          onKeyDown={(e) => {
            // Autocomplete navigation takes priority while the popover is open.
            if (ac && acItems.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAcIndex((i) => (i + 1) % acItems.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                acceptAc(acItems[acIndex]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setAc(null);
                return;
              }
            }
            // Esc cancels an in-progress reply first.
            if (e.key === 'Escape' && replyingTo) {
              e.preventDefault();
              setReplyingTo(null);
              return;
            }
            // Empty composer + ArrowUp → edit your last message (Discord-style).
            if (e.key === 'ArrowUp' && text === '' && !editingId) {
              const lastOwn = [...messages].reverse().find((m) => m.author.id === meId);
              if (lastOwn) {
                e.preventDefault();
                setEditingId(lastOwn.id);
                setEditText(lastOwn.content);
              }
            }
          }}
          placeholder={replyingTo ? `Ответ ${nameOf(replyingTo.author.id, replyingTo.author.displayName)}…` : placeholder}
        />
        <button type="submit" className="send-btn" title="Отправить">
          <Icon name="send" size={18} />
        </button>
        {/* Телефон (#159): пока поле пустое, на месте «отправить» — микрофон. Плашка записи ложится
            ПОВЕРХ строки, а не вместо неё: спрятанное поле потеряло бы фокус, и клавиатура
            схлопнулась бы прямо под пальцем. На компьютере всё это скрыто — там своя полоса записи. */}
        {preview && (
          <div className="rec-inline">
            <button type="button" className="rec-trash" title="Выбросить запись" onClick={voice.discardPreview}>
              <Icon name="trash" size={19} />
            </button>
            <VoicePlayer url={preview.url} waveform={preview.take.waveform} durationMs={preview.take.durationMs} />
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
                  transform: `translateX(${Math.max(-VOICE_HOLD.cancelDx, Math.min(0, holdUi.dx))}px)`,
                  opacity: 1 - voiceHoldProgress(holdUi.dx, holdUi.dy).cancel * 0.8,
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
        {/* Замок над кнопкой становится «стопом», как в Telegram: запись встаёт, её можно послушать. */}
        {recording && !holdUi && (
          <button type="button" className="rec-stop" title="Остановить и прослушать" onClick={() => void voice.stop()}>
            <Icon name="stop" size={18} />
          </button>
        )}
        {micAvailable && (
          <button
            type="button"
            className="mic-btn"
            title={(recording && !holdUi) || preview ? 'Отправить голосовое' : 'Держи, чтобы записать голосовое'}
            disabled={recBusy}
            onPointerDown={onMicDown}
            onPointerMove={onMicMove}
            onPointerUp={onMicUp}
            onPointerCancel={onMicAbort}
            onLostPointerCapture={onMicAbort}
            onContextMenu={(e) => e.preventDefault()}
            onClick={onMicClick}
          >
            <Icon name={(recording && !holdUi) || preview ? 'send' : 'mic'} size={20} />
          </button>
        )}
      </form>
      {picker &&
        (() => {
          // Вкладки — только в строке ввода и только если стикеры тут есть. Реакции остаются
          // эмодзи: стикер реакцией не бывает, а в ЛС наборов нет вовсе.
          const tabs =
            picker.kind === 'composer' && canSticker ? <ExprTabs tab={exprTab} onTab={setExprTabState} /> : undefined;
          return tabs && exprTab === 'stickers' ? (
            <StickerPicker
              anchor={picker.anchor}
              packs={stickerPacks ?? []}
              onPick={(st) => void sendSticker(st)}
              onClose={() => setPicker(null)}
              footer={tabs}
            />
          ) : (
            <EmojiPicker
              anchor={picker.anchor}
              onPick={onEmojiPick}
              onClose={() => setPicker(null)}
              custom={customEmojis}
              footer={tabs}
            />
          );
        })()}
      {plusAnchor && (
        <BottomSheet onClose={() => setPlusAnchor(null)}>
          {/* Выбор файла открываем прямо в этом нажатии, а не после закрытия шторки: без живого
              жеста пользователя браузер диалог выбора файла не покажет. */}
          <SheetRow
            icon="paperclip"
            label="Фото или файл"
            onClick={() => {
              fileRef.current?.click();
              setPlusAnchor(null);
            }}
          />
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
      {lightbox !== null && (
        <Lightbox images={allImages} index={lightbox} onClose={() => setLightbox(null)} onIndex={setLightbox} />
      )}
      {userMenu}
      {msgMenu &&
        (() => {
          const m = msgMenu.m;
          const mine = m.author.id === meId;
          return (
            <ContextMenu pos={msgMenu.pos} onClose={() => setMsgMenu(null)} width={232}>
              <MenuItem
                icon="reply"
                label="Ответить"
                shortcut="R"
                onClick={() => {
                  startReply(m);
                  setMsgMenu(null);
                }}
              />
              {onReact && (
                <MenuItem
                  icon="reaction"
                  label="Добавить реакцию"
                  onClick={() => {
                    setPicker({ kind: 'msg', messageId: m.id, anchor: new DOMRect(msgMenu.pos.x, msgMenu.pos.y, 0, 0) });
                    setMsgMenu(null);
                  }}
                />
              )}
              {(m.content || onCopyLink) && <MenuDivider />}
              {m.content && (
                <MenuItem
                  icon="copy"
                  label="Копировать текст"
                  onClick={() => {
                    copyMessageText(m.content);
                    setMsgMenu(null);
                  }}
                />
              )}
              {onCopyLink && (
                <MenuItem
                  icon="link"
                  label="Копировать ссылку"
                  onClick={() => {
                    onCopyLink(m);
                    setMsgMenu(null);
                  }}
                />
              )}
              {onPin && (
                <MenuItem
                  icon="pin"
                  label={m.pinnedAt ? 'Открепить' : 'Закрепить'}
                  onClick={() => {
                    onPin(m, !m.pinnedAt);
                    setMsgMenu(null);
                  }}
                />
              )}
              {/* 🔴 «Приложить к жалобе» — только у сообщений ГОСТЯ и только тому, кто вправе
                  банить. Жалоба уходит держателю ЧУЖОГО инстанса, и прикладывать к ней переписку
                  своих людей незачем и не за что. Сообщения выбираются руками по одному: сервер
                  сам чужому инстансу чат не отдаёт (§5.11). */}
              {canModerate && guestHomeOf(m.author.id) && m.content && (
                <MenuItem
                  icon="shield"
                  label="Приложить к жалобе"
                  onClick={() => {
                    const ok = addEvidence(m.author.id, {
                      messageId: m.id,
                      text: m.content,
                      at: new Date(m.createdAt).getTime(),
                      // Название канала — это `title` панели: у соседа наших каналов нет, и
                      // строка «#общий» — единственное, что ему о них скажет.
                      channel: typeof title === 'string' ? title : '',
                    });
                    toast(
                      ok ? 'info' : 'error',
                      ok ? 'Сообщение приложено к жалобе' : `Больше ${EVIDENCE_MAX} сообщений приложить нельзя`,
                      ok ? 'Отправится, когда вы забаните этого человека с галочкой «Пожаловаться».' : undefined,
                    );
                    setMsgMenu(null);
                  }}
                />
              )}
              {(mine || canModerate) && (
                <>
                  <MenuDivider />
                  {mine && (
                    <MenuItem
                      icon="edit"
                      label="Изменить"
                      shortcut="E"
                      onClick={() => {
                        setEditingId(m.id);
                        setEditText(m.content);
                        setMsgMenu(null);
                      }}
                    />
                  )}
                  <MenuItem
                    icon="trash"
                    label="Удалить"
                    danger
                    shortcut="Del"
                    onClick={() => {
                      setMsgMenu(null);
                      void del(m);
                    }}
                  />
                </>
              )}
            </ContextMenu>
          );
        })()}
      {sheetMsg &&
        (() => {
          const m = sheetMsg;
          const mine = m.author.id === meId;
          const close = () => setSheetMsg(null);
          return (
            <BottomSheet onClose={close}>
              {onReact && (
                <div className="sheet-reactions">
                  {QUICK_REACTIONS.map((emo) => (
                    <button
                      type="button"
                      key={emo}
                      className="sheet-react"
                      onClick={() => {
                        onReact(m.id, emo, 'add');
                        close();
                      }}
                    >
                      {emo}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="sheet-react more"
                    title="Ещё реакции"
                    onClick={() => {
                      setPicker({
                        kind: 'msg',
                        messageId: m.id,
                        anchor: new DOMRect(window.innerWidth / 2, window.innerHeight - 24, 0, 0),
                      });
                      close();
                    }}
                  >
                    <Icon name="reaction" size={20} />
                  </button>
                </div>
              )}
              <SheetRow
                icon="reply"
                label="Ответить"
                onClick={() => {
                  startReply(m);
                  close();
                }}
              />
              {m.content && (
                <SheetRow
                  icon="copy"
                  label="Копировать текст"
                  onClick={() => {
                    copyMessageText(m.content);
                    close();
                  }}
                />
              )}
              {onCopyLink && (
                <SheetRow
                  icon="link"
                  label="Копировать ссылку"
                  onClick={() => {
                    onCopyLink(m);
                    close();
                  }}
                />
              )}
              {onPin && (
                <SheetRow
                  icon="pin"
                  label={m.pinnedAt ? 'Открепить' : 'Закрепить'}
                  onClick={() => {
                    onPin(m, !m.pinnedAt);
                    close();
                  }}
                />
              )}
              {mine && (
                <SheetRow
                  icon="edit"
                  label="Изменить"
                  onClick={() => {
                    setEditingId(m.id);
                    setEditText(m.content);
                    close();
                  }}
                />
              )}
              {(mine || canModerate) && (
                <SheetRow
                  icon="trash"
                  label="Удалить"
                  danger
                  onClick={() => {
                    close();
                    void del(m);
                  }}
                />
              )}
            </BottomSheet>
          );
        })()}
    </div>
  );
}
