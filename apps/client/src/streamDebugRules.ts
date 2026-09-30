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
