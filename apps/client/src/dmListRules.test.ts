import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as prefs from './dmListRules';

describe('R130 собственный срок заглушки из дней, часов и минут', () => {
  it('нулевой срок и любое незаполненное поле не дают числа секунд', () => {
    // Ноль не должен превращаться в минутную заглушку, а пустое поле — молча восприниматься как набранный ноль.
    const check = (api: typeof prefs) => {
      assert.equal(api.muteDurationSeconds(0, 0, 0), null);
      for (const values of [[null, 5, 1], [2, null, 1], [2, 5, null], [null, null, null]] as const) {
        assert.equal(api.muteDurationSeconds(values[0], values[1], values[2]), null);
      }
      assert.equal(api.muteDurationSeconds(0, 0, 1), 60, 'ровно минута разрешена');
    };
    check(prefs);
    assert.throws(() => check(mutantPrefs('!Number.isFinite(total) || total <= 0', '!Number.isFinite(total)')), assert.AssertionError);
    assert.throws(() => check(mutantPrefs('if (days === null || hours === null || minutes === null) return null;', '')), assert.AssertionError);
  });

  it('дни, часы и минуты преобразуются в секунды без перестановки единиц', () => {
    // Два дня пять часов должны выключить уведомления на задуманный срок, а не на пять суток два часа.
    const check = (api: typeof prefs) => {
      for (const [days, hours, minutes, expected] of [
        [0, 0, 1, 60], [0, 1, 0, 3600], [1, 0, 0, 86400], [2, 5, 0, 190800],
        [31, 23, 59, 2764740],
      ] as const) assert.equal(api.muteDurationSeconds(days, hours, minutes), expected);
    };
    check(prefs);
    assert.throws(() => check(mutantPrefs('d * 86400 + h * 3600', 'd * 3600 + h * 86400')), assert.AssertionError);
  });

  it('каждое поле зажимается до 31 дня, 23 часов и 59 минут с обеих сторон границы', () => {
    // Число 99 в одном поле не должно обходить потолок окна и выдавать другой срок, чем отображённые поля.
    const check = (api: typeof prefs) => {
      for (const values of [[31, 23, 59], [32, 23, 59], [31, 24, 59], [31, 23, 60], [99, 99, 99]] as const) {
        assert.equal(api.muteDurationSeconds(values[0], values[1], values[2]), 2764740);
      }
      assert.equal(api.muteDurationSeconds(30, 23, 59), 2678340);
      assert.equal(api.muteDurationSeconds(31, 22, 59), 2761140);
      assert.equal(api.muteDurationSeconds(31, 23, 58), 2764680);
    };
    check(prefs);
    for (const field of ['days', 'hours', 'minutes']) {
      assert.throws(() => check(mutantPrefs(`Math.min(MUTE_DUR_MAX.${field}, Math.max(0, Math.trunc(${field})))`,
        `Math.max(0, Math.trunc(${field}))`)), assert.AssertionError);
    }
  });

  it('отрицательные и дробные поля нормализуются, NaN не создаёт срок, бесконечность проходит обычный зажим', () => {
    // Ручной ввод неполного/некорректного числа не должен давать отрицательные секунды или обходить пределы.
    assert.equal(prefs.muteDurationSeconds(-1, -2, -3), null);
    assert.equal(prefs.muteDurationSeconds(-1.9, -2.9, 1.9), 60);
    assert.equal(prefs.muteDurationSeconds(0.999, 0.999, 0.999), null);
    assert.equal(prefs.muteDurationSeconds(1.999, 2.999, 3.999), 93780);
    assert.equal(prefs.muteDurationSeconds(-Infinity, 0, 1), 60);
    assert.equal(prefs.muteDurationSeconds(Infinity, Infinity, Infinity), 2764740);
    for (const values of [[NaN, 0, 1], [0, NaN, 1], [0, 0, NaN]] as const) {
      assert.equal(prefs.muteDurationSeconds(values[0], values[1], values[2]), null);
    }
  });

  it('значение окна по умолчанию — восемь часов, предел окна не превышает серверные 366 суток', () => {
    // Замена дефолта и потолка должна быть явным решением, а не незаметным расхождением окна с сервером.
    assert.deepEqual(prefs.MUTE_DUR_DEFAULT, { days: 0, hours: 8, minutes: 0 });
    assert.deepEqual(prefs.MUTE_DUR_MAX, { days: 31, hours: 23, minutes: 59 });
    const seconds = (value: typeof prefs.MUTE_DUR_MAX | typeof prefs.MUTE_DUR_DEFAULT) =>
      prefs.muteDurationSeconds(value.days, value.hours, value.minutes);
    assert.equal(seconds(prefs.MUTE_DUR_DEFAULT), 28800);
    assert.equal(seconds(prefs.MUTE_DUR_MAX), 2764740);
    for (const value of [prefs.MUTE_DUR_DEFAULT, prefs.MUTE_DUR_MAX]) assert.ok(seconds(value)! <= 366 * 24 * 3600);
  });

  it('исходниковый страж минимального срока сохраняет 60 секунд, даже когда минутный шаг скрывает мутант нуля', () => {
    // MIN=0 поведенчески эквивалентен при целых минутных шагах; проверяем константу AST, не выдумываем недоступный ввод.
    const check = (source: string) => {
      const tree = ts.createSourceFile('dmListRules.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const values: ts.Expression[] = [];
      for (const statement of tree.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === 'MUTE_SECONDS_MIN' && declaration.initializer) {
            values.push(declaration.initializer);
          }
        }
      }
      assert.equal(values.length, 1);
      assert.ok(ts.isNumericLiteral(values[0]!));
      assert.equal(Number(values[0]!.text), 60);
    };
    const source = readFileSync(new URL('./dmListRules.ts', import.meta.url), 'utf8');
    check(source);
    const mutant = source.replace('const MUTE_SECONDS_MIN = 60;', 'const MUTE_SECONDS_MIN = 0;');
    assert.notEqual(mutant, source);
    assert.throws(() => check(mutant), assert.AssertionError);
  });
});

