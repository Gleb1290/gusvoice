import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { getMicGateOpen, ownRingSpeaking, setMicGateOpen, subscribeMicGate } from './micGateState.js';

const source = readFileSync(new URL('./micGateState.ts', import.meta.url), 'utf8');

for (const [vad, gate, expected] of [
  [false, null, false], [false, false, false], [false, true, false],
  [true, null, true], [true, false, false], [true, true, true],
] as const) {
  it(`R260 VAD=${vad}, гейт=${gate} → обводка=${expected} — закрытый гейт запрещает речь, отсутствующий не мешает`, () => {
    assert.equal(ownRingSpeaking(vad, gate), expected);
  });
}

it('R260 состояние проходит null → false → true → null — иначе обводка застрянет после пересборки цепи', () => {
  try {
    for (const value of [null, false, true, null]) {
      setMicGateOpen(value);
      assert.equal(getMicGateOpen(), value);
    }
  } finally { setMicGateOpen(null); }
});

it('R260 подписка не уведомляет при регистрации и повторе значения — иначе каждый блок перерисовывает обводку', () => {
  setMicGateOpen(null);
  const seen: (boolean | null)[] = [];
  const off = subscribeMicGate(value => seen.push(value));
  try {
    assert.deepEqual(seen, []);
    for (const value of [null, false, false, true, true, null, null]) setMicGateOpen(value);
    assert.deepEqual(seen, [false, true, null]);
  } finally { off(); setMicGateOpen(null); }
});

it('R260 два подписчика получают одинаковые переходы, отписка одного не снимает другого — иначе слушатель теряет цепь', () => {
  setMicGateOpen(null);
  const first: (boolean | null)[] = [], second: (boolean | null)[] = [];
  const offFirst = subscribeMicGate(value => first.push(value));
  const offSecond = subscribeMicGate(value => second.push(value));
  try {
    setMicGateOpen(false);
    offFirst(); offFirst();
    setMicGateOpen(true);
    assert.deepEqual(first, [false]);
    assert.deepEqual(second, [false, true]);
    assert.equal(getMicGateOpen(), true);
  } finally { offFirst(); offSecond(); setMicGateOpen(null); }
});

it('R260 самоотписка во время уведомления не пропускает соседнего подписчика — иначе переход теряется при teardown', () => {
  setMicGateOpen(null);
  const seen: string[] = [];
  let offSelf = () => {};
  offSelf = subscribeMicGate(value => { seen.push(`self:${value}`); offSelf(); });
  const offOther = subscribeMicGate(value => seen.push(`other:${value}`));
  try {
    setMicGateOpen(false); setMicGateOpen(true);
    assert.deepEqual(seen, ['self:false', 'other:false', 'other:true']);
  } finally { offSelf(); offOther(); setMicGateOpen(null); }
});

function loadOwnRing(raw: string): typeof ownRingSpeaking {
  // Исполняется ВЕСЬ чистый модуль, не вырезанный фрагмент функции.
  const result = ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: { ownRingSpeaking?: typeof ownRingSpeaking } = {};
  vm.runInNewContext(result.outputText, { exports }, { timeout: 1000 });
  assert.equal(typeof exports.ownRingSpeaking, 'function');
  return exports.ownRingSpeaking!;
}

it('R260 контрфакт: требование gate===true замечается именно как потеря речи при отсутствующей цепи', () => {
  const check = (raw: string) => assert.equal(loadOwnRing(raw)(true, null), true, 'R260:null-сохраняет-VAD');
  check(source);
  const from = 'gateOpenNow !== false';
  assert.equal(source.split(from).length - 1, 1, 'одна адресная точка мутации');
  assert.throws(() => check(source.replace(from, 'gateOpenNow === true')), error =>
    error instanceof assert.AssertionError && error.message.includes('R260:null-сохраняет-VAD'));
});
