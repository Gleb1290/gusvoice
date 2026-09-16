import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPreviewPublisher } from './streamPreviewPublisher.js';

/**
 * Цикл отправки своего превью показа (#115).
 *
 * Проверяется ровно то, из-за чего цикл вообще написан отдельным модулем: он крутится ВСЁ время в
 * канале, поэтому обязан молчать в трёх разных случаях — показа нет, тумблер выключен, кадр негодный —
 * и обязан переживать сбои, не прекращая тикать.
 */

const png = 'data:image/png;base64,AAAA';

/** Дать отработать всем висящим промисам: такт асинхронный, а время мы двигаем сами. */
const продышаться = () => new Promise((r) => setImmediate(r));

function стенд(opts: { frames?: (string | null)[]; enabled?: () => boolean; sendFails?: boolean } = {}) {
  const sent: string[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  let now = 0;
  let grabs = 0;
  const frames = opts.frames;

  const publisher = createPreviewPublisher({
    grab: async () => {
      // ⚠️ Без `??`: `null` в списке — это ОСМЫСЛЕННОЕ «показа нет», и слить его с «список кончился»
      // значило бы, что стенд молча подменяет проверяемый случай.
      const f = frames ? (grabs < frames.length ? frames[grabs] : frames[frames.length - 1]) : png;
      grabs += 1;
      return f;
    },
    send: async (image) => {
      if (opts.sendFails) throw new Error('сеть');
      sent.push(image);
    },
    enabled: opts.enabled ?? (() => true),
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    everyMs: 5000,
  });

  return {
    publisher,
    sent,
    grabs: () => grabs,
    живых: () => timers.size,
    /** Промотать время и дождаться, пока сработавшие такты договорят. */
    async промотать(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
      await продышаться();
    },
  };
}

describe('обычная работа', () => {
  it('отправляет кадр каждый такт', async () => {
    const s = стенд();
    s.publisher.start();
    await s.промотать(5000);
    await s.промотать(5000);
    assert.deepEqual(s.sent, [png, png]);
  });

  it('до первого такта не шлёт ничего — старт не должен бить запросом сразу', async () => {
    const s = стенд();
    s.publisher.start();
    assert.deepEqual(s.sent, []);
  });
});

describe('когда слать нечего', () => {
  it('показа нет — такт пропускается, но цикл продолжается', async () => {
    // `null` от источника = «показа нет». Это норма, а не сбой: цикл живёт на канале, а не на показе.
    const s = стенд({ frames: [null, png] });
    s.publisher.start();
    await s.промотать(5000);
    assert.deepEqual(s.sent, [], 'первый такт молчит');
    await s.промотать(5000);
    assert.deepEqual(s.sent, [png], 'второй уже шлёт');
  });

  it('негодный кадр не уходит на сервер', async () => {
    const s = стенд({ frames: ['data:image/svg+xml;base64,AAAA'] });
    s.publisher.start();
    await s.промотать(5000);
    assert.deepEqual(s.sent, []);
  });
});

describe('тумблер приватности', () => {
  it('выключен — не шлём и даже не снимаем кадр', async () => {
    const s = стенд({ enabled: () => false });
    s.publisher.start();
    await s.промотать(5000);
    assert.deepEqual(s.sent, []);
    assert.equal(s.grabs(), 0, 'снимать кадр, который некуда девать, незачем');
  });

  it('включён посреди показа — заработало со следующего такта', async () => {
    // Тумблер спрашивается на КАЖДОМ тике. Прочитай мы его один раз при старте, человек, включивший
    // превью во время показа, не увидел бы эффекта до перезахода в канал.
    let on = false;
    const s = стенд({ enabled: () => on });
    s.publisher.start();
    await s.промотать(5000);
    assert.deepEqual(s.sent, []);
    on = true;
    await s.промотать(5000);
    assert.deepEqual(s.sent, [png]);
  });
});

describe('живучесть', () => {
  it('провал отправки не убивает цикл', async () => {
    const s = стенд({ sendFails: true });
    s.publisher.start();
    await s.промотать(5000);
    await s.промотать(5000);
    assert.equal(s.grabs(), 2, 'после сбоя такт всё равно запланирован заново');
  });

  it('следующий такт планируется только ПОСЛЕ текущего — запросы не наслаиваются', async () => {
    const s = стенд();
    s.publisher.start();
    assert.equal(s.живых(), 1);
    await s.промотать(5000);
    assert.equal(s.живых(), 1, 'ровно один запланированный такт, а не два');
  });
});

describe('остановка', () => {
  it('stop снимает таймер и прекращает отправку', async () => {
    const s = стенд();
    s.publisher.start();
    s.publisher.stop();
    assert.equal(s.живых(), 0);
    await s.промотать(20_000);
    assert.deepEqual(s.sent, []);
  });

  it('второй start не заводит второй цикл', async () => {
    // Иначе перерисовка сцены удваивала бы частоту отправки, и так на каждый ререндер.
    const s = стенд();
    s.publisher.start();
    s.publisher.start();
    assert.equal(s.живых(), 1);
  });

  it('stop дважды безвреден', () => {
    const s = стенд();
    s.publisher.start();
    s.publisher.stop();
    s.publisher.stop();
    assert.equal(s.живых(), 0);
  });
});
