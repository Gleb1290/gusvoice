import type { InstanceUpdateInfo, InstanceUpdateStep } from '@gusvoice/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { updateWatchOutcome } from '../instanceUpdateWatch';
import { toast, toastError } from '../toast';

/**
 * «Версия и обновление» во вкладке «Инстанс» (О2б). Сервер обновляет себя не сам: бэкенд кладёт запрос, служба на
 * хосте запускает `update.sh --from-panel` и пишет шаги, а мы их опрашиваем. Во время перезапуска бэкенд недоступен —
 * это нормально, карточка ждёт и подключается сама.
 */

const STEPS: { id: InstanceUpdateStep; label: string }[] = [
  { id: 'files', label: 'Скачиваем файлы стека' },
  { id: 'pull', label: 'Скачиваем новые образы' },
  { id: 'backup', label: 'Копируем базу' },
  { id: 'restart', label: 'Перезапускаем сервисы' },
  { id: 'health', label: 'Ждём, пока сервер поднимется' },
];

const ERROR_TEXT: Record<string, string> = {
  'bad-request': 'Сервер не понял запрос из панели. Попробуйте ещё раз.',
  locked: 'На сервере уже идёт обновление, запущенное вручную. Дождитесь его окончания.',
  'pinned-tag':
    'В .env закреплена конкретная версия (TAG) — по ней новые образы не скачать. Поменяйте TAG на latest и запустите ./update.sh на сервере.',
  files: 'Не скачались файлы стека — нет связи с GitHub? Работает прежняя версия.',
  pull: 'Не скачались новые образы. Работает прежняя версия.',
  backup: 'Не получилось скопировать базу, и обновление остановлено. Работает прежняя версия.',
  'backup-space': 'На диске не хватает места для копии базы, и обновление остановлено. Работает прежняя версия.',
  restart: 'Сервисы не перезапустились.',
  'storage-migrate':
    'Сервер обновился, но старые файлы не перенеслись в новое хранилище: старые аватарки и вложения пока не видны. Ничего не потеряно — причина и повтор: ./update.sh --images-only на сервере.',
  health: 'Сервер не поднялся за 5 минут после перезапуска.',
  interrupted: 'Обновление прервалось — возможно, сервер перезагрузился посреди шага. Запустите ещё раз.',
};

const POLL_MS = 2000;
/** Столько бэкенд может молчать во время обновления, прежде чем мы скажем, что что-то не так. */
const QUIET_LIMIT_MS = 5 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

function timeText(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function CopyCommand({ command }: { command: string }) {
  return (
    <div className="inst-update-cmd">
      <code>{command}</code>
      <button
        type="button"
        className="link"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => toast('success', 'Скопировано'),
            () => toast('error', 'Не удалось скопировать'),
          )
        }
      >
        Скопировать
      </button>
    </div>
  );
}

