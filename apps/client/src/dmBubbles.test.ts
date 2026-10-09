import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DM_BUBBLES_DEFAULT, dmBubblesSwitch, setDmBubblesSwitch, planBubblesFromSearch, applyBubblesFromUrl } from './dmBubbles';

function loadBubbles(change: (source: string) => string = s => s) {
  const source = readFileSync(new URL('./dmBubbles.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = ts.transpileModule(change(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const values = new Map<string, string>();
  const context = vm.createContext({ exports: {}, URLSearchParams, localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  vm.runInContext(code, context);
  return { rules: context.exports as typeof import('./dmBubbles'), values };
}

it('утверждённое умолчание true включает пустое устройство, но явный 0 сохраняет старую ленту', () => {
  // Настоящий экспорт не подменяется: откат константы в false обязан краснить тест.
  assert.equal(DM_BUBBLES_DEFAULT, true);
  withStorage(values => {
    values.delete('gv_dm_bubbles');
    assert.equal(dmBubblesSwitch(), true);
  });
  const { rules, values } = loadBubbles();
  assert.equal(rules.DM_BUBBLES_DEFAULT, true);
  assert.equal(rules.dmBubblesSwitch(), true);
  values.set('gv_dm_bubbles', '0'); assert.equal(rules.dmBubblesSwitch(), false);
  values.set('gv_dm_bubbles', '1'); assert.equal(rules.dmBubblesSwitch(), true);
  values.set('gv_dm_bubbles', 'garbage'); assert.equal(rules.dmBubblesSwitch(), true);
});

it('контракт ссылки ловит потерю повтора, перекодирование, запись мусора и потерю state', () => {
  // Защитный тест должен краснеть от нарушения поведения, а не от отсутствия текстового якоря.
  const contract = (rules: typeof import('./dmBubbles'), values: Map<string, string>) => {
    assert.equal(rules.planBubblesFromSearch('?bubbles=0&bubbles=1').set, false);
    assert.equal(rules.planBubblesFromSearch('?x=a%2fb&bubbles=1').search, '?x=a%2fb');
    const state = { marker: 'fixture' };
    let seen: unknown;
    rules.applyBubblesFromUrl({ pathname: '/', search: '?bubbles=garbage', hash: '' }, {
      state, replaceState(s) { seen = s; },
    });
    assert.equal(seen, state);
    assert.equal(values.has('gv_dm_bubbles'), false);
  };
  const original = loadBubbles(); contract(original.rules, original.values);
  for (const [from, to] of [
    ['if (!found) value = parsed.get(PARAM);', 'value = parsed.get(PARAM);'],
    ['rest.push(pair);', "rest.push(new URLSearchParams(pair).toString());"],
    ['if (plan.set !== null) setDmBubblesSwitch(plan.set);', 'setDmBubblesSwitch(Boolean(plan.set));'],
    ["hist.replaceState(hist.state, '',", "hist.replaceState(null, '',"],
  ]) {
    const mutant = loadBubbles(source => {
      assert.ok(source.includes(from), 'найден якорь контрфакта');
      return source.replace(from, to);
    });
    assert.throws(() => contract(mutant.rules, mutant.values), assert.AssertionError);
  }
});

it('ссылка принимает ровно 1 и 0, прочие значения убирает без команды', () => {
  // Ошибочная ссылка не должна отменять ранее выбранный вид ленты.
  for (const [raw, set] of [['1', true], ['0', false], ['', null], ['true', null], ['01', null], ['%201', null], ['2', null]] as const) {
    assert.deepEqual(planBubblesFromSearch(`?bubbles=${raw}`), { set, search: '' });
  }
});

it('без параметра bubbles адрес и переключатель не требуют изменения', () => {
  // Обычный запуск не должен переписывать ссылку приглашения или историю.
  for (const query of ['', '?', '?invite=x&x=1', '?Bubbles=1', '?xbubbles=1', '??bubbles=1']) {
    assert.deepEqual(planBubblesFromSearch(query), { set: null, search: null });
  }
});

it('повторы bubbles удаляются все, команда берётся только у первого', () => {
  // Повторный параметр не может тайно перебить первую команду.
  assert.deepEqual(planBubblesFromSearch('?bubbles=0&x=1&bubbles=1'), { set: false, search: '?x=1' });
  assert.deepEqual(planBubblesFromSearch('?bubbles=bad&bubbles=1'), { set: null, search: '' });
  assert.deepEqual(planBubblesFromSearch('bubbles=1&bubbles=0'), { set: true, search: '' });
});

it('закодированное имя и значение распознаются, остальные пары сохраняются побайтово', () => {
  // Перекодирование URL ломает подписанные приглашения и значения с плюсами.
  const rest = 'invite=a%2fb+%20&x=&x=2&flag&v=a=b';
  assert.deepEqual(planBubblesFromSearch(`?${rest}&%62ubbles=%31`), { set: true, search: `?${rest}` });
});

function withStorage(run: (values: Map<string, string>, writes: string[]) => void): void {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([['gv_dm_bubbles', '0'], ['other', 'keep']]);
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(`${key}=${value}`); values.set(key, value); },
  } });
  try { run(values, writes); }
  finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else Reflect.deleteProperty(globalThis, 'localStorage'); }
}

