import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

function fixture(browser = true) {
  const handlers = new Map<string, () => void>();
  const navigator = { onLine: true };
  let changes = 0;
  let release: (() => void) | undefined;
  const module = { exports: {} };
  const raw = readFileSync(new URL('./connState.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports,
    ...(browser ? { navigator, window: { addEventListener: (key: string, fn: () => void) => handlers.set(key, fn) } } : {}),
    require: (id: string) => {
      assert.equal(id, 'react', 'модуль не подключает стор приложения');
      return { useSyncExternalStore: (subscribe: (fn: () => void) => () => void, snapshot: () => string) => {
        release ??= subscribe(() => changes++);
        return snapshot();
      } };
    },
  });
  return { api: module.exports as typeof import('./connState'), navigator, handlers, changes: () => changes, release: () => release?.() };
}

it('сеть устройства важнее потерянного шлюза во всех четырёх сочетаниях', () => {
  // При отсутствии сети обещание «Подключение» ошибочно: подключаться пока некуда.
  const { api } = fixture(false);
  for (const deviceOffline of [false, true]) for (const gatewayLost of [false, true]) assert.equal(api.connStateOf({ deviceOffline, gatewayLost }), deviceOffline ? 'waiting' : gatewayLost ? 'connecting' : 'online');
  assert.equal(api.connLabel('waiting'), 'Ожидание сети…');
  assert.equal(api.connLabel('connecting'), 'Соединение…');
  assert.equal(api.connLabel('online'), null);
});

it('шлюз не потерян до первого ready, после обрыва подключается, выход забывает старое соединение', () => {
  // Старый обрыв не должен красить следующий аккаунт как потерявший ещё не открытый шлюз.
  const { api } = fixture(false);
  api.setGatewayLive(false); assert.equal(api.useConnState(), 'online');
  api.setGatewayLive(true); api.setGatewayLive(false); assert.equal(api.useConnState(), 'connecting');
  api.setGatewayLive(true); assert.equal(api.useConnState(), 'online');
  api.setGatewayLive(false); api.resetGatewayLive(); assert.equal(api.useConnState(), 'online');
  api.setGatewayLive(false); assert.equal(api.useConnState(), 'online');
});

it('offline и online перечитывают устройство, повтор не уведомляет, reset не притворяется сетью', () => {
  // Ошибка подписки оставляет устаревший онлайн собеседника после потери сети.
  const f = fixture(); f.api.useConnState();
  assert.deepEqual([...f.handlers.keys()].sort(), ['offline', 'online']);
  f.api.setGatewayLive(true); f.api.setGatewayLive(false);
  assert.equal(f.api.useConnState(), 'connecting'); assert.equal(f.changes(), 1);
  f.navigator.onLine = false; f.handlers.get('offline')!();
  assert.equal(f.api.useConnState(), 'waiting'); assert.equal(f.changes(), 2);
  f.handlers.get('offline')!(); f.api.resetGatewayLive(); assert.equal(f.changes(), 2);
  f.navigator.onLine = true; f.handlers.get('online')!();
  assert.equal(f.api.useConnState(), 'online'); assert.equal(f.changes(), 3);
  f.release(); f.api.setGatewayLive(true); f.api.setGatewayLive(false); assert.equal(f.changes(), 3, 'отписанный компонент не уведомляется');
});

it('первая подписка сразу видит уже отключённое устройство без ожидания события offline', () => {
  // Вкладка могла открыться уже без сети, когда нового события браузер не пришлёт.
  const f = fixture(); f.navigator.onLine = false;
  assert.equal(f.api.useConnState(), 'waiting');
});
