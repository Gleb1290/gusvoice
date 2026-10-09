import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PHOTO_QUALITY } from '../attachRules';
import {
  PRISTINE_EDIT,
  aspectRatio,
  cropPixels,
  dragCrop,
  editIsPristine,
  editOutputType,
  editedName,
  fitAspect,
  flipEdit,
  rotateLeft,
  rotatedSize,
  type CropAspect,
  type CropHandle,
  type PhotoEdit,
} from '../photoEditRules';
import { toast } from '../toast';
import { Icon } from './Icon';

/**
 * Перенос поворота и отражения на холст: точка исходника (px, py) уходит в видимое изображение (повёрнутое на `angle` против
 * часовой и отражённое по горизонтали). `w`, `h` — размер исходника.
 */
function applyEditTransform(ctx: CanvasRenderingContext2D, w: number, h: number, e: PhotoEdit) {
  const v = rotatedSize(w, h, e.angle);
  if (e.flipped) {
    ctx.translate(v.w, 0);
    ctx.scale(-1, 1);
  }
  if (e.angle === 90) {
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  } else if (e.angle === 180) {
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
  } else if (e.angle === 270) {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  }
}

/**
 * Отредактированная копия: рамка кадра в полном разрешении, тип — как у исходника (`editOutputType`), качество — как у нашего
 * сжатия (`PHOTO_QUALITY`). Метаданные холст не переносит (как `compressPhoto`). JPEG — на белом (альфы не знает).
 */
async function renderEdit(file: File, bmp: ImageBitmap, e: PhotoEdit): Promise<File> {
  const v = rotatedSize(bmp.width, bmp.height, e.angle);
  const px = cropPixels(e.crop, v.w, v.h, aspectRatio(e.aspect, v.w, v.h));
  const type = editOutputType(file.type);
  const canvas = document.createElement('canvas');
  canvas.width = px.w;
  canvas.height = px.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px.w, px.h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(-px.x, -px.y);
  applyEditTransform(ctx, bmp.width, bmp.height, e);
  ctx.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, type === 'image/png' ? undefined : PHOTO_QUALITY),
  );
  canvas.width = 0;
  canvas.height = 0;
  if (!blob || blob.size === 0) throw new Error('empty blob');
  return new File([blob], editedName(file.name, type), { type, lastModified: Date.now() });
}

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const ASPECTS: { id: CropAspect; label: string }[] = [
  { id: 'free', label: 'Свободно' },
  { id: 'square', label: 'Квадрат' },
  { id: 'original', label: 'Оригинал' },
];

/**
 * Простой редактор фото до отправки (08.10, #211, G49; Telegram Desktop `editor/photo_editor*.cpp`, Android `PhotoCropView`):
 * кадрирование рамкой с ручками по углам и краям (пропорции «Свободно» / «Квадрат» / «Оригинал»; при пропорции — только углы),
 * поворот на 90° против часовой, отражение, «Сбросить». «Готово» отдаёт отредактированную копию (`renderEdit`) и состояние
 * правки — зовущий хранит исходник, и повторное открытие начинается с той же рамки. Ничего не правили — отдаёт исходный файл.
 * Esc — отмена, Enter — «Готово». Рисования и обрезки видео нет (план G49).
 */
