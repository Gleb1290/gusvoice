import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const apiSource = source('./api.ts');
const sockets = source('./sockets.ts');
const pane = source('./components/MessagePane.tsx');

function property(text: string, name: string): string {
  const file = ts.createSourceFile('api.ts', text, ts.ScriptTarget.Latest, true);
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === name) {
      assert.equal(found, undefined, 'свойство API определено ровно один раз');
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, `найдено настоящее свойство ${name}`);
  return found.getText(file);
}

it('R116 регистрация пуша передаёт пояс только при непустом явном аргументе', () => {
  // Исполняется исходное тело свойства API; req — граница транспорта, никаких профилей/секретов/сети.
  const check = (text: string) => {
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    const module = { exports: {} as { register: (...args: unknown[]) => unknown } };
    const js = ts.transpileModule(`export const register = ${property(text, 'registerPush')};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(js, { module, exports: module.exports, req: (method: string, path: string, body: Record<string, unknown>) => {
      calls.push({ method, path, body });
    } });
    const register = module.exports.register;
    for (const tz of [undefined, null, '']) register('https://push.test/endpoint', 'device', undefined, undefined, tz);
    for (const call of calls) {
      assert.equal(call.method, 'POST'); assert.equal(call.path, '/push/register');
      assert.equal(Object.hasOwn(call.body, 'tz'), false, 'нет аргумента — нет поля, сервер сохраняет прежний пояс');
    }
    const keys = { p256dh: 'fixture-public', auth: 'fixture-auth' };
    register('https://push.test/endpoint', 'device', keys, ['reply1'], 'Europe/Moscow');
    const body = JSON.parse(JSON.stringify(calls.at(-1)!.body));
    assert.deepEqual(body, { endpoint: 'https://push.test/endpoint', deviceId: 'device', platform: 'android', keys, caps: ['reply1'], tz: 'Europe/Moscow' });
  };
  check(apiSource);
  for (const [before, after] of [
    ['...(tz ? { tz } : {}),', 'tz,'],
    ['...(tz ? { tz } : {}),', ''],
  ]) {
    const mutant = apiSource.replace(before, after);
    assert.notEqual(mutant, apiSource);
    assert.throws(() => check(mutant), assert.AssertionError);
  }
});

it('R116 сокет объявляет typing2 среди возможностей соединения', () => {
  const check = (text: string) => {
    const executable = ts.createSourceFile('sockets.ts', text, ts.ScriptTarget.Latest, true);
    let pushes = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(executable) === 'caps?.push'
        && node.arguments.some(arg => arg.getText(executable) === 'FEATURE_TYPING2')) pushes++;
      ts.forEachChild(node, visit);
    };
    visit(executable);
    assert.equal(pushes, 1, 'возможность объявлена исполняемым вызовом, а не комментарием');
  };
  check(sockets);
  const mutant = sockets.replace('caps?.push(FEATURE_TYPING2);', '/* caps?.push(FEATURE_TYPING2); */');
  assert.notEqual(mutant, sockets);
  assert.throws(() => check(mutant), assert.AssertionError);
});

it('R116 запись кружка шлёт round сразу и каждые 2,5 секунды, голосовое не дублирует её', () => {
  // Страж проводки, не проверка React/реального микрофона: эти два эффекта должны оставаться взаимоисключающими.
  const check = (text: string) => {
    assert.match(text, /if \(!recording \|\| roundRec\) return;[^]*?signalActionRef\.current\('voice'\)/);
    assert.match(text, /if \(!recording \|\| !roundRec\) return;\s*signalActionRef\.current\('round'\);\s*const t = setInterval\(\(\) => signalActionRef\.current\('round'\), 2500\);\s*return \(\) => clearInterval\(t\);\s*\}, \[recording, roundRec\]\)/);
  };
  check(pane);
  for (const [before, after] of [
    ["signalActionRef.current('round')", "signalActionRef.current('voice')"],
    ['if (!recording || !roundRec) return;', 'if (!recording) return;'],
    ['if (!recording || roundRec) return;', 'if (!recording) return;'],
  ]) {
    const mutant = pane.replace(before, after);
    assert.notEqual(mutant, pane);
    assert.throws(() => check(mutant), assert.AssertionError);
  }
});

it('R116 открытие канала снимает только его уведомления и только при смене канала', () => {
  const check = (text: string) => {
    assert.match(text, /useStore\.subscribe\(\(st, prev\) => \{[^]*?if \(st\.currentChannelId && st\.currentChannelId !== prev\.currentChannelId\) clearOsNotifications\(channelNoticeGroup\(st\.currentChannelId\)\);/);
  };
  check(sockets);
  for (const [before, after] of [
    ['clearOsNotifications(channelNoticeGroup(st.currentChannelId));', 'clearOsNotifications(channelNoticeGroup(prev.currentChannelId));'],
    ['st.currentChannelId !== prev.currentChannelId', 'true'],
  ]) {
    const mutant = sockets.replace(before, after);
    assert.notEqual(mutant, sockets);
    assert.throws(() => check(mutant), assert.AssertionError);
  }
});
