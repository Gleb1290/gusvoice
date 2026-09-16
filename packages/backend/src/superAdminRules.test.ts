import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claimsAreSuperAdmin, decideSuperAdminBinding, isSuperAdminId } from './superAdminRules.js';

describe('супер-админ — человек по id, а не логин (#140)', () => {
  it('тот же логин, но другой id — не супер-админ', () => {
    // Ловит возврат к сравнению логинов: на инстансе друга можно завести такой же логин.
    assert.equal(isSuperAdminId('impostor-id', 'real-id'), false);
    assert.equal(isSuperAdminId('real-id', 'real-id'), true);
  });

  it('без привязки супер-админа нет ни у кого, включая пустой id', () => {
    // Ловит «пустая строка равна пустой строке» — выдачу прав при непривязанном инстансе.
    assert.equal(isSuperAdminId('', null), false);
    assert.equal(isSuperAdminId(undefined, null), false);
    assert.equal(isSuperAdminId('', ''), false);
  });

  it('токен с подменённым username, но чужим sub — не супер-админ', () => {
    // Ловит проверку прав по полю username из JWT.
    assert.equal(claimsAreSuperAdmin({ sub: 'someone-else', username: 'SuperGoose' }, 'real-id'), false);
    assert.equal(claimsAreSuperAdmin({ sub: 'real-id', username: 'renamed' }, 'real-id'), true);
  });
});

describe('привязка супер-админа при старте', () => {
  it('привязанный id выигрывает у логина из env, даже если логин теперь у другого', () => {
    // Ловит повторный поиск по SUPERADMIN_USERNAME на каждом старте: смена .env молча
    // передавала бы инстанс другому человеку.
    const d = decideSuperAdminBinding({
      storedId: 'real-id',
      storedExists: true,
      envUsername: 'SuperGoose',
      usernameMatchId: 'impostor-id',
    });
    assert.equal(d.superAdminId, 'real-id');
    assert.equal(d.persist, false);
  });

  it('первая привязка по точному логину записывается один раз', () => {
    // Ловит забытую запись: без неё привязка по логину происходила бы на каждом старте.
    const d = decideSuperAdminBinding({
      storedId: null,
      storedExists: false,
      envUsername: 'SuperGoose',
      usernameMatchId: 'real-id',
    });
    assert.equal(d.superAdminId, 'real-id');
    assert.equal(d.persist, true);
  });

  it('пропавший привязанный аккаунт не заменяется поиском по логину', () => {
    // Ловит «автоматика назначила нового супер-админа, потому что старого не нашла».
    const d = decideSuperAdminBinding({
      storedId: 'gone-id',
      storedExists: false,
      envUsername: 'SuperGoose',
      usernameMatchId: 'impostor-id',
    });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
  });

  it('повреждённая запись оставляет инстанс без супер-админа и требует внимания', () => {
    // Ловит трактовку битого JSON как отсутствующей настройки с тихой новой привязкой.
    const d = decideSuperAdminBinding({
      storedId: null,
      storedMalformed: true,
      storedExists: false,
      envUsername: '',
      usernameMatchId: null,
    });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
    assert.match(d.log?.message ?? '', /повреждена/);
  });

  it('повреждённая запись сильнее совпавшего логина из env', () => {
    // Ловит повторную выдачу прав по изменяемому env, пока занятая битая строка не перезаписывается.
    const d = decideSuperAdminBinding({
      storedId: null,
      storedMalformed: true,
      storedExists: false,
      envUsername: 'SuperGoose',
      usernameMatchId: 'matched-id',
    });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
  });

  it('логин задан, аккаунта нет — никого и громко в лог, без записи', () => {
    const d = decideSuperAdminBinding({ storedId: null, storedExists: false, envUsername: 'admin', usernameMatchId: null });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
  });

  it('пустой env и нет привязки — никого и молча', () => {
    const d = decideSuperAdminBinding({ storedId: null, storedExists: false, envUsername: '', usernameMatchId: null });
    assert.deepEqual(d, { superAdminId: null, persist: false, log: null });
  });
});
