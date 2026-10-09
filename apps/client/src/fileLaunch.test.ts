import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

function fixture(change?: (s: string) => string) {
  const source = readFileSync(new URL('./fileLaunch.ts', import.meta.url), 'utf8');
  const module = { exports: {} }; const values = new Map<string, string>(); const asked: Record<string, unknown>[] = [];
  let answer: { option: boolean } | null = null;
  runInNewContext(ts.transpileModule(change ? change(source) : source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string,v: string) => values.set(k,v) }, require: (id: string) => { assert.equal(id, './confirm'); return { confirmWithOption: async (spec: Record<string, unknown>) => { asked.push(spec); return answer; } }; } });
  return { api: module.exports as typeof import('./fileLaunch'), values, asked, answer: (a: typeof answer) => { answer = a; } };
}
it('расширение берётся у файла, опасное и сетевое спрашиваются, известное безопасное не спрашивается', () => {
  // Точка каталога и регистр не должны обойти предупреждение о запуске сценария.
  const check = (api: typeof import('./fileLaunch')) => {
    for (const name of ['setup.exe','a.PS1','x.apk']) assert.equal(api.launchKind(name), 'exe');
    for (const name of ['notes.pdf','p.PNG']) assert.equal(api.launchKind(name), 'safe');
    for (const name of ['a.svg','p.m3u']) assert.equal(api.launchKind(name), 'ip');
    for (const name of ['a.xyz','README','.hidden']) assert.equal(api.launchKind(name), 'other');
    assert.equal(api.fileExtension('dir.v1/file'), ''); assert.equal(api.fileExtension('a.tar.gz'), 'gz');
  }; check(fixture().api);
  for (const [a,b] of [['exe fxp', 'fxp'], ["? 'safe' : 'other'", "? 'other' : 'safe'"], ['.toLowerCase()', '']]) {
    assert.throws(() => check(fixture(s => { assert.ok(s.includes(a), 'мутант найден'); return s.replace(a,b); }).api), assert.AssertionError);
  }
});
it('доверенное расширение не доверяет соседнему, отключение сетевого предупреждения действует только на ip', () => {
  // Одно разрешение на exe не должно отключать предупреждение о любом исполняемом файле.
  const f = fixture(); f.values.set('gv_launch_trusted', '["exe"]');
  assert.equal(f.api.needsLaunchWarning('a.exe'), false); assert.equal(f.api.needsLaunchWarning('a.bat'), true);
  f.values.set('gv_launch_ip_off','1'); assert.equal(f.api.needsLaunchWarning('a.svg'), false); assert.equal(f.api.needsLaunchWarning('a.xyz'), true);
  assert.equal(f.api.launchWarningText('exe','exe').confirmLabel, 'Запустить');
  assert.match(f.api.launchWarningText('other','').body, /нет расширения/i);
});
it('отмена ничего не запоминает, согласие с галочкой запоминает один раз, safe не открывает окно', async () => {
  // Галочка при отказе иначе разрешала следующий запуск без согласия пользователя.
  const f = fixture(); assert.equal(await f.api.confirmLaunch('x.exe'), false); assert.equal(f.values.size, 0);
  assert.equal(f.asked[0].tone, 'danger'); assert.equal(f.asked[0].icon, 'alert-circle');
  f.answer({ option: true }); assert.equal(await f.api.confirmLaunch('x.exe'), true); assert.equal(f.values.get('gv_launch_trusted'), '["exe"]');
  const calls = f.asked.length; assert.equal(await f.api.confirmLaunch('x.exe'), true); assert.equal(await f.api.confirmLaunch('x.pdf'), true); assert.equal(f.asked.length, calls);
  assert.equal(await f.api.confirmLaunch('x.svg'), true); assert.equal(f.asked.at(-1)?.icon, 'alert-circle'); assert.equal(f.values.get('gv_launch_ip_off'), '1');
});
