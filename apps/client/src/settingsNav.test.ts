import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { appVersionLabel, SECTIONS, SETTINGS_INDEX, searchSettings, visibleSections, withoutInAppGroups, type SettingsSection } from './settingsNav.js';

const federation = (sections: SettingsSection[]) => sections.find((s) => s.key === 'federation');

describe('видимость и поиск настроек инстансов', () => {
  it('Федерация содержит только доступные группы и исчезает, когда обе недоступны', () => {
    // Ловит пустой раздел в вебе и смешение независимых признаков federation/multi.
    assert.equal(federation(visibleSections({ federation: false, desktop: false, mobile: false })) , undefined);
    assert.deepEqual(
      federation(visibleSections({ federation: false, desktop: true, mobile: false, multi: true }))?.groups.map((g) => g.id),
      ['set-g-instances'],
    );
    assert.deepEqual(
      federation(visibleSections({ federation: true, desktop: false, mobile: false, multi: false }))?.groups.map((g) => g.id),
      ['set-g-guest'],
    );
    assert.deepEqual(
      federation(visibleSections({ federation: true, desktop: true, mobile: false, multi: true }))?.groups.map((g) => g.id),
      ['set-g-instances', 'set-g-guest'],
    );
  });

  it('старый вызов без multi сохраняет прежнюю федеративную группу', () => {
    // Ловит обратную несовместимость веб-клиента, где новый аргумент ещё не передан.
    assert.deepEqual(
      federation(visibleSections({ federation: true, desktop: false, mobile: false }))?.groups.map((g) => g.id),
      ['set-g-guest'],
    );
  });

  it('поиск не ведёт в скрытую группу, а при multi возвращает полный путь', () => {
    // Ловит результат поиска, который прокручивает к отсутствующему элементу.
    const web = visibleSections({ federation: true, desktop: false, mobile: false, multi: false });
    assert.deepEqual(searchSettings('инстанс', web).map((x) => x.title), ['Где я гость']);
    const app = visibleSections({ federation: false, desktop: true, mobile: false, multi: true });
    assert.deepEqual(searchSettings('инстанс', app).map((x) => [x.title, x.path]), [
      ['Мои инстансы', 'Федерация › Мои инстансы'],
    ]);
  });
});

describe('настройки производительности и курсора', () => {
  it('курсор стоит сразу после качества трансляции и виден только на десктопе', () => {
    // Ловит настройку без панели либо в неправильном разделе, где её не найдёт показывающий.
    const desktop = visibleSections({ federation: false, desktop: true, mobile: false });
    const web = visibleSections({ federation: false, desktop: false, mobile: false });
    const ids = desktop.find((s) => s.key === 'sound')?.groups.map((g) => g.id) ?? [];
    const stream = ids.indexOf('set-g-stream');
    assert.equal(ids[stream + 1], 'set-g-stream-cursor');
    assert.equal(web.find((s) => s.key === 'sound')?.groups.some((g) => g.id === 'set-g-stream-cursor'), false);
    assert.deepEqual(searchSettings('курсор', desktop).map((x) => x.id), ['set-g-stream-cursor']);
  });

  it('оптимизированный режим стоит перед аватарами и находится поиском', () => {
    // Ловит потерю единственного UI-входа в режим и расхождение каталога с индексом поиска.
    const sections = visibleSections({ federation: false, desktop: true, mobile: false });
    const ids = sections.find((s) => s.key === 'look')?.groups.map((g) => g.id) ?? [];
    assert.equal(ids[ids.indexOf('set-g-avatars') - 1], 'set-g-lite');
    assert.deepEqual(searchSettings('оптимизация', sections).map((x) => x.id), ['set-g-lite']);
  });
});

function checkBlocked(nav: Pick<typeof import('./settingsNav'), 'SETTINGS_INDEX' | 'searchSettings' | 'visibleSections'>) {
  const sections = nav.visibleSections({ federation: false, desktop: false, mobile: false });
  const entry = nav.SETTINGS_INDEX.filter(item => item.id === 'set-g-blocked');
  assert.equal(entry.length, 1);
  assert.equal(entry[0].section, 'privacy', 'R232 поиск заблокированных ведёт в конфиденциальность');
  assert.equal(sections.find(section => section.key === 'account')?.groups.some(group => group.id === 'set-g-blocked'), false);
  const groups = sections.find(section => section.key === 'privacy')?.groups ?? [];
  assert.equal(groups.at(-1)?.id, 'set-g-blocked', 'R232 заблокированные последняя группа конфиденциальности');
  assert.equal(sections.flatMap(section => section.groups).filter(group => group.id === 'set-g-blocked').length, 1);
  assert.equal(JSON.stringify(nav.searchSettings('заблокированные', sections).map(item => [item.id, item.section, item.path])),
    JSON.stringify([['set-g-blocked', 'privacy', 'Конфиденциальность › Чёрный список']]));
}
describe('чёрный список в настройках конфиденциальности', () => {
  it('группа завершает конфиденциальность, отсутствует в аккаунте и находится по словам блокировки', () => {
    // Ловит серверную возможность без достижимого экрана управления и запись поиска без живой группы.
    checkBlocked({ SETTINGS_INDEX, searchSettings, visibleSections });
  });
});
it('R232 возврат поиска заблокированных в аккаунт обнаруживается на исполненном модуле', () => {
  const source = readFileSync(new URL('./settingsNav.ts', import.meta.url), 'utf8');
  const load = (raw: string) => {
    const module = { exports: {} as typeof import('./settingsNav') };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, require: (id: string) => assert.fail(`Неописанный импорт ${id}`) });
    return module.exports;
  };
  // VM-массивы не имеют host prototype: сравниваем одинаковые сериализованные значения по обе стороны границы.
  const anchor = "id: 'set-g-blocked', title: 'Заблокированные', section: 'privacy'";
  assert.equal(source.split(anchor).length - 1, 1);
  checkBlocked(load(source));
  assert.throws(() => checkBlocked(load(source.replace(anchor, anchor.replace("section: 'privacy'", "section: 'account'")))),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R232 поиск заблокированных ведёт в конфиденциальность') &&
      e.operator === 'strictEqual' && e.actual === 'account' && e.expected === 'privacy');
});

