import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchSettings, visibleSections, type SettingsSection } from './settingsNav.js';

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

describe('чёрный список в настройках аккаунта', () => {
  it('группа видима в аккаунте и находится по словам блокировки', () => {
    // Ловит серверную возможность без достижимого экрана управления и запись поиска без живой группы.
    const sections = visibleSections({ federation: false, desktop: false, mobile: false });
    const account = sections.find((s) => s.key === 'account');
    assert.equal(account?.groups.some((g) => g.id === 'set-g-blocked'), true);
    assert.deepEqual(searchSettings('заблокированные', sections).map((x) => x.id), ['set-g-blocked']);
  });
});
