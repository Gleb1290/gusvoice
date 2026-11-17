import { counterfact as runCounterfact } from '../test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as actual from './permissions.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./permissions.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const permissionCheck = 'return has(perms, Permission.MANAGE_PREDICTIONS) || has(perms, Permission.MANAGE_ECONOMY);';

function load(raw: string): Rules {
  const module = { exports: {} };
  // В память загружается весь настоящий модуль; ни прод-файлы, ни его зависимости не подменяются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.fail(`R343 права setup: неожиданный импорт ${id}`); },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function counterfact(check: (rules: Rules) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {

    runCounterfact(() => {
      assert.equal(source.split(from).length, 2, `R343 права setup: единственный якорь ${from}`);
      const changed = source.replace(from, to);
      assert.notEqual(changed, source, 'R343 права setup: мутант действительно меняет модуль');
      assert.throws(() => check(load(changed)), (error: unknown) =>
        error instanceof assert.AssertionError && error.message.startsWith('R343 права:'),
      'мутант обязан краснеть на адресном утверждении хоста, не на setup/импорте/синтаксисе');
    });
    check(load(source));
  }
}

describe('R343 отдельное право проводить ставки не даёт управлять экономикой', () => {
  it('новый бит равен 1n << 30n и не пересекается ни с одним старым правом', () => {
    counterfact(r => {
      assert.equal(r.Permission.MANAGE_PREDICTIONS, 1n << 30n, 'R343 права: стабильная позиция нового бита');
      for (const [name, value] of Object.entries(r.Permission)) {
        if (name !== 'MANAGE_PREDICTIONS') {
          assert.equal(value & r.Permission.MANAGE_PREDICTIONS, 0n, `R343 права: нет пересечения с ${name}`);
        }
      }
    }, { from: 'MANAGE_PREDICTIONS: 1n << 30n', to: 'MANAGE_PREDICTIONS: 1n << 29n' });
  });

  it('ведущий с одним MANAGE_PREDICTIONS проводит ставки без управления деньгами', () => {
    counterfact(r => {
      const perms = r.Permission.MANAGE_PREDICTIONS;
      assert.equal(r.canRunPredictions(perms), true, 'R343 права: отдельного права ведущего достаточно');
      assert.equal(r.has(perms, r.Permission.MANAGE_ECONOMY), false, 'R343 права: ведущий не управляет экономикой');
      assert.equal(r.canRunPredictions(perms | r.Permission.SEND_MESSAGES), true, 'R343 права: бытовой бит не мешает ведущему');
    }, { from: permissionCheck, to: 'return has(perms, Permission.MANAGE_ECONOMY);' });
  });

  it('управляющий экономикой по-прежнему проводит ставки без отдельного нового бита', () => {
    counterfact(r => {
      assert.equal(r.canRunPredictions(r.Permission.MANAGE_ECONOMY), true, 'R343 права: старое право экономики сохранено');
      assert.equal(r.Permission.MANAGE_ECONOMY & r.Permission.MANAGE_PREDICTIONS, 0n, 'R343 права: права остаются раздельными');
    }, { from: permissionCheck, to: 'return has(perms, Permission.MANAGE_PREDICTIONS);' });
  });

  it('администратор проводит ставки без буквального бита ведущего или экономики', () => {
    counterfact(r => {
      assert.equal(r.canRunPredictions(r.Permission.ADMINISTRATOR), true, 'R343 права: администратору сохранена поблажка has');
      assert.equal(r.Permission.ADMINISTRATOR & (r.Permission.MANAGE_PREDICTIONS | r.Permission.MANAGE_ECONOMY), 0n,
        'R343 права: администратор проверен без явных разрешений');
    }, { from: permissionCheck,
      to: 'return (perms & (Permission.MANAGE_PREDICTIONS | Permission.MANAGE_ECONOMY)) !== 0n;' });
  });

  it('нулевая маска не проводит ставки, в отличие от явного права ведущего', () => {
    counterfact(r => {
      assert.equal(r.canRunPredictions(0n), false, 'R343 права: без прав отказ');
      assert.equal(r.canRunPredictions(r.Permission.MANAGE_PREDICTIONS), true, 'R343 права: с правом разрешено');
    }, { from: permissionCheck, to: 'return perms === 0n || has(perms, Permission.MANAGE_PREDICTIONS) || has(perms, Permission.MANAGE_ECONOMY);' });
  });

  it('управление сервером само по себе не разрешает проводить ставки', () => {
    counterfact(r => {
      assert.equal(r.canRunPredictions(r.Permission.MANAGE_SERVER), false, 'R343 права: переименование сервера не даёт денег и ставок');
      assert.equal(r.canRunPredictions(r.Permission.MANAGE_SERVER | r.Permission.MANAGE_PREDICTIONS), true,
        'R343 права: явная выдача ведущего всё же работает');
    }, { from: permissionCheck,
      to: 'return has(perms, Permission.MANAGE_SERVER) || has(perms, Permission.MANAGE_PREDICTIONS) || has(perms, Permission.MANAGE_ECONOMY);' });
  });

  it('ALL_PERMISSIONS включает новый бит, поэтому маска владельца не теряет право', () => {
    counterfact(r => {
      assert.equal(r.ALL_PERMISSIONS & (1n << 30n), 1n << 30n, 'R343 права: новый бит включён в полную маску');
      assert.equal(r.canRunPredictions(r.ALL_PERMISSIONS), true, 'R343 права: полная маска проводит ставки');
    }, { from: 'Object.values(Permission).reduce((a, b) => a | b, 0n)',
      to: 'Object.values(Permission).reduce((a, b) => a | b, 0n) & ~Permission.MANAGE_PREDICTIONS' });
  });

  it('обычный @everyone не получает право ведущего по умолчанию', () => {
    counterfact(r => {
      assert.equal(r.DEFAULT_EVERYONE_PERMISSIONS & r.Permission.MANAGE_PREDICTIONS, 0n, 'R343 права: бит отсутствует у everyone');
      assert.equal(r.canRunPredictions(r.DEFAULT_EVERYONE_PERMISSIONS), false, 'R343 права: everyone не проводит ставки');
      assert.equal(r.canRunPredictions(r.DEFAULT_EVERYONE_PERMISSIONS | r.Permission.MANAGE_PREDICTIONS), true,
        'R343 права: выданный поверх everyone бит работает');
    }, { from: '  Permission.MENTION_EVERYONE;', to: '  Permission.MENTION_EVERYONE | Permission.MANAGE_PREDICTIONS;' });
  });
});
