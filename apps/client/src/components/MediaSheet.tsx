import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { composerCounter, MESSAGE_TEXT_MAX, tooLongText } from '../longTextRules';
import { createPortal } from 'react-dom';
import type { Attachment } from '@gusvoice/shared';
import { api } from '../api';
import {
  GALLERY_PAGE,
  fileBadge,
  fileSizeText,
  filterFilesByName,
  formatDuration,
  megabytes,
  ATTACH_MAX_BYTES,
  overLimit,
  permNotice,
  recentFilesOf,
  selectedNumber,
  selectionTitle,
  skippedText,
  SWEEP_HOLD_MS,
  SWEEP_SLOP_PX,
  sweepOrder,
  sweepScrollSpeed,
  thumbPx,
  toggleSelected,
  type GalleryPerm,
  type RecentFile,
} from '../attachRules';
import { cameraAllowedQuietly, cameraCount, cameraSupported, openCamera, stopStream, type Facing } from '../cameraCapture';
import {
  cancelNativeFiles,
  captureErrorCode,
  captureNative,
  cameraPermissionNative,
  galleryAlbums,
  galleryFiles,
  galleryPage,
  galleryPermission,
  galleryThumb,
  nativeMediaInfo,
  pickDocumentsNative,
  type GalleryAlbum,
  type GalleryItem,
} from '../nativeMedia';
import { useStore } from '../store';
import { toast } from '../toast';
import { confirmAction } from '../confirm';
import { BottomSheet } from './BottomSheet';
import { CameraCell, CameraScreen, type CameraShot } from './CameraScreen';
import { MenuItem } from './ContextMenu';
import { MediaPickViewer, type PickEntry } from './MediaPickViewer';
import { Icon, type IconName } from './Icon';
import { SchedPick } from './SchedPick';