export function InstanceUpdateCard() {
  const [info, setInfo] = useState<InstanceUpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Ждём конца обновления (переживает недоступность бэкенда). `baseline` — время начала ПРЕДЫДУЩЕГО, уже законченного
   * обновления: пока в статусе оно, итог не наш, даже если запрос уже исчез (хост его забрал, а новый статус ещё не
   * дописан) — иначе мы показали бы прошлый «Обновлено» как результат этой кнопки.
   */
  const [watch, setWatch] = useState<{ since: number; baseline: string | null } | null>(null);
  const [quietSince, setQuietSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const watching = watch !== null;

  const beginWatch = useCallback((current: InstanceUpdateInfo | null) => {
    if (watchRef.current) return;
    const s = current?.status;
    const next = { since: Date.now(), baseline: s && s.state !== 'running' ? s.startedAt : null };
    watchRef.current = next;
    setWatch(next);
  }, []);

  const load = useCallback(
    async (refresh = false) => {
      try {
        const next = await api.adminInstanceUpdate(refresh);
        setInfo(next);
        setQuietSince(null);
        const s = next.status;
        const w = watchRef.current;
        if (!w) {
          if (s?.state === 'running' || next.requestPending) beginWatch(next);
          return;
        }
        const outcome = updateWatchOutcome({ baseline: w.baseline, status: s, requestPending: next.requestPending });
        if (outcome === 'wait') return;
        watchRef.current = null;
        setWatch(null);
        if (outcome === 'done') toast('success', `Сервер обновлён${s?.version ? ` до ${s.version}` : ''}`);
        else toast('error', 'Обновление не удалось — подробности во вкладке «Инстанс»');
      } catch (e) {
        // Во время перезапуска бэкенд не отвечает — это ожидаемо, не ошибка.
        if (watchRef.current) setQuietSince((t) => t ?? Date.now());
        else toastError(e);
      }
    },
    [beginWatch],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!watching) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [watching, load]);

  async function refresh() {
    setBusy(true);
    await load(true);
    setBusy(false);
  }

  async function start(version: string) {
    if (
      !window.confirm(
        `Обновить сервер до ${version}?\n\nВо время перезапуска (обычно около минуты) чат и голос прервутся у всех, потом переподключатся сами. Перед перезапуском сервер сохранит копию базы.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.adminStartInstanceUpdate(version);
      beginWatch(info);
      await load();
    } catch (e) {
      toastError(e, 'Не удалось начать обновление');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return (
      <div className="setup-check inst-update" role="status">
        <span className="muted">Проверяем версию…</span>
      </div>
    );
  }

  const status = info.status;
  const running = status?.state === 'running';
  const currentStep = running ? STEPS.findIndex((s) => s.id === status?.step) : -1;
  const recent = (iso: string | null) => !!iso && now - Date.parse(iso) < RECENT_MS;
  const quietTooLong = quietSince !== null && now - quietSince > QUIET_LIMIT_MS;
  // Запрос забран, а о ходе хост не пишет уже минуту — он умер между шагами или пишет не туда.
  const silentHost =
    watch !== null && !running && !info.requestPending && quietSince === null && now - watch.since > 60_000;

  return (
    <div className="setup-check inst-update">
      <div className="inst-update-head">
        <div>
          <div className="setup-check-title">Версия сервера</div>
          <div className="setup-check-text">
            {info.devBuild ? (
              <>
                Сборка разработки <code>{info.installed}</code> — такой сервер обновляется не из панели.
              </>
            ) : (
              <>
                Установлена <b>{info.installed}</b>
                {info.latest && info.blockedReason !== 'up-to-date' && info.latest.version !== info.installed && (
                  <>
                    {' · '}доступна <b>{info.latest.version}</b>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        {!info.devBuild && !info.checkDisabled && !watching && (
          <button type="button" className="link" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Проверяем…' : 'Проверить снова'}
          </button>
        )}
      </div>

      {watching && (
        <ol className="inst-update-steps" aria-live="polite">
          {STEPS.map((s, i) => {
            const state = currentStep < 0 ? 'todo' : i < currentStep ? 'done' : i === currentStep ? 'now' : 'todo';
            return (
              <li key={s.id} className={state}>
                {s.label}
              </li>
            );
          })}
        </ol>
      )}
      {watching && quietSince !== null && !quietTooLong && (
        <div className="setup-check-result warn" role="status">
          Перезапускаемся… Страница подключится сама.
        </div>
      )}
      {watching && quietTooLong && (
        <div className="setup-check-result fail" role="alert">
          Сервер не отвечает дольше 5 минут. Что с ним, видно на сервере:
          <CopyCommand command="journalctl -u gusvoice-update -n 100" />
        </div>
      )}
      {watching && info.requestStuck && (
        <div className="setup-check-result fail" role="alert">
          Служба обновления на сервере не берёт запрос. Перезапустите её — в папке GusVoice на сервере:
          <CopyCommand command="sudo ./update.sh --install-updater" />
        </div>
      )}
      {silentHost && (
        <div className="setup-check-result fail" role="alert">
          Сервер забрал запрос, но не сообщает, как идёт обновление. Что с ним, видно на сервере:
          <CopyCommand command="journalctl -u gusvoice-update -n 100" />
        </div>
      )}
      {watching && info.requestPending && !info.requestStuck && (
        <div className="setup-check-result warn" role="status">
          Запрос отправлен, ждём сервер…
        </div>
      )}

      {!watching && status?.state === 'done' && recent(status.finishedAt) && (
        <div className="setup-check-result ok" role="status">
          Обновлено{status.version ? ` до ${status.version}` : ''} · {timeText(status.finishedAt)}
        </div>
      )}
      {!watching && status?.state === 'failed' && recent(status.finishedAt ?? status.startedAt) && (
        <div className="setup-check-result fail" role="alert">
          {ERROR_TEXT[status.error ?? ''] ?? 'Обновление не удалось.'}
          {(status.error === 'restart' || status.error === 'health' || !ERROR_TEXT[status.error ?? '']) && (
            <>
              {' '}
              Подробности на сервере:
              <CopyCommand command="journalctl -u gusvoice-update -n 100" />
            </>
          )}
          {status.backup && (
            <div className="muted">
              Копия базы до обновления: <code>{status.backup}</code>
            </div>
          )}
        </div>
      )}

      {!watching && info.blockedReason === 'up-to-date' && (
        <div className="setup-check-result ok">Это последняя версия.</div>
      )}
      {!watching && info.blockedReason === 'check-disabled' && (
        <div className="muted">Проверка новых версий выключена на сервере (GV_RELEASES_URL).</div>
      )}
      {!watching && info.blockedReason === 'unknown-latest' && (
        <div className="setup-check-result warn">
          {info.checkFailed ? 'Не удалось узнать о новых версиях — нет связи с GitHub?' : 'Сведений о выпусках пока нет.'}
        </div>
      )}
      {!watching && info.latest && info.latest.version !== info.installed && info.blockedReason !== 'up-to-date' && info.latest.url && (
        <div className="setup-links">
          <a className="inst-update-notes" href={info.latest.url} target="_blank" rel="noreferrer">
            Что нового в {info.latest.version}
          </a>
        </div>
      )}
      {!watching && info.blockedReason === 'no-updater' && (
        <div className="reg-policy-note">
          Кнопка обновления на этом сервере не включена. Включите её один раз — в папке GusVoice на сервере:
          <CopyCommand command="sudo ./update.sh --install-updater" />
          Или обновите вручную там же: <code>./update.sh</code>
        </div>
      )}
      {!watching && info.blockedReason === 'pinned-tag' && (
        <div className="reg-policy-note">
          В .env закреплена версия образов <code>TAG={info.updater?.tag}</code>, поэтому обновить из панели нельзя. Поменяйте
          TAG на <code>latest</code> и запустите на сервере <code>./update.sh</code>.
        </div>
      )}
      {!watching && info.canUpdate && info.latest && (
        <div className="smtp-actions">
          <button type="button" className="auth-cta" disabled={busy} onClick={() => void start(info.latest!.version)}>
            Обновить до {info.latest.version}
          </button>
          <span className="muted">Чат и голос прервутся примерно на минуту</span>
        </div>
      )}
    </div>
  );
}