export function PhotoEditor({
  file,
  initial,
  onDone,
  onCancel,
}: {
  /** Исходник (не отредактированная копия). */
  file: File;
  initial?: PhotoEdit;
  onDone: (out: File, edit: PhotoEdit) => void;
  onCancel: () => void;
}) {
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [edit, setEdit] = useState<PhotoEdit>(initial ?? PRISTINE_EDIT);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ handle: CropHandle; x: number; y: number; crop: PhotoEdit['crop'] } | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    let alive = true;
    let got: ImageBitmap | null = null;
    createImageBitmap(file, { imageOrientation: 'from-image' })
      .then((b) => {
        got = b;
        if (alive) setBmp(b);
        else b.close();
      })
      .catch(() => {
        if (!alive) return;
        toast('error', 'Не удалось открыть фото для правки');
        cancelRef.current();
      });
    return () => {
      alive = false;
      got?.close();
    };
  }, [file]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = bmp ? rotatedSize(bmp.width, bmp.height, edit.angle) : { w: 1, h: 1 };
  const scale = bmp && stage.w > 0 && stage.h > 0 ? Math.min(stage.w / view.w, stage.h / view.h) : 0;
  const dispW = Math.max(1, Math.round(view.w * scale));
  const dispH = Math.max(1, Math.round(view.h * scale));
  const ratio = aspectRatio(edit.aspect, view.w, view.h);

  // Снимок на экране: весь, повёрнутый и отражённый; рамка — поверх него.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !bmp || scale <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(dispW * dpr);
    c.height = Math.round(dispH * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.scale((dispW * dpr) / view.w, (dispH * dpr) / view.h);
    applyEditTransform(ctx, bmp.width, bmp.height, edit);
    ctx.drawImage(bmp, 0, 0);
  }, [bmp, edit.angle, edit.flipped, dispW, dispH, scale, view.w, view.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = async () => {
    if (!bmp || busy) return;
    if (editIsPristine(edit)) return onDone(file, PRISTINE_EDIT);
    setBusy(true);
    try {
      onDone(await renderEdit(file, bmp, edit), edit);
    } catch {
      toast('error', 'Не удалось сохранить правку');
      setBusy(false);
    }
  };
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void doneRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const startDrag = (handle: CropHandle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, crop: edit.crop };
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setEdit((cur) => ({ ...cur, crop: dragCrop(d.crop, d.handle, e.clientX - d.x, e.clientY - d.y, dispW, dispH, ratio) }));
  };
  const endDrag = () => {
    drag.current = null;
  };
  const setAspect = (aspect: CropAspect) =>
    setEdit((cur) => ({ ...cur, aspect, crop: fitAspect(cur.crop, aspectRatio(aspect, view.w, view.h), view.w, view.h) }));

  const c = edit.crop;
  // В `body`, как просмотр: внутри ленты фиксированное окно обрезал бы предок с `transform`.
  return createPortal(
    <div className="photo-editor" role="dialog" aria-modal="true" aria-label="Изменить фото">
      <div className="lb-top">
        <div className="lb-meta">
          <div className="lb-name">Изменить фото</div>
          <div className="lb-sub">{file.name}</div>
        </div>
        <button type="button" className="lb-btn" title="Закрыть · Esc" aria-label="Закрыть" onClick={onCancel}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="pe-stage" ref={stageRef}>
        {bmp && scale > 0 && (
          <div className="pe-frame" style={{ width: dispW, height: dispH }}>
            <canvas ref={canvasRef} className="pe-canvas" style={{ width: dispW, height: dispH }} />
            <div
              className="pe-crop"
              style={{ left: c.x * dispW, top: c.y * dispH, width: c.w * dispW, height: c.h * dispH }}
              onPointerDown={startDrag('move')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {HANDLES.filter((h) => ratio === null || h.length === 2).map((h) => (
                <span
                  key={h}
                  className={`pe-handle ${h}`}
                  onPointerDown={startDrag(h)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="pe-bar">
        <div className="pe-tools">
          <button
            type="button"
            className="lb-btn"
            title="Повернуть"
            aria-label="Повернуть"
            onClick={() => setEdit(rotateLeft)}
          >
            <Icon name="rotate" size={18} />
          </button>
          <button type="button" className="lb-btn" title="Отразить" aria-label="Отразить" onClick={() => setEdit(flipEdit)}>
            <Icon name="flip" size={18} />
          </button>
          <span className="pe-aspects" role="radiogroup" aria-label="Пропорции">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={edit.aspect === a.id}
                className={`pe-chip${edit.aspect === a.id ? ' on' : ''}`}
                onClick={() => setAspect(a.id)}
              >
                {a.label}
              </button>
            ))}
          </span>
        </div>
        <div className="pe-foot">
          <button
            type="button"
            className="link pe-reset"
            disabled={editIsPristine(edit) && edit.aspect === 'free'}
            onClick={() => setEdit(PRISTINE_EDIT)}
          >
            Сбросить
          </button>
          <span className="sfb-gap" />
          <button type="button" className="link pe-cancel" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="pe-done" disabled={!bmp || busy} onClick={() => void done()}>
            Готово
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
