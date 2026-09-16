import type { InstanceUpdateError, InstanceUpdateInfo, InstanceUpdateStatus, InstanceUpdateStep } from '@gusvoice/shared';

/**
 * Кнопка «Обновить инстанс» в админ-панели (О2б, `docs/open-source-plan.md` §3.6) — чистые правила, без файлов и сети.
 *
 * Обновляет ХОСТ, бэкенд только просит: пишет номер версии в `run/request/update`, systemd на хосте запускает
 * `update.sh --from-panel`, тот пишет ход в `run/status/status.json`. Всё, что приходит из этих файлов и из ответа
 * сервера выпусков, здесь проверяется и приводится к известному виду — ни одно поле не уходит клиенту как есть.
 */

/** Номер выпуска: `v0.7.2` или `0.7.2`. Всё остальное (`master-abc1234`, `dev`, `latest`) — не выпуск. */
const RELEASE_RE = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export const UPDATE_STEPS: readonly InstanceUpdateStep[] = ['files', 'pull', 'backup', 'restart', 'health'];

/** Свежий выпуск спрашиваем не чаще раза в 6 часов… */
export const LATEST_CACHE_MS = 6 * 60 * 60 * 1000;
/** …а по кнопке «Проверить снова» — не чаще раза в минуту. */
export const LATEST_FORCE_MIN_MS = 60 * 1000;
/** Запрос, который хост не взял за это время, — служба на сервере не отвечает. */
export const REQUEST_STUCK_MS = 30 * 1000;
/**
 * «Идёт обновление», начатое дольше этого назад, — прервалось (перезагрузка сервера посреди шага). Больше самого
 * долгого честного обновления: скачивание образов по медленной сети + копия большой базы.
 */
export const RUNNING_STALE_MS = 45 * 60 * 1000;

export function parseReleaseVersion(raw: unknown): [number, number, number] | null {
  if (typeof raw !== 'string') return null;
  const m = RELEASE_RE.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `0.7.2` → `v0.7.2`; не выпуск → null. */
export function normalizeReleaseVersion(raw: unknown): string | null {
  const v = parseReleaseVersion(raw);
  return v ? `v${v[0]}.${v[1]}.${v[2]}` : null;
}

/** -1 — `a` старше, 0 — равны, 1 — `a` новее. Не выпуск с любой стороны → null (сравнивать нечего). */
export function compareReleaseVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseReleaseVersion(a);
  const y = parseReleaseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

function isoDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Ответ `GET /repos/<владелец>/gusvoice/releases/latest` (GitHub) → выпуск. Черновики и пред-выпуски GitHub в этот
 * адрес не отдаёт, но проверяем и сами: чужое зеркало может отдать что угодно. Метка не `vX.Y.Z` → null.
 */
export function parseLatestRelease(json: unknown): InstanceUpdateInfo['latest'] {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const version = normalizeReleaseVersion(r.tag_name);
  if (!version) return null;
  return { version, url: httpsUrl(r.html_url), publishedAt: isoDate(r.published_at) };
}

/** Метка образов из `.env`, как её записал хост: только безопасные символы, иначе считаем неизвестной. */
function cleanTag(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : null;
}

/** `run/status/updater.json` — служба обновления установлена. Не объект → службы нет. */
export function parseUpdaterMarker(json: unknown): InstanceUpdateInfo['updater'] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return { tag: cleanTag((json as Record<string, unknown>).tag) };
}

/**
 * Метка образов закреплена на конкретной версии (`TAG=v0.7.0`). Тогда скачивать новые образы бессмысленно — придёт
 * та же версия; менять `.env` панель не должна. `latest`, `master` и прочие плавающие метки — можно.
 *
 * 🔴 Шире, чем `RELEASE_RE`, и намеренно: это тот же шаблон, что у `tag_is_pinned` в `update.sh` — решение принимают
 * ОБА слоя, и разъехавшиеся шаблоны обещают в панели обновление, которое хост тут же отклоняет кодом `pinned-tag`
 * (нашёл Codex на `TAG=v12345.0.0`: у выпуска компоненты до 4 цифр, у метки — любые). Меняешь здесь — меняй там.
 */
const PINNED_TAG_RE = /^v?\d+\.\d+\.\d+$/;

export function isPinnedTag(tag: string | null): boolean {
  return tag !== null && PINNED_TAG_RE.test(tag);
}

