import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveLastActive, IDLE_MS, shouldGoAway, shouldReturnOnVoice, shouldReturnOnline } from './afkRules.js';

/**
 * Переходы авто-«отошёл».
 *
 * Повод: статус уходил в «отошёл» и НЕ возвращался, хотя человек вернулся, шевелил мышкой и
 * разговаривал в голосе. Часть причин была в наборе отслеживаемых событий (движение мыши и речь
 * не считались активностью), часть — вот в этих переходах: признак «увели мы» жил в памяти модуля
 * и терялся при перезагрузке, после чего вернуть статус было уже некому.
 */
const МИН = 60 * 1000;

describe('уход в «отошёл»', () => {
  const базовые = { now: 100 * МИН, status: 'online', autoAway: false };

  it('уводит после десяти минут простоя', () => {
    assert.equal(shouldGoAway({ ...базовые, lastActive: 100 * МИН - 10 * МИН }), true);
  });

  it('не уводит раньше срока', () => {
    assert.equal(shouldGoAway({ ...базовые, lastActive: 100 * МИН - 9 * МИН }), false);
  });

  it('не уводит повторно, если уже увели', () => {
    assert.equal(shouldGoAway({ ...базовые, lastActive: 0, autoAway: true }), false);
  });

  for (const status of ['dnd', 'invisible', 'away']) {
    it(`не трогает статус «${status}», поставленный руками`, () => {
      assert.equal(shouldGoAway({ ...базовые, lastActive: 0, status }), false);
    });
  }

  it('не трогает, когда статус вообще неизвестен', () => {
    assert.equal(shouldGoAway({ ...базовые, lastActive: 0, status: undefined }), false);
  });
});

describe('возврат в «в сети»', () => {
  it('возвращает, если в «отошёл» увели мы', () => {
    assert.equal(shouldReturnOnline({ status: 'away', autoAway: true }), true);
  });

  it('НЕ трогает «отошёл», поставленный руками', () => {
    assert.equal(shouldReturnOnline({ status: 'away', autoAway: false }), false);
  });

  it('не дёргает статус, если он и так «в сети»', () => {
    assert.equal(shouldReturnOnline({ status: 'online', autoAway: true }), false);
  });

  it('не перетирает «не беспокоить», даже если флаг остался', () => {
    assert.equal(shouldReturnOnline({ status: 'dnd', autoAway: true }), false);
  });
});

describe('сценарий из жалобы', () => {
  it('ушёл → увели → вернулся: статус обязан вернуться', () => {
    const lastActive = 0;
    const now = 11 * МИН;
    assert.equal(shouldGoAway({ now, lastActive, status: 'online', autoAway: false }), true, 'должен был уйти');
    // человек вернулся: признак «увели мы» сохранён (в т.ч. переживает перезагрузку)
    assert.equal(shouldReturnOnline({ status: 'away', autoAway: true }), true, 'должен был вернуться');
  });

  it('перезагрузка между уходом и возвратом не ломает возврат', () => {
    // Раньше признак жил в памяти модуля: перезагрузил вкладку — и вернуть статус уже некому.
    // Здесь он читается из хранилища, поэтому после перезагрузки условие всё ещё истинно.
    assert.equal(shouldReturnOnline({ status: 'away', autoAway: true }), true);
  });
});

describe('совмещение активности веба и операционной системы', () => {
  it('без системного API время веб-активности возвращается без изменений', () => {
    // Ловит изменение прежнего поведения в вебе и Android, где osIdleMs недоступен.
    assert.equal(effectiveLastActive({ webLastActive: 12_345, osIdleMs: null, now: 99_999 }), 12_345);
  });

  it('более свежий ввод в ОС перебивает старую веб-активность', () => {
    // Ловит ложный away во время игры, когда события клавиатуры не доходят до DOM.
    assert.equal(effectiveLastActive({ webLastActive: 1_000, osIdleMs: 2_000, now: 10_000 }), 8_000);
  });

  it('более свежая веб-активность перебивает простой ввода в ОС', () => {
    // Ловит ложный away во время разговора или нажатия глобального микрофонного хоткея.
    assert.equal(effectiveLastActive({ webLastActive: 9_000, osIdleMs: 5_000, now: 10_000 }), 9_000);
  });

  it('из двух старых источников берётся более свежий, но порог away сохраняется', () => {
    // Ловит выбор более старого источника, который преждевременно уводит человека в away.
    const now = 20 * МИН;
    const effective = effectiveLastActive({ webLastActive: 2 * МИН, osIdleMs: 15 * МИН, now });
    assert.equal(effective, 5 * МИН);
    assert.equal(shouldGoAway({ now, lastActive: effective, status: 'online', autoAway: false }), true);
    assert.ok(now - effective >= IDLE_MS);
  });

  it('нулевой системный простой означает активность прямо сейчас', () => {
    // Ловит falsy-проверку, которая перепутает 0 с отсутствующим системным значением.
    assert.equal(effectiveLastActive({ webLastActive: 1_000, osIdleMs: 0, now: 10_000 }), 10_000);
  });
});

describe('shouldReturnOnVoice — голос отменяет «отошёл» (04.09)', () => {
  it('снимает «отошёл» независимо от того, кто его поставил', () => {
    // Ручной статус здесь снимается ОСОЗНАННО: человек, который говорит в канале, опроверг своё
    // «меня нет». Заодно это лечит любое застревание — первое слово возвращает в сеть.
    assert.equal(shouldReturnOnVoice('away'), true);
  });

  it('не трогает «не беспокоить» и «невидимку» — они не про присутствие', () => {
    assert.equal(shouldReturnOnVoice('dnd'), false);
    assert.equal(shouldReturnOnVoice('invisible'), false);
  });

  it('на «в сети» и пустом статусе делать нечего', () => {
    assert.equal(shouldReturnOnVoice('online'), false);
    assert.equal(shouldReturnOnVoice(undefined), false);
  });
});
