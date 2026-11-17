import { lazy, Suspense, useState } from 'react';
import { launchStorage, readLaunchSeen, writeLaunchSeen } from '../economy';
import { launchNoticeDue, type GamesLaunchNotice as Notice } from '../gamesLaunchRules';
import { registerBuiltinSound } from '../sounds';
import { useStore } from '../store';

/**
 * Объявление «Игры пришли в голос» (ГусКоины 2, решения владельца 29.10, пп. 8–9, 12–14) — после «Запустить игры»
 * (`EconomyPanel.tsx`, бэкенд `gameLaunch.ts`). С 29.10 вместо карточки — сцена «БУМ» (`GamesLaunchScene.tsx`: море,
 * залп, палуба, знакомство с командой, карточка в финале); здесь — только хост, решающий, КОМУ и КОГДА её показать.
 *
 * Модуль ленивый (как «Итоги»): `MainLayout` монтирует хост (`GamesLaunchHost`, экспорт по умолчанию) только когда
 * сцена может понадобиться и не поверх других окон, — так у раскладки нет ни одного нового статического импорта
 * (её проверки держат закрытый перечень). Сама сцена — ЕЩЁ один ленивый кусок (кадры ~0,5 МБ качаются только при показе).
 * Что показать: событие `games.launched` (`sockets.ts` → `gamesLaunchNotice` в сторе) — сразу; иначе при входе на
 * запущенный сервер, пока сцену там не видели (`gamesLaunchRules.launchNoticeDue`, окна «7 суток» больше нет — владелец
 * 29.10, п. 14); повтор из «Активностей» («Что это у нас?», `replay`) — всегда и без строки о подарке. Закрытие ЛЮБЫМ
 * способом = «видел» (`localStorage`, `writeLaunchSeen`; `sessionSkipped` — страховка на сессию, если хранилище
 * недоступно). «Запустить» в финале открывает «Активности» сервера. Горн, выстрелы и рында — в самой сцене.
 */
const ART: Record<string, string> = import.meta.glob<string>('../assets/launch/ship.{png,webp,svg}', {
  eager: true,
  import: 'default',
  query: '?url',
});

/**
 * Настоящая запись горна (владелец выберет): файл `assets/sounds/games-launch.mp3` (или `.ogg`) подхватывается сборкой и
 * подменяет синтез `gamesLaunch` в `sounds.ts` — логику трогать не нужно.
 * С 29.10 тот же файл регистрирует и общий `builtinSounds.ts` (та же ссылка ассета — повтор безвреден); здесь оставлено,
 * чтобы ленивая карточка не зависела от порядка загрузки модулей (регистрацию закрепляет тест R343).
 */
const HORN: Record<string, string> = import.meta.glob<string>('../assets/sounds/games-launch.{mp3,ogg}', {
  eager: true,
  import: 'default',
  query: '?url',
});
const hornFile = HORN['../assets/sounds/games-launch.mp3'] ?? HORN['../assets/sounds/games-launch.ogg'];
if (hornFile) registerBuiltinSound('gamesLaunch', hornFile);

function shipUrl(): string | null {
  for (const ext of ['png', 'webp', 'svg']) {
    const url = ART[`../assets/launch/ship.${ext}`];
    if (url) return url;
  }
  return null;
}

const GamesLaunchScene = lazy(() => import('./GamesLaunchScene'));

/** Закрытые в этой сессии серверы — если `localStorage` недоступен, карточка не всплывёт второй раз до перезагрузки. */
const sessionSkipped = new Set<string>();

/**
 * Хост карточки: по событию (не тому, кто уже видел; запустивший — как все) или сама при входе
 * на текущий сервер. Ворота «не поверх других окон» держит `MainLayout`, монтируя хост.
 */
export default function GamesLaunchHost() {
  const requested = useStore((s) => s.gamesLaunchNotice);
  const setRequested = useStore((s) => s.setGamesLaunchNotice);
  const serverId = useStore((s) => s.bootstrap?.server.id ?? null);
  const view = useStore((s) => (s.bootstrap ? s.economy[s.bootstrap.server.id] : undefined));
  const [, rerender] = useState(0);
  const store = launchStorage();
  // Повтор из «Активностей» — всегда (и без подарка: его ставит сама кнопка); событие — тем, кто сцену ещё не видел.
  const fromEvent =
    requested && (requested.replay || (!sessionSkipped.has(requested.serverId) && !readLaunchSeen(store, requested.serverId)))
      ? requested
      : null;
  const auto =
    serverId && view?.enabled && view.gamesEnabled && !sessionSkipped.has(serverId)
      ? launchNoticeDue(serverId, view.gamesLaunch, readLaunchSeen(store, serverId))
      : null;
  const notice = fromEvent ?? auto;
  const cardView = useStore((s) => (notice ? s.economy[notice.serverId] : undefined));
  if (!notice) return null;
  return (
    <GamesLaunchCard
      key={`${notice.serverId}:${notice.replay ? 'replay' : 'launch'}`}
      notice={notice}
      iconUrl={cardView?.iconUrl ?? null}
      onClose={() => {
        sessionSkipped.add(notice.serverId);
        setRequested(null);
        rerender((n) => n + 1);
      }}
    />
  );
}

/** Экран загрузки, пока едет кусок сцены (те же классы, что у загрузки кадров в `GamesLaunchScene`). */
function LaunchLoading({ onClose }: { onClose: () => void }) {
  const ship = shipUrl();
  return (
    <div className="boom-overlay boom-loading" role="dialog" aria-modal="true" aria-label="Игры пришли в голос">
      {ship && <img className="boom-loading-ship" src={ship} alt="" />}
      <p className="boom-loading-text">Поднимаем паруса…</p>
      <button type="button" className="boom-skip on" onClick={onClose}>
        Пропустить
      </button>
    </div>
  );
}

/** Показ сцены: закрытие = «видел», «Запустить» — в «Активности» сервера сцены. */
function GamesLaunchCard({
  notice,
  iconUrl,
  onClose,
}: {
  notice: Notice;
  iconUrl: string | null;
  onClose: () => void;
}) {
  const openActivities = useStore((s) => s.openActivities);
  const deafened = useStore((s) => s.selfDeafened);

  function close() {
    writeLaunchSeen(launchStorage(), notice.serverId);
    onClose();
  }
  function launch() {
    close();
    openActivities({ serverId: notice.serverId, view: 'list' });
  }

  return (
    <Suspense fallback={<LaunchLoading onClose={close} />}>
      <GamesLaunchScene
        mine={notice.replay ? 0 : notice.mine}
        iconUrl={iconUrl}
        ship={shipUrl()}
        sound={!deafened}
        onClose={close}
        onLaunch={launch}
      />
    </Suspense>
  );
}
