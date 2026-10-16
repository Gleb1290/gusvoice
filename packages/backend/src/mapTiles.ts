import { open, stat, type FileHandle } from 'node:fs/promises';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import { mapEtag } from './mapTilesRules.js';

/**
 * Чтение локального файла PMTiles (14.10, `osmmap1`): библиотека `pmtiles` умеет только `Source` — реализуем его поверх `fs`.
 * Один открытый дескриптор на файл, чтения по смещению безопасны при параллельных запросах. Каталоги библиотека кеширует сама.
 */
class LocalFileSource implements Source {
  private handle: Promise<FileHandle> | null = null;
  constructor(private readonly path: string) {}
  getKey(): string {
    return this.path;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    this.handle ??= open(this.path, 'r');
    let fh: FileHandle;
    try {
      fh = await this.handle;
    } catch (e) {
      this.handle = null;
      throw e;
    }
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) as ArrayBuffer };
  }
}

export type MapInfo = {
  minzoom: number;
  maxzoom: number;
  /** [запад, юг, восток, север] */
  bounds: [number, number, number, number];
  /** [долгота, широта] */
  center: [number, number];
  etag: string;
};

/** Плитка MVT без сжатия (библиотека `pmtiles` сама распаковывает сжатие файла); сжимаем для ответа в маршруте. */
export type MapTile = { data: Buffer };

export type MapArchive = {
  info(): Promise<MapInfo>;
  /** Плитка (распакованная); `null` — такой плитки нет. */
  tile(z: number, x: number, y: number): Promise<MapTile | null>;
};

/** Открыть архив (лениво: файл читается при первом запросе). Ошибка файла — исключение запроса (маршрут ответит 503). */
export function openMapArchive(path: string): MapArchive {
  const source = new LocalFileSource(path);
  const pm = new PMTiles(source);
  let infoJob: Promise<MapInfo> | null = null;
  return {
    info() {
      infoJob ??= (async () => {
        const [h, st] = await Promise.all([pm.getHeader(), stat(path)]);
        return {
          minzoom: h.minZoom,
          maxzoom: h.maxZoom,
          bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat] as [number, number, number, number],
          center: [h.centerLon, h.centerLat] as [number, number],
          etag: mapEtag(st.size, st.mtimeMs),
        };
      })().catch((e) => {
        infoJob = null;
        throw e;
      });
      return infoJob;
    },
    async tile(z, x, y) {
      const h = await pm.getHeader();
      if (z < h.minZoom || z > h.maxZoom) return null;
      const got = await pm.getZxy(z, x, y);
      return got ? { data: Buffer.from(got.data) } : null;
    },
  };
}