it('применение записывает выбор до замены адреса и сохраняет путь, хеш и state', () => {
  // Первая отрисовка должна видеть выбор, а кнопка Назад — прежнюю историю.
  withStorage((values, writes) => {
    const state = { token: 'fixture' };
    const calls: unknown[][] = [];
    applyBubblesFromUrl({ pathname: '/chat/fixture', search: '?invite=a%2fb&bubbles=1', hash: '#msg' }, {
      state, replaceState: (...args) => {
        assert.equal(values.get('gv_dm_bubbles'), '1');
        calls.push(args);
      },
    });
    assert.deepEqual(writes, ['gv_dm_bubbles=1']);
    assert.deepEqual(calls, [[state, '', '/chat/fixture?invite=a%2fb#msg']]);
    assert.equal(calls[0][0], state);
    assert.equal(values.get('other'), 'keep');
  });
});

it('выключение по ссылке записывает 0, мусор и отсутствие команды не пишут хранилище', () => {
  // Нельзя трактовать строку «0» как truthy и случайно включить пузыри.
  withStorage((values, writes) => {
    values.set('gv_dm_bubbles', '1');
    const urls: unknown[] = [];
    const hist = { replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { urls.push(url); } };
    applyBubblesFromUrl({ pathname: '/', search: '?bubbles=0', hash: '' }, hist);
    assert.equal(values.get('gv_dm_bubbles'), '0');
    applyBubblesFromUrl({ pathname: '/', search: '?bubbles=yes', hash: '#x' }, hist);
    applyBubblesFromUrl({ pathname: '/', search: '?invite=x', hash: '' }, hist);
    assert.deepEqual(writes, ['gv_dm_bubbles=0']);
    assert.deepEqual(urls, ['/', '/#x']);
  });
});

it('сбой хранилища не мешает убрать параметр, сбой истории не отменяет сохранённый выбор', () => {
  // Запрет браузера на один API не должен блокировать весь запуск клиента.
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    const calls: unknown[][] = [];
    assert.doesNotThrow(() => applyBubblesFromUrl({ pathname: '/', search: '?bubbles=1', hash: '' }, {
      replaceState: (...args) => { calls.push(args); },
    }));
    assert.deepEqual(calls, [[undefined, '', '/']]);
  } finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else Reflect.deleteProperty(globalThis, 'localStorage'); }
  withStorage((values) => {
    assert.doesNotThrow(() => applyBubblesFromUrl({ pathname: '/', search: '?bubbles=1', hash: '' }, {
      replaceState() { throw new Error('blocked'); },
    }));
    assert.equal(values.get('gv_dm_bubbles'), '1');
  });
});

it('ссылка применяется только в главном окне после https-перехода и до отрисовки приложения', () => {
  // В overlay нельзя менять настройку, а запись в http-хранилище пропадёт после редиректа.
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(source.match(/applyBubblesFromUrl\(location, history\)/g)?.length, 1);
  const call = source.indexOf('  applyBubblesFromUrl(location, history);');
  const main = source.indexOf('} else {', source.indexOf("gvWindow === 'toast'"));
  const render = source.indexOf('  root.render(', main);
  assert.ok(main > source.indexOf('location.replace(httpsUrl)') && main < call && call < render, 'вызов остаётся в главной ветке до render');
});

it('отсутствие или отказ хранилища возвращает умолчание сборки', () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Reflect.deleteProperty(globalThis, 'localStorage');
    assert.equal(dmBubblesSwitch(), DM_BUBBLES_DEFAULT); assert.doesNotThrow(() => setDmBubblesSwitch(true));
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('закрыто'); } });
    assert.equal(dmBubblesSwitch(), DM_BUBBLES_DEFAULT); assert.doesNotThrow(() => setDmBubblesSwitch(false));
  } finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
it('явные 1 и 0 переключают только своё устройство, неизвестное значение даёт умолчание', () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v),
    } });
    assert.equal(dmBubblesSwitch(), DM_BUBBLES_DEFAULT);
    setDmBubblesSwitch(true); assert.equal(values.get('gv_dm_bubbles'), '1'); assert.equal(dmBubblesSwitch(), true);
    setDmBubblesSwitch(false); assert.equal(values.get('gv_dm_bubbles'), '0'); assert.equal(dmBubblesSwitch(), false);
    values.set('gv_dm_bubbles', 'true'); assert.equal(dmBubblesSwitch(), DM_BUBBLES_DEFAULT);
  } finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