function checkPrivacy(nav: Pick<typeof import('./settingsNav'), 'SECTIONS' | 'SETTINGS_INDEX' | 'searchSettings' | 'visibleSections'>) {
  const sections = nav.visibleSections({ federation: false, desktop: false, mobile: true });
  const keys = sections.map(s => s.key);
  assert.equal(keys[keys.indexOf('account') + 1], 'privacy');
  // Проверяется порядок этих трёх групп; положение завершающего blocked закреплено отдельно выше.
  assert.equal(sections.find(s => s.key === 'privacy')?.groups.filter(g =>
    ['set-g-messages', 'set-g-lastseen', 'set-g-calls'].includes(g.id)).map(g => g.id).join(','),
    'set-g-messages,set-g-lastseen,set-g-calls');
  const entries = nav.SETTINGS_INDEX.filter(e => /^(set-g-messages|set-g-lastseen|set-g-calls)(-exceptions)?$/.test(e.id));
  assert.equal(entries.length, 6);
  for (const entry of entries) assert.equal(entry.section, 'privacy', 'R230 все записи приватности ведут в конфиденциальность');
  const hits = nav.searchSettings('кто может мне писать', sections);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'set-g-messages');
  assert.equal(hits[0].path, 'Конфиденциальность › Сообщения');
}
it('R230 конфиденциальность сразу после аккаунта содержит сообщения, время захода и звонки с согласованным поиском', () => {
  // Исключения тоже участвуют в индексе: одного счастливого поискового запроса для переноса недостаточно.
  checkPrivacy({ SECTIONS, SETTINGS_INDEX, searchSettings, visibleSections });
});
it('R230 возврат поисковой записи приватности в аккаунт обнаруживается до показа неверного пути', () => {
  // Исполняется полный чистый модуль, а не повторённая в тесте копия поиска.
  const raw = readFileSync(new URL('./settingsNav.ts', import.meta.url), 'utf8');
  const anchor = "id: 'set-g-messages-exceptions', title: 'Исключения сообщений', section: 'privacy'";
  assert.equal(raw.split(anchor).length - 1, 1);
  const load = (text: string) => {
    const module = { exports: {} as typeof import('./settingsNav') };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, require: (id: string) => assert.fail(`Неописанный импорт ${id}`) });
    return module.exports;
  };
  checkPrivacy(load(raw));
  assert.throws(() => checkPrivacy(load(raw.replace(anchor, anchor.replace("section: 'privacy'", "section: 'account'")))),
    (e: unknown) => e instanceof assert.AssertionError &&
    e.message.startsWith('R230 все записи приватности ведут в конфиденциальность') &&
    e.operator === 'strictEqual' && e.actual === 'account' && e.expected === 'privacy');
});
it('R230 внутри Android скрывается только инструкция установки, ntfy остаётся, поиск android пуст', () => {
  // Фильтр должен питать и рельс, и поиск, не изменяя исходный реестр для других оболочек.
  const sections = visibleSections({ federation: false, desktop: false, mobile: true });
  const before = JSON.stringify(sections);
  const filtered = withoutInAppGroups(sections, true);
  assert.equal(filtered.find(s => s.key === 'apps')?.groups.map(g => g.id).join(','), 'set-g-push');
  assert.deepEqual(searchSettings('android', filtered), []);
  assert.deepEqual(searchSettings('android', sections).map(h => h.id), ['set-g-android']);
  assert.equal(JSON.stringify(sections), before);
  assert.equal(withoutInAppGroups(sections, false), sections);
});
it('R230 раздел из одних установочных групп исчезает на Android, а пустой ввод и остальные разделы сохраняются', () => {
  // В обычном реестре ntfy не даёт получить пустой apps; отдельная фикстура защищает общий контракт фильтра.
  const onlyInstall: SettingsSection = { key: 'apps', label: 'Приложения', sub: '', icon: 'download',
    groups: [{ id: 'set-g-android', label: 'Android', notAndroidApp: true }] };
  assert.deepEqual(withoutInAppGroups([onlyInstall], true), []);
  assert.deepEqual(withoutInAppGroups([], true), []);
  const sections = [onlyInstall, SECTIONS.find(s => s.key === 'privacy')!];
  assert.deepEqual(withoutInAppGroups(sections, true).map(s => s.key), ['privacy']);
  assert.equal(withoutInAppGroups(sections, false), sections);
});
it('R230 подпись версии различает платформы, удаляет начальное v и не выдумывает номер из null или пробелов', () => {
  // Матрица сохраняет парные варианты с номером и без него у каждой оболочки.
  for (const [platform, name] of [['android', 'GusVoice для Android'], ['desktop', 'GusVoice для ПК'], ['web', 'GusVoice для веба']] as const) {
    assert.equal(appVersionLabel(platform, '  v0.9.0  '), `${name} 0.9.0`);
    assert.equal(appVersionLabel(platform, '0.9.0'), `${name} 0.9.0`);
    for (const blank of [null, '', '   ', 'v']) assert.equal(appVersionLabel(platform, blank), name);
  }
});
