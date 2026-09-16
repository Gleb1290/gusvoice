import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStreamCue } from './streamCue.js';

/**
 * Звуки показа при моргании трека (#111).
 *
 * Проверяем ОБА направления, потому что ошибка в любую сторону заметна людям: не заглушим — канал
 * пикает на каждое самолечение; заглушим лишнего — настоящий конец показа пройдёт молча.
 */

/** Стенд с ручными таймерами: время двигаем сами, ждать по-настоящему нечего. */
function стенд(graceMs = 3000) {
  const played: string[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  let now = 0;
  const cue = createStreamCue({
    play: (e) => played.push(e),
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    graceMs,
  });
  return {
    cue,
    played,
    /** Промотать время; сработавшие таймеры выполняются. */
    промотать(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    живых: () => timers.size,
  };
}

describe('показ вернулся быстро (самолечение)', () => {
  it('молчит полностью — ни «конец», ни «начало»', () => {
    const s = стенд();
    s.cue.gone('masha');
    s.промотать(1200); // пересоздание публикации уложилось в грейс
    s.cue.back('masha');
    s.промотать(10_000);
    assert.deepEqual(s.played, []);
  });

  it('не оставляет висящих таймеров', () => {
    const s = стенд();
    s.cue.gone('masha');
    s.cue.back('masha');
    assert.equal(s.живых(), 0);
  });

  it('три лечения подряд так же беззвучны', () => {
    const s = стенд();
    for (let i = 0; i < 3; i += 1) {
      s.cue.gone('masha');
      s.промотать(900);
      s.cue.back('masha');
      s.промотать(30_000);
    }
    assert.deepEqual(s.played, []);
  });
});

describe('показ закончился по-настоящему', () => {
  it('даёт «конец стрима» после грейса', () => {
    const s = стенд();
    s.cue.gone('petya');
    s.промотать(2999);
    assert.deepEqual(s.played, [], 'до грейса молчим');
    s.промотать(2);
    assert.deepEqual(s.played, ['streamStop']);
  });

  it('срабатывает ровно на границе грейса', () => {
    // Ловит строгую проверку `<` вместо включительной границы таймера: в реальном браузере callback
    // может прийти ровно в назначенную миллисекунду.
    const s = стенд();
    s.cue.gone('petya');
    s.промотать(3000);
    assert.deepEqual(s.played, ['streamStop']);
  });

  it('вернувшийся ПОСЛЕ грейса — это новый показ, звучат оба события', () => {
    const s = стенд();
    s.cue.gone('petya');
    s.промотать(5000);
    s.cue.back('petya');
    assert.deepEqual(s.played, ['streamStop', 'stream']);
  });
});

describe('повторное событие пропажи трека', () => {
  it('не заводит второй таймер и не играет двойной конец стрима', () => {
    // LiveKit может прислать повторное удаление при пересогласовании. Два таймера дали бы два
    // одинаковых звука, хотя показ у человека закончился один раз.
    const s = стенд();
    s.cue.gone('petya');
    s.cue.gone('petya');
    assert.equal(s.живых(), 1);
    s.промотать(3000);
    assert.deepEqual(s.played, ['streamStop']);
  });
});

describe('обычное начало показа', () => {
  it('звучит сразу, без всякого грейса', () => {
    const s = стенд();
    s.cue.back('petya');
    assert.deepEqual(s.played, ['stream']);
  });
});

describe('участники не путаются', () => {
  it('возврат одного не глушит конец показа другого', () => {
    const s = стенд();
    s.cue.gone('masha');
    s.cue.gone('petya');
    s.промотать(1000);
    s.cue.back('masha'); // лечение у Masha
    s.промотать(5000);
    assert.deepEqual(s.played, ['streamStop'], 'молчит за Masha, звучит за Petya');
  });
});

describe('уход из канала', () => {
  it('снимает отложенный звук молча', () => {
    const s = стенд();
    s.cue.gone('petya');
    s.cue.dispose();
    s.промотать(10_000);
    assert.deepEqual(s.played, []);
    assert.equal(s.живых(), 0);
  });
});
