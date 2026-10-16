import { mapGlyphsUrlTemplate, mapTilesUrlTemplate, type MapInfoDto } from '@gusvoice/shared';
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';
import { ACC_SOURCE, accuracyCollection, dropSpriteLayers, type MapPoint } from './mapRules';

/**
 * Стиль живой карты (14.10, `osmmap1`): слои `@protomaps/basemaps` (схема basemap v4 файла PMTiles) в светлой/тёмной раскладке, подписи
 * по-русски; плитки и глифы — только наш сервер, спрайтов нет (слои со значками отброшены, `mapRules.dropSpriteLayers`).
 * Грузится лениво вместе с MapLibre (`MapView`). Источник `gv-acc` — круги точности: данные меняются без пересоздания карты.
 */

export const MAP_SOURCE = 'protomaps';

export function buildMapStyle(base: string, info: MapInfoDto, light: boolean, accent: string, points: readonly MapPoint[] = []): StyleSpecification {
  const flavor = namedFlavor(light ? 'light' : 'dark');
  const baseLayers = dropSpriteLayers(layers(MAP_SOURCE, flavor, { lang: 'ru' }));
  return {
    version: 8,
    glyphs: mapGlyphsUrlTemplate(base),
    sources: {
      [MAP_SOURCE]: {
        type: 'vector',
        tiles: [mapTilesUrlTemplate(base)],
        minzoom: info.minzoom,
        maxzoom: info.maxzoom,
        bounds: info.bounds,
      },
      [ACC_SOURCE]: { type: 'geojson', data: accuracyCollection(points) },
    },
    layers: [
      ...baseLayers,
      { id: 'gv-acc-fill', type: 'fill', source: ACC_SOURCE, paint: { 'fill-color': accent, 'fill-opacity': 0.16 } },
      { id: 'gv-acc-line', type: 'line', source: ACC_SOURCE, paint: { 'line-color': accent, 'line-width': 1.5, 'line-opacity': 0.7 } },
    ],
  } as StyleSpecification;
}
