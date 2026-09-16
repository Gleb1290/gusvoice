import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DeviceChoice, type DeviceInfoLike } from './deviceLoss.js';
import { createDeviceWatcher, type DeviceWatchDeps } from './deviceWatch.js';

const dev = (kind: string, deviceId: string, label = ''): DeviceInfoLike => ({ kind, deviceId, label });

const FULL = [
  dev('audioinput', 'default', 'По умолчанию — Микрофон'),
  dev('audioinput', 'mic-hs', 'Микрофон гарнитуры'),
  dev('audiooutput', 'default', 'По умолчанию — Динамики'),
  dev('audiooutput', 'hs', 'Наушники'),
  dev('audiooutput', 'spk', 'Динамики'),
];

/** Стенд: настройки в памяти, список устройств подменяемый, тосты и подписки записываются. */
function harness(start?: Partial<DeviceChoice>) {
  const choice: DeviceChoice = {
    inputDeviceId: '',
    outputDeviceId: '',
    cameraDeviceId: '',
    ...start,
  };
  const state = {
    choice,
    devices: [...FULL] as DeviceInfoLike[],
    notes: [] as { level: string; title: string }[],
    patches: [] as Partial<DeviceChoice>[],
    listeners: 0,
    fire: null as null | (() => void),
    throwOnEnumerate: false,
  };
  const deps: DeviceWatchDeps = {
    enumerateDevices: async () => {
      if (state.throwOnEnumerate) throw new Error('нет доступа');
      return state.devices;
    },
    getChoice: () => ({ ...state.choice }),
    applyPatch: (patch) => {
      state.patches.push(patch);
      Object.assign(state.choice, patch);
    },
    notify: (level, title) => state.notes.push({ level, title }),
    listenDeviceChange: (fn) => {
      state.listeners++;
      state.fire = fn;
      return () => {
        state.listeners--;
        state.fire = null;
      };
    },
  };
  return { state, watcher: createDeviceWatcher(deps) };
}

describe('проводка слежения за устройствами', () => {
  it('пропажа правит РОВНО потерянные поля и не задевает соседние', () => {
    const { state, watcher } = harness({ outputDeviceId: 'hs', inputDeviceId: 'mic-hs' });
    state.devices = FULL.filter((d) => d.deviceId !== 'hs'); // выдернули только наушники
    return watcher.check().then(() => {
      assert.deepEqual(state.patches, [{ outputDeviceId: '' }]);
      assert.equal(state.choice.inputDeviceId, 'mic-hs', 'микрофон не тронут');
      assert.equal(state.notes.length, 1);
      assert.match(state.notes[0].title, /Вывод звука/);
    });
  });

  it('🔴 в один тик не отбираем и не возвращаем одновременно', async () => {
    // Иначе правило возврата увидело бы запись, которую само же только что положило в память.
    const { state, watcher } = harness({ outputDeviceId: 'hs' });
    state.devices = FULL.filter((d) => d.deviceId !== 'hs');
    await watcher.check();
    assert.equal(state.patches.length, 1, 'ровно одна правка — отбор');

    // Устройство вернулось: возврат случается на СЛЕДУЮЩЕЙ проверке.
    state.devices = [...FULL];
    await watcher.check();
    assert.deepEqual(state.patches[1], { outputDeviceId: 'hs' });
    assert.match(state.notes[1].title, /вернулся/);
  });

  it('новая потеря откладывает уже возможный возврат до следующего тика', async () => {
    // Ловит удаление раннего return на настоящих одновременных кандидатах, а не на одной записи taken.
    const { state, watcher } = harness({ outputDeviceId: 'hs' });
    state.devices = FULL.filter((d) => d.deviceId !== 'hs');
    await watcher.check(); // запомнили пропавшие наушники

    state.choice.inputDeviceId = 'mic-hs';
    state.devices = FULL.filter((d) => d.deviceId !== 'mic-hs'); // наушники вернулись, микрофон пропал
    await watcher.check();
    assert.deepEqual(state.patches[1], { inputDeviceId: '' }, 'в этом тике только новая потеря');
    assert.equal(state.choice.outputDeviceId, '', 'возврат пока отложен');

    await watcher.check();
    assert.deepEqual(state.patches[2], { outputDeviceId: 'hs' }, 'возврат состоялся следующим тиком');
  });

  it('свежий ручной выбор сильнее нашей памяти', async () => {
    const { state, watcher } = harness({ outputDeviceId: 'hs' });
    state.devices = FULL.filter((d) => d.deviceId !== 'hs');
    await watcher.check();
    state.choice.outputDeviceId = 'spk'; // человек выбрал сам, пока гарнитуры не было
    state.devices = [...FULL];
    await watcher.check();
    assert.equal(state.choice.outputDeviceId, 'spk', 'его решение не перебито');
    assert.equal(state.patches.length, 1, 'второй правки не было вовсе');
  });

  it('🔴 отказ перечисления не меняет ничего', async () => {
    const { state, watcher } = harness({ outputDeviceId: 'hs' });
    state.throwOnEnumerate = true;
    await watcher.check();
    assert.deepEqual(state.patches, []);
    assert.deepEqual(state.notes, []);
  });

  it('устройство на месте — тишина', async () => {
    const { state, watcher } = harness({ outputDeviceId: 'hs' });
    await watcher.check();
    assert.deepEqual(state.patches, []);
    assert.deepEqual(state.notes, []);
  });

  it('🔴 повторный start не вешает второго слушателя', () => {
    const { state, watcher } = harness();
    const stop = watcher.start();
    watcher.start();
    watcher.start();
    assert.equal(state.listeners, 1, 'иначе каждая смена состава обрабатывалась бы трижды');
    stop();
    assert.equal(state.listeners, 0);
  });

  it('после остановки событие больше не обрабатывается', async () => {
    const { state, watcher } = harness({ outputDeviceId: 'hs' });
    const stop = watcher.start();
    stop();
    state.devices = FULL.filter((d) => d.deviceId !== 'hs');
    assert.equal(state.fire, null, 'подписки нет — дёргать некого');
    await watcher.check(); // ручная проверка по-прежнему работает
    assert.equal(state.patches.length, 1);
  });

  it('после остановки watcher можно запустить заново', () => {
    // Ловит залипший флаг started: React remount не должен навсегда отключать слежение.
    const { state, watcher } = harness();
    const stopFirst = watcher.start();
    stopFirst();
    const stopSecond = watcher.start();
    assert.equal(state.listeners, 1);
    stopSecond();
    assert.equal(state.listeners, 0);
  });
});

