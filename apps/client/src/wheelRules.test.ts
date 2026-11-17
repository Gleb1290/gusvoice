import { counterfact as guardCounterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as actual from './wheelRules.js';
import type { WheelView } from './wheelRules.js';
import type { WheelBetRefusal } from '../../../packages/backend/src/gameWheelRules.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./wheelRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function load(raw: string): Rules {
  const module = { exports: {} };
  // Исполняется весь настоящий модуль: VM не получает React, стор, сеть или копии проверяемых функций.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) {
      if (id === '@gusvoice/shared') return shared;
      assert.fail(`R329 подготовка: неожиданный импорт wheelRules ${id}`);
    },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

async function counterfact(check: (rules: Rules) => void | Promise<void>, mutations: Mutation | Mutation[]): Promise<void> {
  await check(actual);
  await check(load(source));
  await guardCounterfact(async () => {
    for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {
      assert.equal(source.split(from).length, 2, `R329 подготовка: единственный якорь ${from}`);
      const changed = source.replace(from, to);
      assert.notEqual(changed, source, 'R329 подготовка: мутант действительно меняет модуль');
      await assert.rejects(async () => { await check(load(changed)); }, (error: unknown) =>
        error instanceof assert.AssertionError && error.message.startsWith('R329 проверка:'),
      'мутант обязан падать на адресной проверке поведения, не на синтаксисе/импорте/VM');
      await check(load(source));
    }
  });
}

const now = Date.parse('2026-10-28T16:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const round = (state: 'open' | 'locked', extra: Partial<shared.WheelRoundDto> = {}): shared.WheelRoundDto => ({
  id: 'round', state, lockAt: iso(30_000), settleAt: state === 'locked' ? iso(6_000) : null,
  commit: 'public-commit', sector: state === 'locked' ? 2 : null, bets: [], ...extra,
});
const view = (extra: Partial<WheelView> = {}): WheelView => ({
  serverId: 'server', serverNow: iso(0), enabled: true, betMax: 300, jackpot: 0,
  round: null, last: null, cooldownUntil: null, skewMs: 0, ...extra,
});
const mod360 = (angle: number) => ((angle % 360) + 360) % 360;
const hash = (text: string): Uint8Array => createHash('sha256').update(text, 'utf8').digest();
const digest = async (text: string): Promise<Uint8Array> => hash(text);
describe('R343 навязанный джекпот не маскируется под честный', () => {
  it('верные хеши навязанного раунда дают bad и явную подпись dev', async () => {
    await counterfact(r => {
      const result = r.wheelVerdictView({ ok: true, sector: 1 }, { sector: 1, forced: true });
      assert.equal(result.tone, 'bad', 'R329 проверка: forced не получает зелёную галку');
      assert.equal(result.text.includes('принудительный (dev)'), true, 'R329 проверка: человек видит dev-причину');
    }, { from: 'return result.forced === true', to: 'return false' });
  });
  it('обычный и старый итог без forced остаются зелёными', async () => {
    await counterfact(r => {
      for (const forced of [false, undefined]) {
        const result = r.wheelVerdictView({ ok: true, sector: 1 }, { sector: 1, forced });
        assert.equal(result.tone, 'ok', 'R329 проверка: честный раунд не помечен как навязанный');
        assert.equal(result.text.startsWith('✓'), true, 'R329 проверка: честная проверка имеет галку');
      }
    }, { from: 'return result.forced === true', to: 'return true' });
  });
  it('forced не прячет отсутствие SHA256, неверный commit и сектор', async () => {
    await counterfact(r => {
      for (const [verdict, needle] of [[{ ok: false, why: 'unavailable' }, 'не умеет считать хеш'],
        [{ ok: false, why: 'commit' }, 'не открывает замок'], [{ ok: false, why: 'sector', sector: 3 }, 'сектор 3, а не 1']] as const) {
        const result = r.wheelVerdictView(verdict, { sector: 1, forced: true });
        assert.equal(result.tone, 'bad', 'R329 проверка: плохая проверка не превращается в успех');
        assert.equal(result.text.includes(needle), true, 'R329 проверка: исходная причина ошибки не потеряна');
      }
    }, { from: 'if (verdict.ok) {', to: 'if (verdict.ok || result.forced) {' });
  });
});
const proof = (id = 'раунд-🪿', seed = '0123456789abcdef'.repeat(4)) => ({
  id, seed, commit: Buffer.from(hash(`gv-wheel-commit:${id}:${seed}`)).toString('hex'),
  sector: shared.sectorFromHash(hash(`gv-wheel-sector:${id}:${seed}`)),
});

