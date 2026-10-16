import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('./androidBack.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function check(raw = source) {
  for (const [view, currentServerId, serverListOpen, expected, expectedCalls] of [
    ['server', 's', false, true, ['servers:true']],
    ['server', 's', true, true, ['view:dm', 'loadDms', 'pane:list']],
    ['server', null, false, true, ['view:dm', 'loadDms', 'pane:list']],
    ['server', null, true, true, ['view:dm', 'loadDms', 'pane:list']],
    ['dm', 's', false, false, []], ['dm', null, true, false, []],
  ] as const) {
    const calls: string[] = [];
    const state = { view, currentServerId, serverListOpen, mobilePane: 'list', adminOpen: false, settingsOpen: false,
      mobileProfileOpen: false, mobileMembersOpen: false,
      setServerListOpen: (value: boolean) => calls.push(`servers:${value}`),
      setView: (value: string) => calls.push(`view:${value}`),
      loadDms: () => { calls.push('loadDms'); return Promise.resolve(); },
      setMobilePane: (value: string) => calls.push(`pane:${value}`),
    };
    const module = { exports: {} as typeof import('./androidBack') };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, document: { querySelector: () => null },
        require: (id: string) => {
          if (id === './hotkeys') return { isAndroid: () => false };
          if (id === './store') return { useStore: { getState: () => state } };
          assert.fail(`неописанная граница ${id}`);
        } });
    assert.equal(module.exports.stepBack(), expected, 'назад из каналов сервера');
    assert.deepEqual(calls, expectedCalls, 'R232 каналы открывают серверы, корень серверов открывает сообщения, корень ЛС уходит системе');
  }
}
it('R174 назад из каналов открывает серверы, с корня серверов сообщения, а с корня сообщений уходит системе', () => {
  // Нельзя выкидывать из приложения с нестартовой вкладки и нельзя пропустить шаг каналы → серверы.
  check();
});
it('R174 контрфакт потерянного шага каналы → серверы отвергается', () => {
  // Whole-module VM сохраняет реальные порядок слоёв и обработчиков.
  check(); const anchor = "s.view === 'server' && s.currentServerId && !s.serverListOpen"; assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => check(source.replace(anchor, 'false')), (e: unknown) => e instanceof assert.AssertionError &&
    e.message.startsWith('R232 каналы открывают серверы') && e.operator === 'deepStrictEqual' &&
    JSON.stringify(e.actual) === '["view:dm","loadDms","pane:list"]' && JSON.stringify(e.expected) === '["servers:true"]');
});
it('R232 удаление перехода с корня серверов на сообщения ловится на настоящем stepBack', () => {
  check();
  const anchor = "  if (s.view === 'server') {\n    toChatsTab(s);\n    return true;\n  }";
  assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => check(source.replace(anchor, '')), (e: unknown) => e instanceof assert.AssertionError &&
    e.message.startsWith('назад из каналов сервера') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});

function checkProfile(raw = source) {
  for (const view of ['server', 'dm']) {
    const calls: string[] = [];
    const state = { view, mobileProfileOpen: true, mobilePane: 'content', adminOpen: false, settingsOpen: false,
      mobileMembersOpen: true,
      setMobileProfileOpen: (value: boolean) => calls.push(`profile:${value}`),
      setView: (value: string) => calls.push(`view:${value}`),
      loadDms: () => { calls.push('loadDms'); return Promise.resolve(); },
      setMobilePane: (value: string) => calls.push(`pane:${value}`),
      setMobileMembersOpen: () => calls.push('members'),
    };
    const module = { exports: {} as typeof import('./androidBack') };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, document: { querySelector: () => null }, require: (id: string) => {
        if (id === './hotkeys') return { isAndroid: () => false };
        if (id === './store') return { useStore: { getState: () => state } };
        assert.fail(`Неописанный импорт ${id}`);
      } });
    assert.equal(module.exports.stepBack(), true);
    assert.deepEqual(calls, view === 'dm' ? ['profile:false', 'loadDms', 'pane:list'] :
      ['profile:false', 'view:dm', 'loadDms', 'pane:list'], 'R230 профиль возвращает в список сообщений в правильном порядке');
  }
}
it('R230 назад из профиля закрывает профиль, выбирает сообщения при необходимости и загружает список', () => {
  // Даже открытые участники и content не должны перехватить возврат из корневого профиля.
  checkProfile();
});
it('R230 потеря перехода на сообщения после закрытия профиля обнаруживается по последовательности вызовов', () => {
  // Оригинал обязателен: произвольная ошибка загрузки не может засчитать мутант пойманным.
  checkProfile();
  // Другие корневые вкладки тоже смогут вызвать toChatsTab: мутируем только ветку профиля, не все вызовы файла.
  const anchor = '  if (s.mobileProfileOpen) {\n    s.setMobileProfileOpen(false);\n    toChatsTab(s);\n    return true;\n  }';
  assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => checkProfile(source.replace(anchor, anchor.replace('    toChatsTab(s);\n', ''))), (e: unknown) => e instanceof assert.AssertionError &&
    e.message.startsWith('R230 профиль возвращает в список сообщений в правильном порядке') &&
    e.operator === 'deepStrictEqual' && JSON.stringify(e.actual) === '["profile:false"]' &&
    JSON.stringify(e.expected) === '["profile:false","view:dm","loadDms","pane:list"]');
});
