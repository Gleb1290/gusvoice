import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  centerOffset,
  clampOffset,
  coverScale,
  MAX_ZOOM,
  OUT,
  sourceRect,
  VIEW,
  zoomFraction,
  zoomTo,
} from '../avatarCropRules';
import { Icon } from './Icon';

// Геометрия (накрытие, зажим, зум вокруг центра, область-источник) — в `avatarCropRules.ts`;
// здесь остаются DOM-события и canvas.

/**
 * Pick the displayed crop area for an avatar before upload. The image is shown in a square viewport
 * with a circular cut-out; the user pans (drag) and zooms (slider / wheel) to frame it. On confirm we
 * draw the framed region to a 256×256 canvas and hand back a PNG blob. GIFs skip this (handled by the
 * caller) so their animation is preserved.
 */
export function AvatarCropModal({
  file,
  busy,
  onCancel,
  onCrop,
}: {
  file: File;
  busy?: boolean;
  onCancel: () => void;
  onCrop: (blob: Blob) => void;
}) {
  const [url] = useState(() => URL.createObjectURL(file));
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [minScale, setMinScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  function onImgLoad() {
    const img = imgRef.current;
    if (!img) return;
    const n = { w: img.naturalWidth, h: img.naturalHeight };
    const ms = coverScale(n);
    setNat(n);
    setMinScale(ms);
    setScale(ms);
    setOff(centerOffset(n, ms));
  }

  function zoom(target: number) {
    if (!nat) return;
    const next = zoomTo({ scale, off }, target, minScale, nat);
    setScale(next.scale);
    setOff(next.off);
  }

  function down(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: off.x, oy: off.y };
  }
  function move(e: React.PointerEvent) {
    if (!drag.current || !nat) return;
    const o = { x: drag.current.ox + (e.clientX - drag.current.px), y: drag.current.oy + (e.clientY - drag.current.py) };
    setOff(clampOffset(o, scale, nat));
  }
  function up() {
    drag.current = null;
  }
  function wheel(e: React.WheelEvent) {
    zoom(scale * (e.deltaY < 0 ? 1.08 : 0.92));
  }

  function confirm() {
    const img = imgRef.current;
    if (!nat || !img) return;
    const { sx, sy, size } = sourceRect(off, scale);
    const cv = document.createElement('canvas');
    cv.width = OUT;
    cv.height = OUT;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, size, size, 0, 0, OUT, OUT);
    cv.toBlob((b) => b && onCrop(b), 'image/png', 0.92);
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal crop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>Кадрировать аватар</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onCancel}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div
          className="crop-view"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onWheel={wheel}
        >
          <img
            ref={imgRef}
            src={url}
            alt=""
            draggable={false}
            onLoad={onImgLoad}
            className="crop-img"
            style={{ width: nat ? nat.w * scale : undefined, height: nat ? nat.h * scale : undefined, transform: `translate(${off.x}px, ${off.y}px)` }}
          />
          <div className="crop-ring" />
          <div className="crop-circle" />
        </div>
        <div className="crop-zoom">
          <button type="button" className="crop-zoom-btn" title="Уменьшить" onClick={() => zoom(scale * 0.9)} disabled={!nat}>
            −
          </button>
          <input
            type="range"
            className="crop-zoom-range"
            min={minScale}
            max={minScale * MAX_ZOOM}
            step={0.001}
            value={scale}
            style={{ ['--p']: zoomFraction(scale, minScale) } as CSSProperties}
            onChange={(e) => zoom(Number(e.target.value))}
            disabled={!nat}
          />
          <button type="button" className="crop-zoom-btn" title="Увеличить" onClick={() => zoom(scale * 1.1)} disabled={!nat}>
            +
          </button>
        </div>
        <div className="modal-actions">
          <button type="button" className="link" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" onClick={confirm} disabled={busy || !nat}>
            {busy ? '…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