describe('R329 колесо попадает в сектор без обратного рывка', () => {
  it('все 25 секторов достижимы из отрицательных, дробных и многовитковых текущих углов', async () => {
    // Модуль совпадает и у неверного target=rest: отдельно проверяем пройденный путь и отсутствие отката.
    await counterfact(r => {
      for (let sector = 0; sector < 25; sector++) {
        for (const from of [-7200.25, -361, -0.5, 0, 14.4, 359.75, 720, 36_000.125]) {
          for (const turns of [0, 1, 5, 12]) {
            const target = r.spinTarget(from, sector, turns);
            const difference = Math.abs(mod360(target) - shared.wheelRestAngle(sector));
            assert.ok(Math.min(difference, 360 - difference) < 1e-7, 'R329 проверка: нужный сектор под указателем');
            assert.ok(target >= from + turns * 360 - 1e-7, 'R329 проверка: обязательные обороты без движения назад');
            assert.ok(target < from + (turns + 1) * 360 + 1e-7, 'R329 проверка: нет лишнего полного оборота');
          }
        }
      }
    }, [
      { from: 'return base + ((((rest - base) % 360) + 360) % 360);', to: 'return base + (rest - base);' },
      { from: 'const base = fromDeg + Math.max(0, Math.floor(turns)) * 360;', to: 'const base = fromDeg;' },
      { from: 'const rest = wheelRestAngle(sector);', to: 'const rest = wheelRestAngle((sector + 1) % 25);' },
    ]);
  });

  it('дробные обороты округляются вниз, отрицательные не заставляют крутиться назад', async () => {
    await counterfact(r => {
      for (const from of [-361.5, 0, 8000]) for (const sector of [0, 12, 24]) {
        const zero = r.spinTarget(from, sector, 0);
        assert.equal(r.spinTarget(from, sector, -2), zero, 'R329 проверка: отрицательное число оборотов равно нулю');
        assert.ok(Math.abs(r.spinTarget(from, sector, 2.9) - zero - 720) < 1e-7,
          'R329 проверка: дробные обороты не округляются вверх');
      }
    }, { from: 'Math.max(0, Math.floor(turns))', to: 'Math.max(0, Math.round(turns))' });
  });

  it('вход посреди вращения сокращает обороты, но оставляет хотя бы один и не больше пяти', async () => {
    await counterfact(r => {
      assert.deepEqual([-1, 0, 600, 1800, 3000, 5400, 6000, 12_000].map(ms => r.spinTurns(ms)),
        [1, 1, 1, 2, 3, 5, 5, 5], 'R329 проверка: обороты соответствуют остатку анимации');
    }, [
      { from: 'Math.min(leftMs, WHEEL_SPIN_MS)', to: 'leftMs' },
      { from: 'Math.max(1, Math.round((5 * Math.min(leftMs, WHEEL_SPIN_MS)) / WHEEL_SPIN_MS))',
        to: 'Math.max(0, Math.round((5 * Math.min(leftMs, WHEEL_SPIN_MS)) / WHEEL_SPIN_MS))' },
    ]);
  });
});

