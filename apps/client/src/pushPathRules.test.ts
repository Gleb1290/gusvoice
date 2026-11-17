import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Rules = typeof import('./pushPathRules');
const source = readFileSync(new URL('./pushPathRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function rules(raw = source): Rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports });
  return module.exports as Rules;
}

// Полная таблица, а не повторение if из приложения: 24 исхода для трёх значений gateway.
function matrix(raw = source) {
  const choose = rules(raw).choosePushPath;
  for (const [gateway, expected] of [
    [undefined, ['external', 'external', 'external', 'external', 'store', 'store', 'store', 'store']],
    ['', ['external', 'external', 'external', 'external', 'store', 'store', 'store', 'store']],
    ['https://push.example', ['external', 'external', 'external', 'embedded', 'store', 'store', 'store', 'store']],
  ] as const) {
    const combinations = [
      [false, false, false], [false, false, true], [false, true, false], [false, true, true],
      [true, false, false], [true, false, true], [true, true, false], [true, true, true],
    ] as const;
    combinations.forEach(([storeAvailable, embeddedBridge, embeddedAllowed], index) => {
      assert.equal(choose({ storeAvailable, embeddedBridge, embeddedAllowed, pushGateway: gateway }), expected[index],
        `R330:путь:${String(gateway)}:${storeAvailable}/${embeddedBridge}/${embeddedAllowed}`);
    });
  }
}

it('R330 магазин выигрывает у всех альтернатив, встроенный путь требует всех трёх условий', () => matrix());

for (const [name, before, after, address] of [
  ['снятый запрет сборки', 'i.embeddedBridge && i.embeddedAllowed && i.pushGateway', 'i.embeddedBridge && i.pushGateway', 'R330:путь:https://push.example:false/true/false'],
  ['встроенный путь перед магазином', "  if (i.storeAvailable) return 'store';\n  if (i.embeddedBridge && i.embeddedAllowed && i.pushGateway) return 'embedded';",
    "  if (i.embeddedBridge && i.embeddedAllowed && i.pushGateway) return 'embedded';\n  if (i.storeAvailable) return 'store';", 'R330:путь:https://push.example:true/true/true'],
  ['шлюз заменён на true', 'i.embeddedBridge && i.embeddedAllowed && i.pushGateway', 'i.embeddedBridge && i.embeddedAllowed && true', 'R330:путь:undefined:false/true/true'],
] as const) {
  it(`R330 контрфакт «${name}» краснеет на той же полной таблице после зелёного оригинала`, () => {
    matrix();
    counterfact(() => {
      assert.equal(source.split(before).length - 1, 1, 'единственный якорь мутации');
      assert.throws(() => matrix(source.replace(before, after)), error => error instanceof assert.AssertionError
        && error.operator === 'strictEqual' && error.message.startsWith(address));
    });
  });
}
