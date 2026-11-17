import { useEffect } from 'react';
import { create } from 'zustand';
import { Goose, type GoosePose } from './Goose';
import {
  initialSplashView,
  runSplashFlow,
  splashIntent,
  type SplashDeps,
  type SplashIntent,
  type SplashUpdate,
  type SplashView,
} from '../splashFlow';
import { endShareBeforeExit, markJustUpdated, peekSplashMarkers, takeSplashMarkers, unmarkJustUpdated, updateLog } from '../updater';
import { isDesktop } from '../hotkeys';
import { appVersion } from '../desktopWindow';

/**
 * Заставка при запуске десктопа (как у Discord, 15.10): окно `index.html?window=splash` 300×340
 * (`tauri.windows.conf.json`), гусь, строка этапа и полоса. Ход этапов — `splashFlow.ts`; здесь только
 * отрисовка и привязка к Tauri (плагин обновлений + команды `gv_splash_*` из `splash.rs`).
 *
 * Полоса и её классы — те же, что у карточки обновления в приложении (`UpdatePanel`, `.update-progress`).
 * Поза гуся меняется по этапу; только готовые картинки маскота (`Goose`).
 */
export const useSplash = create<SplashView & { set: (v: SplashView) => void }>((set) => ({
  // Первый кадр — по меткам запуска (26.10): перезапуск ради обновления сразу «Скачиваю…», первый запуск
  // новой версии — «Запускаю…», без мелькания «Проверяю обновления…».
  ...initialSplashView(peekSplashMarkers(), Date.now()),
  set: (v) => set(v),
}));

const POSE: Record<SplashView['stage'], GoosePose> = {
  checking: 'admin',
  starting: 'wave',
  downloading: 'admin',
  installing: 'admin',
};

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function core(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}
function call(cmd: string): Promise<unknown> {
  return core()?.invoke(cmd).catch(() => null) ?? Promise.resolve(null);
}

/**
 * Проверка фида. `GV_UPDATE_TEST=downgrade` (только пробная сборка, `splash.rs`) — откат на выпущенную версию.
 * С plugin-updater 2.12 `allowDowngrades` у `check()` убран: разрешает откат сам Rust при сборке плагина
 * (`lib.rs`, `default_version_comparator`), здесь режим только пишется в журнал.
 */
async function checkFeed(): Promise<SplashUpdate | null> {
  const testMode = (await call('gv_update_test_mode')) as string | null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  updateLog('splash', `check${testMode === 'downgrade' ? ' (downgrade test)' : ''}: ${update?.available ? `found v${update.version}` : 'none'}`);
  return update?.available ? update : null;
}

/** Разметка запуска: метки снимаются сразу (один раз на запуск), версия — установленная сборка. */
async function launchIntent(): Promise<SplashIntent> {
  const markers = takeSplashMarkers();
  const intent = splashIntent(markers, await appVersion(), Date.now());
  updateLog('splash', `intent ${JSON.stringify(intent)} markers ${JSON.stringify(markers)}`);
  return intent;
}

function tauriDeps(): SplashDeps {
  return {
    intent: launchIntent,
    check: checkFeed,
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    show: (v) => useSplash.getState().set(v),
    ping: () => void call('gv_splash_ping'),
    beforeInstall: async (version) => {
      await endShareBeforeExit();
      markJustUpdated(version);
      updateLog('splash', `install v${version}`);
    },
    installFailed: () => {
      updateLog('splash', 'install failed');
      unmarkJustUpdated();
    },
    done: () => {
      updateLog('splash', 'done');
      return call('gv_splash_done').then(() => undefined);
    },
  };
}

let started = false;

export function SplashScreen() {
  const { stage, version, progress } = useSplash();

  useEffect(() => {
    // Ход — один раз на окно; в вебе (не Tauri) заставка только рисуется.
    if (started || !isDesktop()) return;
    started = true;
    void runSplashFlow(tauriDeps());
  }, []);

  const pct = progress === null ? null : Math.round(progress * 100);
  const title =
    stage === 'checking'
      ? 'Проверяю обновления…'
      : stage === 'starting'
        ? 'Запускаю…'
        : stage === 'downloading'
          ? `Скачиваю обновление ${version ?? ''}`.trim()
          : 'Устанавливаю…';
  const sub =
    stage === 'downloading' ? `${pct ?? 0} %` : stage === 'installing' ? 'приложение перезапустится само' : ' ';

  return (
    <div className={`splash splash-${stage}`} role="status" aria-live="polite">
      <div className="splash-goose">
        <Goose key={POSE[stage]} pose={POSE[stage]} size={120} className="splash-goose-img" />
      </div>
      <div className="splash-title">{title}</div>
      <div className="splash-sub">{sub}</div>
      <div className="update-progress splash-progress">
        {stage === 'downloading' ? (
          <div className="update-progress-bar splash-bar-fill" style={{ width: `${pct ?? 0}%` }}>
            <span className="update-shimmer" />
          </div>
        ) : (
          <div className="update-progress-bar indeterminate" />
        )}
      </div>
    </div>
  );
}