describe('R329 щелчки следуют за движением колеса', () => {
  it('времена конечны, целые, не убывают и остаются внутри длительности даже при округлённых дублях', async () => {
    await counterfact(r => {
      for (const [from, to] of [[-721.25, 2200], [0, 1800], [345.2, 723.4], [36_000, 37_700]]) {
        for (const duration of [1, 11, 6000]) {
          const times = r.tickTimes(from, to, duration);
          assert.ok(times.length > 1, 'R329 проверка: положительный путь имеет щелчки');
          times.forEach((time, i) => {
            assert.ok(Number.isFinite(time) && Number.isInteger(time) && time >= 0 && time <= duration,
              'R329 проверка: щелчок внутри анимации');
            assert.ok(i === 0 || time >= times[i - 1], 'R329 проверка: щелчки не идут в обратном порядке');
          });
        }
      }
    }, { from: 'out.push(Math.round(x * durationMs));', to: 'out.unshift(Math.round(x * durationMs));' });
  });

  it('число щелчков соответствует границам по 14,4°, старт и финиш сами не щёлкают', async () => {
    await counterfact(r => {
      for (const [from, to] of [[-721.25, -2], [0, 1800], [4, 5000], [36_000.125, 36_300]]) {
        const count = r.tickTimes(from, to, 6000).length;
        assert.ok(Math.abs(count - (to - from) / 14.4) <= 1, 'R329 проверка: число щелчков по фактическому пути');
      }
      assert.equal(r.tickTimes(0, 90, 1000, 30).length, 2, 'R329 проверка: только внутренние границы 30 и 60');
      assert.equal(r.tickTimes(1, 29, 1000, 30).length, 0, 'R329 проверка: без пересечённой границы нет щелчка');
    }, [
      { from: 'stepDeg = 360 / WHEEL_SECTORS.length', to: 'stepDeg = 720 / WHEEL_SECTORS.length' },
      { from: 'let next = (Math.floor(fromDeg / stepDeg) + 1) * stepDeg;', to: 'let next = Math.floor(fromDeg / stepDeg) * stepDeg;' },
      { from: 'while (next < toDeg)', to: 'while (next <= toDeg)' },
    ]);
  });

  it('щелчки используют замедление, а не линейный ход с тем же количеством звуков', async () => {
    // Сохранить только count недостаточно: линейный звук расходился бы с визуальной кривой CSS.
    await counterfact(r => {
      const times = r.tickTimes(0, 360, 6000, 90);
      assert.equal(times.length, 3, 'R329 проверка: три внутренние четверти оборота');
      times.forEach((time, i) => assert.ok(time < (i + 1) * 1500, 'R329 проверка: ease-out проходит границы раньше линейного хода'));
      const twice = r.tickTimes(0, 360, 12_000, 90);
      times.forEach((time, i) => assert.ok(Math.abs(twice[i] - time * 2) <= 1,
        'R329 проверка: время масштабируется с длительностью, не с номером щелчка'));
    }, { from: 'out.push(Math.round(x * durationMs));', to: 'out.push(Math.round(yTarget * durationMs));' });
  });

  it('нулевой и обратный путь, нулевая и отрицательная длительность дают тишину рядом с настоящим вращением', async () => {
    await counterfact(r => {
      for (const [from, to, duration] of [[0, 0, 6000], [90, 0, 6000], [0, 90, 0], [0, 90, -1], [0, 90, NaN]]) {
        assert.deepEqual(normal(r.tickTimes(from, to, duration)), [], 'R329 проверка: без времени или движения нет щелчков');
      }
      assert.ok(r.tickTimes(0, 90, 1).length > 0, 'R329 проверка: короткая положительная длительность принята');
    }, { from: 'if (!(total > 0) || !(durationMs > 0)) return [];', to: 'if (!(total > 0) || !(durationMs >= 0)) return [];' });
  });
});

