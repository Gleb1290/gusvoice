import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DeviceChoice, deviceLabel, lostDevices, restorableDevices } from './deviceLoss.js';

const choice = (p: Partial<DeviceChoice> = {}): DeviceChoice => ({
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  ...p,
});

const dev = (kind: string, deviceId: string, label = '') => ({ kind, deviceId, label });

/** Обычный набор: системные псевдо-устройства плюс одна настоящая гарнитура. */
const NORMAL = [
  dev('audioinput', 'default', 'По умолчанию — Микрофон (Realtek)'),
  dev('audioinput', 'mic-realtek', 'Микрофон (Realtek)'),
  dev('audioinput', 'mic-hs', 'Микрофон гарнитуры'),
  dev('audiooutput', 'default', 'По умолчанию — Динамики'),
  dev('audiooutput', 'spk', 'Динамики'),
  dev('audiooutput', 'hs', 'Наушники'),
  dev('videoinput', 'cam', 'Веб-камера'),
];

describe('пропажа устройства', () => {
  it('выдернутая гарнитура считается потерянной', () => {
    const gone = NORMAL.filter((d) => d.deviceId !== 'hs' && d.deviceId !== 'mic-hs');
    const lost = lostDevices(choice({ outputDeviceId: 'hs', inputDeviceId: 'mic-hs' }), gone);
    assert.deepEqual(
      lost.map((l) => l.field).sort(),
      ['inputDeviceId', 'outputDeviceId'],
    );
  });

  it('пока устройство на месте — ничего не отбираем', () => {
    assert.deepEqual(lostDevices(choice({ outputDeviceId: 'hs' }), NORMAL), []);
  });

  it('🔴 системные псевдо-устройства пропасть не могут', () => {
    // «', 'default', 'communications» — это не железки, а указатели «то, что система считает
    // основным». Считать их потерянными значило бы сбрасывать выбор при каждом втыкании чего угодно.
    for (const id of ['', 'default', 'communications']) {
      assert.deepEqual(lostDevices(choice({ outputDeviceId: id }), []), [], `id «${id}» отобрали зря`);
    }
  });

  it('системные псевдо-устройства не отбираются и по авторитетному списку', () => {
    // Ловит удаление special-case: пустой список скрывает такую ошибку ранним выходом.
    const anotherOutput = [dev('audiooutput', 'spk', 'Динамики')];
    for (const id of ['', 'default', 'communications']) {
      assert.deepEqual(lostDevices(choice({ outputDeviceId: id }), anotherOutput), [], `id «${id}» отобрали зря`);
    }
  });

  it('одноимённый микрофон не притворяется выбранным выводом звука', () => {
    // Ловит потерю проверки kind: deviceId разных видов не обязаны быть глобально уникальны.
    const devices = [dev('audiooutput', 'spk'), dev('audioinput', 'shared-id')];
    assert.deepEqual(lostDevices(choice({ outputDeviceId: 'shared-id' }), devices).map((l) => l.field), [
      'outputDeviceId',
    ]);
  });

  it('🔴 ПУСТОЙ список устройств не означает пропажу', () => {
    // enumerateDevices отдаёт пустоту и когда доступ к медиа отозван, и на короткой перестройке
    // звукового стека. Сбросить по такому поводу — отобрать настройки за чужую икоту.
    assert.deepEqual(lostDevices(choice({ outputDeviceId: 'hs', inputDeviceId: 'mic-hs' }), []), []);
  });

  it('пустой список ОДНОГО вида не задевает другие виды', () => {
    // Пропали все выводы, микрофоны на месте — про микрофон вывод ничего не говорит.
    const noOutputs = NORMAL.filter((d) => d.kind !== 'audiooutput');
    const lost = lostDevices(choice({ outputDeviceId: 'hs', inputDeviceId: 'mic-gone' }), noOutputs);
    assert.deepEqual(lost.map((l) => l.field), ['inputDeviceId']);
  });
});

describe('возврат устройства', () => {
  it('воткнули обратно ту же гарнитуру — вернули выбор человека', () => {
    const back = restorableDevices(choice(), NORMAL, { outputDeviceId: 'hs' });
    assert.deepEqual(back.map((b) => b.id), ['hs']);
  });

  it('🔴 человек уже выбрал сам — его решение сильнее нашей памяти', () => {
    // Иначе мы перебили бы свежий осознанный выбор воспоминанием о том, что отобрали полчаса назад.
    const back = restorableDevices(choice({ outputDeviceId: 'spk' }), NORMAL, { outputDeviceId: 'hs' });
    assert.deepEqual(back, []);
  });

  it('🔴 НОВОЕ устройство не подставляем никогда', () => {
    // Воткнули гарнитуру, которую человек не выбирал, — это его выбор, а не наш.
    assert.deepEqual(restorableDevices(choice(), NORMAL, {}), []);
  });

  it('устройство ещё не вернулось — ждём', () => {
    const without = NORMAL.filter((d) => d.deviceId !== 'hs');
    assert.deepEqual(restorableDevices(choice(), without, { outputDeviceId: 'hs' }), []);
  });

  it('одноимённое устройство другого вида не считается вернувшимся', () => {
    // Ловит возврат не той железки при совпавших deviceId у разных MediaDeviceKind.
    const back = restorableDevices(choice(), [dev('audioinput', 'shared-id')], { outputDeviceId: 'shared-id' });
    assert.deepEqual(back, []);
  });
});

describe('имя устройства для человека', () => {
  it('берётся метка системы', () => {
    assert.equal(deviceLabel(NORMAL, 'audiooutput', 'hs'), 'Наушники');
  });

  it('метки нет (доступ не выдан) — говорим честно, а не пустыми кавычками', () => {
    assert.equal(deviceLabel([dev('audiooutput', 'hs', '')], 'audiooutput', 'hs'), 'системное по умолчанию');
    assert.equal(deviceLabel([], 'audiooutput', 'hs'), 'системное по умолчанию');
  });
});

describe('🔴 доступ к микрофону ещё не выдан', () => {
  /**
   * Ровно то, что вернул живой браузер без выданного доступа (замерено 06.09, не придумано):
   * НЕ пустой список, а по одной заглушке на вид с пустыми `deviceId` и `label`.
   */
  const NO_PERMISSION = [dev('audioinput', '', ''), dev('audiooutput', '', '')];

  it('заглушки не считаются списком устройств', () => {
    // Без этой проверки выбор человека стирался бы при КАЖДОЙ загрузке страницы, пока он не пустит
    // приложение к микрофону: его id в списке заглушек, разумеется, нет.
    assert.deepEqual(lostDevices(choice({ inputDeviceId: 'mic-hs', outputDeviceId: 'hs' }), NO_PERMISSION), []);
  });

  it('и вернуть по заглушкам тоже нечего', () => {
    assert.deepEqual(restorableDevices(choice(), NO_PERMISSION, { outputDeviceId: 'hs' }), []);
  });

  it('а как только доступ выдан — работает как обычно', () => {
    const gone = NORMAL.filter((d) => d.deviceId !== 'hs');
    assert.deepEqual(lostDevices(choice({ outputDeviceId: 'hs' }), gone).map((l) => l.id), ['hs']);
  });
});