const ERROR_CODES: readonly InstanceUpdateError[] = [
  'bad-request',
  'locked',
  'pinned-tag',
  'files',
  'pull',
  'backup',
  'backup-space',
  'restart',
  'storage-migrate',
  'health',
  'interrupted',
];

/**
 * `run/status/status.json` → статус. Неизвестное состояние → null (как будто обновлений не было); неизвестный шаг →
 * null; неизвестный код ошибки сохраняется, если похож на код (клиент покажет общий текст). «Идёт» дольше
 * `RUNNING_STALE_MS` → «прервалось»: процесс на хосте умер, не дописав статус, а кнопка иначе заблокирована навсегда.
 */
export function parseUpdateStatus(json: unknown, now: number): InstanceUpdateStatus | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const s = json as Record<string, unknown>;
  if (s.state !== 'running' && s.state !== 'done' && s.state !== 'failed') return null;
  const step = UPDATE_STEPS.includes(s.step as InstanceUpdateStep) ? (s.step as InstanceUpdateStep) : null;
  const error =
    typeof s.error === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(s.error)
      ? (ERROR_CODES.find((c) => c === s.error) ?? s.error)
      : null;
  const backup = typeof s.backup === 'string' && /^\.gusvoice-backups\/[A-Za-z0-9._-]{1,80}$/.test(s.backup) ? s.backup : null;
  const status: InstanceUpdateStatus = {
    state: s.state,
    step,
    requested: normalizeReleaseVersion(s.requested),
    version: cleanTag(s.version),
    startedAt: isoDate(s.startedAt),
    finishedAt: isoDate(s.finishedAt),
    error: s.state === 'failed' ? (error ?? 'interrupted') : null,
    backup,
  };
  if (status.state === 'running') {
    const started = status.startedAt ? Date.parse(status.startedAt) : NaN;
    if (!Number.isFinite(started) || now - started > RUNNING_STALE_MS) {
      return { ...status, state: 'failed', error: 'interrupted' };
    }
  }
  return status;
}

/** Нужно ли спрашивать сервер выпусков сейчас или хватит запомненного ответа. */
export function shouldCheckLatest(lastCheckedAt: number | null, now: number, force: boolean): boolean {
  if (lastCheckedAt === null) return true;
  const age = now - lastCheckedAt;
  return force ? age >= LATEST_FORCE_MIN_MS : age >= LATEST_CACHE_MS;
}

export interface UpdateDecisionInput {
  installed: string;
  latest: InstanceUpdateInfo['latest'];
  checkDisabled: boolean;
  updater: InstanceUpdateInfo['updater'];
  status: InstanceUpdateStatus | null;
  /** Возраст лежащего запроса в мс; null — запроса нет. */
  requestAgeMs: number | null;
}

/**
 * Можно ли нажать «Обновить» и если нет — почему. Порядок причин = что человеку важнее узнать первым: сборка
 * разработки объясняет всё остальное; идущее обновление (или невзятый запрос) важнее того, есть ли свежий выпуск;
 * «уже свежая» важнее «нет службы» и закреплённой метки, которые иначе пугали бы зря.
 */
export function decideUpdate(input: UpdateDecisionInput): Pick<
  InstanceUpdateInfo,
  'devBuild' | 'canUpdate' | 'blockedReason' | 'requestPending' | 'requestStuck'
> {
  const devBuild = parseReleaseVersion(input.installed) === null;
  const requestPending = input.requestAgeMs !== null;
  const requestStuck = requestPending && (input.requestAgeMs as number) > REQUEST_STUCK_MS;
  const base = { devBuild, requestPending, requestStuck };
  const blocked = (blockedReason: NonNullable<InstanceUpdateInfo['blockedReason']>) => ({
    ...base,
    canUpdate: false,
    blockedReason,
  });

  if (devBuild) return blocked('dev-build');
  if (input.status?.state === 'running') return blocked('running');
  if (requestPending) return blocked('pending');
  if (input.checkDisabled) return blocked('check-disabled');
  if (!input.latest) return blocked('unknown-latest');
  if ((compareReleaseVersions(input.latest.version, input.installed) ?? 0) <= 0) return blocked('up-to-date');
  if (!input.updater) return blocked('no-updater');
  if (isPinnedTag(input.updater.tag)) return blocked('pinned-tag');
  return { ...base, canUpdate: true, blockedReason: null };
}

/** Что писать в файл запроса. Хост принимает только `vX.Y.Z` и больше ничего из файла не читает. */
export function updateRequestLine(version: string): string | null {
  const v = normalizeReleaseVersion(version);
  return v ? `${v}\n` : null;
}