describe('R329 фаза и сроки считаются по часам сервера', () => {
  it('open важнее паузы и остаётся открытым с нулём на границе и после неё; знак skew верный в обе стороны', async () => {
    await counterfact(r => {
      for (const skewMs of [-5000, 0, 5000]) {
        const input = view({ round: round('open'), cooldownUntil: iso(60_000), skewMs });
        for (const offset of [29_999, 30_000, 30_001]) {
          assert.deepEqual(normal(r.wheelPhase(input, now + offset - skewMs)),
            { kind: 'open', leftMs: Math.max(0, 30_000 - offset) }, 'R329 проверка: open и точный серверный остаток');
        }
      }
    }, [
      { from: 'const now = nowMs + view.skewMs;', to: 'const now = nowMs - view.skewMs;' },
      { from: "if (r?.state === 'open')", to: "if (r?.state === 'open' && false)" },
    ]);
  });

  it('locked важнее паузы: срок вращения обнуляется, а отсутствующий или битый срок не даёт NaN', async () => {
    await counterfact(r => {
      for (const offset of [5999, 6000, 6001]) {
        assert.deepEqual(normal(r.wheelPhase(view({ round: round('locked'), cooldownUntil: iso(60_000) }), now + offset)),
          { kind: 'spinning', leftMs: Math.max(0, 6000 - offset) }, 'R329 проверка: вращение до срока и после срока');
      }
      for (const settleAt of [null, 'битая-дата']) {
        assert.deepEqual(normal(r.wheelPhase(view({ round: round('locked', { settleAt }) }), now)),
          { kind: 'spinning', leftMs: 0 }, 'R329 проверка: неизвестный срок вращения безопасно обнулён');
      }
    }, [
      { from: "if (r?.state === 'locked')", to: "if (r?.state === 'locked' && false)" },
      { from: 'Number.isFinite(settle) ? Math.max(0, settle - now) : 0', to: 'Math.max(0, settle - now)' },
    ]);
  });

  it('пауза исчезает ровно в срок по серверным часам и ограничена двадцатью секундами', async () => {
    await counterfact(r => {
      for (const skewMs of [-5000, 0, 5000]) {
        const input = view({ cooldownUntil: iso(10_000), skewMs });
        assert.deepEqual(normal(r.wheelPhase(input, now + 9999 - skewMs)), { kind: 'cooldown', leftMs: 1 },
          'R329 проверка: последняя миллисекунда паузы ещё видна');
        for (const offset of [10_000, 10_001]) assert.deepEqual(normal(r.wheelPhase(input, now + offset - skewMs)),
          { kind: 'idle' }, 'R329 проверка: на границе пауза закончилась');
      }
      assert.deepEqual(normal(r.wheelPhase(view({ cooldownUntil: iso(20_000) }), now)), { kind: 'cooldown', leftMs: 20_000 },
        'R329 проверка: ровно предельная пауза принята');
      assert.deepEqual(normal(r.wheelPhase(view({ cooldownUntil: iso(20_001) }), now)), { kind: 'cooldown', leftMs: 20_000 },
        'R329 проверка: лишняя миллисекунда ограничена');
    }, [
      { from: 'Number.isFinite(cd) && cd > now', to: 'Number.isFinite(cd) && cd >= now' },
      { from: 'Math.min(cd - now, WHEEL_COOLDOWN_MS * 2)', to: 'cd - now' },
    ]);
  });

  it('без раунда и действующей паузы колесо простаивает, включая битую дату', async () => {
    await counterfact(r => {
      for (const cooldownUntil of [null, '', 'битая-дата', iso(-1)]) {
        assert.deepEqual(normal(r.wheelPhase(view({ cooldownUntil }), now)), { kind: 'idle' }, 'R329 проверка: безопасный простой');
      }
    }, { from: "return { kind: 'idle' };", to: "return { kind: 'cooldown', leftMs: 0 };" });
  });

  it('живой значок есть только у включённого сервера с раундом, а не у последнего итога', async () => {
    await counterfact(r => {
      assert.equal(r.wheelLive(undefined), false, 'R329 проверка: без снимка нет живого колеса');
      assert.equal(r.wheelLive(view()), false, 'R329 проверка: пустой снимок не живой');
      assert.equal(r.wheelLive(view({ enabled: false, round: round('open') })), false, 'R329 проверка: выключенное колесо не живое');
      for (const state of ['open', 'locked'] as const) assert.equal(r.wheelLive(view({ round: round(state) })), true,
        'R329 проверка: каждый живой раунд отмечен');
    }, { from: 'return !!view?.enabled && !!view.round;', to: 'return !!view?.round;' });
  });
});

