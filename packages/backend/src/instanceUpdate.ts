import type { InstanceUpdateInfo } from '@gusvoice/shared';
import { randomBytes } from 'node:crypto';
import { open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.js';
import {
  decideUpdate,
  parseLatestRelease,
  parseReleaseVersion,
  parseUpdateStatus,
  parseUpdaterMarker,
  shouldCheckLatest,
  updateRequestLine,
} from './instanceUpdateRules.js';

/**
 * Кнопка «Обновить инстанс» (О2б) — файлы и сеть. Правила — `instanceUpdateRules.ts`.
 *
 * В контейнере два каталога (docker-compose.yml): `run/request` — на запись, сюда кладётся запрос; `run/status` —
 * только на чтение, его пишет `update.sh` на хосте. Разделены намеренно: хост работает от root и не пишет туда, куда
 * может писать контейнер (иначе подложенная ссылка перезаписала бы файл хоста).
 */

const requestFile = () => join(env.gvRunDir, 'request', 'update');
const statusFile = () => join(env.gvRunDir, 'status', 'status.json');
const markerFile = () => join(env.gvRunDir, 'status', 'updater.json');

const MAX_JSON_BYTES = 64 * 1024;
const MAX_RELEASE_BYTES = 512 * 1024;

/** Небольшой JSON с диска; нет файла, слишком большой или битый → null. */
async function readSmallJson(path: string): Promise<unknown> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(MAX_JSON_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_JSON_BYTES) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

let latestCache: { checkedAt: number | null; value: InstanceUpdateInfo['latest']; failed: boolean } = {
  checkedAt: null,
  value: null,
  failed: false,
};

/**
 * Свежий выпуск. Адрес задаёт владелец инстанса (`GV_RELEASES_URL`), пользователь его не выбирает — поэтому обычный
 * fetch, как у ленты обновлений десктопа (`routes/download.ts`), а не `safeFetch` для чужих адресов.
 * Неудача не стирает прошлый удачный ответ: показываем его с пометкой «проверить не удалось».
 */
async function latestRelease(force: boolean): Promise<typeof latestCache> {
  const now = Date.now();
  if (!shouldCheckLatest(latestCache.checkedAt, now, force)) return latestCache;
  let value: InstanceUpdateInfo['latest'] = null;
  try {
    const res = await fetch(env.gvReleasesUrl, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'GusVoice instance update check' },
      signal: AbortSignal.timeout(5000),
    });
    const text = res.ok ? await res.text() : '';
    if (text.length <= MAX_RELEASE_BYTES) value = parseLatestRelease(JSON.parse(text));
  } catch {
    value = null;
  }
  latestCache = value
    ? { checkedAt: now, value, failed: false }
    : { checkedAt: now, value: latestCache.value, failed: true };
  return latestCache;
}

async function requestAgeMs(): Promise<number | null> {
  try {
    const st = await stat(requestFile());
    return Math.max(0, Date.now() - st.mtimeMs);
  } catch {
    return null;
  }
}

export async function instanceUpdateInfo(force = false): Promise<InstanceUpdateInfo> {
  const installed = env.gvVersion;
  const isRelease = parseReleaseVersion(installed) !== null;
  const checkDisabled = !env.gvReleasesUrl;
  // Сборку разработки (прод на master) не с чем сравнивать — никуда не ходим.
  const latest = isRelease && !checkDisabled ? await latestRelease(force) : null;
  const [statusJson, markerJson, ageMs] = await Promise.all([
    readSmallJson(statusFile()),
    readSmallJson(markerFile()),
    requestAgeMs(),
  ]);
  const status = parseUpdateStatus(statusJson, Date.now());
  const updater = parseUpdaterMarker(markerJson);
  const decision = decideUpdate({
    installed,
    latest: latest?.value ?? null,
    checkDisabled,
    updater,
    status,
    requestAgeMs: ageMs,
  });
  return {
    installed,
    latest: latest?.value ?? null,
    checkedAt: latest?.checkedAt ? new Date(latest.checkedAt).toISOString() : null,
    checkFailed: latest?.failed ?? false,
    checkDisabled,
    updater,
    status,
    ...decision,
  };
}

/**
 * Положить запрос для хоста. Пишем во временный файл рядом и переименовываем: служба на хосте срабатывает на
 * появление `update` и не должна прочитать недописанную строку.
 */
export async function writeUpdateRequest(version: string): Promise<void> {
  const line = updateRequestLine(version);
  if (!line) throw new Error('bad version');
  const tmp = `${requestFile()}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, line, { mode: 0o644 });
    await rename(tmp, requestFile());
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
