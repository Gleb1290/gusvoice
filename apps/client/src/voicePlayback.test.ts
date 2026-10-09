import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';

type VoicePlayback = typeof import('./voicePlayback');
function load(mutate?: (source: string) => string, storage?: Storage, doc?: Document): VoicePlayback {
  const module = { exports: {} };
  const source = readFileSync(new URL('./voicePlayback.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = ts.transpileModule(mutate ? mutate(source) : source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports, localStorage: storage, document: doc });
  return module.exports as VoicePlayback;
}

describe('скорость, отметка прослушивания и следующий голосовой', () => {
  it('ширина волны зажимает длительность и сохраняет разные границы телефона и ПК', () => {
    // Ловит перестановку min/max телефона и скачущую ширину для повреждённой длительности.
    const v = load();
    assert.equal(v.voiceWaveWidth(0, false), 190);
    assert.equal(v.voiceWaveWidth(NaN, false), 190);
    assert.equal(v.voiceWaveWidth(30_000, false), 190);
    assert.equal(v.voiceWaveWidth(60_000, false), 256);
    assert.equal(v.voiceWaveWidth(120_000, false), 256);
    assert.equal(v.voiceWaveWidth(0, true), 152);
    assert.equal(v.voiceWaveWidth(30_000, true), 152);
    assert.equal(v.voiceWaveWidth(60_000, true), 190);
    assert.equal(v.voiceWaveWidth(120_000, true), 190);
    const broken = load((s) => s.replace('const min = phone ? VOICE_WAVE_W.phoneMin : VOICE_WAVE_W.min;',
      'const min = phone ? VOICE_WAVE_W.phoneMax : VOICE_WAVE_W.min;').replace(
      'const max = phone ? VOICE_WAVE_W.phoneMax : VOICE_WAVE_W.max;',
      'const max = phone ? VOICE_WAVE_W.phoneMin : VOICE_WAVE_W.max;'));
    assert.throws(() => assert.equal(broken.voiceWaveWidth(60_000, true), 190), assert.AssertionError,
      'мутант смешивает минимальную и максимальную ширину телефона');
  });

  it('ползунок округляет десятые и зажимает края, кнопка ПК возвращает последнее ускорение', () => {
    // Ловит потерю промежуточной скорости и смешение настольного переключателя с телефонным кругом.
    const v = load();
    for (const [n, want] of [[0.49, 0.5], [0.5, 0.5], [1.24, 1.2], [1.26, 1.3], [2.5, 2.5], [2.51, 2.5]]) {
      assert.equal(v.clampVoiceSpeed(n), want);
    }
    for (const n of [NaN, Infinity, -Infinity]) assert.equal(v.clampVoiceSpeed(n), null);
    assert.equal(v.nextVoiceSpeed(1.7), 2);
    assert.equal(v.toggleVoiceSpeed(1, 1.7), 1.7);
    assert.equal(v.toggleVoiceSpeed(1.7, 1.7), 1);
    assert.equal(v.toggleVoiceSpeed(0.5, 2), 1);
    assert.deepEqual(Array.from(v.VOICE_SPEED_MENU, x => x.speed), [0.5, 1, 1.2, 1.5, 1.7, 2]);
  });

  it('фильтр очереди пропускает неподходящие записи и не ищет до текущей, тайм-код сохраняет часы', () => {
    // Ловит повтор уже прослушанных записей и минутный тайм-код вместо часового.
    const v = load(); const order = ['a', 'b', 'c', 'd']; const seen: string[] = [];
    assert.equal(v.nextVoiceKeyWhere(order, 'a', key => { seen.push(key); return key === 'c'; }), 'c');
    assert.deepEqual(seen, ['b', 'c']);
    assert.equal(v.nextVoiceKeyWhere(order, 'd', () => true), null);
    assert.equal(v.nextVoiceKeyWhere(order, 'absent', () => { assert.fail('нет текущего — нет обхода'); }), null);
    assert.equal(v.nextVoiceKeyWhere(order, 'a', () => false), null);
    assert.equal(v.prevVoiceKey(order, 'a'), null);
    assert.equal(v.prevVoiceKey(order, 'c'), 'b');
    assert.equal(v.prevVoiceKey([], 'c'), null);
    for (const [ms, text] of [[-1, '0:00'], [59999, '0:59'], [60000, '1:00'], [3600000, '1:00:00'], [3723000, '1:02:03']] as const) {
      assert.equal(v.voiceTimecode(ms), text);
    }
  });
  it('скорость ходит 1 → 1,5 → 2 → 1, мусор сбрасывается, индекс не зацикливается', () => {
    // Автопереход заканчивается у последнего пузыря, не отправляя слушателя обратно в начало ленты.
    const v = load();
    assert.equal(v.nextVoiceSpeed(1), 1.5);
    assert.equal(v.nextVoiceSpeed(1.5), 2);
    assert.equal(v.nextVoiceSpeed(2), 1);
    assert.equal(v.nextVoiceSpeed(3), 1, 'неизвестное текущее значение начинает цикл с 1×');
    for (const raw of [null, undefined, '', 'abc']) assert.equal(v.parseVoiceSpeed(raw), 1);
    // Ползунок ПК расширил диапазон; телефонный цикл выше при этом остаётся прежним.
    assert.equal(v.parseVoiceSpeed('3'), 2.5);
    assert.equal(v.parseVoiceSpeed('0.5'), 0.5);
    assert.equal(v.parseVoiceSpeed('1.5'), 1.5);
    assert.equal(v.parseVoiceSpeed('2'), 2);
    assert.deepEqual([v.voiceSpeedLabel(1), v.voiceSpeedLabel(1.5), v.voiceSpeedLabel(2)], ['1×', '1,5×', '2×']);
    assert.equal(v.nextVoiceIndex(0, 0), null);
    assert.equal(v.nextVoiceIndex(3, -1), null);
    assert.equal(v.nextVoiceIndex(3, 0), 1);
    assert.equal(v.nextVoiceIndex(3, 2), null);
    assert.equal(v.voiceUnheard(undefined, false), false);
    assert.equal(v.voiceUnheard(true, false), false);
    assert.equal(v.voiceUnheard(false, false), true);
    assert.equal(v.voiceUnheard(false, true), false);
    assert.equal(v.shouldReportListened(false, false, false), true);
    assert.equal(v.shouldReportListened(true, false, false), false, 'автор не отмечает собственный файл как услышанный');
    assert.equal(v.shouldReportListened(false, undefined, false), false);
    assert.equal(v.shouldReportListened(false, false, true), false);
  });

  it('читает и сохраняет скорость в localStorage, уведомляет подписчиков и переживает закрытое хранилище', async () => {
    // Настройка личная для устройства; один живой плеер должен обновить остальные сразу после нажатия.
    GlobalRegistrator.register({ url: 'http://localhost/' });
    try {
      localStorage.removeItem('gv.voiceSpeed');
      localStorage.setItem('gv.voiceSpeed', '1.5');
      const v = load(undefined, localStorage, document);
      assert.equal(v.getVoiceSpeed(), 1.5, 'скорость переживает перезапуск вкладки');
      const seen: number[] = [];
      const stop = v.subscribeVoiceSpeed(s => seen.push(s));
      v.setVoiceSpeed(2);
      stop();
      v.setVoiceSpeed(1);
      assert.deepEqual(seen, [2], 'после unsubscribe вызов не приходит');
      assert.equal(localStorage.getItem('gv.voiceSpeed'), '1');
      const closed = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } as unknown as Storage;
      const fallback = load(undefined, closed);
      assert.doesNotThrow(() => fallback.getVoiceSpeed(), 'закрытая настройка не ломает воспроизведение');
      assert.doesNotThrow(() => fallback.setVoiceSpeed(1.5), 'закрытая настройка не мешает сменить скорость до перезагрузки');
    } finally { GlobalRegistrator.unregister(); }
  });

  it('ключ дорожки различает пересылки, следующий берётся из сохранённого порядка без круга', () => {
    // Пузырь может уйти из DOM при прокрутке: автопереход зависит от порядка ключей, не соседнего элемента.
    const v = load();
    assert.equal(v.voiceTrackKey('msg', 'att', 'url'), 'msg:att');
    assert.equal(v.voiceTrackKey(undefined, 'att', 'url'), 'local:url');
    assert.equal(v.voiceHeardKey('conv', 'msg'), 'conv:msg');
    assert.equal(v.nextVoiceKey(['a', 'b'], 'a'), 'b');
    assert.equal(v.nextVoiceKey(['a', 'b'], 'b'), null);
    assert.equal(v.nextVoiceKey(['a', 'b'], 'absent'), null);
    assert.equal(v.nextVoiceKey([], 'a'), null);
  });

  it('реальные мутанты выявляют круг, собственное «прослушано» и неверный предел скорости', () => {
    // Три соседних ошибки выглядят как нормальная кнопка скорости, но меняют очередь или серверные отметки.
    const source = readFileSync(new URL('./voicePlayback.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const mutants = [
      (s: string) => s.replace('cur >= 0 && cur + 1 < count ? cur + 1 : null', 'cur + 1 < count ? cur + 1 : 0'),
      (s: string) => s.replace('return !mine && voiceUnheard(listened, heardNow);', 'return voiceUnheard(listened, heardNow);'),
      (s: string) => s.replace('VOICE_SPEED_MAX = 2.5', 'VOICE_SPEED_MAX = 3'),
    ];
    const probes = [
      (m: VoicePlayback) => assert.equal(m.nextVoiceIndex(2, 1), null, 'последний не возвращает к нулевому'),
      (m: VoicePlayback) => assert.equal(m.shouldReportListened(true, false, false), false, 'автор не помечает своё'),
      (m: VoicePlayback) => assert.equal(m.parseVoiceSpeed('3'), 2.5, 'скорость 3× зажимается к верхней границе ползунка'),
    ];
    mutants.forEach((mutate, i) => {
      const altered = mutate(source);
      assert.notEqual(altered, source, `мутант ${i + 1} изменил реальный якорь`);
      assert.throws(() => probes[i]!(load(() => altered)), assert.AssertionError, `контракт должен отвергнуть мутант ${i + 1}`);
    });
  });
});