describe('R329 ставка остаётся в пределах денег и условий сервера', () => {
  it('пресеты включают ровно достигнутую границу и не превышают ни потолок, ни баланс', async () => {
    await counterfact(r => {
      assert.deepEqual(normal(r.BET_PRESETS), [10, 50, 100, 300], 'R329 проверка: согласованный набор быстрых сумм');
      for (const [limit, expected] of [[9, []], [10, [10]], [49, [10]], [50, [10, 50]], [99, [10, 50]],
        [100, [10, 50, 100]], [299, [10, 50, 100]], [300, [10, 50, 100, 300]]] as const) {
        assert.deepEqual(normal(r.betPresets(limit, 1000)), expected, 'R329 проверка: граница потолка пресета');
        assert.deepEqual(normal(r.betPresets(1000, limit)), expected, 'R329 проверка: граница баланса пресета');
      }
      assert.deepEqual(normal(r.betPresets(0, 1000)), [], 'R329 проверка: нулевой потолок без пресетов');
      assert.deepEqual(normal(r.betPresets(1000, -1)), [], 'R329 проверка: отрицательный баланс без пресетов');
    }, [
      { from: 'v <= betMax && v <= balance', to: 'v < betMax && v <= balance' },
      { from: 'v <= betMax && v <= balance', to: 'v <= betMax' },
    ]);
  });

  it('целая монета принимается, дробь округляется вниз, сумма ниже единицы не становится ставкой', async () => {
    await counterfact(r => {
      for (const [raw, expected] of [[-1, 0], [0, 0], [0.999, 0], [1, 1], [1.999, 1], [49.9, 49], [50, 50]]) {
        assert.equal(r.clampBet(raw, 100, 100), expected, 'R329 проверка: нижняя граница и целые монеты');
      }
    }, { from: 'const v = Math.floor(raw);', to: 'const v = Math.ceil(raw);' });
  });

  it('потолок, баланс и заранее переданный остаток проигрыша ограничивают сумму с обеих сторон границы', async () => {
    // Сам helper не знает loss-limit: сцена передаёт min(balance, lossLeft) как готовый cap.
    await counterfact(r => {
      for (const [betMax, balance] of [[7, 100], [100, 7], [7, 7]]) {
        for (const raw of [6, 7, 8]) assert.equal(r.clampBet(raw, betMax, balance), Math.min(raw, 7),
          'R329 проверка: равная граница проходит, превышение срезается');
      }
      for (const lossLeft of [0, 1, 7]) {
        const cap = Math.min(50, lossLeft);
        assert.equal(r.clampBet(40, 100, cap), lossLeft, 'R329 проверка: готовый остаток предела не обходится');
      }
      for (const cap of [0, -1]) assert.equal(r.clampBet(10, cap, 100), 0, 'R329 проверка: неположительный потолок не даёт отрицательную ставку');
    }, [
      { from: 'Math.min(v, betMax, balance)', to: 'Math.min(v, balance)' },
      { from: 'Math.min(v, betMax, balance)', to: 'Math.min(v, betMax)' },
      { from: 'return Math.max(0, Math.min(v, betMax, balance));', to: 'return Math.min(v, betMax, balance);' },
    ]);
  });

  it('NaN и обе бесконечности гасят кнопку, а конечная положительная сумма принимается', async () => {
    await counterfact(r => {
      for (const raw of [NaN, Infinity, -Infinity]) assert.equal(r.clampBet(raw, 100, 100), 0, 'R329 проверка: нечисловая сумма отвергнута');
      assert.equal(r.clampBet(5, 100, 100), 5, 'R329 проверка: конечная сумма принята');
    }, { from: 'if (!Number.isFinite(raw)) return 0;', to: '' });
  });
});

const fallback = 'Сервер объяснил отказ';
// Record связывает таблицу со ВСЕМ union сервера; новый код нельзя забыть молча, импорт только типовой, без БД.
const refusals: Record<WheelBetRefusal, string> = {
  not_in_voice: 'Ставки принимаются только с палубы — зайди в голосовой канал этого сервера',
  round_locked: 'Колесо уже крутится — ставка пойдёт в следующий раунд',
  cooldown: 'Команда переводит дух — новый раунд через несколько секунд',
  duplicate_pick: 'На это число ты уже поставил в этом раунде',
  duplicate: 'На это число ты уже поставил в этом раунде',
  'games-off': 'Игры на этом сервере выключены',
  'opted-out': 'Ты не участвуешь в экономике — включи её в настройках сервера',
  'games-opted-out': 'Ты выключил себе игры — включить можно в кошельке',
  'over-bet-max': 'Больше максимальной ставки на этом сервере',
  poor: 'Не хватает монет в сундуке',
  'loss-limit': 'Сегодняшний предел проигрыша исчерпан — завтра снова в море',
  'bad-amount': 'Ставка — целое число монет, от одной',
  bot: 'Боты не играют',
  busy: fallback, 'bad-pick': fallback, 'round-closed': fallback,
};

