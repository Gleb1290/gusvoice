import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import catalog from './games.json';
import { exeBasename, isKnownGame, matchRunningGame } from './gameDetect.js';

describe('определение игры по процессу', () => {
  it('Windows- и Unix-пути сводятся к lowercase basename', () => {
    // Ловит публикацию полного локального пути либо промах каталога из-за регистра и разделителей.
    assert.equal(exeBasename('  C:\\Games\\DOTA2.EXE  '), 'dota2.exe');
    assert.equal(exeBasename('/opt/games/CS2.EXE'), 'cs2.exe');
    assert.equal(exeBasename('C:\\Games\\'), 'games');
  });

  it('известная игра находится по полному пути и возвращает метаданные каталога', () => {
    // Ловит ситуацию, когда нативный shell отдаёт путь, а поиск умеет только голое имя процесса.
    assert.deepEqual(matchRunningGame(['C:\\Steam\\steam.exe', 'D:\\SteamLibrary\\dota2.exe']), {
      exe: 'dota2.exe',
      name: 'Dota 2',
      appId: 570,
    });
  });

  it('неизвестные и пустые процессы не превращаются в игровую активность', () => {
    // Ловит утечку названий произвольных приложений вроде браузера в статус пользователя.
    assert.equal(matchRunningGame(['chrome.exe', 'explorer.exe', '']), null);
    assert.equal(matchRunningGame([]), null);
  });

  it('при нескольких играх побеждает первая в порядке foreground-first', () => {
    // Ловит недетерминированный выбор фоновой игры вместо текущего активного окна.
    assert.equal(matchRunningGame(['CS2.EXE', 'dota2.exe'])?.name, 'Counter-Strike 2');
    assert.equal(matchRunningGame(['dota2.exe', 'CS2.EXE'])?.name, 'Dota 2');
  });

  it('каждая живая запись каталога узнаётся с точными name и appId', () => {
    // Ловит битую запись внешнего games.json, которую рассуждением о нескольких примерах не заметить.
    for (const [exe, expected] of Object.entries(catalog)) {
      assert.equal(isKnownGame(`C:\\Games\\${exe.toUpperCase()}`), true);
      assert.deepEqual(matchRunningGame([exe]), {
        exe,
        name: expected.name,
        appId: 'appId' in expected ? expected.appId : undefined,
      });
    }
    assert.equal(isKnownGame('not-a-game.exe'), false);
  });
});
