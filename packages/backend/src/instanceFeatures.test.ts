import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as shared from '@gusvoice/shared';
import ts from 'typescript';
import * as features from './instanceFeatures.js';
import * as threats from './linkThreatsRules.js';

type FeatureApi = Pick<typeof features, 'INSTANCE_FEATURES' | 'FED_DM_FEATURES' | 'instanceFeatures'>;
const source = readFileSync(new URL('./instanceFeatures.ts', import.meta.url), 'utf8');
const fedNames = ['fedm1', 'fedm2', 'fedm3', 'fedm4', 'fedm5', 'fedcall1', 'fedm6'];

function load(raw = source, env: Record<string, string> = {}): FeatureApi {
  const module = { exports: {} as FeatureApi };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './linkThreatsRules.js': threats };
  // Исполняется весь модуль в отдельном окружении: настоящая .env и состояние процесса не меняются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, process: { env: { ...env } },
    require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `неописанный импорт признаков ${id}`);
      return deps[id];
    } });
  return module.exports;
}

function checkDisabled(api: FeatureApi) {
  const base = Array.from(api.INSTANCE_FEATURES);
  assert.ok(base.includes('conv1'), 'постоянные признаки не подменены пустым списком');
  assert.deepEqual(base.filter(feature => fedNames.includes(feature)), [],
    'R290-static-dm: постоянный список не объявляет выключенные ЛС между инстансами');
  assert.deepEqual(Array.from(api.instanceFeatures(false)), base,
    'R290-dm-disabled: выключение оставляет ровно постоянные признаки');
}

function checkEnabled(api: FeatureApi) {
  const list = Array.from(api.instanceFeatures(true));
  assert.deepEqual(list, [...api.INSTANCE_FEATURES, ...api.FED_DM_FEATURES],
    'R290-dm-enabled: включение добавляет весь набор ЛС, сохраняя постоянные признаки');
  for (const name of fedNames) assert.equal(list.filter(feature => feature === name).length, 1,
    `R290-dm-once: ${name} объявлен ровно один раз`);
}

it('R290 набор ЛС состоит ровно из семи ожидаемых признаков без повторов', () => {
  // Копирование только fedm1 скрыло бы потерю файлов, звонков или групп при успешном открытии ЛС.
  assert.deepEqual([...features.FED_DM_FEATURES].sort(), [...fedNames].sort());
  checkDisabled(features);
});

it('R290 включение ЛС добавляет все семь признаков, выключение сразу возвращает постоянный набор', () => {
  // Вызовы чередуются в одном загруженном модуле: первый ответ не должен стать кешем навсегда.
  const base = [...features.INSTANCE_FEATURES], dm = [...features.FED_DM_FEATURES];
  checkDisabled(features);
  checkEnabled(features);
  checkDisabled(features);
  checkEnabled(features);
  assert.deepEqual(Array.from(features.INSTANCE_FEATURES), base, 'вызовы не изменяют постоянный список');
  assert.deepEqual(Array.from(features.FED_DM_FEATURES), dm, 'вызовы не изменяют набор ЛС');
});

it('R290 runtime-флаг работает при пустом и противоречащем окружении', () => {
  // Переменная могла отсутствовать или остаться true после выключения тумблером; решает аргумент.
  const environments: Record<string, string>[] = [{}, { FEDERATION_DM_ENABLED: 'false' },
    { FEDERATION_ENABLED: 'true', FEDERATION_DM_ENABLED: 'true' }];
  for (const env of environments) {
    const api = load(source, env);
    checkDisabled(api);
    checkEnabled(api);
    checkDisabled(api);
  }
});

it('R290 контрфакт переноса признаков ЛС в постоянный список обнаруживает ложное объявление при выключении', () => {
  const original = load();
  checkDisabled(original); checkEnabled(original);
  const tree = ts.createSourceFile('instanceFeatures.ts', source, ts.ScriptTarget.Latest, true);
  const array = (name: string) => {
    const declarations = tree.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
      .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
    assert.equal(declarations.length, 1, `найден один настоящий список ${name}`);
    const init = declarations[0].initializer;
    assert.ok(init && ts.isArrayLiteralExpression(init));
    return init;
  };
  const base = array('INSTANCE_FEATURES'), fed = array('FED_DM_FEATURES');
  // FED_DM_FEATURES объявлен позже: вставляем его реальные элементы, не вызывая ложный TDZ ReferenceError.
  const at = base.getStart(tree) + 1;
  const mutant = source.slice(0, at) + '\n' + fed.elements.map(element => element.getText(tree)).join(', ') + ',' + source.slice(at);
  assert.notEqual(mutant, source);
  assert.throws(() => checkDisabled(load(mutant)), error => error instanceof assert.AssertionError
    && error.operator === 'deepStrictEqual' && error.message.startsWith('R290-static-dm:'));
});

it('R290 контрфакт всегда постоянного списка ловится именно при включении ЛС', () => {
  const original = load();
  checkDisabled(original); checkEnabled(original);
  const from = 'return fedDmEnabled ? [...INSTANCE_FEATURES, ...FED_DM_FEATURES] : [...INSTANCE_FEATURES];';
  assert.equal(source.split(from).length - 1, 1, 'контрфакт адресует действующий возврат функции');
  const mutant = load(source.replace(from, 'return [...INSTANCE_FEATURES];'));
  checkDisabled(mutant);
  assert.throws(() => checkEnabled(mutant), error => error instanceof assert.AssertionError
    && error.operator === 'deepStrictEqual' && error.message.startsWith('R290-dm-enabled:'));
});
