import {
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
import { acTokenAt, applyAc, emojiSubstitution, isFirstUnread, isGrouped, type AcToken } from '../messagePaneRules';
import { MessageLink } from '../linkGuard';
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
import { VoiceMessage } from './VoiceMessage';
import { startVoiceRecording, voiceRecordingSupported, type VoiceRecording, type VoiceTake } from '../voiceRecorder';
import { LinkPreviewCard, linkPreviewsEnabled, previewableLinks } from './LinkPreview';
import { PollCard } from './PollCard';
import { PollComposer } from './PollComposer';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { Lightbox } from './Lightbox';
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
  | { kind: 'channel'; id: string; insert: string; label: string }
  | { kind: 'emoji'; id: string; insert: string; label: string; emoji: string };

const isImage = (ct: string) => ct.startsWith('image/');
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
    return (
      <div className="att-img-wrap">
        <button type="button" className="att-img-link" title={a.name} onClick={() => onOpen?.(a)}>
          {/* data-ctxsave: это КОНТЕНТ — правый клик оставляет «Сохранить изображение» (#75). */}
          <img className="att-img" data-ctxsave src={a.url} alt={a.name} loading="lazy" />
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
  /** Индекс картинки, открытой на просмотр ДО отправки (null — просмотр закрыт). */
  const [pendingBox, setPendingBox] = useState<number | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  // Запись голосового (#20): сам объект записи + живые счётчик и уровень для полоски.
  const recRef = useRef<VoiceRecording | null>(null);
  const [recording, setRecording] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const [recLevel, setRecLevel] = useState(0);
  const [recBusy, setRecBusy] = useState(false);
  // Якорь пикера стикеров (#68). null = закрыт.
  const [stickerAnchor, setStickerAnchor] = useState<DOMRect | null>(null);
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
  const [sending, setSending] = useState(false);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [messages.length]);

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
      return [...users, ...roles].slice(0, 8);
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

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if ((!content && pending.length === 0) || sending) return;
    setSending(true);
    try {
      await onSend(content, pending, replyingTo?.id ?? null);
      setText('');
      setPending([]);
      setReplyingTo(null);
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
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
    if (!window.confirm('Удалить сообщение?')) return;
    try {
      await onDelete(m);
    } catch (err) {
      toastError(err);
    }
  }

  // Тикаем, пока идёт запись: и таймер, и уровень. 100 мс — глазу достаточно, процессору не жалко.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const r = recRef.current;
      if (!r) return;
      setRecMs(Date.now() - r.startedAt);
      setRecLevel(r.level());
    }, 100);
    return () => clearInterval(t);
  }, [recording]);

  // Уходим со страницы посреди записи — глушим микрофон. Иначе индикатор записи в браузере
  // остаётся гореть, а устройство — занятым.
  useEffect(
    () => () => {
      recRef.current?.cancel();
      recRef.current = null;
    },
    [],
  );

  async function startRec() {
    try {
      recRef.current = await startVoiceRecording();
      setRecMs(0);
      setRecLevel(0);
      setRecording(true);
    } catch {
      // Единственная реальная причина — отказ в доступе к микрофону; говорим прямо.
      toast('error', 'Нет доступа к микрофону');
    }
  }

  function cancelRec() {
    recRef.current?.cancel();
    recRef.current = null;
    setRecording(false);
  }

  async function finishRec() {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    setRecording(false);
    setRecBusy(true);
    try {
      const take = await r.stop();
      // Полсекунды — это промах по кнопке, а не сообщение. Молча выбрасываем.
      if (take.durationMs < 500) return;
      await onSendVoice?.(take);
    } catch (err) {
      toastError(err);
    } finally {
      setRecBusy(false);
    }
  }

  /** Отправить стикер. Открытый пикер закрываем СРАЗУ: ждать сети с раскрытой панелью — это залипание. */
  async function sendSticker(s: Sticker) {
    setStickerAnchor(null);
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
      className="chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="channel-topbar">
        {title}
        {headerActions ? <span className="topbar-actions">{headerActions}</span> : null}
      </div>
      <div className="messages">
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
          return (
            <Fragment key={m.id}>
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
                    </span>{' '}
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
        <div ref={bottomRef} />
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
      {recording && (
        <div className="voice-rec">
          <span className="voice-rec-dot" />
          <span className="voice-rec-time">{formatDuration(recMs)}</span>
          <div className="voice-rec-level" aria-hidden>
            {/* Полоска живого уровня: видно, что микрофон реально слышит, ещё до отправки. */}
            <span style={{ width: `${Math.round(Math.min(1, recLevel * 1.6) * 100)}%` }} />
          </div>
          <span className="voice-rec-limit muted">до {formatDuration(VOICE_MAX_MS)}</span>
          <button type="button" className="rs-close" title="Отменить запись" onClick={cancelRec}>
            <Icon name="trash" size={15} />
          </button>
          <button type="button" className="voice-rec-send" title="Отправить" onClick={() => void finishRec()}>
            <Icon name="send" size={15} />
          </button>
        </div>
      )}
      <form className={`composer${text.trim() || pending.length ? '' : ' empty'}`} onSubmit={send}>
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
                    <Icon name={it.kind === 'role' ? 'users' : 'hash'} size={15} />
                  </span>
                )}
                <span className="ac-name">{it.label}</span>
                {it.kind === 'user' ? (
                  <span className="ac-handle">{it.handle}</span>
                ) : it.kind === 'role' ? (
                  <span className="ac-handle">роль</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
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
          title="Эмодзи"
          onClick={(e) => setPicker({ kind: 'composer', anchor: e.currentTarget.getBoundingClientRect() })}
        >
          <Icon name="reaction" size={19} />
        </button>
        {onSendVoice && voiceRecordingSupported() && !recording && (
          <button
            type="button"
            className="att-btn voice"
            title="Записать голосовое"
            disabled={recBusy}
            onClick={() => void startRec()}
          >
            <Icon name="mic" size={19} />
          </button>
        )}
        {!!stickerPacks?.length && onSendSticker && (
          <button
            type="button"
            className="att-btn sticker"
            title="Стикеры"
            onClick={(e) => setStickerAnchor(e.currentTarget.getBoundingClientRect())}
          >
            <Icon name="sticker" size={19} />
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
        <button type="submit" className="send-btn" title="Отправить" disabled={sending}>
          {sending ? '…' : <Icon name="send" size={18} />}
        </button>
      </form>
      {picker && (
        <EmojiPicker anchor={picker.anchor} onPick={onEmojiPick} onClose={() => setPicker(null)} custom={customEmojis} />
      )}
      {stickerAnchor && !!stickerPacks?.length && (
        <StickerPicker
          anchor={stickerAnchor}
          packs={stickerPacks}
          onPick={(st) => void sendSticker(st)}
          onClose={() => setStickerAnchor(null)}
        />
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
