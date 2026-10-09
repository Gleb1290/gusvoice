import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { composerCounter, MESSAGE_TEXT_MAX, tooLongText } from '../longTextRules';
import { createPortal } from 'react-dom';
import type { Attachment } from '@gusvoice/shared';
import { api } from '../api';
import {
  GALLERY_PAGE,
  fileBadge,
  fileSizeText,
  formatDuration,
  megabytes,
  ATTACH_MAX_BYTES,
  overLimit,
  permNotice,
  recentFilesOf,
  selectedNumber,
  selectionTitle,
  skippedText,
  thumbPx,
  toggleSelected,
  type GalleryPerm,
  type RecentFile,
} from '../attachRules';
import { cameraAllowedQuietly, cameraCount, cameraSupported, openCamera, stopStream, type Facing } from '../cameraCapture';
import {
  cancelNativeFiles,
  galleryFiles,
  galleryPage,
  galleryPermission,
  galleryThumb,
  nativeMediaInfo,
  pickDocumentsNative,
  type GalleryItem,
} from '../nativeMedia';
import { useStore } from '../store';
import { toast } from '../toast';
import { BottomSheet } from './BottomSheet';
import { CameraCell, CameraScreen, type CameraShot } from './CameraScreen';
import { MenuItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import { SchedPick } from './SchedPick';

/** Как отправить выбранное: сразу, без звука, позже (время) или «когда будет в сети». */
export type MediaSendHow = 'now' | 'silent' | 'online' | { at: Date };

/** Пункты меню удержания кнопки отправки (как меню «Отправить» порции 8). */
export interface MediaSendMenu {
  silent: boolean;
  /** «Отправить позже» и «Когда будет в сети» есть (сервер умеет отложенные)… */
  later: boolean;
  /** «Когда будет в сети» — только у беседы с человеком, чьё время захода видно (не «Избранное», не группа); нет поля — как раньше, есть. */
  whenOnline?: boolean;
  /** …и принимает их с вложениями (`attachRules.serverScheduledAttachments`). Нет — пункты серые. */
  scheduleMedia: boolean;
}

/** Системный выбор файла (в том же нажатии, иначе браузер окно не покажет): фото сжатыми, оригиналами, любые файлы. */
export type SystemPickKind = 'photos' | 'originals' | 'files';

export interface MediaSheetProps {
  /** Своя галерея устройства (мост `GusVoiceMedia`); `false` — браузер телефона: камера и системный выбор. */
  native: boolean;
  /** Сколько вложений ещё влезает в сообщение. */
  room: number;
  /** Предел одного файла, байт (`bigfile1`: в ЛС больше 25 МБ — `attachRules.dmAttachMaxBytes`). Нет — 25 МБ. */
  maxBytes?: number;
  /** Начальная подпись — текст из поля ввода (как у Telegram: набранное становится подписью). */
  caption: string;
  sendMenu?: MediaSendMenu;
  /** Отправить сразу сообщением: вложения и подпись — тем же путём, что обычная отправка с вложениями. */
  onSend: (files: File[], caption: string, how: MediaSendHow) => void;
  /** Положить в поле вложений без отправки (документы, недавние файлы). */
  onAttach: (files: File[]) => void;
  onSystemPick: (kind: SystemPickKind) => void;
  /** Ещё вкладки-действия после «Галерея / Файл» (у Telegram там опрос, геопозиция…): нажатие зовёт `run`. */
  actions?: readonly { key: string; icon: IconName; label: string; run: () => void }[];
  onClose: () => void;
}

type SheetTab = 'gallery' | 'file';

/** Вкладки внизу листа. У Telegram их больше (кошелёк, геопозиция, статья) — новая вкладка = строка здесь и ветка в разметке. */
const TABS: readonly { key: SheetTab; icon: IconName; label: string }[] = [
  { key: 'gallery', icon: 'photo', label: 'Галерея' },
  { key: 'file', icon: 'file', label: 'Файл' },
];

/** Удержание кнопки отправки дольше этого, мс, — меню «позже / без звука / когда в сети» (как у Telegram). */
const HOLD_MENU_MS = 450;

/** Миниатюры по мосту — не больше стольких сразу: листание не должно забивать очередь натива. */
const THUMBS_AT_ONCE = 4;

/** Очередь миниатюр с кешем ссылок `blob:` на время жизни листа. */
class ThumbLoader {
  private urls = new Map<string, string>();
  private queue: { item: GalleryItem; px: number; done: (url: string | null) => void }[] = [];
  private busy = 0;
  private dead = false;

  get(id: string): string | undefined {
    return this.urls.get(id);
  }

  /** Попросить миниатюру; вернёт отмену (ячейка ушла из вида раньше, чем дошла очередь). */
  want(item: GalleryItem, px: number, done: (url: string | null) => void): () => void {
    const have = this.urls.get(item.id);
    if (have) {
      done(have);
      return () => undefined;
    }
    const job = { item, px, done };
    this.queue.push(job);
    this.pump();
    return () => {
      const i = this.queue.indexOf(job);
      if (i >= 0) this.queue.splice(i, 1);
    };
  }

  private pump(): void {
    while (!this.dead && this.busy < THUMBS_AT_ONCE && this.queue.length) {
      const job = this.queue.shift()!;
      this.busy++;
      void galleryThumb(job.item, job.px).then((url) => {
        this.busy--;
        if (this.dead) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) this.urls.set(job.item.id, url);
        job.done(url);
        this.pump();
      });
    }
  }

  dispose(): void {
    this.dead = true;
    this.queue = [];
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

function cameraErrorText(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Нет доступа к камере';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Камера занята другим приложением';
  return 'Не удалось включить камеру';
}

/** Вложение из ленты → `File`: закрытые файлы ЛС — по своей ссылке API, публичные — через скачивание API (у хранилища нет CORS). */
async function attachmentFile(a: Attachment): Promise<File> {
  const res = await fetch(a.id ? a.url : api.attachmentDownloadUrl(a), { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], a.name, { type: a.contentType || blob.type });
}

/**
 * Лист вложений «как в Telegram» (решение владельца 05.10, вид сверен со снимками Telegram Android):
 * сетка галереи в 3 колонки, первая ячейка — живая камера на две строки; внизу — плавающая панель вкладок «Галерея / Файл».
 * Выбрано хоть одно — панель сменяется полем «Добавить подпись…» и кнопкой отправки со счётчиком, заголовок — «Выбрана
 * N фотография». Удержание кнопки — выбранное крупно поверх размытого фона и меню «Отправить позже / без звука / когда
 * будет в сети». Вкладка «Файл» — «Внутреннее хранилище» (системные «Файлы»), «Галерея» без сжатия, «Недавние файлы» из бесед.
 *
 * В приложении Android сетка — своя галерея устройства (`nativeMedia.ts`), в браузере телефона — камера и системный
 * выбор. На ПК листа нет: там у скрепки маленькое меню (`MessagePane`).
 */
export function MediaSheet({
  native,
  room,
  maxBytes = ATTACH_MAX_BYTES,
  caption: initialCaption,
  sendMenu,
  onSend,
  onAttach,
  onSystemPick,
  actions,
  onClose,
}: MediaSheetProps) {
  const [tab, setTab] = useState<SheetTab>('gallery');
  /** «Файл → Галерея»: та же сетка, но без камеры и без сжатия. */
  const [originals, setOriginals] = useState(false);
  const [perm, setPerm] = useState<GalleryPerm | null>(native ? null : 'granted');
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [end, setEnd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [caption, setCaption] = useState(initialCaption);
  // Счётчик подписи (07.10): с остатка 100 до предела сообщения, сверх — «−N» (Telegram 10.3, 2.15).
  const capCounter = composerCounter(caption.trim().length, true);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [holdOpen, setHoldOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');

  const [camAllowed, setCamAllowed] = useState(false);
  const [camOpen, setCamOpen] = useState(false);
  const [facing, setFacing] = useState<Facing>('environment');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [canFlip, setCanFlip] = useState(false);
  const [shot, setShot] = useState<CameraShot | null>(null);
  /** Есть ли у приложения микрофон для звука видео (`nativeMediaInfo().mic`); в браузере — как всегда, спросит сам браузер. */
  const [micAllowed, setMicAllowed] = useState(true);

  const camSupported = useMemo(cameraSupported, []);
  const thumbs = useMemo(() => new ThumbLoader(), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<GalleryItem[]>([]);
  itemsRef.current = items;
  const loadingRef = useRef(false);
  const alive = useRef(true);
  const camOpenRef = useRef(camOpen);
  camOpenRef.current = camOpen;
  const noteTimer = useRef(0);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const chosen = useMemo(() => order.map((id) => byId.get(id)).filter((i): i is GalleryItem => !!i), [order, byId]);

  const showNote = useCallback((text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2600);
  }, []);

  useEffect(
    () => () => {
      alive.current = false;
      window.clearTimeout(noteTimer.current);
      thumbs.dispose();
      cancelNativeFiles();
    },
    [thumbs],
  );

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // Снимок в предпросмотре держит ссылку `blob:` — снимаем, когда он сменился или лист закрылся.
  useEffect(() => () => (shot ? URL.revokeObjectURL(shot.url) : undefined), [shot]);

  // ——— Доступ и первая порция ———————————————————————————————————————————————————————————————————————————————
  useEffect(() => {
    let on = true;
    if (!native) {
      void cameraAllowedQuietly().then((ok) => on && setCamAllowed(ok));
      return () => {
        on = false;
      };
    }
    void (async () => {
      try {
        const info = await nativeMediaInfo();
        if (!on) return;
        setCamAllowed(info.camera);
        setMicAllowed(info.mic);
        // Окно системы — само только при первом открытии галереи; дальше — плашка с кнопкой.
        const p = info.perm === 'ask' && !info.asked ? await galleryPermission('ask') : info.perm;
        if (on) setPerm(p);
      } catch {
        if (on) {
          setPerm('ask');
          setFailed(true);
        }
      }
    })();
    return () => {
      on = false;
    };
  }, [native]);

  // Свой экран камеры открыли — микрофон мог измениться с открытия листа (настройки приложения): спросим натив ещё раз.
  useEffect(() => {
    if (!native || !camOpen) return;
    let on = true;
    void nativeMediaInfo().then(
      (i) => on && setMicAllowed(i.mic),
      () => undefined,
    );
    return () => {
      on = false;
    };
  }, [native, camOpen]);

  // Вернулись в приложение (из настроек, из окна «выбрать ещё фото») — доступ мог измениться.
  useEffect(() => {
    if (!native || !visible || perm === null) return;
    let on = true;
    void galleryPermission('check')
      .then((p) => on && setPerm((prev) => (prev === p ? prev : p)))
      .catch(() => undefined);
    return () => {
      on = false;
    };
    // `perm` в зависимостях не нужен: проверяем на возврате, а не после каждой смены.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, visible]);

  const loadMore = useCallback(async (reset: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const list = itemsRef.current;
      const page = await galleryPage(reset ? null : (list[list.length - 1] ?? null), GALLERY_PAGE);
      if (!alive.current) return;
      setItems((prev) => {
        if (reset) return page.items;
        const have = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !have.has(i.id))];
      });
      setEnd(page.end);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      loadingRef.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  const permOk = perm === 'granted' || perm === 'partial';
  useEffect(() => {
    if (!native || !permOk) return;
    setEnd(false);
    void loadMore(true);
  }, [native, permOk, perm, loadMore]);

  // Подгрузка у низа сетки.
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!native || !permOk || end || !el || !root || tab !== 'gallery') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore(false);
      },
      { root, rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [native, permOk, end, tab, loadMore, items.length]);

  // ——— Камера: живая ячейка и свой экран ————————————————————————————————————————————————————————————————————————
  const camWanted = camSupported && visible && !originals && (camOpen || (camAllowed && tab === 'gallery'));
  /**
   * Последняя попытка включить камеру кончилась отказом — сама она не повторяется, только по нажатию на ячейку. 🔴 Окно
   * разрешения системы — отдельная активность поверх: страница становится «скрыта» (`visible` ложно, эффект снимается и его
   * `on` гаснет), а отказ приходит ещё до возврата — раньше его выбрасывали (`!on`), и на «видна» эффект просил камеру снова,
   * по кругу: при «больше не спрашивать» система отказывает мгновенно — 200 окон за минуту, лист висел на «Включаю
   * камеру…», по итогу приложение закрылось (стенд 06.10, Android 16).
   */
  const camDenied = useRef(false);
  useEffect(() => {
    if (!camWanted || camDenied.current) return;
    let on = true;
    let s: MediaStream | null = null;
    setCamError(null);
    openCamera(facing).then(
      (st) => {
        if (!on) {
          stopStream(st);
          return;
        }
        s = st;
        setStream(st);
        setCamAllowed(true);
        st.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (on) setStream(null);
        });
        void cameraCount().then((n) => on && setCanFlip(n > 1));
      },
      (e: unknown) => {
        // Отказ человека или системы запоминаем и при снятой подписке; прочие ошибки — только пока эффект жив.
        const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        if (denied) camDenied.current = true;
        if (!on && !denied) return;
        setCamError(cameraErrorText(e));
        if (!camOpenRef.current) setCamAllowed(false);
      },
    );
    // Лист закрыли, свернули приложение, ушли на «Файл» — трек останавливается, индикатор камеры гаснет.
    return () => {
      on = false;
      stopStream(s);
      setStream(null);
    };
  }, [camWanted, facing]);

  // ——— Выбор ———————————————————————————————————————————————————————————————————————————————————————————————————
  const toggle = (item: GalleryItem) => {
    if (busy) return;
    if (overLimit(item, !originals, maxBytes) && !order.includes(item.id)) {
      showNote(`Больше ${megabytes(maxBytes)} МБ — такое не отправить`);
      return;
    }
    const next = toggleSelected(order, item.id, room);
    if (next.full) {
      showNote(room > 0 ? `Не больше ${room} за раз` : 'В сообщении уже 10 вложений');
      return;
    }
    setOrder(next.order);
  };

  const photos = chosen.filter((i) => i.kind === 'image').length;
  const videos = chosen.length - photos;

  /**
   * Подпись длиннее предела сообщения не режется (07.10, как у Telegram: подпись — одно сообщение с файлами): отказ словами
   * в заметке листа, подпись остаётся. Раньше `maxLength` молча не давал печатать дальше.
   */
  function captionTooLong(): boolean {
    const over = caption.trim().length - MESSAGE_TEXT_MAX;
    if (over <= 0) return false;
    showNote(tooLongText(over, true));
    return true;
  }

  async function sendSelected(how: MediaSendHow) {
    if (!chosen.length || busy) return;
    if (captionTooLong()) return;
    setBusy({ done: 0, total: chosen.length });
    try {
      const res = await galleryFiles(chosen, {
        compress: !originals,
        maxBytes,
        onProgress: (done, total) => alive.current && setBusy({ done, total }),
      });
      if (!alive.current) return;
      const text = skippedText(res.skipped, maxBytes);
      if (!res.files.length) {
        showNote(text ?? 'Не удалось прочитать файлы');
        return;
      }
      if (text) toast('warn', text);
      onSend(res.files, caption.trim(), how);
      onClose();
    } catch {
      if (alive.current) showNote('Не удалось прочитать файлы');
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  // ——— Вкладка «Файл» ——————————————————————————————————————————————————————————————————————————————————————————
  async function pickDocuments() {
    if (!native) {
      onSystemPick('files');
      return;
    }
    if (busy) return;
    try {
      setBusy({ done: 0, total: 0 });
      const res = await pickDocumentsNative({ limit: Math.max(1, room), maxBytes, onProgress: (done, total) => alive.current && setBusy({ done, total }) });
      if (!alive.current) return;
      if (res.cancelled) return;
      const text = skippedText(res.skipped, maxBytes);
      if (!res.files.length) {
        showNote(text ?? 'Не удалось прочитать файлы');
        return;
      }
      if (text) toast('warn', text);
      if (res.dropped > 0) toast('warn', `Не больше ${room} вложений — лишние не добавлены`);
      onAttach(res.files);
      onClose();
    } catch {
      if (alive.current) showNote('Не удалось открыть «Файлы»');
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  function pickOriginals() {
    if (!native) {
      onSystemPick('originals');
      return;
    }
    setOrder([]);
    setOriginals(true);
    setTab('gallery');
  }

  const dmMessages = useStore((s) => s.dmMessages);
  const recent = useMemo(() => recentFilesOf<Attachment>(dmMessages, 20), [dmMessages]);
  const [recentBusy, setRecentBusy] = useState<string | null>(null);

  async function attachRecent(r: RecentFile<Attachment>) {
    if (recentBusy || room <= 0) {
      if (room <= 0) showNote('В сообщении уже 10 вложений');
      return;
    }
    const key = r.att.id || r.att.url;
    setRecentBusy(key);
    try {
      const file = await attachmentFile(r.att);
      if (!alive.current) return;
      onAttach([file]);
      onClose();
    } catch {
      if (alive.current) showNote('Не удалось скачать файл');
    } finally {
      if (alive.current) setRecentBusy(null);
    }
  }

  // ——— Закрытие: «назад», Esc, подложка — сперва верхний слой ————————————————————————————————————————————————————
  const closeTop = () => {
    if (schedOpen) return; // окно «позже» закрывается своим листом
    if (holdOpen) return setHoldOpen(false);
    if (shot) return setShot(null);
    if (camOpen) return setCamOpen(false);
    if (originals) {
      setOriginals(false);
      setOrder([]);
      return;
    }
    onClose();
  };

  // ——— Кнопка отправки: нажатие — отправить, удержание — меню ——————————————————————————————————————————————————————
  const holdTimer = useRef(0);
  const held = useRef(false);
  /**
   * Меню встаёт под пальцем, пока его держат: `click` того же касания придёт уже в меню и закрыл бы его (или нажал пункт
   * под пальцем). Глотаем клики, пока палец не отпущен и ещё 400 мс после — как у меню «Отправить» в поле.
   */
  const swallow = useRef(false);
  const menuItems = !!sendMenu && (sendMenu.silent || sendMenu.later);
  const openHold = () => {
    held.current = true;
    swallow.current = true;
    const up = () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.setTimeout(() => (swallow.current = false), 400);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    setHoldOpen(true);
  };
  const pressSend = () => {
    held.current = false;
    window.clearTimeout(holdTimer.current);
    if (!menuItems) return;
    holdTimer.current = window.setTimeout(openHold, HOLD_MENU_MS);
  };
  const releaseSend = () => window.clearTimeout(holdTimer.current);
  const clickSend = () => {
    if (held.current) {
      held.current = false;
      return;
    }
    void sendSelected('now');
  };

  const notice = native && perm ? permNotice(perm) : null;
  const title = order.length ? `${selectionTitle(photos, videos)}${originals ? ' · без сжатия' : ''}` : originals ? 'Галерея · без сжатия' : undefined;
  const tall = order.length > 0 || scrolled || originals || tab === 'file';

  const sendButton = (
    <button
      type="button"
      className="gal-send-btn"
      aria-label={`Отправить: ${order.length}`}
      onPointerDown={pressSend}
      onPointerUp={releaseSend}
      onPointerCancel={releaseSend}
      onPointerLeave={releaseSend}
      onContextMenu={(e) => {
        e.preventDefault();
        if (menuItems && !holdOpen) {
          window.clearTimeout(holdTimer.current);
          openHold();
        }
      }}
      onClick={clickSend}
      disabled={!!busy}
    >
      <Icon name="send" size={22} />
      <span className="gal-count">{order.length}</span>
    </button>
  );

  return (
    <BottomSheet title={title} onClose={closeTop}>
      <div className={`gal${tall ? ' tall' : ''}${native ? '' : ' sys'}`}>
        {tab === 'gallery' ? (
          <div
            className="gal-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              if (!scrolled && e.currentTarget.scrollTop > 24) setScrolled(true);
            }}
          >
            {notice && (
              <div className="gal-notice" role="status">
                <span>{notice.text}</span>
                <button
                  type="button"
                  onClick={() => {
                    const was = perm;
                    void galleryPermission(notice.action)
                      .then((p) => {
                        if (!alive.current) return;
                        setPerm(p);
                        // «Выбрать ещё» при частичном доступе: состояние то же («partial»), эффект загрузки не сработает, а
                        // в окне системы человек мог добавить фото — перечитываем сами (стенд 06.10: сетка не менялась до
                        // следующего открытия листа). Из «ask» в «partial»/«granted» загрузит сам эффект.
                        if (was === 'partial' && p === 'partial') {
                          setEnd(false);
                          void loadMore(true);
                        }
                      })
                      .catch(() => alive.current && showNote('Не удалось спросить доступ'));
                  }}
                >
                  {notice.button}
                </button>
                {perm !== 'partial' && (
                  <button type="button" className="link" onClick={() => onSystemPick(originals ? 'originals' : 'photos')}>
                    Выбрать через систему
                  </button>
                )}
              </div>
            )}
            <div className="gal-grid">
              {camSupported && !originals && (
                <CameraCell
                  stream={camOpen ? null : stream}
                  facing={facing}
                  onOpen={() => {
                    // Нажатие — новая попытка: прежний отказ (`camDenied`) её не держит.
                    camDenied.current = false;
                    setCamError(null);
                    setCamOpen(true);
                  }}
                />
              )}
              {native &&
                items.map((item) => (
                  <GalleryCell
                    key={item.id}
                    item={item}
                    n={selectedNumber(order, item.id)}
                    big={overLimit(item, !originals, maxBytes)}
                    thumbs={thumbs}
                    root={scrollRef}
                    onToggle={toggle}
                  />
                ))}
              {/* Своей галереи нет (браузер) или к ней нет доступа — рядом с камерой плитка системного выбора. */}
              {(!native || (perm !== null && !permOk) || (failed && items.length === 0)) && (
                <button type="button" className="gal-system" onClick={() => onSystemPick(originals ? 'originals' : 'photos')}>
                  <Icon name="photo" size={30} />
                  <span>Выбрать фото или видео</span>
                </button>
              )}
              {native && permOk && loading && items.length === 0 && Array.from({ length: 8 }, (_, i) => <span key={i} className="gal-cell sk" />)}
            </div>
            {native && permOk && !loading && items.length === 0 && !failed && <div className="gal-empty">Здесь пока нет фото и видео</div>}
            {native && failed && (
              <div className="gal-empty">
                Галерею прочитать не удалось.{' '}
                <button type="button" className="link" onClick={() => onSystemPick(originals ? 'originals' : 'photos')}>
                  Выбрать через систему
                </button>
              </div>
            )}
            <div ref={sentinelRef} className="gal-sentinel" />
          </div>
        ) : (
          <div className="gal-scroll gal-files">
            <div className="gal-card">
              <button type="button" className="gal-row" onClick={() => void pickDocuments()}>
                <span className="gal-row-ico green">
                  <Icon name="file" size={22} />
                </span>
                <span className="gal-row-text">
                  <span className="gal-row-title">Внутреннее хранилище</span>
                  <span className="gal-row-sub">Поиск в файловой системе</span>
                </span>
              </button>
              <button type="button" className="gal-row" onClick={pickOriginals}>
                <span className="gal-row-ico honey">
                  <Icon name="photo" size={22} />
                </span>
                <span className="gal-row-text">
                  <span className="gal-row-title">Галерея</span>
                  <span className="gal-row-sub">Для отправки изображений без сжатия</span>
                </span>
              </button>
            </div>
            {recent.length > 0 && (
              <div className="gal-card">
                <div className="gal-card-head">Недавние файлы</div>
                {recent.map((r) => {
                  const key = r.att.id || r.att.url;
                  const badge = fileBadge(r.att.name);
                  return (
                    <button
                      type="button"
                      className={`gal-row${recentBusy === key ? ' busy' : ''}`}
                      key={key}
                      onClick={() => void attachRecent(r)}
                    >
                      {r.att.contentType.startsWith('image/') ? (
                        <img className="gal-row-thumb" src={r.att.url} alt="" loading="lazy" />
                      ) : (
                        <span className={`gal-badge ${badge.tone}`}>{badge.ext}</span>
                      )}
                      <span className="gal-row-text">
                        <span className="gal-row-title">{r.att.name}</span>
                        <span className="gal-row-sub">{fileSizeText(r.att.size)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {note && (
          <div className="gal-note" role="status">
            {note}
          </div>
        )}

        <div className="gal-bar">
          {order.length > 0 ? (
            <div className="gal-compose">
              <label className="gal-caption">
                <textarea
                  rows={1}
                  value={caption}
                  placeholder="Добавить подпись…"
                  onChange={(e) => {
                    setCaption(e.target.value);
                    const t = e.currentTarget;
                    t.style.height = 'auto';
                    t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
                  }}
                />
                {capCounter && (
                  <span className={capCounter.over ? 'send-count gal over' : 'send-count gal'} aria-live="polite">
                    {capCounter.text}
                  </span>
                )}
              </label>
              {sendButton}
            </div>
          ) : (
            <nav className="gal-tabs" role="tablist" aria-label="Что прикрепить">
              {TABS.map((t) => {
                // «Галерея без сжатия» открыта из «Файла» — подсвечен «Файл», как у Telegram.
                const on = t.key === 'file' ? tab === 'file' || originals : tab === 'gallery' && !originals;
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    className={`gal-tab${on ? ' on' : ''}`}
                    key={t.key}
                    onClick={() => {
                      setOriginals(false);
                      setOrder([]);
                      setTab(t.key);
                    }}
                  >
                    <Icon name={t.icon} size={24} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
              {actions?.map((a) => (
                <button type="button" role="tab" aria-selected={false} className="gal-tab" key={a.key} onClick={a.run}>
                  <Icon name={a.icon} size={24} />
                  <span>{a.label}</span>
                </button>
              ))}
            </nav>
          )}
        </div>

        {busy && (
          <div className="gal-busy" role="status" aria-live="polite">
            <span className="confirm-spin" aria-hidden="true" />
            <span>{busy.total > 0 ? `Готовлю файлы… ${busy.done} из ${busy.total}` : 'Готовлю файлы…'}</span>
          </div>
        )}
      </div>

      {camOpen && (
        <CameraScreen
          stream={stream}
          error={camError}
          facing={facing}
          canFlip={canFlip}
          mic={micAllowed}
          shot={shot}
          onShot={(file) => setShot({ file, url: URL.createObjectURL(file), kind: file.type.startsWith('video/') ? 'video' : 'photo' })}
          onRetake={() => setShot(null)}
          onFlip={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
          onClose={() => {
            setShot(null);
            setCamOpen(false);
          }}
          onSend={(file) => {
            if (captionTooLong()) return;
            onSend([file], caption.trim(), 'now');
            onClose();
          }}
          onNote={showNote}
        />
      )}
      {camOpen && note && createPortal(<div className="gal-note cam-note" role="status">{note}</div>, document.body)}

      {holdOpen &&
        createPortal(
          <div
            className="gal-hold"
            onClickCapture={(e) => {
              if (!swallow.current) return;
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => setHoldOpen(false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="gal-hold-box" onClick={(e) => e.stopPropagation()}>
              <div className={`gal-hold-media n${Math.min(chosen.length, 4)}`}>
                {chosen.slice(0, 4).map((it) => (
                  <HoldThumb key={it.id} item={it} thumbs={thumbs} />
                ))}
                {chosen.length > 4 && <span className="gal-hold-more">+{chosen.length - 4}</span>}
              </div>
              <div className="gal-hold-row">
                <div className="gal-hold-menu" role="menu">
                  {sendMenu?.later && (
                    <MenuItem
                      icon="calendar-time"
                      label="Отправить позже"
                      disabled={!sendMenu.scheduleMedia}
                      sub={sendMenu.scheduleMedia ? undefined : 'Пока только текст, без вложений'}
                      onClick={() => {
                        setHoldOpen(false);
                        setSchedOpen(true);
                      }}
                    />
                  )}
                  {sendMenu?.silent && (
                    <MenuItem
                      icon="bell-off"
                      label="Отправить без звука"
                      onClick={() => {
                        setHoldOpen(false);
                        void sendSelected('silent');
                      }}
                    />
                  )}
                  {sendMenu?.later && sendMenu.whenOnline !== false && (
                    <MenuItem
                      icon="alarm"
                      label="Когда будет в сети"
                      disabled={!sendMenu.scheduleMedia}
                      sub={sendMenu.scheduleMedia ? undefined : 'Пока только текст, без вложений'}
                      onClick={() => {
                        setHoldOpen(false);
                        void sendSelected('online');
                      }}
                    />
                  )}
                </div>
                <button
                  type="button"
                  className="gal-send-btn"
                  aria-label={`Отправить: ${order.length}`}
                  onClick={() => {
                    setHoldOpen(false);
                    void sendSelected('now');
                  }}
                >
                  <Icon name="send" size={22} />
                  <span className="gal-count">{order.length}</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {schedOpen && (
        <SchedPick
          text={caption.trim()}
          onPick={(at) => void sendSelected({ at })}
          onClose={() => setSchedOpen(false)}
        />
      )}
    </BottomSheet>
  );
}

/** Ячейка галереи: миниатюра (по мосту, когда ячейка близко к виду), номер выбора в кружке, у видео — длительность. */
function GalleryCell({
  item,
  n,
  big,
  thumbs,
  root,
  onToggle,
}: {
  item: GalleryItem;
  n: number;
  big: boolean;
  thumbs: ThumbLoader;
  root: React.RefObject<HTMLDivElement>;
  onToggle: (item: GalleryItem) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | undefined>(() => thumbs.get(item.id));

  useEffect(() => {
    if (url) return;
    const el = ref.current;
    if (!el) return;
    let cancel: (() => void) | null = null;
    let on = true;
    const io = new IntersectionObserver(
      (entries) => {
        const near = entries.some((e) => e.isIntersecting);
        if (near && !cancel) {
          const px = thumbPx(el.clientWidth || 120, window.devicePixelRatio || 1);
          cancel = thumbs.want(item, px, (u) => on && u && setUrl(u));
        } else if (!near && cancel) {
          cancel();
          cancel = null;
        }
      },
      { root: root.current, rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => {
      on = false;
      io.disconnect();
      cancel?.();
    };
  }, [item, thumbs, root, url]);

  return (
    <button
      type="button"
      ref={ref}
      className={`gal-cell${n ? ' on' : ''}${big ? ' big' : ''}`}
      aria-pressed={n > 0}
      aria-label={`${item.kind === 'video' ? 'Видео' : 'Фото'}${item.kind === 'video' ? `, ${formatDuration(item.durationMs)}` : ''}${n ? `, выбрано ${n}` : ''}`}
      onClick={() => onToggle(item)}
    >
      {url ? <img src={url} alt="" draggable={false} /> : null}
      {item.kind === 'video' && (
        <span className="gal-dur">
          <Icon name="play" size={12} />
          {formatDuration(item.durationMs)}
        </span>
      )}
      <span className={`gal-check${n ? ' on' : ''}`} aria-hidden="true">
        {n || ''}
      </span>
    </button>
  );
}

/** Миниатюра выбранного в меню удержания — та же, что в сетке (из кеша листа). */
function HoldThumb({ item, thumbs }: { item: GalleryItem; thumbs: ThumbLoader }) {
  const url = thumbs.get(item.id);
  return (
    <span className="gal-hold-cell">
      {url ? <img src={url} alt="" /> : null}
      {item.kind === 'video' && <span className="gal-dur">{formatDuration(item.durationMs)}</span>}
    </span>
  );
}
