import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fitZoom } from '../lightboxZoom';
import { Icon } from './Icon';

export type LightboxImage = {
  url: string;
  name: string;
  /** Вес файла. Не всегда известен: аватар приходит ссылкой, без карточки вложения. */
  size?: number;
  /** Подпись под заголовком («Аватар»). */
  sub?: string;
  downloadUrl?: string;
};

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`);
const ZMIN = 0.5;
const ZMAX = 3;

/**
 * Full-screen image viewer (round-7 P4): prev/next across all images in the view, zoom (+/−),
 * download, filmstrip, counter. Keyboard: Esc close, ←/→ navigate, +/− zoom. Portalled.
 */
export function Lightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const img = images[index];

  /** Подтянуть маленькую картинку к сцене — аватар 256×256 иначе теряется посреди чёрного поля. */
  const applyFit = useCallback(() => {
    const stage = stageRef.current;
    const el = imgRef.current;
    if (!stage || !el || !el.naturalWidth) return;
    setZoom(fitZoom({ w: el.naturalWidth, h: el.naturalHeight }, { w: stage.clientWidth, h: stage.clientHeight }));
  }, []);

  /**
   * Смена картинки: сбрасываем масштаб и сразу пробуем подогнать.
   *
   * ⚠️ Одним `onLoad` обойтись нельзя: у картинки из кэша событие успевает пройти ДО того, как React
   * повесит обработчик, — и тогда аватар остался бы в единице именно на повторном открытии, то есть
   * ровно в самом частом случае.
   */
  useEffect(() => {
    setZoom(1);
    applyFit();
  }, [index, applyFit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(ZMAX, +(z + 0.25).toFixed(2)));
      else if (e.key === '-') setZoom((z) => Math.max(ZMIN, +(z - 0.25).toFixed(2)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onClose, onIndex]);

  if (!img) return null;

  // Подпись собирается из того, что известно: назначение картинки, вес файла, место в наборе.
  // Для одиночной картинки «1 из 1» — шум, поэтому счётчик появляется только у набора.
  const sub = [img.sub, img.size != null ? kb(img.size) : null, images.length > 1 ? `${index + 1} из ${images.length}` : null]
    .filter(Boolean)
    .join(' · ');

  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <div className="lb-top" onClick={(e) => e.stopPropagation()}>
        <div className="lb-meta">
          <div className="lb-name">{img.name}</div>
          {sub && <div className="lb-sub">{sub}</div>}
        </div>
        {/* downloadUrl = the backend force-download endpoint; the bare `download` attribute is
            a no-op cross-origin (MinIO lives on another host), so it alone never saved anything.
            Нет такого маршрута — кнопки нет: она увела бы картинку в соседнюю вкладку вместо того,
            чтобы сохранить файл. Правый клик по картинке («Сохранить изображение») остаётся. */}
        {img.downloadUrl && (
          <a className="lb-btn" href={img.downloadUrl} download={img.name} title="Скачать">
            <Icon name="download" size={18} />
          </a>
        )}
        <button type="button" className="lb-btn" title="Закрыть" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="lb-stage" ref={stageRef} onClick={onClose}>
        {/* data-ctxsave: контент — правый клик оставляет «Сохранить изображение» (#75). */}
        <img
          className="lb-img"
          data-ctxsave
          ref={imgRef}
          src={img.url}
          alt={img.name}
          onLoad={applyFit}
          style={{ transform: `scale(${zoom})` }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {index > 0 && (
        <button
          type="button"
          className="lb-nav prev"
          title="Назад"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index - 1);
          }}
        >
          <Icon name="chevron-right" size={22} className="lb-flip" />
        </button>
      )}
      {index < images.length - 1 && (
        <button
          type="button"
          className="lb-nav next"
          title="Вперёд"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index + 1);
          }}
        >
          <Icon name="chevron-right" size={22} />
        </button>
      )}

      <div className="lb-bottom" onClick={(e) => e.stopPropagation()}>
        {images.length > 1 && (
          <div className="lb-strip">
            {images.map((im, i) => (
              <button
                type="button"
                key={i}
                className={`lb-thumb ${i === index ? 'active' : ''}`}
                onClick={() => onIndex(i)}
                title={im.name}
              >
                <img src={im.url} alt="" />
              </button>
            ))}
          </div>
        )}
        <div className="lb-zoom">
          <button
            type="button"
            title="Уменьшить"
            disabled={zoom <= ZMIN}
            onClick={() => setZoom((z) => Math.max(ZMIN, +(z - 0.25).toFixed(2)))}
          >
            <Icon name="minus" size={17} />
          </button>
          <span className="lb-zoom-val">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            title="Увеличить"
            disabled={zoom >= ZMAX}
            onClick={() => setZoom((z) => Math.min(ZMAX, +(z + 0.25).toFixed(2)))}
          >
            <Icon name="plus" size={17} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
