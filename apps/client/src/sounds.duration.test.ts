import assert from 'node:assert/strict';
import { it } from 'node:test';
import { load, edited, sourceOf, type Edit } from './predictions.harness';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
function paired(source: string, check: (raw: string) => void, edits: readonly Edit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
        const mutant = edited(source, edit);
        assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
          'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}

const source = sourceOf('./sounds.ts');
const P = 'R351 длина звука: ';
type Sounds = typeof import('./sounds');

function fixture(raw: string) {
  const durations = new Map<string, number>();
  class Audio {
    currentTime = 0; volume = 0; preload = '';
    constructor(readonly url: string) {}
    get duration() { return durations.get(this.url) ?? Number.NaN; }
    async play() {}
  }
  // Выполняется весь sounds.ts: кэши заполняет настоящий playSound, а не тестовая копия soundDurationMs.
  const api = load<Sounds>(raw, { './voiceKeepAlive': { sharedAudioContext: () => null } }, {
    Audio, window: {}, localStorage: { getItem: () => null, setItem() {} },
  });
  function prime(url: string, seconds: number) {
    durations.set(url, seconds);
    api.registerBuiltinSound('wheelJackpot', url);
    api.playSound('wheelJackpot');
  }
  return { api, prime, durations };
}
function test(title: string, check: (f: ReturnType<typeof fixture>) => void, edits: Edit[]) {
  it(`R351 ${title}`, () => paired(source, raw => check(fixture(raw)), edits, P));
}

// Кастомный выстрел может быть другой длины: свечение должно следовать реально выбранной записи.
test('своя длина главнее вшитой, после снятия пака снова берётся вшитая', f => {
  f.prime('/builtin.ogg', 9.9);
  f.prime('/custom.ogg', 12.3456);
  f.api.registerBuiltinSound('wheelJackpot', '/builtin.ogg');
  f.api.setCustomSounds({ wheelJackpot: '/custom.ogg' });
  assert.equal(f.api.soundDurationMs('wheelJackpot'), 12_346, P + 'выбрана пользовательская запись с округлением до мс');
  f.api.setCustomSounds(undefined);
  assert.equal(f.api.soundDurationMs('wheelJackpot'), 9_900, P + 'снятие пака возвращает вшитую длину');
}, [['const url = customSounds[event] || BUILTIN[event];', 'const url = BUILTIN[event] || customSounds[event];'],
  ['Math.round(sec * 1000)', 'Math.floor(sec * 1000)']]);

// Неизвестная длина своей записи не даёт права подставить длину другого, вшитого выстрела.
test('незагруженная своя запись не наследует известную длину вшитой', f => {
  f.prime('/builtin.ogg', 9.9);
  f.api.setCustomSounds({ wheelJackpot: '/not-loaded.ogg' });
  assert.equal(f.api.soundDurationMs('wheelJackpot'), null, P + 'неизвестная пользовательская запись остаётся неизвестной');
  f.api.setCustomSounds(undefined);
  assert.equal(f.api.soundDurationMs('wheelJackpot'), 9_900, P + 'длина существующей вшитой записи известна');
}, [['const url = customSounds[event] || BUILTIN[event];', 'const url = BUILTIN[event] || customSounds[event];']]);

// Поток/ошибка метаданных не должны превращать свечение в бесконечное или отрицательное ожидание.
test('неизвестная, бесконечная, нулевая и отрицательная длины дают null, положительная принимается', f => {
  assert.equal(f.api.soundDurationMs('wheelJackpot'), null, P + 'нет записи — нет выдуманной длины');
  f.api.registerBuiltinSound('wheelJackpot', '/metadata.ogg');
  assert.equal(f.api.soundDurationMs('wheelJackpot'), null, P + 'до метаданных длина неизвестна');
  for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
    f.prime('/metadata.ogg', seconds);
    assert.equal(f.api.soundDurationMs('wheelJackpot'), null, P + `негодная длина ${seconds} отвергнута`);
  }
  f.prime('/metadata.ogg', 0.001);
  assert.equal(f.api.soundDurationMs('wheelJackpot'), 1, P + 'одна миллисекунда — допустимая положительная длина');
}, [['Number.isFinite(sec) && sec > 0', 'sec > 0'], ['Number.isFinite(sec) && sec > 0', 'Number.isFinite(sec)']]);
