import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/gv-gate-worklet.js', import.meta.url), 'utf8');
type Message = { open: boolean };
interface Gate {
  hold: number;
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(data: unknown): void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

function gate(raw = source) {
  const messages: Message[] = [];
  let Registered: (new () => Gate) | undefined;
  class Base {
    port = {
      onmessage: null,
      postMessage(data: unknown) {
        assert.ok(typeof data === 'object' && data !== null);
        assert.ok('open' in data);
        assert.deepEqual(Object.keys(data), ['open']);
        assert.equal(typeof data.open, 'boolean');
        messages.push({ open: data.open as boolean });
      },
    };
  }
  // Настоящий зарегистрированный worklet целиком, без сети, AudioContext и копии алгоритма.
  vm.runInNewContext(raw, {
    AudioWorkletProcessor: Base,
    sampleRate: 48_000,
    registerProcessor(name: string, ctor: new () => Gate) {
      assert.equal(name, 'gv-gate');
      assert.equal(Registered, undefined);
      Registered = ctor;
    },
  }, { timeout: 1000 });
  assert.ok(Registered);
  const instance = new Registered();
  function threshold(value: number) {
    assert.ok(instance.port.onmessage);
    instance.port.onmessage({ data: { threshold: value } });
  }
  function block(value: number, frames = 128) {
    const input = new Float32Array(frames).fill(value), output = new Float32Array(frames);
    assert.equal(instance.process([[input]], [[output]]), true);
    return output;
  }
  return { instance, messages, threshold, block };
}

function disabledReports(raw: string) {
  const p = gate(raw);
  p.threshold(0); p.block(0);
  assert.deepEqual(p.messages, [{ open: true }], 'R260:нулевой-порог-сообщает-открытие');
}

it('R260 нулевой порог сообщает open:true даже в тишине — иначе рация оставит обводку закрытой', () => disabledReports(source));

it('R260 отрицательный порог тоже отключает гейт и пропускает звук — иначе ветка threshold≤0 расходится с индикацией', () => {
  const p = gate(); p.threshold(-0.1);
  assert.deepEqual(p.block(0.25, 3), new Float32Array([0.25, 0.25, 0.25]));
  assert.deepEqual(p.messages, [{ open: true }]);
});

function quietReports(raw: string) {
  const p = gate(raw); p.threshold(0.5);
  for (let i = 0; i < 20; i++) p.block(0);
  assert.deepEqual(p.messages, [{ open: false }], 'R260:тишина-без-повторных-кадров');
}

it('R260 закрытая цепь сообщает false один раз, не каждый блок тишины — иначе порт забивается повторами', () => quietReports(source));

it('R260 громкий блок открывает гейт и держит его 250 мс в сэмплах — иначе обрезается хвост речи', () => {
  const p = gate(); p.threshold(0.5); p.block(0);
  // report идёт ДО расходования hold в текущем блоке. Один сэмпл речи + 11999 тишины = 250 мс.
  p.block(1, 1);
  assert.equal(p.instance.hold, 11_999);
  p.block(0, 11_998);
  assert.equal(p.instance.hold, 1);
  assert.deepEqual(p.messages, [{ open: false }, { open: true }]);
  p.block(0, 1);
  assert.equal(p.instance.hold, 0);
  assert.deepEqual(p.messages, [{ open: false }, { open: true }]);
  p.block(0, 1);
  assert.deepEqual(p.messages, [{ open: false }, { open: true }, { open: false }]);
});

it('R260 после 250 мс тишины гейт закрыт, дальнейшая тишина не повторяет false — иначе обводка зависает или дребезжит', () => {
  const p = gate(); p.threshold(0.5); p.block(1);
  for (let i = 0; i < 94; i++) p.block(0); // 12032 сэмпла тишины, чуть больше 250 мс.
  assert.deepEqual(p.messages, [{ open: true }, { open: false }]);
  for (let i = 0; i < 50; i++) p.block(0);
  assert.deepEqual(p.messages, [{ open: true }, { open: false }]);
});

it('R260 повторная речь продлевает hold, отключение гейта открывает закрытую цепь — иначе новое слово гасит обводку', () => {
  const p = gate(); p.threshold(0.5); p.block(1, 1); p.block(0, 11_998);
  assert.equal(p.instance.hold, 1);
  p.block(1, 1);
  assert.equal(p.instance.hold, 11_999);
  assert.deepEqual(p.messages, [{ open: true }]);
  p.block(0, 12_000); p.block(0);
  assert.deepEqual(p.messages, [{ open: true }, { open: false }]);
  p.threshold(0); p.block(0); p.block(0);
  assert.deepEqual(p.messages, [{ open: true }, { open: false }, { open: true }]);
});

for (const [label, from, to, check, marker] of [
  ['отключённый гейт перестал сообщать открытие', '      this.report(true);', '', disabledReports, 'R260:нулевой-порог-сообщает-открытие'],
  ['состояние сообщается каждый блок', '    if (isOpen === this.reported) return;', '', quietReports, 'R260:тишина-без-повторных-кадров'],
] as const) {
  it(`R260 контрфакт: ${label} — требуется адресная ошибка утверждения, не сбой загрузки`, () => {
    check(source);
    assert.equal(source.split(from).length - 1, 1, 'одна адресная точка мутации');
    assert.throws(() => check(source.replace(from, to)), error =>
      error instanceof assert.AssertionError && error.message.includes(marker));
  });
}
