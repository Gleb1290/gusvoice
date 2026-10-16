import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment, ConvScheduled, MessageReplyPreview } from '@gusvoice/shared';
import { api } from '../api';
import { pushBackHandler, TOP_LAYERS } from '../androidBack';
import { albumClass, albumStyleOf, bubbleLook, bubblesAllLeft, replyQuoteLook } from '../bubbleRules';
import { confirmAction } from '../confirm';
import { plural } from '../dmRowRules';
import { isMobile } from '../hotkeys';
import { MessageLink } from '../linkGuard';
import { enterBreaksLine, enterSends, pressByTouch } from '../messagePaneRules';
import { getSendMode, insertLineBreak } from '../sendMode';
import { renderMessageText } from '../messageText';
import { usePhoneLayout } from '../phoneLayout';
import { schedBubbleTime, schedFootLabel, schedHeadSub, schedSection } from '../schedRules';
import { holdSchedView } from '../schedView';
import { toast, toastError } from '../toast';
import { toastCopied } from '../copyConfirm';
import { ATT_IMG_MAX_H, ATT_IMG_MAX_W, AttachmentView, isImage, isVideo } from './AttachmentView';
import { Avatar } from './Avatar';
import { ContextMenu, MenuItem, type MenuAlign, type MenuPos, type MenuSpotlight } from './ContextMenu';
import { EmojiPicker } from './EmojiPicker';
import { Icon } from './Icon';
import { Lightbox } from './Lightbox';
import { BubbleMeta, DayDivider, MessageBubble, ReplyQuote, SelectCheck } from './MessageBubble';
import { SchedPick } from './SchedPick';

/**
 * Вид «Отложенные» беседы ЛС (раунд 12, порция 8; `docs/design/design-step12/HANDOFF.md` §8.4, макеты `Phone`/`Desktop` с
 * `screen=sched`, часть `SchedFeed`, меню — `MsgMenu kind=sched`). Та же лента беседы: шапка «Отложенные» и «<имя> ·
 * 2 сообщения», «назад» — к беседе (ПК — кнопка в шапке, телефон — `.mobile-back` в `MainLayout` через `schedView.ts`); дни —
 * пилюлями `DayDivider` («Завтра, 5 октября»), «Когда <имя> будет в сети» — своей пилюлей; пузыри — свои, время в пузыре —
 * время отправки без отметки, у «когда в сети» — без времени. Поле — «Отложенное сообщение»: отправка из него открывает
 * «Отправить позже» (`SchedPick`). Меню отложенного (ПК — правый клик, телефон — тап у пузыря): Отправить сейчас · Изменить
 * время · Изменить · Скопировать текст · Удалить, без реакций, подвал «Будет отправлено завтра в 9:00».
 *
 * Ставится ПОВЕРХ ленты беседы (`.chat.sched-view` — `position: absolute` внутри `.chat` ленты, CSS «Раунд 12» §5): лента
 * под ним живёт дальше — прокрутка, черновик в поле, окно истории не пересоздаются. Её содержимое на это время `inert`
 * (Tab и читалка не уходят под вид). Всё сетевое — у зовущего (`DmChatView`): вид зовёт действия и показывает тост при
 * отказе. Только за переключателем пузырей и при признаке сервера `conv9` — решает зовущий.
 *
 * Отличия от макета: в поле ввода нет скрепки, «+» и микрофона — новое отложенное с файлами ставится из поля беседы (меню
 * «Отправить» и лист вложений), а в макете поле взято общее с беседы.
 *
 * Отложенные с вложениями (06.10, признак сервера `conv10`): файлы — в пузыре ровно как в ленте (`AttachmentView`, вид
 * пузыря — `bubbleLook`: фото во всю ширину, альбом сеткой, время поверх фото без подписи), фото и видео (06.10: кадр с ▶)
 * открываются просмотром (`Lightbox`). Ссылки на файлы — свои у автора, приходят с сервера в списке; сам список в кеш на диске не пишется. «Изменить»
 * у такого правит подпись (пустая — «убрать подпись»), файлы не трогает.
 */