describe('🔴 регрессии, найденные Codex в моём же выносе', () => {
  it('возврат устройства — ХОРОШАЯ новость, а не предупреждение', () => {
    // Вынося проводку в фабрику, я потерял уровень тоста: боевой адаптер красил ОБА случая в
    // `warn`, и «наушники вернулись» показывалось человеку как тревога. Стенд этого не видел,
    // потому что записывал только заголовок — тест был слеп ровно к тому, что сломалось.
    const { state, watcher } = harness({ outputDeviceId: 'hs' });
    state.devices = FULL.filter((d) => d.deviceId !== 'hs');
    return watcher
      .check()
      .then(() => {
        state.devices = [...FULL];
        return watcher.check();
      })
      .then(() => {
        assert.equal(state.notes[0].level, 'warn', 'пропажа — предупреждение');
        assert.equal(state.notes[1].level, 'info', 'возврат — обычное сообщение');
      });
  });

  it('🔴 поздний СТАРЫЙ ответ не перебивает решение по свежему снимку', async () => {
    // Доказанная Codex гонка, не подозрение: события смены состава прилетают пачками, перечисление
    // асинхронное, и ответ первой проверки мог прийти последним — гарнитура оставалась
    // «пропавшей», хотя самый свежий снимок её подтверждал.
    const choice: DeviceChoice = { inputDeviceId: '', outputDeviceId: 'hs', cameraDeviceId: '' };
    const patches: Partial<DeviceChoice>[] = [];
    // Каждая проверка получает свой снимок и завершается только по нашей команде — так мы задаём
    // порядок завершения независимо от порядка запуска.
    const snapshots = [FULL.filter((d) => d.deviceId !== 'hs'), [...FULL]];
    const gates: (() => void)[] = [];
    let started = 0;
    const w = createDeviceWatcher({
      enumerateDevices: () =>
        new Promise<DeviceInfoLike[]>((resolve) => {
          const mine = started++;
          gates.push(() => resolve(snapshots[mine]!));
        }),
      getChoice: () => ({ ...choice }),
      applyPatch: (patch) => {
        patches.push(patch);
        Object.assign(choice, patch);
      },
      notify: () => {},
      listenDeviceChange: () => () => {},
    });

    const stale = w.check(); // старый снимок: гарнитуры нет
    const fresh = w.check(); // свежий снимок: гарнитура на месте
    gates[1]!(); // свежая проверка завершается ПЕРВОЙ
    await fresh;
    gates[0]!(); // а устаревшая — последней
    await stale;

    assert.deepEqual(patches, [], 'устаревший ответ не применён вовсе');
    assert.equal(choice.outputDeviceId, 'hs', 'выбор человека уцелел');
  });

  it('ошибка свежей проверки всё равно делает предыдущий снимок устаревшим', async () => {
    // Ловит epoch только на успешном ответе: поздняя старая «пропажа» опаснее пропущенного решения.
    const choice: DeviceChoice = { inputDeviceId: '', outputDeviceId: 'hs', cameraDeviceId: '' };
    const patches: Partial<DeviceChoice>[] = [];
    const gates: { resolve: (v: DeviceInfoLike[]) => void; reject: (e: Error) => void }[] = [];
    const w = createDeviceWatcher({
      enumerateDevices: () =>
        new Promise<DeviceInfoLike[]>((resolve, reject) => {
          gates.push({ resolve, reject });
        }),
      getChoice: () => ({ ...choice }),
      applyPatch: (patch) => patches.push(patch),
      notify: () => {},
      listenDeviceChange: () => () => {},
    });

    const stale = w.check();
    const fresh = w.check();
    gates[1]!.reject(new Error('временный отказ'));
    await fresh;
    gates[0]!.resolve(FULL.filter((d) => d.deviceId !== 'hs'));
    await stale;
    assert.deepEqual(patches, [], 'старый снимок не оживает после отказа более свежего');
  });
});
