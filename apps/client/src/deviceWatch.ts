import { getAudioSettings, setAudioSettings } from './audioSettings';
import {
  type DeviceChoice,
  type DeviceInfoLike,
  deviceLabel,
  KIND_NAME,
  lostDevices,
  restorableDevices,
} from './deviceLoss';
import { toast } from './toast';

/**
 * Слежение за составом устройств (#131): выдернул наушники или микрофон — приложение переходит на
 * то, что осталось, вместо того чтобы молча онеметь.
 *
 * 🔴 **Переключаем НАСТРОЙКУ, а не трек.** Живое переключение устройства в комнате уже написано и
 * висит на изменении настроек (`VoiceConnection`, `switchActiveDevice`). Городить рядом второй путь
 * к тому же треку — это ровно то, чем нас однажды укусил звук стрима (#71): две системы дёргали
 * одну громкость и перебивали друг друга. Здесь достаточно сказать «устройство теперь системное».
 *
 * ⚠️ Отобранный выбор ПОМНИМ на время сессии: воткнули ту же гарнитуру обратно — вернём её сами.
 * Это не самовольство: возвращаем ровно то, что человек выбирал, и только если он с тех пор не
 * выбрал что-то другое руками. А вот НОВОЕ устройство не трогаем никогда — чужой выбор.
 *
 * ⚠️ Всё, что ходит наружу, — через `deps` (по разбору Codex): иначе проводку нечем проверить, а
 * проверять там есть что — точность правки настроек, память, приоритет потери над возвратом.
 */
export interface DeviceWatchDeps {
  enumerateDevices: () => Promise<DeviceInfoLike[]>;
  getChoice: () => DeviceChoice;
  applyPatch: (patch: Partial<DeviceChoice>) => void;
  /**
   * ⚠️ Уровень — часть контракта, а не украшение. При выносе я его потерял, и `browserDeps`
   * красил ОБА случая в предупреждение: возврат гарнитуры показывался человеку как тревога.
   * Поймал Codex; его же стенд этого не видел, потому что записывал только заголовок.
   */
  notify: (level: 'warn' | 'info', title: string, text: string) => void;
  /** Подписка на смену состава. Возвращает отписку. */
  listenDeviceChange: (fn: () => void) => () => void;
}

export interface DeviceWatcher {
  /** Одна проверка. Отдельно от `start` — ради тестов и первичного прогона. */
  check: () => Promise<void>;
  start: () => () => void;
}

export function createDeviceWatcher(deps: DeviceWatchDeps): DeviceWatcher {
  /** Что мы у человека отобрали в этой сессии. Не переживает перезапуск — и не должно. */
  const taken: Partial<Record<keyof DeviceChoice, string>> = {};
  let unlisten: (() => void) | null = null;
  /**
   * 🔴 Номер поколения проверки. Перечисление асинхронное, а `devicechange` прилетает пачками:
   * выдернул разветвитель — событий несколько подряд. Без этого счётчика ПОЗДНО пришедший СТАРЫЙ
   * ответ перебивал решение, принятое по свежему снимку: Codex воспроизвёл это на внедрённых
   * зависимостях, а не предположил — гарнитура оставалась «пропавшей», хотя последний снимок её
   * подтверждал.
   */
  let epoch = 0;

  async function check(): Promise<void> {
    const mine = ++epoch;
    let devices: DeviceInfoLike[];
    try {
      devices = await deps.enumerateDevices();
    } catch {
      return; // перечисление не удалось — это не повод отбирать настройки
    }
    // Пока мы ждали, началась более свежая проверка. Её снимок новее нашего, и решать должна она:
    // применить устаревший результат хуже, чем не применить никакого.
    if (mine !== epoch) return;

    const lost = lostDevices(deps.getChoice(), devices);
    if (lost.length > 0) {
      const patch: Partial<DeviceChoice> = {};
      for (const l of lost) {
        taken[l.field] = l.id;
        patch[l.field] = '';
      }
      deps.applyPatch(patch);
      for (const l of lost) {
        // Что переключили и куда — обязательно: без этого человек слышит себя из другого микрофона
        // и не понимает, почему. Имя пропавшего устройства уже не достать (его нет в списке),
        // поэтому называем ВИД и то, куда переехали.
        deps.notify(
          'warn',
          `${KIND_NAME[l.kind]} отключился`,
          `Переключил на системное по умолчанию (${deviceLabel(devices, l.kind, 'default')}). Выбрать другое — в настройках.`,
        );
      }
      // ⚠️ Возврат разбираем СЛЕДУЮЩЕЙ проверкой. В один тик и отбирать, и возвращать — каша: в
      // `taken` только что легло новое, и правило возврата увидело бы собственную запись.
      return;
    }

    for (const b of restorableDevices(deps.getChoice(), devices, taken)) {
      deps.applyPatch({ [b.field]: b.id });
      delete taken[b.field];
      deps.notify('info', `${KIND_NAME[b.kind]} вернулся`, `Вернул ваш выбор: ${deviceLabel(devices, b.kind, b.id)}.`);
    }
  }

  function start(): () => void {
    // Идемпотентно: второй вызов не должен вешать второго слушателя — иначе каждая смена состава
    // обрабатывалась бы дважды, а это два тоста и две правки настроек подряд.
    if (unlisten) return () => {};
    unlisten = deps.listenDeviceChange(() => void check());
    // Первая проверка сразу: устройство могли выдернуть, пока приложение было закрыто, и тогда в
    // настройках лежит ссылка на то, чего давно нет.
    void check();
    return () => {
      unlisten?.();
      unlisten = null;
    };
  }

  return { check, start };
}

/** Боевые зависимости: браузер, настройки приложения и тосты. */
function browserDeps(): DeviceWatchDeps | null {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices || !md.addEventListener) return null;
  return {
    enumerateDevices: () => md.enumerateDevices(),
    getChoice: () => {
      const s = getAudioSettings();
      return {
        inputDeviceId: s.inputDeviceId,
        outputDeviceId: s.outputDeviceId,
        cameraDeviceId: s.cameraDeviceId,
      };
    },
    applyPatch: (patch) => setAudioSettings({ ...getAudioSettings(), ...patch }),
    notify: (level, title, text) => toast(level, title, text),
    listenDeviceChange: (fn) => {
      md.addEventListener('devicechange', fn);
      return () => md.removeEventListener('devicechange', fn);
    },
  };
}

let live: DeviceWatcher | null = null;

/**
 * Включить слежение. Зовётся из корня приложения, а не из голосового соединения — устройство
 * выдёргивают и когда в канале не сидят, и тогда выбор тоже становится сломанным.
 */
export function startDeviceWatch(): () => void {
  if (!live) {
    const deps = browserDeps();
    if (!deps) return () => {};
    live = createDeviceWatcher(deps);
  }
  return live.start();
}