export interface ScheduledViewProps {
  /** Мои отложенные беседы, как отдаёт сервер (по времени, затем «когда в сети»). `null` — список ещё грузится. */
  items: readonly ConvScheduled[] | null;
  /** Имя собеседника — шапка и «Когда <имя> будет в сети». */
  peerName: string;
  /** Я — аватар у своих пузырей в широкой ленте ПК (как в ленте беседы). */
  me: { name: string; avatarUrl: string | null };
  /** К беседе. */
  onBack: () => void;
  /** Новое отложенное из поля вида: `at` — когда (выбрано в «Отправить позже»). */
  create: (content: string, at: Date, silent?: boolean) => Promise<void>;
  /** Колокольчик «без звука» в окне «Отправить позже» (G47, сервер с `conv8`). */
  silentToggle?: boolean;
  sendNow: (id: string) => Promise<void>;
  /** «Изменить время»: новое время. */
  reschedule: (id: string, at: Date) => Promise<void>;
  /** «Изменить»: новый текст. */
  edit: (id: string, content: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Меню у пузыря (телефон и узкое окно): прямоугольник пузыря, полоса строки под подложкой и край. */
type Spot = { anchor: DOMRect; spotlight: MenuSpotlight; align: MenuAlign };

/**
 * Цитата отложенного — тем же правилом, что в ленте (`bubbleRules.replyQuoteLook`): цитируемого здесь под рукой нет,
 * вид вложения — из полей сервера в самой цитате (05.10: «Фото» с миниатюрой, «Видео», «Голосовое сообщение · 0:42»,
 * «Файл: имя»). Раньше всё без текста было «Вложение».
 */
function ScheduledQuote({ reply }: { reply: MessageReplyPreview }) {
  const look = replyQuoteLook(reply, undefined);
  return <ReplyQuote author={reply.authorName} text={look.text} kind={look.kind} thumb={look.thumb} spoiler={look.spoiler === true} />;
}

type MenuState = { id: string; pos?: MenuPos; spot?: Spot };

/** Потолок высоты поля, px — как у поля беседы (`composerSizeRules.COMPOSER_MAX_PX`). */
const FIELD_MAX_PX = 160;

/**
 * Телефон: палец и раскладка телефона (то же правило, что тап-меню ленты, `MessagePane.phoneTaps`). Палец ли — по самому
 * нажатию (`touch`, `pressByTouch`, 05.10); не сказано (`null`) — по основному указателю.
 */
function phoneTaps(touch: boolean | null = null): boolean {
  return (touch ?? window.matchMedia('(pointer: coarse)').matches) && window.matchMedia('(max-width: 760px)').matches;
}

/** Окно уже ширины, с которой меню по точке становится листом (`ContextMenu`, ≤ 620 px), — меню встаёт у пузыря. */
function narrowWindow(): boolean {
  return window.matchMedia('(max-width: 620px)').matches;
}

/** Кнопки поля не забирают фокус (как у поля беседы): клавиатура телефона не прячется после нажатия. */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

export function ScheduledView({ items, peerName, me, onBack, create, silentToggle, sendNow, reschedule, edit, remove }: ScheduledViewProps) {
  const phone = usePhoneLayout();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  /** Правка текста отложенного (`Изменить`): его id и то, что было в поле до правки (вернётся после). */
  const [editing, setEditing] = useState<{ id: string; before: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** «Отправить позже» открыто: из поля (новое) или «Изменить время» (`id`, `initial`). */
  const [pick, setPick] = useState<{ text: string; id?: string; ids?: string[]; initial?: Date } | null>(null);
  /**
   * Выбор нескольких (07.10, G46; Telegram Desktop `history_view_scheduled_section.cpp`: «Отправить выбранные сейчас» —
   * `lng_context_send_now_selected`, «Перенести выбранные» — `lng_context_reschedule_selected`, подтверждение
   * `lng_scheduled_send_now_many`): id выбранных. Пусто — обычный вид; вход — «Выбрать» в меню отложенного.
   */
  const [sel, setSel] = useState<string[]>([]);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [emoji, setEmoji] = useState<DOMRect | null>(null);
  const [multiline, setMultiline] = useState(false);
  const [left, setLeft] = useState(false);
  const onBackRef = useRef(onBack);
  // «Назад», Esc и стрелка шапки: сперва снимают выбор, и лишь потом уводят к беседе.
  onBackRef.current = () => (selRef.current.length > 0 ? setSel([]) : onBack());
  /** «Назад» Android в правке текста сперва отменяет правку (как в поле беседы), а не уводит к беседе. */
  const cancelEditRef = useRef<(() => void) | null>(null);

  const list = items ?? [];
  const now = new Date();
  const editItem = editing ? list.find((x) => x.id === editing.id) : undefined;
  /** Фото и видео (06.10) всех отложенных (`conv10`) — просмотр листает их по порядку, как в ленте. */
  const images = useMemo(
    () =>
      (items ?? []).flatMap((it) =>
        (it.attachments ?? [])
          .filter((a) => (isImage(a.contentType) || isVideo(a.contentType)) && !!a.url)
          .map((a) => ({
            url: a.url,
            name: a.name,
            size: a.size,
            downloadUrl: api.attachmentDownloadUrl(a),
            type: a.contentType,
            video: isVideo(a.contentType),
            att: a,
          })),
      ),
    [items],
  );
  const [shown, setShown] = useState<number | null>(null);
  const openImage = (a: Attachment) => {
    const i = images.findIndex((x) => x.att === a);
    if (i >= 0) setShown(i);
  };

  /* Лента под видом — `inert` (Tab, мышь и читалка не уходят под него); вид — «назад» телефона и Android, Esc на ПК. При
     закрытии — всё обратно и фокус туда, откуда открыли (кнопка входа в поле беседы). */
  useEffect(() => {
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!root || !host) return;
    const opener = document.activeElement as HTMLElement | null;
    const made = new Set<HTMLElement>();
    const mute = () => {
      for (const el of Array.from(host.children)) {
        if (el === root || !(el instanceof HTMLElement) || el.inert) continue;
        el.inert = true;
        made.add(el);
      }
    };
    mute();
    // Лента дорисовывает своё (кнопка «Вниз», плашки), пока вид открыт, — новое тоже под ним.
    const mo = new MutationObserver(mute);
    mo.observe(host, { childList: true });
    if (!isMobile() && !phoneTaps()) inputRef.current?.focus();
    const release = holdSchedView(() => onBackRef.current());
    const back = pushBackHandler(() => {
      if (cancelEditRef.current) cancelEditRef.current();
      else onBackRef.current();
      return true;
    });
    return () => {
      mo.disconnect();
      for (const el of made) el.inert = false;
      release();
      back();
      if (opener?.isConnected) opener.focus?.();
    };
  }, []);

  // Esc на ПК: сперва правка в поле (её гасит само поле), потом — к беседе; поверх открыто окно или слой — их Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector(`[aria-modal="true"], ${TOP_LAYERS}`)) return;
      e.preventDefault();
      onBackRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Широкая лента ПК — все пузыри слева с аватаром, как в ленте беседы (`bubblesAllLeft`).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || isMobile() || typeof ResizeObserver !== 'function') return;
    const check = () => setLeft(bubblesAllLeft(el.clientWidth, false));
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Поле растёт под текст до потолка, дальше прокручивается (как поле беседы).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || el.clientWidth < 40) return;
    el.style.height = 'auto';
    const full = el.scrollHeight;
    const h = Math.min(full, FIELD_MAX_PX);
    el.style.height = `${h}px`;
    el.style.overflowY = full > FIELD_MAX_PX ? 'auto' : 'hidden';
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    setMultiline(h > line * 1.5 + pad);
  }, [text]);

  // Правку (или меню) того, что ушло или удалено (событием, с другого устройства), — гасим.
  useEffect(() => {
    if (editing && items && !items.some((x) => x.id === editing.id)) {
      setText(editing.before);
      setEditing(null);
    }
    if (menu && items && !items.some((x) => x.id === menu.id)) setMenu(null);
    if (items && sel.some((id) => !items.some((x) => x.id === id))) setSel((cur) => cur.filter((id) => items.some((x) => x.id === id)));
  }, [items, editing, menu, sel]);

  const finishEdit = () => {
    setText(editing?.before ?? '');
    setEditing(null);
  };
  cancelEditRef.current = editing ? finishEdit : null;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const content = text.trim();
    if (editing) {
      const it = editItem;
      if (!it) return finishEdit();
      // Ничего не поменял — просто выходим.
      if (content === it.content.trim()) return finishEdit();
      // Пустая подпись — только у отложенного с файлами («убрать подпись», `conv10`); у текстового сервер ответит 400.
      if (!content && !it.attachments?.length) return;
      const id = it.id;
      edit(id, content).then(finishEdit, (err: unknown) => toastError(err, 'Не удалось изменить отложенное'));
      return;
    }
    if (!content) return;
    setPick({ text: content });
  };

  /** Время выбрано в «Отправить позже». Поле пустеет сразу; не вышло — текст возвращается в поле (если оно ещё пустое). */
  const picked = (at: Date, silent = false) => {
    const p = pick;
    if (!p) return;
    if (p.ids) {
      // «Перенести» выбранных — все на одно время; по порядку списка, с разницей в миллисекунду, чтобы порядок сохранился.
      const ids = p.ids;
      setSel([]);
      void (async () => {
        for (const [i, id] of ids.entries()) {
          try {
            await reschedule(id, new Date(at.getTime() + i));
          } catch (err) {
            toastError(err, 'Не удалось перенести');
          }
        }
      })();
      return;
    }
    if (p.id) {
      reschedule(p.id, at).catch((err: unknown) => toastError(err, 'Не удалось перенести'));
      return;
    }
    const content = p.text;
    if (inputRef.current) inputRef.current.value = '';
    setText('');
    create(content, at, silent).catch((err: unknown) => {
      setText((cur) => (cur.trim() ? cur : content));
      toastError(err, 'Не удалось отложить сообщение');
    });
  };

  const openMenuAt = (it: ConvScheduled, row: HTMLElement) => {
    const anchor = (row.querySelector<HTMLElement>('.message-main') ?? row).getBoundingClientRect();
    const band = row.getBoundingClientRect();
    setMenu({ id: it.id, spot: { anchor, spotlight: { top: band.top, bottom: band.bottom }, align: left ? 'start' : 'end' } });
  };
  const onRowMenu = (e: MouseEvent<HTMLDivElement>, it: ConvScheduled) => {
    e.preventDefault();
    // Узкое окно — у пузыря, как на телефоне; с клавиатуры (Shift+F10, клавиша меню: точки нет) — тоже у пузыря.
    if (narrowWindow() || (e.clientX === 0 && e.clientY === 0)) openMenuAt(it, e.currentTarget);
    else setMenu({ id: it.id, pos: { x: e.clientX, y: e.clientY } });
  };
  /* Телефон: тап по пузырю — меню у пузыря (как у сообщений беседы); ссылка в тексте делает своё. Меню у якоря открываем
     по `click` (не по касанию): иначе `click` того же касания закрыл бы его как «мимо». */
  const onRowTap = (e: MouseEvent<HTMLDivElement>, it: ConvScheduled) => {
    if (sel.length > 0) return;
    if (!phoneTaps(pressByTouch(e.nativeEvent)) || e.defaultPrevented) return;
    if ((e.target as Element).closest('a, button')) return;
    openMenuAt(it, e.currentTarget);
  };

  const menuItem = menu ? list.find((x) => x.id === menu.id) : undefined;
  const closeMenu = () => setMenu(null);

  // Лента: пилюля над первым в разделе (день или «когда в сети»), соседи одного раздела — одной группой.
  const sections = list.map((it) => schedSection(it, peerName, now));
  const selSet = new Set(sel);
  const selecting = sel.length > 0;
  const toggleSel = (id: string) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const rows = list.map((it, i) => {
    const sec = sections[i];
    const first = i === 0 || sections[i - 1].key !== sec.key;
    const last = i === list.length - 1 || sections[i + 1].key !== sec.key;
    const time = schedBubbleTime(it);
    /* Вложения (`conv10`) — как в ленте (`MessagePane`, пузыри): вид пузыря по `bubbleLook` (фото во всю ширину, альбом 2–4
       сеткой), фото — первым, подпись под ним; время — у фото без подписи поверх фото, у файлов — отдельной строкой. У
       текстового отложенного вид прежний (обычный пузырь). */
    const files = it.attachments ?? [];
    const look = files.length > 0 ? bubbleLook({ content: it.content, attachments: files, replyTo: it.replyTo }, ATT_IMG_MAX_W, ATT_IMG_MAX_H) : null;
    const media = look?.kind === 'media';
    const metaAt: 'body' | 'over' | 'row' = media ? (it.content ? 'body' : 'over') : files.length > 0 || !it.content ? 'row' : 'body';
    const meta = time || it.failed ? <BubbleMeta time={time} over={metaAt === 'over'} status={it.failed ? 'failed' : undefined} /> : null;
    const active = menu?.id === it.id || editing?.id === it.id;
    const isPicked = selSet.has(it.id);
    const body = it.content ? (
      <div className="message-body">
        {renderMessageText(
          it.content,
          (url, key) => <MessageLink key={key} url={url} />,
        )}
        {metaAt === 'body' ? meta : null}
      </div>
    ) : null;
    const attachments =
      files.length > 0 ? (
        <div
          className={look?.album ? albumClass(look.album) : 'attachments'}
          style={look?.album ? (albumStyleOf(files, ATT_IMG_MAX_W, ATT_IMG_MAX_H) as CSSProperties | undefined) : undefined}
        >
          {files.map((a, j) => (
            <AttachmentView key={a.id ?? j} a={a} onOpen={openImage} fill={!!look?.album} />
          ))}
          {metaAt === 'over' ? meta : null}
        </div>
      ) : null;
    return (
      <Fragment key={it.id}>
        {first && sec.label && <DayDivider label={sec.label} pill />}
        <MessageBubble
          side="out"
          grouped={!first}
          tail={last}
          active={active}
          {...(look ? { kind: look.kind, mediaWidth: look.mediaWidth, mediaEnd: metaAt === 'over' } : {})}
          avatar={left ? last ? <Avatar url={me.avatarUrl} name={me.name} size={34} /> : null : undefined}
          onContextMenu={(e) => (selecting ? e.preventDefault() : onRowMenu(e, it))}
          onClick={(e) => onRowTap(e, it)}
          // Выбор нескольких: строка — флажок целиком (нажатие ловим на подходе, чтобы фото и ссылка внутри не делали своего).
          {...(selecting
            ? {
                role: 'checkbox',
                'aria-checked': isPicked,
                className: isPicked ? 'picked' : undefined,
                onClickCapture: (e: MouseEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleSel(it.id);
                },
              }
            : {})}
          actions={selecting ? <SelectCheck checked={isPicked} /> : undefined}
          // С клавиатуры: строка — в порядке Tab, Enter и пробел открывают её меню у пузыря (в выборе — переключают строку).
          tabIndex={0}
          aria-haspopup={selecting ? undefined : 'menu'}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            if (selecting) toggleSel(it.id);
            else openMenuAt(it, e.currentTarget);
          }}
        >
          {it.replyTo && <ScheduledQuote reply={it.replyTo} />}
          {media ? (
            <>
              {attachments}
              {body}
            </>
          ) : (
            <>
              {body}
              {attachments}
            </>
          )}
          {metaAt === 'row' && meta ? <div className="bub-meta-row">{meta}</div> : null}
        </MessageBubble>
      </Fragment>
    );
  });

  /** Выбранные — в порядке списка (по времени отправки). */
  const selected = () => list.filter((x) => selSet.has(x.id));
  /** «Отправить сейчас N» (G46): подтверждение, как `lng_scheduled_send_now_many`, затем по очереди — порядок сохраняется. */
  const sendSelected = () => {
    const ids = selected().map((x) => x.id);
    if (ids.length === 0) return;
    void confirmAction({
      title: ids.length === 1 ? 'Отправить сообщение сейчас?' : `Отправить ${ids.length} ${plural(ids.length, 'сообщение', 'сообщения', 'сообщений')} сейчас?`,
      confirmLabel: 'Отправить',
    }).then(async (ok) => {
      if (!ok) return;
      setSel([]);
      for (const id of ids) {
        try {
          await sendNow(id);
        } catch (err) {
          toastError(err, 'Не удалось отправить');
        }
      }
    });
  };
  /** «Перенести» (G46): окно времени одно на всех выбранных; начало — время первого из них. */
  const rescheduleSelected = () => {
    const picked = selected();
    if (picked.length === 0) return;
    const at = picked[0].sendAt ? new Date(picked[0].sendAt) : undefined;
    setPick({ text: `${picked.length} ${plural(picked.length, 'сообщение', 'сообщения', 'сообщений')}`, ids: picked.map((x) => x.id), initial: at });
  };
  const deleteSelected = () => {
    const ids = selected().map((x) => x.id);
    if (ids.length === 0) return;
    void confirmAction({
      title: ids.length === 1 ? 'Удалить отложенное сообщение?' : `Удалить ${ids.length} ${plural(ids.length, 'отложенное', 'отложенных', 'отложенных')}?`,
      body: 'Они не будут отправлены.',
      tone: 'danger',
      confirmLabel: 'Удалить',
    }).then(async (ok) => {
      if (!ok) return;
      setSel([]);
      for (const id of ids) {
        try {
          await remove(id);
        } catch (err) {
          toastError(err, 'Не удалось удалить');
        }
      }
    });
  };

  const head = (
    <div className="topbar-title">
      <span className="dm-who">
        <strong>Отложенные</strong>
        <span className="topbar-topic dm-who-sub">
          <span className="dm-who-status">{schedHeadSub(peerName, list.length)}</span>
        </span>
      </span>
    </div>
  );

  const stopDrag = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    // Файлы сюда не бросают (у поля этого вида вложений нет — с файлами откладывают из поля беседы): перетаскивание не
    // доходит до ленты под видом.
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className="chat sched-view"
      ref={rootRef}
      role="region"
      aria-label="Отложенные сообщения"
      onDragEnter={stopDrag}
      onDragOver={stopDrag}
      onDragLeave={stopDrag}
      onDrop={stopDrag}
    >
      {selecting ? (
        /* Выбрано N (G46): ПК — крестик первой кнопкой шапки (и Esc), телефон — крестик вместо «назад» в `MainLayout`. */
        <div className="channel-topbar sel-head">
          {!phone && (
            <button type="button" className="topbar-btn" aria-label="Выйти из выделения" title="Выйти из выделения · Esc" onClick={() => setSel([])}>
              <Icon name="close" size={18} />
            </button>
          )}
          <div className="topbar-title">
            <strong>Выбрано {sel.length}</strong>
          </div>
        </div>
      ) : (
        <div className="channel-topbar">
          {!phone && (
            <button type="button" className="topbar-btn" aria-label="К беседе" title="К беседе" onClick={onBack}>
              <Icon name="chevron-left" size={18} />
            </button>
          )}
          {head}
        </div>
      )}
      <div className="feed-frame bub-feed">
        <div className={left ? 'messages bubbles bub-left' : 'messages bubbles'} ref={listRef}>
          {items === null ? <div className="older-hint">Загружаем отложенные…</div> : rows}
        </div>
      </div>
      {editing && (
        <div className="reply-strip edit-strip">
          <Icon name="edit" size={14} />
          <span className="rs-label">
            <b>Редактирование</b>
          </span>
          <span className="rs-text">{editItem ? editItem.content || schedFilesLabel(editItem) : ''}</span>
          <button
            type="button"
            className="rs-close"
            title="Отменить правку"
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={finishEdit}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {selecting ? (
        <div className="composer sel-bar">
          <button type="button" className="sel-bar-btn sel-main" onClick={sendSelected}>
            <Icon name="send" size={phone ? 20 : 18} />
            {`Отправить сейчас ${sel.length}`}
          </button>
          {/* Телефон: «Перенести» и «Удалить» — значками (в 412 px три подписи не помещаются); подпись — в aria-label. */}
          <button type="button" className="sel-bar-btn" aria-label="Перенести" title="Перенести" onClick={rescheduleSelected}>
            <Icon name="calendar-time" size={phone ? 22 : 18} />
            {!phone && 'Перенести'}
          </button>
          <button type="button" className="sel-bar-btn" aria-label="Удалить" title="Удалить" onClick={deleteSelected}>
            <Icon name="trash" size={phone ? 22 : 18} />
            {!phone && 'Удалить'}
          </button>
        </div>
      ) : (
      <form
        className={`composer${text.trim() || editing ? '' : ' empty'}${multiline ? ' multiline' : ''}${editing ? ' editing' : ''}`}
        onSubmit={submit}
      >
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={editing ? 'Текст сообщения' : 'Отложенное сообщение'}
          aria-label={editing ? 'Текст отложенного сообщения' : 'Отложенное сообщение'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && editing) {
              e.preventDefault();
              finishEdit();
              return;
            }
            if (
              e.key === 'Enter' &&
              enterSends({
                shift: e.shiftKey,
                composing: e.nativeEvent.isComposing,
                touchOnly: window.matchMedia('(pointer: coarse)').matches,
                // Режим «Отправка по Ctrl+Enter» (G36) — и здесь: то же поле ввода, та же клавиша.
                ctrl: e.ctrlKey || e.metaKey,
                mode: getSendMode(),
              })
            ) {
              e.preventDefault();
              submit();
            } else if (
              e.key === 'Enter' &&
              enterBreaksLine({ shift: e.shiftKey, composing: e.nativeEvent.isComposing, ctrl: e.ctrlKey || e.metaKey, mode: getSendMode() })
            ) {
              e.preventDefault();
              insertLineBreak(e.currentTarget);
            }
          }}
        />
        <button
          type="button"
          className="att-btn emoji"
          title="Эмодзи"
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={(e) => setEmoji(e.currentTarget.getBoundingClientRect())}
        >
          <Icon name="reaction" size={19} />
        </button>
        <button
          type="submit"
          className="send-btn"
          title={editing ? 'Сохранить' : 'Отправить позже'}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
        >
          <Icon name={editing ? 'check' : 'send'} size={18} />
        </button>
      </form>
      )}
      {emoji && (
        <EmojiPicker
          anchor={emoji}
          onPick={(ch) => {
            setText((t) => t + ch);
            setEmoji(null);
          }}
          onClose={() => setEmoji(null)}
        />
      )}
      {menu && menuItem && (
        /* Меню отложенного (HANDOFF §3, «Отложенное»; макет `MsgMenu kind=sched`): без реакций, подвал — когда уйдёт. */
        <ContextMenu
          {...(menu.spot
            ? { anchor: menu.spot.anchor, spotlight: menu.spot.spotlight, align: menu.spot.align }
            : { pos: menu.pos ?? { x: 0, y: 0 } })}
          onClose={closeMenu}
          width={248}
        >
          <MenuItem
            icon="send"
            label="Отправить сейчас"
            onClick={() => {
              closeMenu();
              sendNow(menuItem.id).catch((err: unknown) => toastError(err, 'Не удалось отправить'));
            }}
          />
          <MenuItem
            icon="check"
            label="Выбрать"
            onClick={() => {
              closeMenu();
              setSel([menuItem.id]);
            }}
          />
          <MenuItem
            icon="calendar-time"
            label="Изменить время"
            onClick={() => {
              closeMenu();
              const at = menuItem.sendAt ? new Date(menuItem.sendAt) : undefined;
              setPick({ text: menuItem.content, id: menuItem.id, initial: at });
            }}
          />
          <MenuItem
            icon="edit"
            label="Изменить"
            onClick={() => {
              closeMenu();
              setEditing({ id: menuItem.id, before: editing ? editing.before : text });
              setText(menuItem.content);
              requestAnimationFrame(() => {
                const el = inputRef.current;
                if (!el) return;
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
              });
            }}
          />
          {/* Фото без подписи (`conv10`) — копировать нечего. */}
          {menuItem.content && (
            <MenuItem
              icon="copy"
              label="Скопировать текст"
              onClick={() => {
                closeMenu();
                navigator.clipboard
                  ?.writeText(menuItem.content)
                  .then(() => toastCopied('Текст скопирован'))
                  .catch(() => toast('error', 'Не удалось скопировать'));
              }}
            />
          )}
          <MenuItem
            icon="trash"
            label="Удалить"
            danger
            onClick={() => {
              closeMenu();
              const id = menuItem.id;
              void confirmAction({
                title: 'Удалить отложенное сообщение?',
                body: 'Оно не будет отправлено.',
                tone: 'danger',
                confirmLabel: 'Удалить',
              }).then((ok) => {
                if (ok) remove(id).catch((err: unknown) => toastError(err, 'Не удалось удалить'));
              });
            }}
          />
          <div className="ctx-foot" role="none">
            <span className="ctx-foot-ico" />
            <span>{schedFootLabel(menuItem, peerName, now)}</span>
          </div>
        </ContextMenu>
      )}
      {pick &&
        /* Окно — порталом в `body`: вид стоит своим слоем (`z-index`), и окно по центру внутри него не накрыло бы всё окно. */
        createPortal(
          <SchedPick
            text={pick.text}
            initial={pick.initial}
            silentToggle={!!silentToggle && !pick.id && !pick.ids}
            onPick={picked}
            onClose={() => setPick(null)}
          />,
          document.body,
        )}
      {/* Просмотр фото отложенного (`conv10`) — тот же, что в ленте; он порталом и в `TOP_LAYERS`: Esc и «назад» — сперва его. */}
      {shown !== null && images[shown] && (
        <Lightbox images={images} index={shown} onClose={() => setShown(null)} onIndex={setShown} />
      )}
    </div>
  );
}

/** Вложения отложенного словами — для плашки правки, когда подписи нет: «Фото», «Файл: имя», «Видео». */
function schedFilesLabel(it: ConvScheduled): string {
  const files = it.attachments ?? [];
  if (files.length === 0) return '';
  return replyQuoteLook({ content: '' }, { attachments: files }).text;
}
