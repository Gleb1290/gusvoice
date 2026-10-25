import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogChrome } from '../dialogChrome';
import { kb } from './AttachmentView';
import { ContextMenu, MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { Lightbox } from './Lightbox';
import { PhotoEditor } from './PhotoEditor';
import { SpoilerParticles } from './SpoilerCover';
import {
  boxTitle,
  captionMoveVisible,
  hasAsFileOption,
  hasGroupOption,
  hdOptionVisible,
  moveFile,
  rememberVisible,
  sendKind,
  spoilerMenuVisible,
  type SendWay,
} from '../sendFilesRules';
import { photoEditable, renameTarget, replaceAt, type PhotoEdit } from '../photoEditRules';

/** Таймер самоуничтожения (#226) — только фото и видео кадром, не GIF (как `onceMediaRules.canSetOnce`; свой перечень импортов закрыт). */
function canSetOnce(file: { type: string }, asFile: boolean): boolean {
  if (asFile || file.type === 'image/gif') return false;
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/** Как уходит сообщение из окна: сразу, без звука или позже (выбор времени — у зовущего). */
export type SendBoxHow = 'now' | 'silent' | 'later';

export interface SendFilesResult {
  files: File[];
  caption: string;
  way: SendWay;
  /** «Запомнить выбор» отмечен — зовущий кладёт `way` в хранилище. */
  remember: boolean;
  how: SendBoxHow;
  /** Спойлер (G48, `media2`): индексы файлов `files`, скрытых под спойлером. Пусто без признака сервера. */
  spoilers: ReadonlySet<number>;
  /** «Подпись над медиа» (G48, `media2`). */
  captionAbove: boolean;
  /**
   * Одноразовые (#226, `ttlmedia1`): индекс файла `files` → таймер, с (0 — «Просмотр один раз»). Пусто без пункта меню.
   * Каждый такой файл зовущий шлёт отдельным сообщением.
   */
  once: ReadonlyMap<number, number>;
}

/**
 * Окно отправки файлов на ПК (07.10, #211, G48; Telegram Desktop `boxes/send_files_box.cpp`, Web A
 * `composer/AttachmentModal.tsx`): «Выбрано файлов: N» / «Отправить изображение», превью файлов с крестиком и перетаскиванием
 * для порядка, «Группировать» и «Отправить как файлы» (без сжатия), «Запомнить выбор» — когда выбор отличается от прежнего,
 * подпись, «Добавить», «Отмена», «Отправить» и «⋯» — «Отправить без звука» / «Отправить позже» (меню кнопки «Отправить» у
 * Telegram). Окно только собирает выбор: сжатие, разбивку по сообщениям и отправку делает зовущий (`MessagePane.sendFromBox`).
 * «Отмена» и Esc отдают подпись обратно (`onCancel`) — поле ввода получает её назад, как у Desktop при закрытии окна.
 *
 * С признаком сервера `media2` (08.10, G48): «Высокое качество» (фото до 2560 px, а не 1280; `hasSendLargePhotosOption`) среди
 * переключателей и запоминается вместе с ними; «Скрыть под спойлером» (`SpoilerOn` / `SpoilerOff`) — в «⋯» для всех и в
 * правом клике по плитке для одной (`toggleSpoilers`, меню плитки); «Подпись над медиа» (`CaptionUp` / `CaptionDown`) — в «⋯»,
 * поле подписи в окне переезжает над плитки.
 *
 * Правка до отправки (08.10, G49; `send_files_box.cpp` меню плитки, `editor/photo_editor*.cpp`): правый клик по плитке или
 * строке — «Изменить» (фото, не «как файл» — `PhotoEditor`), «Заменить файл» (выбор нового на то же место), «Переименовать»
 * (строки «как файл»: поле на месте имени, Enter — сохранить, Esc — отмена); нажатие по плитке — просмотр крупно (`Lightbox`).
 * Исходник отредактированного фото хранится (`origins`): повторная правка начинается с той же рамки, «Сбросить» — к исходнику.
 */
export function SendFilesBox({
  files,
  caption: initialCaption,
  way: initialWay,
  saved,
  menu,
  media2,
  onceItems,
  onFiles,
  onAdd,
  onCancel,
  onSend,
}: {
  files: File[];
  caption: string;
  way: SendWay;
  /** Запомненный выбор, с которого окно открылось: «Запомнить выбор» виден, когда текущий от него отличается. */
  saved: SendWay;
  /** Что умеет сервер: «без звука» (`conv8`) и «позже» с файлами (`conv9` + `conv10`). Нет ни того ни другого — «⋯» нет. */
  menu: { silent: boolean; later: boolean };
  /** Сервер с признаком `media2` (G48): «Высокое качество», спойлер и подпись над медиа. */
  media2: boolean;
  /**
   * «Таймер самоуничтожения» в меню фото/видео (#226, `ttlmedia1`, только личка 1:1 с человеком): пункты подменю даёт зовущий
   * (`OnceTimerItems`) — у окна закрытый перечень импортов. Нет — пункта нет.
   */
  onceItems?: (current: number | null, choose: (ttl: number | null) => void, back: () => void) => import('react').ReactNode;
  /** Состав или порядок файлов изменился (крестик, перетаскивание). */
  onFiles: (files: File[]) => void;
  /** «Добавить» — открыть выбор файлов (результат вернётся в `files` через зовущего). */
  onAdd: () => void;
  onCancel: (caption: string) => void;
  onSend: (r: SendFilesResult) => void;
}) {
  const [caption, setCaption] = useState(initialCaption);
  const [way, setWay] = useState<SendWay>(initialWay);
  const first = useRef(saved);
  const [remember, setRemember] = useState(false);
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  // Спойлер (G48): по файлам, а не по номерам — порядок и состав списка меняются.
  const [marked, setMarked] = useState<ReadonlySet<File>>(() => new Set());
  const [captionAbove, setCaptionAbove] = useState(false);
  const [tileMenu, setTileMenu] = useState<{ pos: { x: number; y: number }; file: File; timer?: boolean } | null>(null);
  // Таймер самоуничтожения (#226): по файлам, как спойлер; 0 — «Просмотр один раз».
  const [ttls, setTtls] = useState<ReadonlyMap<File, number>>(() => new Map());
  const onceMenu = !!onceItems;
  const [dims, setDims] = useState<ReadonlyMap<File, { w: number; h: number }>>(() => new Map());
  const capRef = useRef<HTMLTextAreaElement>(null);
  const captionNow = useRef(caption);
  captionNow.current = caption;
  // Правка до отправки (G49): исходники отредактированных фото, открытые редактор / просмотр / переименование.
  const [origins, setOrigins] = useState<ReadonlyMap<File, { src: File; edit: PhotoEdit }>>(() => new Map());
  const [editing, setEditing] = useState<File | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<File | null>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replacing = useRef<File | null>(null);
  // Esc в просмотре закрывает просмотр, а не окно (у редактора свой перехват Esc).
  const overlayOpen = useRef(false);
  overlayOpen.current = preview !== null || editing !== null;
  const dialogRef = useDialogChrome<HTMLDivElement>(() => {
    if (!overlayOpen.current) onCancel(captionNow.current);
  });

  const urls = useMemo(() => {
    const m = new Map<File, string>();
    for (const f of files) if (sendKind(f) !== 'file') m.set(f, URL.createObjectURL(f));
    return m;
  }, [files]);
  useEffect(
    () => () => {
      for (const u of urls.values()) URL.revokeObjectURL(u);
    },
    [urls],
  );
  // Размеры фото — для «Высокого качества»: пункт виден, пока есть фото крупнее обычного предела (`canUseHighQualityPhoto`).
  useEffect(() => {
    if (!media2) return;
    let alive = true;
    for (const f of files) {
      const u = urls.get(f);
      if (!u || sendKind(f) !== 'photo') continue;
      const im = new Image();
      im.onload = () => {
        if (alive) setDims((d) => new Map(d).set(f, { w: im.naturalWidth, h: im.naturalHeight }));
      };
      im.src = u;
    }
    return () => {
      alive = false;
    };
  }, [urls, files, media2]);

  const group = hasGroupOption(files);
  const asFileOpt = hasAsFileOption(files);
  const spoilerMenu = media2 && spoilerMenuVisible(files, way);
  const captionMenu = media2 && captionMoveVisible(files, way);
  const hdOpt = media2 && hdOptionVisible(files.map((f) => dims.get(f) ?? null), way);
  const canMenu = menu.silent || menu.later || spoilerMenu || captionMenu;
  const capUp = captionMenu && captionAbove;
  // Поле подписи при смене места (над / под плитками) пересоздаётся — фокус возвращаем ему.
  useEffect(() => {
    capRef.current?.focus();
  }, [capUp]);
  const allMarked = files.length > 0 && files.every((f) => marked.has(f));
  const toggleSpoilers = (list: readonly File[], on: boolean) =>
    setMarked((m) => {
      const n = new Set(m);
      for (const f of list) {
        if (on) n.add(f);
        else n.delete(f);
      }
      return n;
    });
  const submit = (how: SendBoxHow) => {
    if (files.length === 0) return;
    const spoilers = new Set<number>();
    if (spoilerMenu) files.forEach((f, i) => marked.has(f) && spoilers.add(i));
    const once = new Map<number, number>();
    if (onceMenu) files.forEach((f, i) => ttls.has(f) && canSetOnce(f, way.asFile) && once.set(i, ttls.get(f)!));
    onSend({
      files,
      caption,
      way,
      remember: remember && rememberVisible(first.current, way),
      how,
      spoilers,
      captionAbove: capUp,
      once,
    });
  };
  const asTiles = !way.asFile && files.some((f) => sendKind(f) !== 'file');
  const onceOn = onceMenu && files.some((f) => ttls.has(f) && canSetOnce(f, way.asFile));

  /** Файл на месте `old` меняется на `next` (правка, замена, имя): спойлер и исходник правки переезжают с ним. */
  const swap = (old: File, next: File, origin?: { src: File; edit: PhotoEdit }) => {
    const i = files.indexOf(old);
    if (i < 0) return;
    setMarked((m) => {
      if (!m.has(old)) return m;
      const n = new Set(m);
      n.delete(old);
      n.add(next);
      return n;
    });
    setOrigins((o) => {
      const n = new Map(o);
      n.delete(old);
      if (origin) n.set(next, origin);
      return n;
    });
    onFiles(replaceAt(files, i, next));
  };
  const viewable = asTilesFiles(files, way.asFile);

  const drop = (i: number) => {
    const next = files.filter((_, j) => j !== i);
    if (next.length === 0) onCancel(caption);
    else onFiles(next);
  };

  const tile = (f: File, i: number) => {
    const url = urls.get(f);
    const media = !!url && !way.asFile;
    const hidden = media && spoilerMenu && marked.has(f);
    return (
      <div
        key={`${f.name}-${f.size}-${i}`}
        className={`sfb-item${media ? ' tile' : ' row'}${hidden ? ' spoiled' : ''}${dragOver === i && dragFrom !== null && dragFrom !== i ? ' over' : ''}`}
        draggable={files.length > 1}
        onDragStart={(e) => {
          setDragFrom(i);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/x-gv-sendfile', String(i));
        }}
        onDragOver={(e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(i);
        }}
        onDrop={(e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          e.stopPropagation();
          onFiles(moveFile(files, dragFrom, i));
          setDragFrom(null);
          setDragOver(null);
        }}
        onDragEnd={() => {
          setDragFrom(null);
          setDragOver(null);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setTileMenu({ pos: { x: e.clientX, y: e.clientY }, file: f });
        }}
        onClick={media ? () => setPreview(viewable.indexOf(f)) : undefined}
        title={
          media
            ? `${f.name} — нажмите, чтобы открыть${files.length > 1 ? ', перетащите, чтобы поменять порядок' : ''}`
            : files.length > 1
              ? `${f.name} — перетащите, чтобы поменять порядок`
              : f.name
        }
      >
        {media ? (
          sendKind(f) === 'video' ? (
            <video src={url} muted preload="metadata" className="sfb-thumb" />
          ) : (
            <img src={url} alt={f.name} className="sfb-thumb" />
          )
        ) : (
          <>
            <span className="sfb-ico">
              <Icon name="file" size={20} />
            </span>
            {renaming === f ? (
              <input
                className="sfb-rename"
                defaultValue={f.name}
                aria-label="Имя файла"
                autoFocus
                onFocus={(e) => {
                  // Выделено имя без расширения — как у Проводника и Telegram Desktop.
                  const dot = e.currentTarget.value.lastIndexOf('.');
                  e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
                onBlur={(e) => {
                  if (renaming !== f) return;
                  setRenaming(null);
                  const name = renameTarget(f.name, e.currentTarget.value);
                  if (name) swap(f, new File([f], name, { type: f.type, lastModified: f.lastModified }), origins.get(f));
                }}
              />
            ) : (
              <span className="sfb-name">{f.name}</span>
            )}
            <span className="sfb-size">{kb(f.size)}</span>
          </>
        )}
        {hidden && <SpoilerParticles />}
        {onceMenu && ttls.has(f) && canSetOnce(f, way.asFile) && (
          <span className="sfb-once" title={ttls.get(f) ? `Исчезнет через ${ttls.get(f)} с после открытия` : 'Просмотр один раз'}>
            <Icon name={ttls.get(f) ? 'clock' : 'flame'} size={12} />
            {ttls.get(f) ? String(ttls.get(f)) : '1'}
          </span>
        )}
        <button
          type="button"
          className="sfb-x"
          title="Убрать"
          aria-label={`Убрать ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            drop(i);
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    );
  };

  const captionField = (
    <textarea
      ref={capRef}
      className="sfb-caption"
      rows={1}
      placeholder="Подпись"
      value={caption}
      onChange={(e) => setCaption(e.target.value)}
      onKeyDown={(e) => {
        // Enter — отправить, Shift+Enter — новая строка (поле окна у Telegram ведёт себя как поле чата).
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit('now');
        }
      }}
    />
  );

  // Меню — рядом с окном, а не внутри `.modal-overlay`: портал `ContextMenu` пускает нажатие вверх по дереву React, и нажатие
  // по пункту закрывало окно («нажатие по затемнению» = «Отмена»).
  return (
    <>
      <div className="modal-overlay" onClick={() => onCancel(caption)}>
        <div
          className="modal create-channel sfb"
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sfb-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="admin-head">
            <h2 id="sfb-title">{boxTitle(files)}</h2>
            <button type="button" className="icon-close" aria-label="Закрыть" title="Закрыть" onClick={() => onCancel(caption)}>
              <Icon name="close" size={18} />
            </button>
          </div>
          {capUp && captionField}
          <div className={`sfb-list${asTiles ? ' tiles' : ''}${asTiles && files.length === 1 ? ' one' : ''}`}>{files.map(tile)}</div>
          {(group || asFileOpt || hdOpt) && (
            <div className="sfb-ways">
              {group && (
                <label className="sfb-check">
                  <input type="checkbox" checked={way.group} onChange={(e) => setWay((w) => ({ ...w, group: e.target.checked }))} />
                  <span>Группировать</span>
                </label>
              )}
              {asFileOpt && (
                <label className="sfb-check">
                  <input type="checkbox" checked={way.asFile} onChange={(e) => setWay((w) => ({ ...w, asFile: e.target.checked }))} />
                  <span>{files.length > 1 ? 'Отправить как файлы' : 'Отправить как файл'}</span>
                </label>
              )}
              {hdOpt && (
                <label className="sfb-check">
                  <input type="checkbox" checked={way.hd === true} onChange={(e) => setWay((w) => ({ ...w, hd: e.target.checked }))} />
                  <span>Высокое качество</span>
                </label>
              )}
              {rememberVisible(first.current, way) && (
                <label className="sfb-check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  <span>Запомнить выбор</span>
                </label>
              )}
            </div>
          )}
          {!capUp && captionField}
          <div className="sfb-foot">
            <button type="button" className="link sfb-add" onClick={onAdd} disabled={files.length >= 10}>
              <Icon name="plus" size={14} /> Добавить
            </button>
            <span className="sfb-gap" />
            <button type="button" className="link" onClick={() => onCancel(caption)}>
              Отмена
            </button>
            <span className="sfb-send">
              <button type="button" className="sfb-go" onClick={() => submit('now')}>
                Отправить
              </button>
              {canMenu && (
                <button
                  type="button"
                  className="sfb-more"
                  title="Ещё"
                  aria-label="Ещё"
                  aria-haspopup="menu"
                  onClick={(e) => setMenuAt(e.currentTarget.getBoundingClientRect())}
                >
                  <Icon name="more" size={16} />
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
      {menuAt && (
        <ContextMenu anchor={menuAt} align="end" onClose={() => setMenuAt(null)} width={232}>
          {spoilerMenu && (
            <MenuItem
              icon="eye"
              label={allMarked ? 'Снять спойлер' : 'Скрыть под спойлером'}
              onClick={() => {
                setMenuAt(null);
                toggleSpoilers(files, !allMarked);
              }}
            />
          )}
          {captionMenu && (
            <MenuItem
              icon={captionAbove ? 'chevron-down' : 'chevron-up'}
              label={captionAbove ? 'Подпись под медиа' : 'Подпись над медиа'}
              onClick={() => {
                setMenuAt(null);
                setCaptionAbove(!captionAbove);
              }}
            />
          )}
          {menu.silent && (
            <MenuItem
              icon="bell-off"
              label="Отправить без звука"
              onClick={() => {
                setMenuAt(null);
                submit('silent');
              }}
            />
          )}
          {menu.later && (
            <MenuItem
              icon="calendar-time"
              label="Отправить позже"
              disabled={onceOn}
              sub={onceOn ? 'Самоуничтожающиеся медиа нельзя отложить' : undefined}
              onClick={() => {
                setMenuAt(null);
                submit('later');
              }}
            />
          )}
        </ContextMenu>
      )}
      {tileMenu?.timer && (
        <ContextMenu pos={tileMenu.pos} onClose={() => setTileMenu(null)} width={248}>
          {onceItems!(
            ttls.has(tileMenu.file) ? ttls.get(tileMenu.file)! : null,
            (ttl) => {
              const f = tileMenu.file;
              setTileMenu(null);
              setTtls((m) => {
                const n = new Map(m);
                if (ttl === null) n.delete(f);
                else n.set(f, ttl);
                return n;
              });
            },
            () => setTileMenu({ ...tileMenu, timer: false }),
          )}
        </ContextMenu>
      )}
      {tileMenu && !tileMenu.timer && (
        <ContextMenu pos={tileMenu.pos} onClose={() => setTileMenu(null)} width={232}>
          {!way.asFile && sendKind(tileMenu.file) === 'photo' && photoEditable(tileMenu.file.type) && (
            <MenuItem
              icon="photo"
              label="Изменить фото"
              onClick={() => {
                setTileMenu(null);
                setEditing(tileMenu.file);
              }}
            />
          )}
          <MenuItem
            icon="repeat"
            label="Заменить файл"
            onClick={() => {
              replacing.current = tileMenu.file;
              setTileMenu(null);
              replaceRef.current?.click();
            }}
          />
          {!asTilesFile(tileMenu.file, way.asFile) && (
            <MenuItem
              icon="edit"
              label="Переименовать"
              onClick={() => {
                setTileMenu(null);
                setRenaming(tileMenu.file);
              }}
            />
          )}
          {spoilerMenu && asTilesFile(tileMenu.file, way.asFile) && (
            <MenuItem
              icon="eye"
              label={marked.has(tileMenu.file) ? 'Снять спойлер' : 'Скрыть под спойлером'}
              onClick={() => {
                const f = tileMenu.file;
                setTileMenu(null);
                toggleSpoilers([f], !marked.has(f));
              }}
            />
          )}
          {/* Таймер самоуничтожения (#226; tdesktop `send_files_box.cpp` — пункт меню файла с подменю, только фото и видео). */}
          {onceMenu && canSetOnce(tileMenu.file, way.asFile) && (
            <MenuItem
              icon="clock"
              label="Таймер самоуничтожения"
              submenu
              onClick={() => setTileMenu({ ...tileMenu, timer: true })}
            />
          )}
          <MenuItem
            icon="trash"
            label="Удалить"
            danger
            onClick={() => {
              const i = files.indexOf(tileMenu.file);
              setTileMenu(null);
              if (i >= 0) drop(i);
            }}
          />
        </ContextMenu>
      )}
      <input
        ref={replaceRef}
        type="file"
        hidden
        accept={way.asFile ? undefined : 'image/*,video/*'}
        onChange={(e) => {
          const next = e.currentTarget.files?.[0];
          const old = replacing.current;
          e.currentTarget.value = '';
          replacing.current = null;
          if (next && old) swap(old, next);
        }}
      />
      {preview !== null && viewable.length > 0 && (
        <Lightbox
          images={viewable.map((f) => ({
            url: urls.get(f) ?? '',
            name: f.name,
            size: f.size,
            video: sendKind(f) === 'video',
            type: f.type,
          }))}
          index={Math.min(Math.max(preview, 0), viewable.length - 1)}
          onClose={() => setPreview(null)}
          onIndex={setPreview}
        />
      )}
      {editing && (
        <PhotoEditor
          file={origins.get(editing)?.src ?? editing}
          initial={origins.get(editing)?.edit}
          onCancel={() => setEditing(null)}
          onDone={(out, edit) => {
            const cur = editing;
            const src = origins.get(cur)?.src ?? cur;
            setEditing(null);
            if (out === src) swap(cur, src);
            else swap(cur, out, { src, edit });
          }}
        />
      )}
    </>
  );
}

/** Файл в окне — плиткой медиа (фото или видео не «как файлы»): его можно открыть крупно и скрыть под спойлером. */
function asTilesFile(f: File, asFile: boolean): boolean {
  return !asFile && sendKind(f) !== 'file';
}

/** Плитки медиа по порядку окна — список для просмотра крупно. */
function asTilesFiles(files: readonly File[], asFile: boolean): File[] {
  return files.filter((f) => asTilesFile(f, asFile));
}