describe('R329 машинные причины становятся понятным отказом', () => {
  for (const [code, expected] of Object.entries(refusals)) it(`причина ${code} получает свой текст или предусмотренный текст сервера`, async () => {
    await counterfact(r => {
      assert.equal(r.wheelBetErrorText(code, fallback), expected, 'R329 проверка: согласованный текст каждого серверного кода');
    }, expected === fallback
      ? { from: "return fallback || 'Ставка не прошла';", to: "return 'Ставка не прошла';" }
      : { from: `case '${code}':`, to: `case 'r329-unknown-${code}':` });
  });

  it('неизвестная или отсутствующая причина сохраняет текст сервера, пустой текст получает безопасный запасной', async () => {
    await counterfact(r => {
      for (const code of [undefined, '', 'new-server-reason']) {
        assert.equal(r.wheelBetErrorText(code, fallback), fallback, 'R329 проверка: незнакомая причина не теряет объяснение');
        assert.equal(r.wheelBetErrorText(code, ''), 'Ставка не прошла', 'R329 проверка: пустой отказ не оставляет пользователя без текста');
      }
    }, { from: "return fallback || 'Ставка не прошла';", to: 'return fallback;' });
  });
});

describe('R329 честность проверяется реальными SHA256 обоих доменов', () => {
  it('верное зерно подтверждает сектор, регистр hex не важен, оба UTF-8 домена и ведущие нули сохранены', async () => {
    await counterfact(async r => {
      for (let n = 0; n < 32; n++) {
        const input = proof(`раунд-🪿-${n}`);
        input.commit = input.commit.toUpperCase();
        const calls: string[] = [];
        const result = await r.verifyWheelResult(input, async text => { calls.push(text); return hash(text); });
        assert.deepEqual(normal(result), { ok: true, sector: input.sector }, 'R329 проверка: настоящее зерно и сектор подтверждены');
        assert.deepEqual(calls, [`gv-wheel-commit:${input.id}:${input.seed}`, `gv-wheel-sector:${input.id}:${input.seed}`],
          'R329 проверка: точные и разные домены в правильном порядке');
      }
    }, [
      { from: 'digest(wheelCommitInput(r.id, r.seed))', to: 'digest(wheelSectorInput(r.id, r.seed))' },
      { from: 'r.commit.toLowerCase()', to: 'r.commit' },
      { from: "b.toString(16).padStart(2, '0')", to: 'b.toString(16)' },
    ]);
  });

  it('подмена обещания, идентификатора или зерна отвергается до вычисления сектора', async () => {
    await counterfact(async r => {
      const correct = proof();
      for (const input of [{ ...correct, commit: 'ff'.repeat(32) }, { ...correct, id: 'чужой-раунд' },
        { ...correct, seed: 'ab'.repeat(32) }]) {
        const calls: string[] = [];
        assert.deepEqual(normal(await r.verifyWheelResult(input, async text => { calls.push(text); return hash(text); })),
          { ok: false, why: 'commit' }, 'R329 проверка: обещание не совпало');
        assert.deepEqual(calls, [`gv-wheel-commit:${input.id}:${input.seed}`], 'R329 проверка: после неверного обещания сектор не вычисляется');
      }
    }, { from: "if (hexOf(commit) !== r.commit.toLowerCase()) return { ok: false, why: 'commit' };", to: '' });
  });

  it('правильное обещание с подменённым сектором возвращает пересчитанный настоящий сектор', async () => {
    await counterfact(async r => {
      const correct = proof();
      const changed = { ...correct, sector: (correct.sector + 1) % 25 };
      assert.deepEqual(normal(await r.verifyWheelResult(changed, digest)), { ok: false, why: 'sector', sector: correct.sector },
        'R329 проверка: несовпадение сектора не маскируется успешной проверкой обещания');
    }, [
      { from: 'sector === r.sector ?', to: 'true ?' },
      { from: 'digest(wheelSectorInput(r.id, r.seed))', to: 'digest(wheelCommitInput(r.id, r.seed))' },
    ]);
  });

  it('недоступный первый SHA256 — не обвинение в подмене и не попытка считать второй', async () => {
    await counterfact(async r => {
      const calls: string[] = [];
      const input = proof();
      assert.deepEqual(normal(await r.verifyWheelResult(input, async text => { calls.push(text); return null; })),
        { ok: false, why: 'unavailable' }, 'R329 проверка: отсутствие криптографии при обещании');
      assert.deepEqual(calls, [`gv-wheel-commit:${input.id}:${input.seed}`], 'R329 проверка: второй хеш не запрошен');
    }, { from: "if (!commit) return { ok: false, why: 'unavailable' };", to: "if (!commit) return { ok: false, why: 'commit' };" });
  });

  it('недоступный второй SHA256 после верного обещания тоже означает невозможность проверки, не мошенничество', async () => {
    await counterfact(async r => {
      const input = proof();
      const calls: string[] = [];
      assert.deepEqual(normal(await r.verifyWheelResult(input, async text => {
        calls.push(text);
        return calls.length === 1 ? hash(text) : null;
      })), { ok: false, why: 'unavailable' }, 'R329 проверка: отсутствие криптографии при секторе');
      assert.deepEqual(calls, [`gv-wheel-commit:${input.id}:${input.seed}`, `gv-wheel-sector:${input.id}:${input.seed}`],
        'R329 проверка: отказ именно на втором этапе');
    }, { from: "if (!h) return { ok: false, why: 'unavailable' };", to: "if (!h) return { ok: false, why: 'sector' };" });
  });
});