it('R125 короткие пресеты заглушки дают пять сроков из полной совместимой шкалы', () => {
  // Барабан не возвращается к шестнадцати пунктам, а прежние сохранённые сроки остаются допустимыми.
  assert.deepEqual(prefs.DM_MUTE_PRESETS.map(p => p.seconds), [3600, 28800, 86400, 172800, 604800]);
  assert.equal(prefs.DM_MUTE_PERIODS.length, 16);
  for (const preset of prefs.DM_MUTE_PRESETS) {
    assert.ok(prefs.DM_MUTE_PERIODS.some(p => p.seconds === preset.seconds && p.label === preset.label));
  }
  assert.equal(prefs.mutePeriodLabel(900), '15 минут');
  assert.equal(prefs.mutePeriodLabel(93 * 86400), '3 месяца');
  assert.equal(prefs.mutePeriodLabel(901), '');
});

describe('R115 перестановка закреплённых бесед', () => {
  it('средние строки проходят строго после середины, крайние принимают границу с запасом полпикселя', () => {
    const check = (api: typeof prefs) => {
      const mids = [100, 160, 220, 280];
      for (const [pos, expected] of [[219, 1], [220, 1], [221, 2], [279.49, 2], [279.5, 3], [280, 3], [281, 3], [101, 1], [100.51, 1], [100.5, 0], [100, 0], [99, 0]] as const)
        assert.equal(api.pinDropIndex(mids, 1, pos), expected, `середина ${pos}`);
      for (const [pos, expected] of [[160.01, 2], [160, 2], [159.99, 1]] as const)
        assert.equal(api.pinDropIndex(mids, 2, pos), expected, `средняя строка вверх ${pos}`);
      assert.equal(api.pinDropIndex(mids, 3, 99), 0);
      assert.equal(api.pinDropIndex(mids, 0, -100), 0);
      assert.equal(api.pinDropIndex(mids, 3, 1000), 3);
      assert.equal(api.pinDropIndex([100], 0, 1000), 0);
    };
    check(prefs);
    // Clamp не даёт перейти край: строгость там делала первое и последнее место недостижимыми.
    assert.throws(() => check(mutantPrefs('pos >= mids[j] - PIN_EDGE_EPS', 'pos > mids[j]')), assert.AssertionError);
    assert.throws(() => check(mutantPrefs('pos <= mids[j] + PIN_EDGE_EPS', 'pos < mids[j]')), assert.AssertionError);
    assert.throws(() => check(mutantPrefs('const PIN_EDGE_EPS = 0.5', 'const PIN_EDGE_EPS = 0')), assert.AssertionError);
    // На внутренних строках равенство по-прежнему не меняет порядок: ряд иначе дрожит у порога.
    assert.throws(() => check(mutantPrefs('pos > mids[j]', 'pos >= mids[j]')), assert.AssertionError);
    assert.throws(() => check(mutantPrefs('pos < mids[j]', 'pos <= mids[j]')), assert.AssertionError);
  });

  it('сдвиг ограничен крайними закрепами, но внутренний и ровно граничный сдвиг разрешены', () => {
    const mids = [100, 160, 220];
    for (const [along, expected] of [[-61, -60], [-60, -60], [-59, -59], [0, 0], [59, 59], [60, 60], [61, 60]] as const)
      assert.equal(prefs.pinDragClamp(mids, 1, along), expected);
    assert.equal(prefs.pinDragClamp(mids, 0, -1), 0);
    assert.equal(prefs.pinDragClamp(mids, 2, 1), 0);
    assert.equal(prefs.pinDragClamp([100], 0, 100), 0);
    assert.equal(prefs.pinDragClamp([], 0, 100), 0);
  });

  it('автопрокрутка начинается внутри сорокапиксельной полосы и ограничена четырнадцатью пикселями', () => {
    assert.equal(prefs.PIN_DRAG_EDGE_PX, 40);
    assert.equal(prefs.PIN_DRAG_SCROLL_MAX, 14);
    assert.equal(prefs.PIN_DRAG_START_PX, 30);
    for (const [y, expected] of [[50, -14], [100, -14], [120, -7], [139, -1], [140, 0], [141, 0], [300, 0], [459, 0], [460, 0], [461, 1], [480, 7], [500, 14], [550, 14]] as const)
      assert.equal(prefs.pinDragScrollStep(y, 100, 500), expected, `курсор ${y}`);
  });

  it('меню двигает только на соседнее место, на краях и для неизвестной беседы действий нет', () => {
    const ids = Object.freeze(['a', 'b', 'c']);
    assert.equal(prefs.pinnedStep(ids, 'a', -1), null);
    assert.equal(prefs.pinnedStep(ids, 'c', 1), null);
    for (const dir of [-1, 1] as const) {
      assert.equal(prefs.pinnedStep(ids, 'missing', dir), null);
      assert.equal(prefs.pinnedStep([], 'a', dir), null);
      assert.equal(prefs.pinnedStep(['a'], 'a', dir), null);
    }
    assert.deepEqual(prefs.pinnedStep(ids, 'b', -1), ['b', 'a', 'c']);
    assert.deepEqual(prefs.pinnedStep(ids, 'b', 1), ['a', 'c', 'b']);
    assert.deepEqual(prefs.pinnedStep(ids, 'a', 1), ['b', 'a', 'c']);
    assert.deepEqual(prefs.pinnedStep(ids, 'c', -1), ['a', 'c', 'b']);
    assert.deepEqual(ids, ['a', 'b', 'c']);
  });

  it('закрепы архива и основного списка сортируются независимо, незакреплённые исключены', () => {
    const rows = Object.freeze([
      { ...dm('main-old', '2026-10-09'), pinnedAt: '2026-10-07' },
      { ...dm('arch-new', null), pinnedAt: '2026-10-09', archived: true },
      { ...dm('main-new', null), pinnedAt: '2026-10-08', archived: false },
      { ...dm('arch-old', null), pinnedAt: '2026-10-06', archived: true },
      { ...dm('unpinned', '2026-10-10'), pinnedAt: null },
      { ...dm('arch-unpinned', null), archived: true },
    ]);
    const check = (api: typeof prefs) => {
      assert.deepEqual(Array.from(api.pinnedGroupIds(rows, false)), ['main-new', 'main-old']);
      assert.deepEqual(Array.from(api.pinnedGroupIds(rows, true)), ['arch-new', 'arch-old']);
      assert.deepEqual(Array.from(api.pinnedGroupIds([], true)), []);
    };
    check(prefs);
    assert.throws(() => check(mutantPrefs('&& (d.archived === true) === archived', '')), assert.AssertionError);
    assert.deepEqual(rows.map((d) => d.id), ['main-old', 'arch-new', 'main-new', 'arch-old', 'unpinned', 'arch-unpinned']);
  });
});

