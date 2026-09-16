import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
}

interface GateProcessor {
  env: number;
  hold: number;
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

const source = readFileSync(new URL('../public/gv-gate-worklet.js', import.meta.url), 'utf8');

function processor(sampleRate = 48_000): GateProcessor {
  let Registered: (new () => GateProcessor) | undefined;
  class AudioWorkletProcessorStub {
    port: WorkletPort = { onmessage: null, postMessage() {} };
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    sampleRate,
    registerProcessor(name: string, ctor: new () => GateProcessor) {
      assert.equal(name, 'gv-gate');
      Registered = ctor;
    },
  });
  assert.ok(Registered, 'worklet должен зарегистрировать процессор');
  return new Registered();
}

function threshold(p: GateProcessor, value: number): void {
  assert.ok(p.port.onmessage, 'обработчик настроек должен быть установлен');
  p.port.onmessage({ data: { threshold: value } });
}

function block(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe('шумовой гейт AudioWorklet', () => {
  it('без гейта моно-вход одинаково заполняет оба канала стереовыхода', () => {
    // Ловит регрессию #82: правый канал оставался нулевым у монофонического микрофона.
    const p = processor();
    const input = block([0.25, -0.5, 0.75]);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);

    p.process([[input]], [[left, right]]);

    assert.deepEqual(left, input);
    assert.deepEqual(right, input);
  });

  it('с включённым гейтом моно-вход тоже заполняет оба канала одинаковым сигналом', () => {
    // Ловит возврат одноканального цикла только в ветке threshold > 0.
    const p = processor();
    threshold(p, 0.5);
    const input = block([0.8, 0.8, 0.8, 0.8]);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);

    p.process([[input]], [[left, right]]);

    assert.deepEqual(left, right);
    assert.ok(left.every((value) => value > 0));
  });

  it('стереовход проходит в стереовыход без перестановки каналов', () => {
    // Ловит копирование левого канала поверх правого при починке моно-раздачи.
    const p = processor();
    const inputLeft = block([0.1, 0.2, 0.3]);
    const inputRight = block([-0.4, -0.5, -0.6]);
    const outputLeft = new Float32Array(3);
    const outputRight = new Float32Array(3);

    p.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);

    assert.deepEqual(outputLeft, inputLeft);
    assert.deepEqual(outputRight, inputRight);
  });

  it('закрытый гейт гасит тихий вход', () => {
    // Ловит гейт, который визуально закрыт, но продолжает публиковать фоновый шум.
    const p = processor();
    threshold(p, 0.5);
    const input = new Float32Array(32).fill(0.1);
    const output = new Float32Array(input.length);

    p.process([[input]], [[output]]);

    assert.ok(output.every((value) => value === 0));
  });

  it('открытый гейт пропускает сигнал выше порога', () => {
    // Ловит обратное сравнение порога, при котором речь заглушается вместо шума.
    const p = processor();
    threshold(p, 0.5);
    const input = new Float32Array(32).fill(0.8);
    const output = new Float32Array(input.length);

    p.process([[input]], [[output]]);

    assert.ok(output.every((value) => value > 0));
    assert.ok(output[output.length - 1] > output[0], 'атака должна открывать гейт постепенно');
  });

  it('hold удерживает гейт открытым четверть секунды после срабатывания', () => {
    // Ловит ошибку порядка величины в переводе 250 мс в число аудиосэмплов.
    const p = processor(40);
    threshold(p, 0.5);
    p.process([[block([0.8])]], [[new Float32Array(1)]]);
    assert.equal(p.hold, 9, 'первый из десяти сэмплов hold уже обработан');

    const quiet = block(new Array(9).fill(0.1));
    const held = new Float32Array(quiet.length);
    const before = p.env;
    p.process([[quiet]], [[held]]);

    assert.equal(p.hold, 0);
    assert.ok(held.every((value) => value > 0));
    assert.ok(p.env > before, 'до конца hold огибающая продолжает открываться');
  });

  it('огибающая обновляется один раз на сэмпл и одинакова в обоих каналах', () => {
    // Ловит старый внешний цикл по каналам, ускорявший огибающую и разводивший левый с правым.
    const p = processor();
    threshold(p, 0.5);
    const input = new Float32Array(128).fill(0.8);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);

    p.process([[input]], [[left, right]]);

    for (let i = 0; i < input.length; i++) assert.equal(left[i], right[i], `сэмпл ${i}`);
  });

  it('process всегда возвращает true, даже когда входа ещё нет', () => {
    // Ловит выгрузку воркера браузером, после которой опубликованный микрофон навсегда замолкает.
    const p = processor();
    assert.equal(p.process([], []), true);
    assert.equal(p.process([[block([0.5])]], [[new Float32Array(1)]]), true);
  });
});
