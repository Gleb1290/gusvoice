/**
 * Чистые правила панели «Отладка стрима» — без React и LiveKit, чтобы их можно было импортировать из
 * Node и покрыть тестами (сам `StreamDebugPanel.tsx` тянет и то, и другое).
 */

/** Цели слоёв одной строкой, Мбит/с. Слой на паузе (dynacast) помечаем, а не прячем. */
export function formatLayerTargets(layers: { rid: string; active: boolean; bps: number }[]): string {
  if (layers.length < 2) return '';
  return layers
    .map((l) => `${l.rid || '?'} ${l.active ? (l.bps / 1e6).toFixed(2) : 'пауза'}`)
    .join(' · ');
}

/** Накопительные счётчики кодировщика для разностей «за окно» (06.10, «чёрный ящик»). */
export interface EncCounters {
  atMs: number;
  frames: number;
  qpSum: number;
  bytesSent: number;
  /** Сколько байт кодировщик ДОЛЖЕН был выдать по своей цели (`totalEncodedBytesTarget`); 0 — не знаем. */
  encBytesTarget: number;
}

/**
 * Средний QP и «цель против факта» за окно между двумя замерами (06.10, #207). `null` — окно негодное
 * (первый замер, счётчики пошли назад — показ перезапущен).
 *
 * QP: 20–30 — чёткий текст, 40+ — мыло, 51 — предел H.264. Факт ≪ цели кодировщика — ему нечего слать
 * (статика: оценке канала не на чем расти); цель ≪ оценки канала — биты ушли нижним слоям.
 */
export function encWindow(
  prev: EncCounters | null,
  cur: EncCounters,
): { qp: number | null; kbps: number; encKbps: number | null } | null {
  if (!prev || cur.atMs <= prev.atMs) return null;
  if (cur.frames < prev.frames || cur.bytesSent < prev.bytesSent || cur.qpSum < prev.qpSum) return null;
  const dtS = (cur.atMs - prev.atMs) / 1000;
  const frames = cur.frames - prev.frames;
  const enc = cur.encBytesTarget - prev.encBytesTarget;
  return {
    qp: frames > 0 && cur.qpSum > 0 ? Math.round(((cur.qpSum - prev.qpSum) / frames) * 10) / 10 : null,
    kbps: Math.round(((cur.bytesSent - prev.bytesSent) * 8) / dtS / 1000),
    encKbps: cur.encBytesTarget > 0 && enc >= 0 ? Math.round((enc * 8) / dtS / 1000) : null,
  };
}

/** С чем показ запущен на самом деле — одной строкой для панели («Показ»). Пусто — оболочка не сказала. */
export function formatShareCfg(c: {
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  mode?: string;
  maxQuality?: boolean;
  layers?: boolean;
  keyframeScale?: number;
}): string {
  if (!c.width || !c.height) return '';
  const parts = [`${c.width}×${c.height}`, `${c.fps ?? 0} к/с`, `${((c.bitrate ?? 0) / 1e6).toFixed(1)} Мбит/с`];
  parts.push(c.mode === 'motion' ? 'Плавность' : 'Чёткость');
  if (c.keyframeScale) parts.push(`опорный ×${c.keyframeScale}`);
  parts.push(c.layers ? 'слои' : 'один поток');
  if (c.maxQuality) parts.push('макс. качество');
  return parts.join(' · ');
}