function mutantPrefs(from: string, to: string): typeof prefs {
  const source = readFileSync(new URL('./dmListRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'мутируется действующая ветка');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof prefs;
}
it('выключенный звук не гасит уведомление и истекает точно на границе срока', () => {
  // Sound-only не должен превращаться в полную заглушку и терять счётчик/баннер.
  const now = Date.parse('2026-10-08T00:00:00Z');
  const mute = { until: new Date(now + 1).toISOString(), soundOnly: true };
  const decision = { countUnread: true, markRead: false, toast: true, sound: true, osNotify: true };
  assert.equal(prefs.muteActive(mute, now), false);
  assert.equal(prefs.muteSoundOff(mute, now), true);
  assert.equal(prefs.muteSoundOff(mute, now + 1), false);
  assert.equal(prefs.muteSoundOff({ until: null, soundOnly: true }, now), true);
  assert.equal(prefs.muteSoundOff({ until: null }, now), false);
  assert.deepEqual(prefs.dmMutedDecision(decision, false, true), { ...decision, sound: false });
  assert.throws(() => assert.equal(mutantPrefs('t > now', 't >= now').muteSoundOff(mute, now + 1), false), assert.AssertionError);
});
it('сроки хранят выбранный и наибольший, шкала заканчивается 93 днями', () => {
  // Повтор не должен раздувать меню и выбрасывать самый долгий выбранный срок.
  assert.deepEqual(prefs.rememberMutePeriod([8 * 3600], 2 * 86400), [8 * 3600, 2 * 86400]);
  assert.deepEqual(prefs.rememberMutePeriod([8 * 3600, 2 * 86400], 2 * 86400), [8 * 3600, 2 * 86400]);
  assert.deepEqual(prefs.rememberMutePeriod([8 * 3600, 2 * 86400], 3 * 3600), [3 * 3600, 2 * 86400]);
  assert.equal(prefs.DM_MUTE_PERIODS.length, 16);
  assert.equal(prefs.DM_MUTE_PERIODS.at(-1)?.seconds, 93 * 86400);
  assert.equal(prefs.READ_ALL_CONFIRM_ABOVE, 1000);
});

it('закрепы выше свежих сообщений, новый закреп выше старого, равные идут по времени беседы', () => {
  // Входящий ответ не должен вытеснять закреп из верха списка.
  const check = (api: typeof prefs) => {
    const a = { createdAt: '2026-01-01', lastMessageAt: '2026-01-01', pinnedAt: '2026-10-02' };
    const b = { ...a, pinnedAt: '2026-10-03', lastMessageAt: '2025-01-01' };
    const c = { ...a, pinnedAt: null, lastMessageAt: '2026-10-07' };
    assert.deepEqual([a, c, b].sort(api.byRecent), [b, a, c]);
    assert.ok(api.byRecent({ ...a, lastMessageAt: '2026-10-06' }, a) < 0, 'равный закреп сортируется по сообщению');
    assert.ok(api.byRecent({ ...c, lastMessageAt: null }, c) > 0, 'без сообщения используется createdAt');
  };
  check(prefs);
  for (const [a,b] of [['pb.localeCompare(pa)', 'pa.localeCompare(pb)'], ['if (pa === null) return 1;', 'if (pa === null) return -1;']])
    assert.throws(() => check(mutantPrefs(a,b)), assert.AssertionError);
});

it('мьют истекает ровно в свой срок, вечный не истекает, мусор не глушит', () => {
  // Срок в прошлом и invalid date иначе оставляют человека без уведомлений навсегда.
  const now = Date.parse('2026-10-07T12:00:00Z');
  const check = (api: typeof prefs) => {
    for (const mute of [null, undefined, { until: 'invalid' }, { until: new Date(now).toISOString() }, { until: new Date(now - 1).toISOString() }]) assert.equal(api.muteActive(mute, now), false);
    assert.equal(api.muteActive({ until: null }, now), true);
    assert.equal(api.muteActive({ until: new Date(now + 1).toISOString() }, now), true);
  };
  check(prefs);
  assert.throws(() => check(mutantPrefs('t > now', 't >= now')), assert.AssertionError);
});

it('остаток мьюта округляется вверх, ближайший таймер берёт лишь будущий конечный срок', () => {
  // 1 мс остатка не должен отображаться как ноль; вечный и уже истёкший мьют не создают таймер.
  const now = 1000; const m = (ms: number) => ({ until: new Date(now + ms).toISOString() });
  const check = (api: typeof prefs) => {
    for (const [ms, text] of [[1, '1 мин'], [59 * 60000, '59 мин'], [60 * 60000, '1 ч'], [47 * 3600000, '47 ч'], [48 * 3600000, '2 д'], [48 * 3600000 + 1, '3 д']] as const) assert.equal(api.muteLeftLabel(m(ms), now), text);
    for (const v of [null, undefined, { until: null }, { until: 'invalid' }, m(0)]) assert.equal(api.muteLeftLabel(v, now), '');
    assert.equal(api.nextMuteExpiry([null, { until: null }, { until: 'invalid' }, m(0), m(9), m(1)], now), now + 1);
    assert.equal(api.nextMuteExpiry([m(-1), { until: null }], now), null);
  };
  check(prefs);
  assert.throws(() => check(mutantPrefs('Math.ceil(left / 60_000)', 'Math.floor(left / 60_000)')), assert.AssertionError);
});

it('сводка мьюта главнее старого списка, выключение звука не съедает непрочитанное', () => {
  // Старая локальная заглушка не должна отменять явное серверное null и скрывать входящие.
  const check = (api: typeof prefs) => {
    const dm = { otherUser: { id: 'peer' } }; const until = { peer: '2026-10-08T12:00:00Z' };
    assert.equal(api.dmMuteOf({ ...dm, muted: null }, ['peer'], until), null);
    assert.deepEqual(JSON.parse(JSON.stringify(api.dmMuteOf(dm, ['peer'], until))), { until: until.peer });
    assert.equal(api.dmMuteOf(dm, [], until), null);
    assert.deepEqual(JSON.parse(JSON.stringify(api.dmMuteOf(dm, ['peer'], {}))), { until: null });
    const base = { sound: true, osNotify: true, countUnread: true, markRead: false };
    assert.equal(api.dmMutedDecision(base, false), base);
    assert.deepEqual(JSON.parse(JSON.stringify(api.dmMutedDecision(base, true))), { ...base, sound: false, osNotify: false });
  };
  check(prefs);
  for (const [a,b] of [['if (dm.muted !== undefined) return dm.muted;', ''], ['{ ...d, sound: false, osNotify: false }', '{ ...d, sound: false, osNotify: false, countUnread: false }']])
    assert.throws(() => check(mutantPrefs(a,b)), assert.AssertionError);
});

it('открытая беседа под слоем сохраняет непрочитанное и не посылает отметку чтения', () => {
  // Настройки поверх переписки не означают, что входящий ответ увидели.
  const check = (api: typeof prefs) => {
    const i = { mine: false, onScreen: true, focused: true, dnd: false };
    assert.equal(api.dmIncomingDecision({ ...i, covered: true }).countUnread, true);
    assert.equal(api.dmIncomingDecision({ ...i, covered: true }).markRead, false);
    assert.equal(api.dmIncomingDecision({ ...i, covered: false }).markRead, true);
  };
  check(prefs);
  assert.throws(() => check(mutantPrefs('i.focused && !i.covered', 'i.focused')), assert.AssertionError);
});
import type { DmChannel, Message } from '@gusvoice/shared';
import { applyDmDelete, dmIncomingDecision, dmSilentDecision, mergeDmChannel, mergeDmUpdate, seedDmList } from './dmListRules.js';

const dm = (id: string, lastMessageAt: string | null, unread?: number): DmChannel => ({
  id,
  otherUser: { id: `u-${id}`, username: id, displayName: id, avatarUrl: null },
  createdAt: '2026-09-01T00:00:00.000Z',
  lastMessageAt,
  ...(unread === undefined ? {} : { unread }),
});

const message = (reactions?: Message['reactions']): Message => ({
  id: 'm1',
  channelId: 'dm1',
  author: { id: 'u1', username: 'u1', displayName: 'U1', avatarUrl: null },
  content: 'до',
  attachments: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  editedAt: null,
  reactions: reactions ?? [],
  replyTo: null,
});

describe('список личных бесед', () => {
  it('удаление последнего сообщения возвращает беседу на прежнее место', () => {
    // Ловит применение правила mergeDmChannel, которое не допускает законного уменьшения времени.
    const result = applyDmDelete(
      [dm('first', '2026-09-20T13:00:00.000Z', 1), dm('second', '2026-09-20T12:00:00.000Z')],
      ['first'], 'first', { lastMessageAt: '2026-09-20T11:00:00.000Z' }, null,
    );
    assert.deepEqual(result.dms.map((d) => d.id), ['second', 'first']);
    assert.equal(result.dms[1]?.lastMessageAt, '2026-09-20T11:00:00.000Z');
    assert.equal(applyDmDelete(result.dms, result.unreadDms, 'first', { lastMessageAt: null }, null).dms[1]?.lastMessageAt, null);
  });

  it('новое число после удаления ставит и снимает флаг непрочитанного', () => {
    // Ловит залипшую единицу после удаления единственного непрочитанного сообщения.
    const start = [dm('one', null, 2)];
    const cleared = applyDmDelete(start, ['one'], 'one', { unread: 0 }, null);
    assert.equal(cleared.dms[0]?.unread, 0);
    assert.deepEqual(cleared.unreadDms, []);
    const raised = applyDmDelete(cleared.dms, cleared.unreadDms, 'one', { unread: 1 }, null);
    assert.equal(raised.dms[0]?.unread, 1);
    assert.deepEqual(raised.unreadDms, ['one']);
  });

  it('удаление на открытом экране не возвращает серверное непрочитанное', () => {
    // Ловит краткую вспышку счётчика, пока запаздывает отметка прочитанного.
    const result = applyDmDelete([dm('open', null, 0)], [], 'open', { unread: 3 }, 'open');
    assert.equal(result.dms[0]?.unread, 0);
    assert.deepEqual(result.unreadDms, []);
  });

  it('старое событие без полей и отсутствующая беседа не портят список', () => {
    // Ловит очистку времени старым сервером и падение на событии удалённой из списка беседы.
    const source = [dm('one', '2026-09-20T10:00:00.000Z', 2)];
    assert.deepEqual(applyDmDelete(source, ['one'], 'one', {}, null), { dms: source, unreadDms: ['one'] });
    assert.deepEqual(applyDmDelete(source, ['one'], 'missing', { unread: 0 }, null), { dms: source, unreadDms: ['one'] });
  });
  it('событие без unread сохраняет счётчик и не откатывает время', () => {
    // Ловит замену записи целиком: следующий dm.create снова считал бы непрочитанное от нуля.
    const result = mergeDmChannel(
      [dm('same', '2026-09-20T12:00:00.000Z', 5)],
      dm('same', '2026-09-20T11:00:00.000Z'),
    );
    assert.equal(result[0]?.unread, 5);
    assert.equal(result[0]?.lastMessageAt, '2026-09-20T12:00:00.000Z');
  });

  it('новая и обновлённая беседы сортируются по настоящей свежести', () => {
    // Ловит добавление новой беседы в фиксированное место и неверный порядок после позднего события.
    const old = dm('old', '2026-09-20T10:00:00.000Z', 1);
    const newer = dm('new', '2026-09-20T12:00:00.000Z');
    assert.deepEqual(mergeDmChannel([old], newer).map((d) => d.id), ['new', 'old']);
    assert.deepEqual(
      mergeDmChannel([newer, old], dm('old', '2026-09-20T13:00:00.000Z')).map((d) => d.id),
      ['old', 'new'],
    );
  });

  it('загрузка списка гасит только открытую беседу и собирает остальные числа', () => {
    // Ловит мигающий счётчик прямо под читающим и потерю непрочитанного в соседней беседе.
    const result = seedDmList([dm('open', null, 3), dm('other', null, 2), dm('read', null, 0)], 'open');
    assert.equal(result.dms.find((d) => d.id === 'open')?.unread, 0);
    assert.deepEqual(result.unreadDms, ['other']);
  });

  it('null не исключает из непрочитанного ни одну беседу', () => {
    // Ловит случай старта на серверном экране, когда выбранный когда-то dm ошибочно считается прочитанным.
    assert.deepEqual(seedDmList([dm('one', null, 1), dm('two', null, 2)], null).unreadDms.sort(), ['one', 'two']);
  });
});

describe('обновление личного сообщения', () => {
  it('правка сохраняет уже видимые реакции, а без них принимает реакции ответа', () => {
    // Ловит превращение моей реакции в чужую из-за ответа, собранного глазами редактора.
    const previous = message([{ emoji: '👍', count: 1, me: true }]);
    const incoming = { ...message([{ emoji: '🔥', count: 2, me: false }]), content: 'после' };
    assert.deepEqual(mergeDmUpdate(previous, incoming).reactions, previous.reactions);
    assert.deepEqual(mergeDmUpdate({ ...previous, reactions: undefined as never }, incoming).reactions, incoming.reactions);
  });
});

describe('решение по входящему ЛС', () => {
  it('своё эхо не считается, не читается и не уведомляет', () => {
    // Ловит двойной счётчик и звук от собственного сообщения с другого устройства.
    assert.deepEqual(dmIncomingDecision({ mine: true, onScreen: false, focused: false, dnd: false }), {
      countUnread: false,
      markRead: false,
      sound: false,
      osNotify: false,
    });
  });

  it('видимое в активном окне только отмечается прочитанным', () => {
    // Ловит Б8: собеседник отвечает на глазах, а клиент всё равно играет звук.
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: true, focused: true, dnd: false }), {
      countUnread: false,
      markRead: true,
      sound: false,
      osNotify: false,
    });
  });

  it('открытая беседа в свёрнутом окне остаётся непрочитанной и уведомляет', () => {
    // Ловит тихую отметку прочитанным, когда лента формально открыта, но человек её не видит.
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: true, focused: false, dnd: false }), {
      countUnread: true,
      markRead: false,
      sound: true,
      osNotify: true,
    });
  });

  it('сообщение вне экрана считается и уведомляет, а DND глушит только шум', () => {
    // Ловит режим «не беспокоить», который вместе со звуком теряет сам счётчик сообщения.
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: false, focused: true, dnd: false }), {
      countUnread: true,
      markRead: false,
      sound: true,
      osNotify: true,
    });
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: false, focused: false, dnd: true }), {
      countUnread: true,
      markRead: false,
      sound: false,
      osNotify: false,
    });
  });

  it('тихое входящее гасит только звук при любом базовом решении', () => {
    // «Без звука» не означает «без уведомления»: счётчик, прочтение и системная нотификация остаются как обычно.
    for (const input of [
      { mine: false, onScreen: false, focused: false, dnd: false },
      { mine: false, onScreen: true, focused: true, dnd: false },
      { mine: false, onScreen: true, focused: false, dnd: false },
      { mine: false, onScreen: false, focused: false, dnd: true },
      { mine: true, onScreen: false, focused: false, dnd: false },
    ]) {
      const base = dmIncomingDecision(input);
      assert.deepEqual(dmSilentDecision(base, { silent: true }), { ...base, sound: false });
    }
  });

  it('обычное или отсутствующее silent сохраняет исходное решение без копии', () => {
    // Неправильное значение не должно неожиданно менять поведение обычного сообщения.
    const base = dmIncomingDecision({ mine: false, onScreen: false, focused: false, dnd: false });
    assert.equal(dmSilentDecision(base, { silent: false } as unknown as Parameters<typeof dmSilentDecision>[1]), base);
    assert.equal(dmSilentDecision(base, {}), base);
    assert.equal(dmSilentDecision(base, { silent: undefined }), base);
  });
});
