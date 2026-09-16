import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNativeShareSession } from './nativeShareCore.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('состояние нативной трансляции', () => {
  it('запуск и чтение флага проходят через внедрённое состояние приложения', () => {
    // Ловит возврат локального флага, который снова умер бы вместе с размонтированным React-компонентом.
    let sharing = false;
    const session = createNativeShareSession({
      stopCapture: async () => {},
      getSharing: () => sharing,
      setSharing: (value) => { sharing = value; },
    });
    session.markSharing();
    assert.equal(sharing, true);
    assert.equal(session.isSharing(), true);
  });

  it('регистрация и явный сброс teardown точно отражаются в hasAudio', () => {
    // Ловит потерю или фантомную остановку системного звука после смены пути трансляции.
    const session = createNativeShareSession({
      stopCapture: async () => {},
      getSharing: () => false,
      setSharing: () => {},
    });
    session.setAudioStop(async () => {});
    assert.equal(session.hasAudio(), true);
    session.setAudioStop(null);
    assert.equal(session.hasAudio(), false);
  });

  it('два параллельных stopAudio вызывают зависший teardown ровно один раз', async () => {
    // Ловит перестановку обнуления после await, при которой кнопка и watcher гасят один ресурс дважды.
    const gate = deferred();
    let calls = 0;
    const session = createNativeShareSession({
      stopCapture: async () => {},
      getSharing: () => false,
      setSharing: () => {},
    });
    session.setAudioStop(async () => { calls += 1; await gate.promise; });
    const first = session.stopAudio();
    const second = session.stopAudio();
    assert.equal(calls, 1);
    assert.equal(session.hasAudio(), false);
    gate.resolve();
    await Promise.all([first, second]);
  });

  it('ошибка audio teardown поглощается и не возвращает фантомный ресурс', async () => {
    // Ловит сломанный cleanup после уже недоступного WASAPI-захвата.
    const session = createNativeShareSession({
      stopCapture: async () => {},
      getSharing: () => false,
      setSharing: () => {},
    });
    session.setAudioStop(async () => { throw new Error('audio already gone'); });
    await assert.doesNotReject(() => session.stopAudio());
    assert.equal(session.hasAudio(), false);
  });

  it('stop снимает флаг до ожидания capture и гасит звук только после него', async () => {
    // Ловит подвисшую кнопку и нарушение порядка освобождения видео и сопровождающего звука.
    const gate = deferred();
    const events: string[] = [];
    let sharing = true;
    const session = createNativeShareSession({
      stopCapture: async () => { events.push('capture:start'); await gate.promise; events.push('capture:end'); },
      getSharing: () => sharing,
      setSharing: (value) => { sharing = value; events.push(`sharing:${value}`); },
    });
    session.setAudioStop(async () => { events.push('audio'); });
    const stopping = session.stop();
    assert.equal(sharing, false);
    assert.deepEqual(events, ['sharing:false', 'capture:start']);
    gate.resolve();
    await stopping;
    assert.deepEqual(events, ['sharing:false', 'capture:start', 'capture:end', 'audio']);
  });

  it('stopIfActive без нативного видео всё равно гасит отдельный системный звук', async () => {
    // Регрессия #96: веб-видео с нативным звуком иначе продолжало вещать после остановки показа.
    const events: string[] = [];
    const session = createNativeShareSession({
      stopCapture: async () => { events.push('capture'); },
      getSharing: () => false,
      setSharing: () => { events.push('sharing'); },
    });
    session.setAudioStop(async () => { events.push('audio'); });
    await session.stopIfActive();
    assert.deepEqual(events, ['audio']);
  });

  it('stopIfActive живой трансляции продолжает cleanup после ошибки capture', async () => {
    // Ловит потерю аудио-teardown, когда Rust-захват уже исчез и команда остановки отверглась.
    const events: string[] = [];
    let sharing = true;
    const session = createNativeShareSession({
      stopCapture: async () => { events.push('capture'); throw new Error('capture already gone'); },
      getSharing: () => sharing,
      setSharing: (value) => { sharing = value; events.push(`sharing:${value}`); },
    });
    session.setAudioStop(async () => { events.push('audio'); });
    await assert.doesNotReject(() => session.stopIfActive());
    assert.equal(sharing, false);
    assert.deepEqual(events, ['sharing:false', 'capture', 'audio']);
  });
});