describe('R329 подписи и список ставок не искажают данные', () => {
  it('секунды округляются вверх, минуты переносятся, отрицательный остаток не виден', async () => {
    await counterfact(r => {
      assert.deepEqual([-1, 0, 1, 999, 1000, 1001, 59_000, 59_001, 60_000, 60_001].map(ms => r.clockLabel(ms)),
        ['0:00', '0:00', '0:01', '0:01', '0:01', '0:02', '0:59', '1:00', '1:00', '1:01'],
        'R329 проверка: точные границы часов без преждевременного нуля');
    }, { from: 'Math.ceil(ms / 1000)', to: 'Math.floor(ms / 1000)' });
  });

  it('множители и количество секторов совпадают с пятью числами настоящего колеса', async () => {
    await counterfact(r => {
      assert.deepEqual(shared.WHEEL_PICKS.map(pick => r.multiplierLabel(pick)), ['×1,9', '×3,8', '×5,75', '×11,5', '×23'],
        'R329 проверка: русские множители без потери сотых');
      assert.deepEqual(shared.WHEEL_PICKS.map(pick => r.pickSectors(pick)), [12, 6, 4, 2, 1], 'R329 проверка: шансы соответствуют арту');
    }, [
      { from: "String(WHEEL_PAYOUT_X100[pick] / 100).replace('.', ',')", to: 'String(WHEEL_PAYOUT_X100[pick] / 100)' },
      { from: 'WHEEL_SECTORS.filter((v) => v === pick).length', to: 'WHEEL_SECTORS.filter((v) => v !== pick).length' },
    ]);
  });

  it('ставки группируются по первому появлению человека, сохраняют порядок чисел и суммируются без изменения входа', async () => {
    await counterfact(r => {
      const bets: shared.WheelBetDto[] = [
        { userId: 'b', pick: 1, amount: 7 }, { userId: 'a', pick: 20, amount: 11 },
        { userId: 'b', pick: 3, amount: 13 }, { userId: 'a', pick: 5, amount: 17 },
      ];
      const before = normal(bets);
      assert.deepEqual(normal(r.betsByUser(bets)), [
        { userId: 'b', bets: [before[0], before[2]], total: 20 },
        { userId: 'a', bets: [before[1], before[3]], total: 28 },
      ], 'R329 проверка: порядок, принадлежность и сумма ставок');
      assert.deepEqual(bets, before, 'R329 проверка: входные ставки не мутируют');
      assert.deepEqual(normal(r.betsByUser([])), [], 'R329 проверка: пустой список остаётся пустым');
    }, [
      { from: 'if (i === undefined)', to: 'if (!i)' },
      { from: 'out[i].total += b.amount;', to: 'out[i].total = b.amount;' },
    ]);
  });
});
