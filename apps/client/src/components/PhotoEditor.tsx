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
import {
  BRUSH_DEFAULT,
  BRUSH_MAX,
  BRUSH_MIN,
  DEFAULT_MARK_COLOR,
  MARK_PALETTE,
  SLIDER_STEPS,
  TEXT_DEFAULT,
  TEXT_MAX,
  TEXT_MIN,
  appendPoint,
  hasMarks,
  hitText,
  markUnit,
  pruneMarks,
  removeMark,
  sliderToValue,
  textBox,
  textOutline,
  undoMark,
  updateMark,
  valueToSlider,
  visibleToSource,
  type DrawMark,
} from '../photoDrawRules';
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

const textFont = (px: number) => `700 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Ширина надписи в единицах метки (кегль `size` — доля короткой стороны). */
function measureTextWidth(text: string, size: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.6;
  measureCtx.font = textFont(100);
  return (measureCtx.measureText(text).width / 100) * size;
}

/**
 * Рисует метки (штрихи и надписи) на холсте, у которого УЖЕ стоит `applyEditTransform` — то есть в пикселях исходника.
 * `u` — `markUnit`; `flipped` — отражение (надпись переворачивается обратно, чтобы читалась); `sel` / `px` — рамка выбранной
 * надписи на экране (`px` — пикселей исходника в одном пикселе экрана); при запекании в файл `sel` = -1.
 */
function paintMarks(ctx: CanvasRenderingContext2D, marks: readonly DrawMark[], u: number, flipped: boolean, sel = -1, px = 1) {
  marks.forEach((m, i) => {
    ctx.save();
    if (m.kind === 'stroke') {
      const pts = m.points;
      if (pts.length > 0) {
        ctx.globalCompositeOperation = m.erase ? 'destination-out' : 'source-over';
        const color = m.erase ? '#000000' : m.color;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = m.width * u;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (pts.length === 1) {
          ctx.beginPath();
          ctx.arc(pts[0].x * u, pts[0].y * u, (m.width * u) / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(pts[0].x * u, pts[0].y * u);
          for (let k = 1; k < pts.length - 1; k++) {
            ctx.quadraticCurveTo(pts[k].x * u, pts[k].y * u, ((pts[k].x + pts[k + 1].x) / 2) * u, ((pts[k].y + pts[k + 1].y) / 2) * u);
          }
          ctx.lineTo(pts[pts.length - 1].x * u, pts[pts.length - 1].y * u);
          ctx.stroke();
        }
      }
    } else {
      ctx.translate(m.x * u, m.y * u);
      if (flipped) ctx.scale(-1, 1);
      if (m.text.trim()) {
        ctx.font = textFont(m.size * u);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = m.size * u * 0.16;
        ctx.strokeStyle = textOutline(m.color);
        ctx.strokeText(m.text, 0, 0);
        ctx.fillStyle = m.color;
        ctx.fillText(m.text, 0, 0);
      }
      if (i === sel) {
        const b = textBox(m, measureTextWidth);
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.strokeRect((-b.w / 2) * u, (-b.h / 2) * u, b.w * u, b.h * u);
      }
    }
    ctx.restore();
  });
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
  // Нарисованное и надписи — отдельным слоем (ластик стирает только их, не снимок), потом поверх снимка.
  const marks = pruneMarks(e.marks ?? []);
  if (marks.length > 0) {
    const layer = document.createElement('canvas');
    layer.width = px.w;
    layer.height = px.h;
    const lctx = layer.getContext('2d');
    if (!lctx) throw new Error('no 2d context');
    lctx.translate(-px.x, -px.y);
    applyEditTransform(lctx, bmp.width, bmp.height, e);
    paintMarks(lctx, marks, markUnit(bmp.width, bmp.height), e.flipped);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    layer.width = 0;
    layer.height = 0;
  }
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
 * Esc — отмена, Enter — «Готово». Обрезки видео нет (план G49).
 *
 * 14.10 (G49): три режима — «Кадр» (всё выше), «Рисовать» (кисть и ластик, палитра из десяти цветов Telegram Desktop, толщина,
 * «Отменить») и «Текст» (нажать на снимок — надпись, тянется пальцем, цвет, размер, «Удалить»). Метки — в `PhotoEdit.marks`
 * (`photoDrawRules.ts`), на выходе запекаются в файл поверх снимка тем же поворотом и отражением.
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
  const [mode, setMode] = useState<'crop' | 'draw' | 'text'>('crop');
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush');
  const [color, setColor] = useState(DEFAULT_MARK_COLOR);
  const [brush, setBrush] = useState(BRUSH_DEFAULT);
  const [textSize, setTextSize] = useState(TEXT_DEFAULT);
  /** Номер выбранной надписи в `edit.marks`; -1 — никакой. */
  const [sel, setSel] = useState(-1);
  const marksRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const painting = useRef(false);
  const textDrag = useRef<{ idx: number; dx: number; dy: number } | null>(null);
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

  const marks = edit.marks ?? [];
  const unit = bmp ? markUnit(bmp.width, bmp.height) : 1;
  const setMarks = (fn: (m: DrawMark[]) => DrawMark[]) => setEdit((cur) => ({ ...cur, marks: fn(cur.marks ?? []) }));

  // Метки поверх снимка: отдельный холст с тем же поворотом и отражением; в режиме «Текст» — рамка выбранной надписи.
  useEffect(() => {
    const c = marksRef.current;
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
    paintMarks(ctx, marks, unit, edit.flipped, mode === 'text' ? sel : -1, view.w / dispW);
  }, [bmp, edit.angle, edit.flipped, edit.marks, dispW, dispH, scale, view.w, view.h, sel, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Выбрали надпись — курсор в поле над палитрой (на телефоне поднимает клавиатуру).
  useEffect(() => {
    if (mode === 'text' && sel >= 0) inputRef.current?.focus();
  }, [mode, sel]);

  /** Пустые надписи не живут: ушли с них — выбрасываем. */
  const dropEmpty = () => {
    setMarks(pruneMarks);
    setSel(-1);
  };
  const deselectRef = useRef(dropEmpty);
  deselectRef.current = dropEmpty;
  const undoRef = useRef(() => {});
  undoRef.current = () => {
    if (marks.length === 0) return;
    setMarks(undoMark);
    setSel(-1);
  };
  const goMode = (next: 'crop' | 'draw' | 'text') => {
    if (next === mode) return;
    dropEmpty();
    setMode(next);
  };
  /** Точка касания в единицах меток (доля короткой стороны исходника) — через обратный поворот и отражение. */
  const markPoint = (e: React.PointerEvent) => {
    const r = overlayRef.current?.getBoundingClientRect();
    if (!bmp || !r || r.width <= 0 || r.height <= 0) return null;
    const vx = ((e.clientX - r.left) / r.width) * view.w;
    const vy = ((e.clientY - r.top) / r.height) * view.h;
    const s = visibleToSource(vx, vy, bmp.width, bmp.height, edit.angle, edit.flipped);
    return { x: s.x / unit, y: s.y / unit };
  };
  const paintDown = (e: React.PointerEvent) => {
    const p = markPoint(e);
    if (!p || !bmp) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (mode === 'draw') {
      painting.current = true;
      setMarks((ms) => [...ms, { kind: 'stroke', color, width: brush, erase: tool === 'eraser' || undefined, points: [p] }]);
      return;
    }
    const idx = hitText(marks, p, measureTextWidth);
    if (idx >= 0) {
      const m = marks[idx];
      if (m.kind === 'text') {
        textDrag.current = { idx, dx: m.x - p.x, dy: m.y - p.y };
        setColor(m.color);
        setTextSize(m.size);
      }
      setSel(idx);
      return;
    }
    // Мимо надписи — новая (пустая, пока ничего не набрали).
    const fresh = pruneMarks(marks);
    const t: DrawMark = { kind: 'text', color, size: textSize, text: '', x: p.x, y: p.y };
    setMarks(() => [...fresh, t]);
    setSel(fresh.length);
    textDrag.current = { idx: fresh.length, dx: 0, dy: 0 };
  };
  const paintMove = (e: React.PointerEvent) => {
    const p = markPoint(e);
    if (!p || !bmp) return;
    if (mode === 'draw') {
      if (!painting.current) return;
      setMarks((ms) => {
        const last = ms[ms.length - 1];
        if (!last || last.kind !== 'stroke') return ms;
        const pts = appendPoint(last.points, p);
        return pts === last.points ? ms : [...ms.slice(0, -1), { ...last, points: pts }];
      });
      return;
    }
    const d = textDrag.current;
    if (!d) return;
    const maxX = bmp.width / unit;
    const maxY = bmp.height / unit;
    setMarks((ms) => updateMark(ms, d.idx, { x: Math.min(maxX, Math.max(0, p.x + d.dx)), y: Math.min(maxY, Math.max(0, p.y + d.dy)) }));
  };
  const paintUp = () => {
    painting.current = false;
    // Браузер после нажатия снимает фокус с поля — возвращаем, когда палец отпущен (иначе на телефоне не поднимется клавиатура).
    if (mode === 'text' && textDrag.current) window.setTimeout(() => inputRef.current?.focus(), 0);
    textDrag.current = null;
  };
  const pickColor = (c: string) => {
    setColor(c);
    if (mode === 'text' && sel >= 0) setMarks((ms) => updateMark(ms, sel, { color: c }));
  };
  const selMark = sel >= 0 && marks[sel]?.kind === 'text' ? (marks[sel] as Extract<DrawMark, { kind: 'text' }>) : null;
  const sliderValue = mode === 'text' ? (selMark ? selMark.size : textSize) : brush;
  const [sliderLo, sliderHi] = mode === 'text' ? [TEXT_MIN, TEXT_MAX] : [BRUSH_MIN, BRUSH_MAX];
  const onSlider = (step: number) => {
    const v = sliderToValue(step, sliderLo, sliderHi);
    if (mode === 'draw') setBrush(v);
    else {
      setTextSize(v);
      if (selMark) setMarks((ms) => updateMark(ms, sel, { size: v }));
    }
  };

  const markedEdit = hasMarks(edit.marks);
  const done = async () => {
    if (!bmp || busy) return;
    const fin: PhotoEdit = { ...edit, marks: pruneMarks(edit.marks ?? []) };
    if (fin.marks!.length === 0) delete fin.marks;
    if (editIsPristine(fin) && !fin.marks) return onDone(file, PRISTINE_EDIT);
    setBusy(true);
    try {
      onDone(await renderEdit(file, bmp, fin), fin);
    } catch {
      toast('error', 'Не удалось сохранить правку');
      setBusy(false);
    }
  };
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'я') && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        undoRef.current();
        return;
      }
      // В поле надписи Enter / Esc кончают набор, а не закрывают редактор.
      if (e.target instanceof HTMLInputElement && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault();
        deselectRef.current();
        return;
      }
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
    <div className={`photo-editor${mode === 'crop' ? '' : ` paint ${mode}`}`} role="dialog" aria-modal="true" aria-label="Изменить фото">
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
            <canvas ref={marksRef} className="pe-marks" style={{ width: dispW, height: dispH }} />
            <div
              className={`pe-crop${mode === 'crop' ? '' : ' locked'}`}
              style={{ left: c.x * dispW, top: c.y * dispH, width: c.w * dispW, height: c.h * dispH }}
              onPointerDown={startDrag('move')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {HANDLES.filter((h) => mode === 'crop' && (ratio === null || h.length === 2)).map((h) => (
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
            {mode !== 'crop' && (
              <div
                ref={overlayRef}
                className={`pe-paint-area ${mode}`}
                onPointerDown={paintDown}
                onPointerMove={paintMove}
                onPointerUp={paintUp}
                onPointerCancel={paintUp}
              />
            )}
          </div>
        )}
      </div>
      <div className="pe-bar">
        <div className="pe-modes" role="tablist" aria-label="Режим">
          {(
            [
              ['crop', 'Кадр', null],
              ['draw', 'Рисовать', 'brush'],
              ['text', 'Текст', 'text-size'],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              className={`pe-chip${mode === id ? ' on' : ''}`}
              onClick={() => goMode(id)}
            >
              {icon && <Icon name={icon} size={16} />}
              {label}
            </button>
          ))}
        </div>
        {mode !== 'crop' && (
          <div className="pe-paint">
            {mode === 'text' && (
              <input
                ref={inputRef}
                className="pe-text-input"
                value={selMark?.text ?? ''}
                disabled={!selMark}
                maxLength={120}
                placeholder="Нажмите на фото, чтобы добавить надпись"
                aria-label="Текст надписи"
                onChange={(ev) => setMarks((ms) => updateMark(ms, sel, { text: ev.target.value }))}
              />
            )}
            <div className="pe-palette" role="radiogroup" aria-label="Цвет">
              {MARK_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={(selMark?.color ?? color) === c}
                  aria-label={c}
                  title={c}
                  className={`pe-swatch${(selMark?.color ?? color) === c ? ' on' : ''}`}
                  style={{ background: c }}
                  onClick={() => pickColor(c)}
                />
              ))}
            </div>
            <div className="pe-opts">
              {mode === 'draw' && (
                <>
                  <button
                    type="button"
                    className="lb-btn"
                    title="Кисть"
                    aria-label="Кисть"
                    aria-pressed={tool === 'brush'}
                    data-on={tool === 'brush' || undefined}
                    onClick={() => setTool('brush')}
                  >
                    <Icon name="brush" size={18} />
                  </button>
                  <button
                    type="button"
                    className="lb-btn"
                    title="Ластик"
                    aria-label="Ластик"
                    aria-pressed={tool === 'eraser'}
                    data-on={tool === 'eraser' || undefined}
                    onClick={() => setTool('eraser')}
                  >
                    <Icon name="eraser" size={18} />
                  </button>
                </>
              )}
              <input
                type="range"
                className="pe-range"
                min={0}
                max={SLIDER_STEPS}
                step={1}
                value={valueToSlider(sliderValue, sliderLo, sliderHi)}
                aria-label={mode === 'draw' ? 'Толщина' : 'Размер текста'}
                title={mode === 'draw' ? 'Толщина' : 'Размер текста'}
                onChange={(ev) => onSlider(Number(ev.target.value))}
              />
              {mode === 'text' && (
                <button
                  type="button"
                  className="lb-btn"
                  title="Удалить надпись"
                  aria-label="Удалить надпись"
                  disabled={!selMark}
                  onClick={() => {
                    setMarks((ms) => removeMark(ms, sel));
                    setSel(-1);
                  }}
                >
                  <Icon name="trash" size={18} />
                </button>
              )}
              <button
                type="button"
                className="lb-btn"
                title="Отменить · Ctrl+Z"
                aria-label="Отменить"
                disabled={marks.length === 0}
                onClick={() => undoRef.current()}
              >
                <Icon name="undo" size={18} />
              </button>
            </div>
          </div>
        )}
        {mode === 'crop' && <div className="pe-tools">
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
        </div>}
        <div className="pe-foot">
          <button
            type="button"
            className="link pe-reset"
            disabled={editIsPristine(edit) && edit.aspect === 'free' && !markedEdit}
            onClick={() => {
              setEdit(PRISTINE_EDIT);
              setSel(-1);
            }}
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