/** Как отправить выбранное: сразу, без звука, позже (время) или «когда будет в сети». */
/** `{ once }` (#226): одноразовое фото/видео — 0 «просмотр один раз», иначе таймер, с; только один выбранный файл. */
export type MediaSendHow = 'now' | 'silent' | 'online' | { at: Date } | { once: number };

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
  /**
   * «Таймер самоуничтожения» в меню удержания «Отправить» (#226, `ttlmedia1`, личка 1:1): при одном выбранном фото/видео.
   * Пункты даёт зовущий (`OnceTimerItems`) — у листа закрытый перечень импортов. Нет — пункта нет.
   */
  onceItems?: (choose: (ttl: number | null) => void, back: () => void) => import('react').ReactNode;
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
  onceItems,
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
  // Меню удержания показывает пункты таймера самоуничтожения (#226) вместо своих.
  const [onceTimerOpen, setOnceTimerOpen] = useState(false);
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
  /**
   * Камера листа — системная (10.10, #218, решение владельца): сборка Android отвечает на `capture` (`NativeMediaInfo.capture`).
   * Тап по ячейке — фото, удержание — видео; готовый файл — в тот же предпросмотр «Переснять / Отправить», что у своей камеры.
   * Своя камера (`CameraScreen` на getUserMedia) остаётся браузеру телефона и старым сборкам.
   */
  const [sysCapture, setSysCapture] = useState(false);
  /** Системная камера открыта (ждём её ответа): поток ячейки отпущен, второй вызов не идёт. */
  const [sysCamBusy, setSysCamBusy] = useState(false);
  /** Просмотр выбора (тап по фото сетки — как Telegram `PhotoViewer.openPhotoForSelect`): с какого элемента открыт. */
  const [view, setView] = useState<number | null>(null);
  /** Снимок системной камеры — в том же просмотре с подписью (как Telegram), не в предпросмотре «Переснять / Отправить». */
  const [camShot, setCamShot] = useState<{ file: File; url: string; video: boolean } | null>(null);
  /**
   * Альбомы (как Telegram Android: выпадающий список в шапке, `ChatAttachAlertPhotoLayout.updateAlbumsDropDown`). `null` —
   * сборка их не отдаёт (или браузер): выбора нет. `album` `null` — вся галерея («Галерея» в шапке, камера в сетке).
   */
  const [albums, setAlbums] = useState<GalleryAlbum[] | null>(null);
  const [album, setAlbum] = useState<GalleryAlbum | null>(null);
  const [albumsOpen, setAlbumsOpen] = useState(false);
  const albumRef = useRef<GalleryAlbum | null>(null);
  albumRef.current = album;
  /** Все виденные элементы (любого альбома): выбор переживает смену альбома, как `selectedPhotos` Telegram. */
  const seen = useRef(new Map<string, GalleryItem>());
  /**
   * Фото, которые просмотр уже получил сжатыми (2560 px, JPEG 85 — ровно то, что уходит), по id: отправка берёт их, не сжимая
   * второй раз (#218 порция 4). Ещё не пришло — обычный путь через мост.
   */
  const ready = useRef(new Map<string, File>());
  /** Поколение порций: смена альбома или сброс — ответы прежних запросов выбрасываются. */
  const genRef = useRef(0);

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

  // Выбор — по всем виденным элементам, не только по альбому на экране.
  const chosen = useMemo(
    () => order.map((id) => seen.current.get(id)).filter((i): i is GalleryItem => !!i),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, items],
  );
  /** Что листает просмотр — один массив на набор элементов (раньше пересобирался на каждый символ подписи, и миниатюра тянулась заново). */
  const pickEntries = useMemo(
    (): PickEntry[] =>
      camShot
        ? [{ kind: 'file', file: camShot.file, url: camShot.url, video: camShot.video }]
        : items.map((item): PickEntry => ({ kind: 'gallery', item })),
    [camShot, items],
  );

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
  useEffect(() => () => (camShot ? URL.revokeObjectURL(camShot.url) : undefined), [camShot]);

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
        setSysCapture(info.capture);
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

  const loadMore = useCallback(async (reset: boolean) => {
    if (loadingRef.current && !reset) return;
    const gen = reset ? ++genRef.current : genRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const list = itemsRef.current;
      const page = await galleryPage(reset ? null : (list[list.length - 1] ?? null), GALLERY_PAGE, albumRef.current);
      if (!alive.current || gen !== genRef.current) return;
      for (const i of page.items) seen.current.set(i.id, i);
      setItems((prev) => {
        if (reset) return page.items;
        const have = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !have.has(i.id))];
      });
      setEnd(page.end);
      setFailed(false);
    } catch {
      if (alive.current && gen === genRef.current) setFailed(true);
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false;
        if (alive.current) setLoading(false);
      }
    }
  }, []);

  /** Выбрать альбом из списка шапки: сетка с начала, выбор остаётся (Telegram `onItemClick(id >= 10)`, строки 3414-3424). */
  const chooseAlbum = useCallback(
    (a: GalleryAlbum | null) => {
      setAlbumsOpen(false);
      const next = a && !a.id && !a.only ? null : a;
      if ((next?.id ?? '') === (albumRef.current?.id ?? '') && (next?.only ?? null) === (albumRef.current?.only ?? null)) return;
      albumRef.current = next;
      setAlbum(next);
      setItems([]);
      setEnd(false);
      scrollRef.current?.scrollTo({ top: 0 });
      void loadMore(true);
    },
    [loadMore],
  );

  // Вернулись в приложение (из настроек) — доступ мог измениться.
  const permRef = useRef(perm);
  permRef.current = perm;
  useEffect(() => {
    if (!native || !visible || permRef.current === null) return;
    let on = true;
    void galleryPermission('check')
      .then((p) => {
        if (!on) return;
        setPerm((prev) => (prev === p ? prev : p));
      })
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [native, visible]);

  // `partial` мост с 10.10 не шлёт (`nativeMedia.asPerm` читает его как `granted`); пришёл бы — это тоже «можно читать».
  const permOk = perm === 'granted' || perm === 'partial';
  useEffect(() => {
    if (!native || !permOk) return;
    setEnd(false);
    void loadMore(true);
  }, [native, permOk, perm, loadMore]);

  // Альбомы — как `loadGalleryPhotosAlbums` Telegram: при доступе и при возврате в приложение (галерея могла измениться).
  useEffect(() => {
    if (!native || !permOk || !visible) return;
    let on = true;
    // Через `then`: любой сбой списка альбомов (и синхронный) — просто «альбомов нет», лист не падает.
    void Promise.resolve()
      .then(galleryAlbums)
      .then(
        (list) => {
          if (on && alive.current) setAlbums(list && list.length > 1 ? list : null);
        },
        () => undefined,
      );
    return () => {
      on = false;
    };
  }, [native, permOk, perm, visible]);

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
  const camWanted =
    camSupported && visible && !originals && !sysCamBusy && ((camOpen && !sysCapture) || (camAllowed && tab === 'gallery'));
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

  /**
   * Системная камера (`sysCapture`): `video` — удержание ячейки. Поток ячейки отпускаем ДО запуска — камера устройства одна.
   * Снято — предпросмотр «Переснять / Отправить» (`CameraScreen` с `shot`); закрыли камеру без снимка — ничего.
   */
  async function systemCamera(video: boolean) {
    if (busy || sysCamBusy) return;
    stopStream(stream);
    setStream(null);
    setSysCamBusy(true);
    try {
      const res = await captureNative({ video, maxBytes });
      if (!alive.current) return;
      const file = res.files[0];
      if (!file) {
        const text = skippedText(res.skipped, maxBytes);
        if (text) showNote(text);
        return;
      }
      setCamShot({ file, url: URL.createObjectURL(file), video: video || file.type.startsWith('video/') });
    } catch (e) {
      if (!alive.current) return;
      const code = captureErrorCode(e);
      if (code === 'busy') return;
      if (code === 'camera-denied') void askSettings('camera');
      else showNote('Не удалось открыть камеру');
    } finally {
      if (alive.current) setSysCamBusy(false);
    }
  }

  // ——— Выбор ———————————————————————————————————————————————————————————————————————————————————————————————————
  /**
   * Отказ в доступе — окно Telegram (tg-src BasePermissionsActivity.java, строки 58-61 и 100-120: `PermissionStorageWithHint` /
   * `PermissionNoCameraWithHint`, кнопки `PermissionOpenSettings` и «Не сейчас»; русские тексты TG в исходниках нет — перевод наш).
   */
  /** Нажатие на ячейку камеры: системная камера (`sysCapture`) или своя на getUserMedia. */
  function openCamCell() {
    if (sysCapture) {
      void systemCamera(false);
      return;
    }
    // Нажатие — новая попытка: прежний отказ (`camDenied`) её не держит.
    camDenied.current = false;
    setCamError(null);
    setCamOpen(true);
  }

  /**
   * «Разрешить доступ к камере» (Telegram: `requestPermissions(CAMERA)`, строки 920-927): окно системы; дали — на месте строки
   * живая ячейка камеры; отказ — окно «Настройки / Не сейчас» (`askSettings`). Сборка без `camPerm` — открываем камеру, она
   * спросит разрешение сама.
   */
  async function askCamera() {
    let r: 'granted' | 'denied' | null;
    try {
      r = await cameraPermissionNative();
    } catch {
      r = null;
    }
    if (!alive.current) return;
    if (r === null) return openCamCell();
    if (r === 'granted') {
      camDenied.current = false;
      setCamAllowed(true);
      return;
    }
    void askSettings('camera');
  }

  async function askSettings(what: 'gallery' | 'camera') {
    const ok = await confirmAction({
      title: what === 'camera' ? 'Нет доступа к камере' : 'Нет доступа к фото и видео',
      body:
        what === 'camera'
          ? 'GusVoice нужен доступ к камере, чтобы вы могли снимать фото и видео. Откройте настройки → «Разрешения» и включите «Камера».'
          : 'GusVoice нужен доступ к фото и видео, чтобы вы могли их отправлять. Откройте настройки → «Разрешения» и включите «Фото и видео».',
      confirmLabel: 'Настройки',
      cancelLabel: 'Не сейчас',
      // Без значка окно рисует `signal` (по умолчанию) — к доступу он не относится.
      icon: what === 'camera' ? 'camera' : 'photo',
    });
    if (!ok || !alive.current) return;
    void galleryPermission('settings').catch(() => alive.current && showNote('Не удалось открыть настройки'));
  }

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

  // Выбор мазком (G50, как Telegram Android): держим палец на миниатюре и ведём по сетке — выбираются подряд, назад — снимаются.
  useGallerySweep({
    scroll: scrollRef,
    enabled: native && tab === 'gallery',
    ids: () => items.map((i) => i.id),
    order: () => order,
    room: () => room,
    blocked: (id) => {
      const it = items.find((x) => x.id === id);
      return !!it && overLimit(it, !originals, maxBytes);
    },
    locked: () => !!busy,
    setOrder,
    onFull: () => showNote(room > 0 ? `Не больше ${room} за раз` : 'В сообщении уже 10 вложений'),
  });

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

  async function sendSelected(how: MediaSendHow, list: GalleryItem[] = chosen) {
    if (!list.length || busy) return;
    if (captionTooLong()) return;
    setBusy({ done: 0, total: list.length });
    try {
      // Сжатое просмотром — как есть, остальное — мостом; порядок файлов — порядок выбора.
      const pre = originals ? [] : list.map((i) => ready.current.get(i.id) ?? null);
      const rest = list.filter((_, k) => !pre[k]);
      const got = rest.length
        ? await galleryFiles(rest, {
            compress: !originals,
            maxBytes,
            onProgress: (done, total) => alive.current && setBusy({ done: done + list.length - rest.length, total: list.length }),
          })
        : { files: [], skipped: [], cancelled: false, dropped: 0, indexes: [] };
      if (!alive.current) return;
      const byRest = new Map<number, File>();
      got.files.forEach((f, k) => byRest.set(got.indexes?.[k] ?? k, f));
      let r = 0;
      const files: File[] = [];
      list.forEach((_, k) => {
        const f = pre[k] ?? byRest.get(r++);
        if (f) files.push(f);
      });
      const res = { ...got, files };
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
  // Поиск во вкладке «Файл» (G50, `ChatAttachAlertDocumentLayout`): без запроса — 20 недавних, с запросом — по всем, что в памяти (до 200).
  const [fileQuery, setFileQuery] = useState('');
  const recentAll = useMemo(() => recentFilesOf<Attachment>(dmMessages, 200), [dmMessages]);
  const recent = useMemo(
    () => (fileQuery.trim() ? filterFilesByName(recentAll, fileQuery) : recentAll.slice(0, 20)),
    [recentAll, fileQuery],
  );
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
    if (albumsOpen) return setAlbumsOpen(false);
    if (camShot) return setCamShot(null);
    if (view !== null) return setView(null);
    if (shot) {
      setShot(null);
      // Предпросмотр системной камеры — без своего экрана под ним: закрылся снимок — закрылась и камера.
      if (sysCapture) setCamOpen(false);
      return;
    }
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
  // #226: одно фото/видео (не GIF) — в меню удержания ещё и «Таймер самоуничтожения».
  const onceOk = !!onceItems && chosen.length === 1 && chosen[0]!.mime !== 'image/gif';
  const menuItems = (!!sendMenu && (sendMenu.silent || sendMenu.later)) || onceOk;
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

  // `partial` — тот же «можно читать» (как `permOk`): своей плашки частичного доступа у листа нет (как TG Android, 10.10).
  const notice = native && perm && perm !== 'partial' ? permNotice(perm) : null;
  /** Своя галерея прочитана и пуста (не загрузка, не ошибка): подпись под сеткой. */
  const noneShown = native && permOk && !loading && items.length === 0 && !failed;
  /**
   * Камера — одна ячейка, пока сетка не набирает больше одного ряда: Telegram Android ставит ей вторую строку
   * (`hasCameraSpaceRow`) только при «камера + фото» больше колонок (`ChatAttachAlertPhotoLayout.java:4596-4598`). На две
   * строки при пустой сетке её чёрный прямоугольник со значком в углу владелец принял за видео с чёрной миниатюрой (#218 п.6).
   * Рядом плитка системного выбора (браузер, нет доступа, ошибка) или заглушки загрузки — остаётся на две, как было.
   */
  /**
   * Камера — две строки (ширина одной ячейки, высота `itemSize·2 + GAP`) с пустой ячейкой под ней, как Telegram Android
   * `hasCameraSpaceRow` (tg-src ChatAttachAlertPhotoLayout.java, строки 4580-4598; высота — `CameraViewItemDecoration`,
   * строки 4766-4769, и `finalHeight` 3124): камера есть (вся галерея, `selectedAlbumEntry == galleryAlbumEntry`), доступ к
   * камере дан (`!noCameraPermissions`) и «камера + элементы» длиннее ряда (`count > itemsPerRow`). Иначе — одна ячейка. У нас
   * это `grid-row: span 2` у `button.gal-cam` и `.short` — одна строка; рядом с плиткой системного выбора — две, как было.
   */
  const camShort =
    native && permOk && !failed && !(loading && items.length === 0) && items.length + 1 <= 3;
  const showCam = (camSupported || sysCapture) && !originals && !album;
  /**
   * Нет доступа к камере (приложение) — на её месте строка с кнопкой «Разрешить доступ к камере» во всю ширину, как Telegram
   * `VIEW_TYPE_CAMERA_PERMISSION_BUTTON` (tg-src ChatAttachAlertPhotoLayout.java, строки 4538-4551: строка 44+10+10−8 dp,
   * кнопка-пилюля 44 dp со значком камеры по центру, отступ снизу 12; во всю ширину — `getSpanSize`, строки 895-898).
   * Только у сборки с системной камерой (`sysCapture`, она же знает `camPerm`): у старой ячейка своей камеры остаётся — её
   * нажатие и есть запрос разрешения getUserMedia.
   */
  const camPermRow = showCam && native && sysCapture && permOk && !camAllowed;
  const galleryName = album ? albumLabel(album) : 'Галерея';
  /**
   * Шапка — название альбома со стрелкой (Telegram `dropDown`: «Галерея» для всей галереи, иначе имя папки, строки 755-769 и
   * 3414-3420); выбранное — подписью под ним. Без альбомов (браузер, сборка старше) — «N фото», как раньше.
   */
  const albumTitle = albums && tab === 'gallery' ? (
    <button
      type="button"
      className="gal-album-btn"
      aria-haspopup="menu"
      aria-expanded={albumsOpen}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => setAlbumsOpen((o) => !o)}
    >
      <span>{originals ? `${galleryName} · без сжатия` : galleryName}</span>
      <Icon name="chevron-down" size={18} />
    </button>
  ) : undefined;
  const picked = order.length ? `${selectionTitle(photos, videos)}${originals ? ' · без сжатия' : ''}` : undefined;
  // С альбомами выбор — строкой под ними: сменить альбом можно и с выбранным (выбор переживает смену, как у Telegram).
  const title = albumTitle ?? picked ?? (originals ? 'Галерея · без сжатия' : undefined);
  const subtitle = albumTitle ? picked : undefined;
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
    <BottomSheet title={title} subtitle={subtitle} onClose={closeTop}>
      <div className={`gal${tall ? ' tall' : ''}${native ? '' : ' sys'}`}>
        {albumsOpen && albums && (
          <>
            <div className="gal-albums-scrim" onClick={() => setAlbumsOpen(false)} />
            <div className="gal-albums" role="menu" aria-label="Альбомы">
              {albums.map((a) => (
                <AlbumRow
                  key={`${a.id}:${a.only ?? ''}`}
                  album={a}
                  label={albumLabel(a)}
                  active={album ? album.id === a.id && album.only === a.only : !a.id && !a.only}
                  thumbs={thumbs}
                  onPick={chooseAlbum}
                />
              ))}
            </div>
          </>
        )}
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
                    // Своей плашки частичного доступа больше нет (10.10, #218): как у Telegram Android, «Выбрать фото» в окне
                    // Android 14+ даёт временный доступ к выбранному — `granted`, сетка загрузится сама.
                    if (notice.action === 'settings') {
                      void askSettings('gallery');
                      return;
                    }
                    void galleryPermission('ask')
                      .then((p) => {
                        if (!alive.current) return;
                        setPerm(p);
                        // Отказ в окне системы — окно Telegram «Открыть настройки / Не сейчас» (после любого отказа, как у TG).
                        if (p !== 'granted') void askSettings('gallery');
                      })
                      .catch(() => alive.current && showNote('Не удалось спросить доступ'));
                  }}
                >
                  {notice.button}
                </button>
                <button type="button" className="link" onClick={() => onSystemPick(originals ? 'originals' : 'photos')}>
                  Выбрать через систему
                </button>
              </div>
            )}
            {camPermRow && (
              <div className="gal-cam-perm">
                <button type="button" onClick={() => void askCamera()}>
                  <Icon name="camera" size={20} />
                  Разрешить доступ к камере
                </button>
              </div>
            )}
            <div className="gal-grid">
              {showCam && !camPermRow && (
                <CameraCell
                  short={camShort}
                  stream={camOpen ? null : stream}
                  facing={facing}
                  onHold={sysCapture ? () => void systemCamera(true) : undefined}
                  onOpen={openCamCell}
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
                    onOpen={(it) => setView(Math.max(0, items.findIndex((x) => x.id === it.id)))}
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
            {noneShown && (
              <div className="gal-empty">Здесь пока нет фото и видео</div>
            )}
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
            {recentAll.length > 0 && (
              <input
                type="search"
                className="sheet-search gal-file-search"
                value={fileQuery}
                placeholder="Поиск файлов"
                aria-label="Поиск файлов по названию"
                enterKeyHint="search"
                autoComplete="off"
                onChange={(e) => setFileQuery(e.target.value)}
              />
            )}
            {!fileQuery.trim() && (
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
            )}
            {fileQuery.trim() && recent.length === 0 && <div className="gal-empty">Ничего не найдено</div>}
            {recent.length > 0 && (
              <div className="gal-card">
                <div className="gal-card-head">{fileQuery.trim() ? 'Найденные файлы' : 'Недавние файлы'}</div>
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

      {(view !== null || camShot) && (
        <MediaPickViewer
          entries={pickEntries}
          start={camShot ? 0 : (view ?? 0)}
          numberOf={(item) => selectedNumber(order, item.id)}
          caption={caption}
          counter={capCounter}
          busy={!!busy}
          onCaption={setCaption}
          onToggle={toggle}
          onSend={(entry) => {
            if (entry.kind === 'file') {
              if (captionTooLong()) return;
              onSend([entry.file], caption.trim(), 'now');
              onClose();
              return;
            }
            // Ничего не выбрано — уходит открытое (как «Отправить» в просмотре Telegram).
            void sendSelected('now', chosen.length ? chosen : [entry.item]);
          }}
          onClose={() => (camShot ? setCamShot(null) : setView(null))}
          maxBytes={maxBytes}
          onReady={(item, file) => {
            if (!originals) ready.current.set(item.id, file);
          }}
        />
      )}
      {camOpen && (
        <CameraScreen
          stream={stream}
          error={camError}
          facing={facing}
          canFlip={canFlip}
          mic={micAllowed}
          maxBytes={maxBytes}
          shot={shot}
          onShot={(file) => setShot({ file, url: URL.createObjectURL(file), kind: file.type.startsWith('video/') ? 'video' : 'photo' })}
          onRetake={() => {
            setShot(null);
            if (!sysCapture) return;
            // «Переснять» системной камерой — та же камера тем же жестом, что дал снимок.
            const video = shot?.kind === 'video';
            setCamOpen(false);
            void systemCamera(video);
          }}
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
                  {/* Таймер самоуничтожения (#226; Telegram Android — кнопка таймера в просмотре выбранного фото): один файл. */}
                  {onceOk &&
                    onceTimerOpen &&
                    onceItems!(
                      (ttl) => {
                        setOnceTimerOpen(false);
                        setHoldOpen(false);
                        if (ttl !== null) void sendSelected({ once: ttl });
                        else void sendSelected('now');
                      },
                      () => setOnceTimerOpen(false),
                    )}
                  {onceOk && !onceTimerOpen && (
                    <MenuItem icon="clock" label="Таймер самоуничтожения" submenu onClick={() => setOnceTimerOpen(true)} />
                  )}
                  {!onceTimerOpen && sendMenu?.later && (
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
                  {!onceTimerOpen && sendMenu?.silent && (
                    <MenuItem
                      icon="bell-off"
                      label="Отправить без звука"
                      onClick={() => {
                        setHoldOpen(false);
                        void sendSelected('silent');
                      }}
                    />
                  )}
                  {!onceTimerOpen && sendMenu?.later && sendMenu.whenOnline !== false && (
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
  onOpen,
}: {
  item: GalleryItem;
  n: number;
  big: boolean;
  thumbs: ThumbLoader;
  root: React.RefObject<HTMLDivElement>;
  onToggle: (item: GalleryItem) => void;
  /** Тап мимо кружка — просмотр (Telegram: ячейка открывает `PhotoViewer`, выбор — кружок в углу). Нет — тап выбирает, как раньше. */
  onOpen?: (item: GalleryItem) => void;
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
      data-gid={item.id}
      className={`gal-cell${n ? ' on' : ''}${big ? ' big' : ''}`}
      aria-pressed={n > 0}
      aria-label={`${item.kind === 'video' ? 'Видео' : 'Фото'}${item.kind === 'video' ? `, ${formatDuration(item.durationMs)}` : ''}${n ? `, выбрано ${n}` : ''}`}
      onClick={(e) => {
        if (onOpen && !(e.target as Element).closest?.('.gal-check')) onOpen(item);
        else onToggle(item);
      }}
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

/** Имя альбома в списке и в шапке: у «всей галереи» имени от натива нет (Telegram `AllMedia` / `AllVideos`). */
function albumLabel(a: GalleryAlbum): string {
  return a.id ? a.name || 'Без названия' : a.only ? 'Все видео' : 'Все медиа';
}

/**
 * Строка списка альбомов — как Telegram Android `AlbumButton` (tg-src Stories/recorder/AlbumButton.java, строки 40-140):
 * высота 48dp, поля 16, обложка 30×30 со скруглением 4, отступ 12, имя 16sp и следом число 13sp.
 */
function AlbumRow({
  album,
  label,
  active,
  thumbs,
  onPick,
}: {
  album: GalleryAlbum;
  label: string;
  active: boolean;
  thumbs: ThumbLoader;
  onPick: (a: GalleryAlbum) => void;
}) {
  const cover = album.cover;
  const [url, setUrl] = useState<string | null>(() => (cover ? (thumbs.get(cover.id) ?? null) : null));
  useEffect(() => {
    if (!cover || url) return;
    let on = true;
    const stop = thumbs.want(cover, 96, (u) => on && setUrl(u));
    return () => {
      on = false;
      stop();
    };
  }, [cover, url, thumbs]);
  return (
    <button type="button" role="menuitemradio" aria-checked={active} className={`gal-album${active ? ' on' : ''}`} onClick={() => onPick(album)}>
      <span className="gal-album-cover">{url ? <img src={url} alt="" draggable={false} /> : <Icon name="photo" size={18} />}</span>
      <span className="gal-album-name">{label}</span>
      <span className="gal-album-count">{album.count}</span>
    </button>
  );
}

/**
 * Выбор мазком по сетке галереи листа вложений (G50, 14.10). Правила — конец `attachRules.ts`; поведение — Telegram Android
 * (`ChatAttachAlertPhotoLayout` + `RecyclerViewItemRangeSelector`): держим палец на миниатюре — она выбирается (или
 * снимается, если была выбрана), ведём по соседним — выбираются подряд, ведём назад — возвращаются; у края список сам едет.
 * Ячейки узнаём по `data-gid` (id элемента галереи). Мышь не трогаем: на ПК выбор — кружок, как был.
 */
interface GallerySweepArgs {
  /** Прокручиваемый список; пока его нет в документе (другая вкладка) — жест не слушается. */
  scroll: React.RefObject<HTMLElement>;
  enabled: boolean;
  /** id ячеек сетки сверху вниз и текущий выбор — читаются в момент жеста, не при отрисовке. */
  ids: () => readonly string[];
  order: () => readonly string[];
  room: () => number;
  blocked: (id: string) => boolean;
  /** Идёт отправка и тому подобное — мазок не начинать. */
  locked: () => boolean;
  setOrder: (order: string[]) => void;
  onFull: () => void;
}

function useGallerySweep(args: GallerySweepArgs): void {
  const a = useRef(args);
  a.current = args;
  const { enabled } = args;

  useEffect(() => {
    const el = args.scroll.current;
    if (!enabled || !el) return;
    // Состояние жеста живёт в замыкании: оно одно на элемент и не нужно отрисовке.
    let pending: { pid: number; x: number; y: number; gid: string } | null = null;
    let timer = 0;
    let active: { pid: number; base: string[]; ids: string[]; anchor: number; cur: number; select: boolean; x: number; y: number; fullShown: boolean } | null = null;
    let raf = 0;
    let lastFrame = 0;
    let suppressUntil = 0;

    const cellAt = (x: number, y: number): string | null => {
      const hit = document.elementFromPoint(x, y)?.closest?.('[data-gid]');
      return hit && el.contains(hit) ? (hit as HTMLElement).dataset.gid || null : null;
    };

    const apply = (gid: string) => {
      const s = active;
      if (!s) return;
      const idx = s.ids.indexOf(gid);
      if (idx < 0 || idx === s.cur) return;
      s.cur = idx;
      const r = sweepOrder(s.base, s.ids, s.anchor, s.cur, s.select, a.current.room(), a.current.blocked);
      if (r.full && !s.fullShown) {
        s.fullShown = true;
        a.current.onFull();
      }
      a.current.setOrder(r.order);
    };

    const stopScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    // Автопрокрутка у верхнего и нижнего края; пока едет, ячейка под пальцем меняется — выбор идёт следом.
    const tick = (t: number) => {
      raf = 0;
      const s = active;
      if (!s) return;
      const rect = el.getBoundingClientRect();
      const v = sweepScrollSpeed(s.y - rect.top, rect.height);
      if (v !== 0) {
        const dt = lastFrame ? Math.min(48, t - lastFrame) : 16;
        el.scrollTop += v * dt;
        const gid = cellAt(s.x, s.y);
        if (gid) apply(gid);
        lastFrame = t;
        raf = requestAnimationFrame(tick);
      } else {
        lastFrame = 0;
      }
    };
    const kick = () => {
      if (!raf && active) raf = requestAnimationFrame(tick);
    };

    const start = () => {
      timer = 0;
      const p = pending;
      pending = null;
      if (!p || a.current.locked()) return;
      const ids = [...a.current.ids()];
      const anchor = ids.indexOf(p.gid);
      if (anchor < 0) return;
      const base = [...a.current.order()];
      const select = !base.includes(p.gid);
      // Нельзя выбрать (больше предела сервера) или мест нет — мазок не начинается, как `isIndexSelectable` у Telegram.
      if (select && (a.current.blocked(p.gid) || base.length >= a.current.room())) {
        if (base.length >= a.current.room()) a.current.onFull();
        return;
      }
      active = { pid: p.pid, base, ids, anchor, cur: -1, select, x: p.x, y: p.y, fullShown: false };
      navigator.vibrate?.(8);
      apply(p.gid);
      kick();
    };

    const finish = () => {
      window.clearTimeout(timer);
      timer = 0;
      pending = null;
      stopScroll();
      if (active) suppressUntil = Date.now() + 400; // отпускание после мазка не должно «открыть» ячейку
      active = null;
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !e.isPrimary || active) return;
      const gid = (e.target as Element | null)?.closest?.('[data-gid]')?.getAttribute('data-gid');
      if (!gid) return;
      window.clearTimeout(timer);
      pending = { pid: e.pointerId, x: e.clientX, y: e.clientY, gid };
      timer = window.setTimeout(start, SWEEP_HOLD_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (active && e.pointerId === active.pid) {
        active.x = e.clientX;
        active.y = e.clientY;
        const gid = cellAt(e.clientX, e.clientY);
        if (gid) apply(gid);
        kick();
        return;
      }
      if (pending && e.pointerId === pending.pid && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > SWEEP_SLOP_PX) {
        window.clearTimeout(timer);
        timer = 0;
        pending = null; // палец поехал раньше срока — это прокрутка
      }
    };
    const onEnd = (e: PointerEvent) => {
      if ((active && e.pointerId === active.pid) || (pending && e.pointerId === pending.pid)) finish();
    };
    // Пока идёт мазок, страница не должна ехать за пальцем: отменяем движение касания (слушатель не пассивный).
    const onTouchMove = (e: TouchEvent) => {
      if (active && e.cancelable) e.preventDefault();
    };
    const onClickCapture = (e: MouseEvent) => {
      if (Date.now() < suppressUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const onMenu = (e: Event) => {
      if (active || pending) e.preventDefault();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onEnd);
    el.addEventListener('pointercancel', onEnd);
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('click', onClickCapture, true);
    el.addEventListener('contextmenu', onMenu);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onEnd);
      el.removeEventListener('pointercancel', onEnd);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('click', onClickCapture, true);
      el.removeEventListener('contextmenu', onMenu);
      window.clearTimeout(timer);
      stopScroll();
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- всё остальное читается из `a.current` в момент жеста
}
