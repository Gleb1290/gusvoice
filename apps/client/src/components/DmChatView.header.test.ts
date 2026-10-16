import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { ConvSummary, DmChannel } from '@gusvoice/shared';
import * as convRules from '../convSyncRules';
import * as listRules from '../dmListRules';
import * as archiveRules from '../dmArchiveRules';
import * as callRules from '../callView';
import * as phoneLayout from '../phoneLayout';
import * as groupRules from '../groupChatRules';
import * as contactRules from '../contactRules';
import * as popover from '../popover';
import { lastSeenLabel } from '../lastSeenText';
import { lastSeenForms } from '../statusFit';
import type { UserLastSeen } from '@gusvoice/shared';
import type * as Chat from './DmChatView';
type PaneProps = Parameters<typeof import('./MessagePane').MessagePane>[0];

const source = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
async function statusFormsScene(width: number, mode: 'today' | 'yesterday' | 'online' | 'approx', raw = source) {
  const online = mode === 'online';
  const lastSeen: UserLastSeen = { userId: 'peer', online, exact: mode !== 'approx',
    at: mode === 'approx' ? null : new Date(2026, 9, mode === 'yesterday' ? 11 : 12, 3, 53).toISOString(),
    approx: mode === 'approx' ? 'recently' : null } as UserLastSeen;
  const expected = online ? 'в сети' : lastSeenLabel(lastSeen, new Date(2026, 9, 12, 20));
  await fixture(width, false, async f => {
    const status = f.host.querySelector('.dm-who-status'); assert.ok(!!status, 'статус шапки существует');
    const variants = [...status.querySelectorAll<HTMLElement>('[data-form]')];
    const multiple = width <= 620 && mode !== 'online' && mode !== 'approx';
    assert.equal(variants.length, multiple ? 2 : 0, 'формы только для точного статуса телефона');
    if (multiple) {
      assert.equal(variants[0].textContent, expected, 'полная форма первая');
      assert.equal(variants[0].hidden, false, 'первая видима');
      assert.equal(variants[1].hidden, true, 'запасная скрыта');
      assert.equal(variants[1].textContent, mode === 'today' ? 'был(а) в 03:53' : 'вчера в 03:53');
    } else assert.equal(status.textContent, expected, 'ПК и одноформные статусы плоские');
  }, raw, { online, lastSeen }, { statusForms: true });
}
it('R182 точный статус телефона содержит полную и скрытую короткую формы, ПК остаётся плоским', async () => {
  // Компактность не должна менять компьютерную шапку или заранее скрывать полный текст.
  for (const width of [360, 1024]) for (const mode of ['today', 'yesterday'] as const) await statusFormsScene(width, mode);
});
it('R182 online и приблизительный статус не получают запасных форм ни на телефоне, ни на ПК', async () => {
  // Присутствие и приватная примерная дата не допускают выдуманных сокращений времени.
  for (const width of [360, 1024]) for (const mode of ['online', 'approx'] as const) await statusFormsScene(width, mode);
});
for (const [name, anchor, replacement, width, target] of [
  ['запасные формы видимы', 'data-form hidden={i > 0}', 'data-form hidden={false}', 360, 'запасная скрыта'],
  ['компактные формы и на ПК', 'const shortForms = phone && seenForms.length > 1;', 'const shortForms = seenForms.length > 1;', 1024, 'формы только'],
  ['ложная проверка несовпадения полной формы', 'const shortForms = phone && seenForms.length > 1;', 'const shortForms = phone && seenForms.length > 1 && seenText !== seenForms[0];', 360, 'формы только'],
] as const) it(`R182 мутант «${name}» обнаруживается настоящей шапкой`, async () => {
  // Не исполняем куски JSX: весь модуль проходит исходный сценарий перед адресной мутацией.
  await statusFormsScene(width, 'today'); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь');
  await assert.rejects(statusFormsScene(width, 'today', source.replace(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});
const noView = () => null;
const unused = () => assert.fail('действие вне проверяемого контракта шапки');

const fedHome = { instanceId: 'neighbor', name: 'Сосед', domain: 'neighbor.example' };
async function fedPresence(remote: boolean, enabled: boolean, online: boolean, raw = source) {
  const shown = !remote || enabled;
  const lastSeen = { userId: 'peer', online: false, exact: false, at: null, approx: 'recently' } as UserLastSeen;
  for (const width of [360, 1024]) await fixture(width, false, async f => {
    assert.equal(f.seenIds().every(id => id === (shown ? 'peer' : null)), true, 'lastSeen запрашивается только для поддержанного собеседника');
    assert.equal(f.seenIds().length > 0, true);
    assert.equal(typeof f.pane().onTyping, shown ? 'function' : 'undefined', 'typing отправляется только поддержанному собеседнику');
    const text = f.host.querySelector('.dm-who-status')?.textContent ?? '';
    assert.equal(text, shown ? online ? 'в сети' : 'был(а) недавно' : '', 'шапка не выдумывает онлайн или время соседа');
    assert.equal(f.host.querySelector('.dm-who')?.classList.contains('solo'), !shown, 'без presence шапка solo');
  }, raw, { online, lastSeen }, { peerHome: remote ? fedHome : undefined, features: enabled ? ['fedm4'] : [] });
}
it('R197 сосед без fedm4 не получает статус, запрос lastSeen и typing, местный и поддержанный сосед сохраняют их', async () => {
  // Фейковый источник намеренно знает онлайн: скрытие должно делать приложение, а не пустая фикстура.
  for (const remote of [false, true]) for (const enabled of [false, true]) for (const online of [false, true]) await fedPresence(remote, enabled, online);
});
for (const [name, anchor, replacement, target] of [
  ['presence включён всем', 'const presenceOn = peerPresenceShown(!!peerHome, features);', 'const presenceOn = true;', 'lastSeen запрашивается только'],
  ['запрос времени без проверки', 'const lastSeen = useLastSeen(group || saved || !presenceOn ? null : dm.otherUser.id);', 'const lastSeen = useLastSeen(group || saved ? null : dm.otherUser.id);', 'lastSeen запрашивается только'],
  ['typing соседу без возможности', "saved || (peerHome && !serverFedPresence(features)) ? undefined : (action)", 'saved ? undefined : (action)', 'typing отправляется только'],
] as const) it(`R197 мутант «${name}» обнаруживается настоящей шапкой и пропсами`, async () => {
  await fedPresence(true, false, false); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь presence');
  await assert.rejects(fedPresence(true, false, false, source.replace(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});
it('R200 мутант rawOnline вместо gatedOnline обнаруживается живым, но неподдержанным соседом', async () => {
  await fedPresence(true, false, true);
  const anchor = 'const online = dmDot(gatedOnline, lastSeen?.exact, features, localOnline);';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь гейта online');
  await assert.rejects(fedPresence(true, false, true, source.replace(anchor, anchor.replace('gatedOnline', 'rawOnline'))),
    e => e instanceof assert.AssertionError && e.message.includes('шапка не выдумывает онлайн'));
});
async function viaBar(remote: boolean, down: boolean, ready: boolean, raw = source) {
  const enabled = remote && down && ready;
  for (const width of [390, 1024]) await fixture(width, false, async f => {
    assert.equal(!!f.host.querySelector('.fed-via-bar'), enabled, 'плашка обхода только с готовой сессией при лежащем доме');
    if (enabled) assert.equal(f.host.querySelector('.fed-via-bar')?.textContent, 'Инстанс «Дом» недоступен — пишем через «Сосед»');
    assert.equal(f.pane().filesBlocked, enabled ? convRules.FED_VIA_TEXT_ONLY : undefined, 'обход закрывает файлы общей текстовой подсказкой');
    assert.equal(typeof f.pane().onSendGif, enabled ? 'undefined' : 'function');
    assert.equal(typeof f.pane().onSendVoice, enabled ? 'undefined' : 'function'); assert.equal(f.pane().roundOk, !enabled);
    assert.equal(!!f.host.querySelector('textarea'), true, 'обход оставляет поле текста');
  }, raw, undefined, { peerHome: remote ? fedHome : undefined, features: ['fedm3', 'gifs1', 'circles1'],
    fedVia: { down, self: 'Дом', ready: ready ? ['conversation'] : [] } });
}
it('R200 DmChatView плашка fed-via-bar и текстовый запрет файлов только при лежащем доме с готовой сессией соседа', async () => {
  for (const remote of [false, true]) for (const down of [false, true]) for (const ready of [false, true]) await viaBar(remote, down, ready);
});
for (const [name, anchor, replacement, ready, target] of [
  ['показ без готовой сессии', '&& !!s.fedVia.ready?.includes(dm.id)', '', false, 'плашка обхода только'],
  ['файлы открыты в обходе', 'viaOn ? FED_VIA_TEXT_ONLY : fedFilesHint(', 'fedFilesHint(', true, 'обход закрывает файлы'],
] as const) it(`R200 DmChatView мутант «${name}» ловится реальным состоянием и пропсами MessagePane`, async () => {
  await viaBar(true, true, ready); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь обходного UI');
  await assert.rejects(viaBar(true, true, ready, source.replace(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});
async function staleNotice(remote: boolean, stale: boolean, broken: boolean, raw = source) {
  const notice = remote && stale && !broken; const archive = remote && broken;
  await fixture(390, false, async f => {
    assert.equal(!!f.host.querySelector('.composer-blocked.fed-archive.fed-stale'), notice, 'плашка задержки только удалённому неархивному чату');
    if (notice) assert.equal(f.host.querySelector('.fed-stale')?.textContent, 'Сообщения ждут, пока «Сосед» их заберёт');
    assert.equal(f.pane().readOnly, archive, 'задержка не превращает чат в архив');
    assert.equal(!!f.host.querySelector('textarea'), !archive, 'задержка оставляет поле отправки');
  }, raw, undefined, { peerHome: remote ? fedHome : undefined, fedStale: stale, fedLink: broken ? 'broken' : 'ok' });
}

async function groupViaBar(kind: 'group' | 'saved', foreign: boolean, down: boolean, ready: boolean, raw = source) {
  const enabled = kind === 'group' && foreign && down && ready;
  for (const width of [390, 1024]) await fixture(width, false, async f => {
    const bar = f.host.querySelector('.fed-via-bar');
    assert.equal(!!bar, enabled, 'обход группы включается только для чужого хоста с готовой сессией');
    if (enabled) {
      assert.equal(bar?.getAttribute('role'), 'status');
      assert.equal(bar?.textContent, 'Инстанс «Дом» недоступен — пишем через «Сосед»');
    }
    assert.equal(f.pane().filesBlocked, enabled ? convRules.FED_VIA_TEXT_ONLY : undefined);
    assert.equal(typeof f.pane().onSendVoice, enabled ? 'undefined' : 'function');
    assert.equal(f.pane().roundOk, !enabled);
    assert.equal(!!f.host.querySelector('textarea'), true, 'сессия группы сохраняет отправку текста');
  }, raw, undefined, { kind, fedGroupHost: foreign ? { instanceId: fedHome.instanceId } : undefined,
    groupMembers: [{ id: 'host-member', username: 'member', displayName: 'Участник', avatarUrl: null, role: 'member', homeInstance: fedHome }],
    features: ['groups1', 'groups3', 'fedm6', 'gifs1', 'circles1'],
    fedVia: { down, self: 'Дом', ready: ready ? ['conversation'] : [] } });
}
// Класс ошибки: обход чужой группы исчезает либо включается для своей группы/Избранного и без готовой сессии.
it('R208 DmChatView проводит обход группы чужого хоста, но не своей группы и Избранного', async () => {
  for (const kind of ['group', 'saved'] as const) for (const foreign of [false, true])
    for (const down of [false, true]) for (const ready of [false, true]) await groupViaBar(kind, foreign, down, ready);
  const anchor = '(!!peerHome || !!groupHostId) && s.fedVia?.down === true';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(groupViaBar('group', true, true, true, source.replace(anchor, '!!peerHome && s.fedVia?.down === true')),
    e => e instanceof assert.AssertionError && e.message.startsWith('обход группы включается только') && e.actual === false && e.expected === true);
});

async function viaSelfName(raw = source) {
  for (const official of ['Наш инстанс', '', undefined]) for (const width of [390, 1024]) await fixture(width, false, async f => {
    const name = official || 'Локальная сессия';
    assert.equal(f.host.querySelector('.fed-via-bar')?.textContent,
      `Инстанс «${name}» недоступен — пишем через «Сосед»`, 'плашка предпочитает имя своего инстанса, пустое заменяет именем сессии');
    assert.equal(f.pane().viaNames?.self, name, 'тот же приоритет передан сообщениям');
    assert.equal(f.pane().viaNames?.peer, 'Сосед');
  }, raw, undefined, { kind: 'group', fedGroupHost: { instanceId: fedHome.instanceId }, selfInstanceName: official,
    groupMembers: [{ id: 'host-member', username: 'member', displayName: 'Участник', avatarUrl: null, role: 'member', homeInstance: fedHome }],
    fedVia: { down: true, self: 'Локальная сессия', ready: ['conversation'] } });
}
// Класс ошибки: подпись «через» показывает имя полученной сессии вместо настоящего дома пользователя.
it('R208 DmChatView предпочитает selfInstanceName и сохраняет fedVia.self при пустом имени', () => viaSelfName());
// Класс ошибки: перестановка приоритета даёт правдоподобную, но неверную подпись своего дома.
it('R208 мутант приоритета своего дома обнаруживается текстом настоящей плашки группы', async () => {
  await viaSelfName();
  const anchor = 'const viaSelf = selfInstanceName || viaSelfLocal;'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(viaSelfName(source.replace(anchor, 'const viaSelf = viaSelfLocal || selfInstanceName;')),
    e => e instanceof assert.AssertionError && e.message.startsWith('плашка предпочитает имя своего инстанса') &&
      e.actual === 'Инстанс «Локальная сессия» недоступен — пишем через «Сосед»' &&
      e.expected === 'Инстанс «Наш инстанс» недоступен — пишем через «Сосед»');
});
it('R201 DmChatView передаёт composerNotice при fedStale, текст остаётся доступен, broken и местный чат без notice', async () => {
  for (const remote of [false, true]) for (const stale of [false, true]) for (const broken of [false, true]) await staleNotice(remote, stale, broken);
});
it('R201 мутант без проверки дома показывает ложную задержку местному чату', async () => {
  await staleNotice(false, true, false);
  const anchor = '!!peerHome && fedLinkStale(s.conv.summaries[dm.id])'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(staleNotice(false, true, false, source.replace(anchor, 'fedLinkStale(s.conv.summaries[dm.id])')),
    e => e instanceof assert.AssertionError && e.message.includes('плашка задержки только'));
});

async function groupDownNotice(options: {
  kind: 'direct' | 'group'; host?: ConvSummary['fedGroupHost']; former?: ConvSummary['former'];
  home?: DmChannel['otherUser']['homeInstance'];
}, raw = source) {
  const shown = options.kind === 'group' && options.host?.down === true && !options.former;
  for (const width of [390, 1024]) await fixture(width, false, async f => {
    const notice = f.host.querySelector('.composer-blocked.fed-archive.fed-stale.fed-group-down');
    assert.equal(!!notice, shown, 'плашка дома только действующей группе с недоступным хостом');
    assert.equal(!!f.pane().composerNotice, shown, 'DmChatView передаёт notice только недоступной действующей группе');
    if (shown) {
      const label = options.home?.name?.trim() || options.home?.domain;
      const expected = label
        ? `Инстанс «${label}», где живёт группа, недоступен — сообщения доедут, когда он вернётся; состав сейчас не меняется`
        : 'Инстанс, где живёт группа, недоступен — сообщения доедут, когда он вернётся; состав сейчас не меняется';
      assert.equal(notice?.getAttribute('role'), 'status');
      assert.equal(notice?.textContent, expected, 'плашка честно называет дом группы либо сообщает, что имя неизвестно');
      assert.equal(f.pane().composerReplacement, undefined, 'недоступность дома не заменяет поле отправки архивом');
    }
    assert.equal(f.pane().readOnly, !!options.former, 'только бывшая группа становится только для чтения');
    assert.equal(!!f.host.querySelector('textarea'), !options.former, 'дом группы может лежать, но поле текста остаётся');
  }, raw, undefined, { kind: options.kind, fedGroupHost: options.host, former: options.former,
    peerHome: options.kind === 'direct' ? options.home : undefined,
    features: ['groups1', 'groups3', 'fedm6'],
    groupMembers: options.home ? [{ id: 'group-owner', username: 'owner', displayName: 'Создатель группы', avatarUrl: null,
      role: 'owner', homeInstance: options.home }] : [] });
}

// Ловит молчащую/неверно подписанную плашку и регрессию, когда падение хоста блокирует отправку текста.
it('R206 DmChatView показывает недоступный дом группы словами и сохраняет поле ввода на телефоне и ПК', async () => {
  for (const home of [fedHome, { instanceId: 'neighbor', name: null, domain: '' }])
    await groupDownNotice({ kind: 'group', host: { instanceId: 'neighbor', down: true }, home });
});

// Ловит ложную тревогу у доступного/неизвестного хоста, архива или 1:1; stale 1:1 должен остаться отдельным сценарием.
it('R206 DmChatView не показывает недоступный дом без down, без хоста, у бывшей группы и у 1:1', async () => {
  await groupDownNotice({ kind: 'group', host: { instanceId: 'neighbor' }, home: fedHome });
  await groupDownNotice({ kind: 'group', home: fedHome });
  await groupDownNotice({ kind: 'group', host: { instanceId: 'neighbor', down: true }, home: fedHome,
    former: { at: '2026-10-12T12:00:00.000Z', removed: false } });
  await groupDownNotice({ kind: 'direct', host: { instanceId: 'neighbor', down: true }, home: fedHome });
  // Похожий класс fed-stale у группы не должен забрать ветку задержки сообщений межинстансного 1:1.
  await staleNotice(true, true, false);
});

// Адресно ловит снятие former-гейта: недоступный дом не должен добавлять notice к бывшей группе.
it('R206 DmChatView мутант без проверки бывшей группы выдаёт лишний composerNotice настоящему архиву', async () => {
  const options = { kind: 'group' as const, host: { instanceId: 'neighbor', down: true as const }, home: fedHome,
    former: { at: '2026-10-12T12:00:00.000Z', removed: false } };
  await groupDownNotice(options);
  const anchor = 'groupDownText && !former ? (';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь notice бывшей группы');
  await assert.rejects(groupDownNotice(options, source.replace(anchor, 'groupDownText ? (')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('плашка дома только действующей группе'));
});
async function filesCapability(remote: boolean, enabled: boolean, refused: boolean, raw = source) {
  const hint = remote ? !enabled ? convRules.FED_FILES_LATER_HINT : refused ? convRules.FED_FILES_PEER_HINT : undefined : undefined;
  for (const width of [360, 1024]) await fixture(width, false, async f => {
    const p = f.pane();
    assert.equal(p.filesBlocked, hint, 'совместимость файлов определяет скрепку');
    assert.equal(typeof p.onSendGif, hint ? 'undefined' : 'function', 'совместимость файлов определяет GIF');
    assert.equal(typeof p.onSendVoice, hint ? 'undefined' : 'function', 'совместимость файлов определяет голосовое');
    assert.equal(p.roundOk, !hint, 'совместимость файлов определяет кружок');
  }, raw, undefined, { peerHome: remote ? fedHome : undefined, fedNoFiles: refused, features: ['gifs1', 'circles1', ...(enabled ? ['fedm3'] : ['fedm2'])] });
}
it('R194 двусторонняя поддержка файлов открывает скрепку, GIF, голос и кружок, местный чат не зависит от неё', async () => {
  // Класс ошибки: возможности Э3 закрыты старым условием дома или открыт несовместимый сосед.
  for (const remote of [false, true]) for (const enabled of [false, true]) for (const refused of [false, true]) await filesCapability(remote, enabled, refused);
});
for (const [name, anchor, replacement, enabled, refused, target] of [
  ['GIF проверяет дом вместо подсказки', 'onSendGif={gifsOn && !filesHint ?', 'onSendGif={gifsOn && !peerHome ?', true, false, 'совместимость файлов определяет GIF'],
  ['кружок проверяет дом вместо подсказки', 'roundOk={roundOn && !filesHint}', 'roundOk={roundOn && !peerHome}', true, false, 'совместимость файлов определяет кружок'],
  ['голос проверяет дом вместо подсказки', 'onSendVoice={filesHint ? undefined :', 'onSendVoice={peerHome ? undefined :', true, false, 'совместимость файлов определяет голосовое'],
  ['сводка fedNoFiles игнорируется', 'fedNoFiles ? { fedNoFiles: true } : null', 'null', true, true, 'совместимость файлов определяет скрепку'],
] as const) it(`R194 контрфакт «${name}» обнаруживается реальными пропсами MessagePane`, async () => {
  // Класс ошибки: один из способов отправки расходится с двусторонним разрешением файлов.
  await filesCapability(true, enabled, refused); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь файлов');
  await assert.rejects(filesCapability(true, enabled, refused, source.replace(anchor, replacement)),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes(target));
});
async function fedComposer(features: string[], remote = true, width = 360, raw = source) {
  await fixture(width, false, async f => {
    // Не передаём DOM-узел в diff AssertionError: печать огромного HappyDOM/React-графа может маскировать отказ мутанта OOM.
    assert.equal(!!f.host.querySelector('[data-testid="fed-dm-write-off"]'), false, 'устаревшая плашка Э1 не скрывает поле переписки');
    assert.ok(!!f.host.querySelector('textarea'), 'MessagePane получает поле для поддерживаемой межинстансной переписки');
  }, raw, undefined, { peerHome: remote ? fedHome : undefined, features });
}
it('R190 межинстансный ЛС с fedm2 имеет поле ввода, прежняя плашка Э1 не возвращается при загрузке признаков', async () => {
  // Класс ошибки: устаревшая плашка продолжает блокировать уже реализованную текстовую переписку.
  for (const width of [360, 1024]) {
    for (const features of [[], ['fedm1'], ['fedm1', 'fedm2']]) await fedComposer(features, true, width);
    await fedComposer([], false, width);
  }
});
async function fedHeader(raw = source) {
  for (const [home, label] of [
    [{ ...fedHome, name: '  Сосед  ' }, 'Сосед'],
    [{ ...fedHome, name: '   ' }, 'neighbor.example'],
    [{ instanceId: 'neighbor', name: null, domain: '' }, 'другой инстанс'],
  ] as const) for (const width of [360, 1024]) await fixture(width, false, async f => {
    const mark = f.host.querySelector('.dm-who strong .guest-mark');
    assert.ok(mark, 'шапка показывает дом собеседника');
    assert.equal(mark.getAttribute('title'), `С инстанса «${label}»`);
    assert.equal(mark.getAttribute('aria-label'), `с инстанса «${label}»`);
    const icon = mark.querySelector('[data-header-icon="globe"]'); assert.ok(icon, 'значок дома — глобус');
    assert.equal(icon.getAttribute('data-size'), '12');
  }, raw, undefined, { peerHome: home, inspectIcons: true });
}
it('R189 шапка межинстансного ЛС показывает глобус с именем, доменом или честным fallback', async () => {
  // Класс ошибки: удалённый собеседник выглядит местным или его неизвестное имя превращается в undefined.
  await fedHeader();
});
it('R189 местная беседа, группа и Избранное не получают значок дома отдельного собеседника', async () => {
  // Класс ошибки: знак одного человека ошибочно подписывает группу или собственные заметки как чужой инстанс.
  for (const kind of ['direct', 'group', 'saved'] as const) await fixture(360, false, async f => {
    assert.equal(f.host.querySelector('.dm-who strong .guest-mark'), null);
    if (kind === 'group') assert.equal(f.host.querySelector('[data-testid="fed-dm-write-off"]'), null);
  }, source, undefined, { kind, peerHome: kind === 'direct' ? undefined : fedHome, inspectIcons: true });
});
it('R190 возврат плашки Э1 обнаруживается настоящим fedm2-состоянием DmChatView', async () => {
  // Класс ошибки: повторное включение старой замены поля делает реализованную Э2 недоступной.
  // Контрфакт прежний; отказ ограничен scalar oracle, а не форматированием циклического DOM-графа.
  await fedComposer(['fedm2']);
  const anchor = '        ) : undefined\n      }\n      /* Как у Telegram Android: просто «Сообщение»';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный fallback замены поля');
  const replacement = '        ) : peerHome ? <div data-testid="fed-dm-write-off">Переписка пока недоступна</div> : undefined\n      }\n      /* Как у Telegram Android: просто «Сообщение»';
  await assert.rejects(fedComposer(['fedm2'], true, 360, source.replace(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes('устаревшая плашка Э1'));
});
it('R189 контрфакт потерянного дома обнаруживается значком настоящей шапки DmChatView', async () => {
  // Класс ошибки: данные дома пришли, но ветка шапки больше их не отображает.
  await fedHeader();
  const anchor = "const peerHomeLabel = peerHome ? peerHome.name?.trim() || peerHome.domain || 'другой инстанс' : null;";
  assert.equal(source.split(anchor).length - 1, 1, 'единственная подпись дома');
  await assert.rejects(fedHeader(source.replace(anchor, 'const peerHomeLabel = null;')),
    e => e instanceof assert.AssertionError && e.message.includes('шапка показывает дом собеседника'));
});

it('R192 человек соседа получает запрет файлов, голосового, GIF и кружка; местному те же признаки оставляют действия', async () => {
  // Класс ошибки: закрываются только кнопки, а обработчики вложений остаются доступны у удалённого человека.
  for (const remote of [false, true]) for (const width of [360, 1024]) await fixture(width, false, async f => {
    const p = f.pane();
    assert.equal(p.filesBlocked, remote ? convRules.FED_FILES_LATER_HINT : undefined);
    assert.equal(typeof p.onSendVoice, remote ? 'undefined' : 'function');
    assert.equal(typeof p.onSendGif, remote ? 'undefined' : 'function');
    assert.equal(p.roundOk, !remote);
  }, source, undefined, { peerHome: remote ? fedHome : undefined, features: ['gifs1', 'circles1', 'fedm2'] });
});
async function archiveContract(remote: boolean, broken = true, raw = source) {
  for (const width of [360, 1024]) await fixture(width, false, async f => {
    const archive = remote && broken;
    assert.equal(f.pane().readOnly, archive, 'только удалённая сломанная связка включает readOnly');
    assert.equal(typeof f.pane().onReact, archive ? 'undefined' : 'function', 'реакция отсутствует у удалённого архива');
    assert.equal(!!f.host.querySelector('button[title="Позвонить"]'), !archive, 'трубка отсутствует у удалённого архива');
    assert.equal(!!f.host.querySelector('.composer-blocked.fed-archive'), archive, 'архив вместо поля ввода');
    assert.equal(!!f.host.querySelector('textarea'), !archive);
    if (archive) assert.match(f.host.querySelector('.fed-archive')!.textContent!, /Связь с инстансом «Сосед» разорвана/);
  }, raw, undefined, { peerHome: remote ? fedHome : undefined, fedLink: broken ? 'broken' : 'ok', features: ['fedm2'] });
}
it('R192 broken сводка архивирует только удалённую беседу, местную и восстановленную оставляет доступными', async () => {
  // Класс ошибки: локальный чужой флаг ломает местный ЛС либо архив разрешает реакцию и звонок.
  await archiveContract(true); await archiveContract(false); await archiveContract(true, false);
});
async function contactContract(remote: boolean, raw = source) {
  await fixture(1024, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]');
    assert.equal(labels(f.host).includes('Добавить в контакты'), !remote, 'добавление в контакты возможно только для местного собеседника');
  }, raw, undefined, { peerHome: remote ? fedHome : undefined, features: ['contacts1'] });
}
it('R192 признак contacts1 даёт добавить местного в контакты, но не человека соседнего инстанса', async () => {
  // Класс ошибки: интерфейс обещает запись удалённого контакта, которую сервер этой фазы не поддерживает.
  await contactContract(false); await contactContract(true);
});
for (const [name, anchor, replacement, remote, target] of [
  ['сломанный флаг местной беседы', '!!peerHome && fedLinkBroken(s.conv.summaries[dm.id])', 'fedLinkBroken(s.conv.summaries[dm.id])', false,
    'только удалённая сломанная связка'],
  ['архив допускает запись', 'readOnly={!!former || linkBroken}', 'readOnly={!!former}', true,
    'только удалённая сломанная связка'],
  ['архив допускает реакции', 'onReact={former || linkBroken ? undefined :', 'onReact={former ? undefined :', true,
    'реакция отсутствует у удалённого архива'],
  ['архив допускает звонок', '{callsOn && !linkBroken && (', '{callsOn && (', true,
    'трубка отсутствует у удалённого архива'],
] as const) it(`R192 контрфакт «${name}» ловится реальным DmChatView`, async () => {
  // Класс ошибки: весь модуль исполняется, а мутант ломает именно выбранное полномочие архива.
  await archiveContract(remote); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь архива');
  await assert.rejects(archiveContract(remote, true, source.replace(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});
it('R192 удаление запрета контактов человека соседа обнаруживается пунктом настоящего меню', async () => {
  // Класс ошибки: несуществующая серверная возможность появляется после снятия одной клиентской проверки дома.
  await contactContract(true);
  const anchor = "useStore((s) => serverContacts(s.serverFeatures)) && !user?.homeInstance && !dm.group && !dm.saved && !peerHome;";
  assert.equal(source.split(anchor).length - 1, 1, 'единственный контракт контактов');
  await assert.rejects(contactContract(true, source.replace(anchor, anchor.replace(' && !peerHome;', ';'))),
    e => e instanceof assert.AssertionError && e.message.includes('добавление в контакты возможно только'));
});

// MessagePane — граница теста: рисует переданные JSX, но не копирует правил шапки/меню/закрепления.
function PaneBoundary({ headerActions, title, chatSearch, placeholder, composerReplacement, composerNote, composerNotice }: {
  headerActions?: React.ReactNode; title: React.ReactNode; chatSearch?: { open: boolean }; placeholder?: string; composerReplacement?: React.ReactNode;
  composerNote?: React.ReactNode; composerNotice?: React.ReactNode;
}) {
  return React.createElement('div', null,
    React.createElement('header', null, title, React.createElement('div', { className: 'topbar-actions' }, headerActions)),
    chatSearch?.open ? React.createElement('div', { 'data-search-open': true }) : null, composerNote, composerNotice,
    composerReplacement ?? React.createElement('textarea', { placeholder }));
}
function MenuBoundary({ children, anchor, pos, align, drop, width, fit }: {
  children: React.ReactNode; anchor?: DOMRect; pos?: { x: number; y: number };
  align?: string; drop?: boolean; width?: number; fit?: boolean;
}) {
  // Это наблюдение пропсов на границе: геометрию и отсутствие листа проверяет suite ContextMenu.
  return React.createElement('div', { role: 'menu', 'data-anchor': anchor ? JSON.stringify([anchor.x, anchor.y, anchor.width, anchor.height]) : undefined,
    'data-pos': pos ? JSON.stringify(pos) : undefined, 'data-align': align,
    'data-drop': String(!!drop), 'data-width': width, 'data-fit': String(!!fit) }, children);
}
function MenuItemBoundary({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return React.createElement('button', { role: 'menuitem', onClick, 'data-danger': String(!!danger) }, label);
}
// Наблюдаем только переданные пропсы: размеры и условия показа определяет настоящий DmChatView.
function AvatarBoundary({ size }: { size: number }) {
  return React.createElement('span', { 'data-header-avatar-size': size });
}
function DotBoundary({ status }: { status: string }) {
  return React.createElement('span', { 'data-header-dot-status': status });
}

async function fixture(width: number, pinned: boolean, check: (f: {
  host: HTMLDivElement; pinCalls: Array<[string, boolean]>; callIds: string[];
  muteCalls: unknown[][]; savedMute: number[];
  render(): Promise<void>; currentDm(): DmChannel; pane(): PaneProps;
  seenIds(): Array<string | null>;
}) => Promise<void>, raw = source, presence?: { online: boolean; lastSeen: UserLastSeen | null },
  options: { kind?: 'direct' | 'group' | 'saved'; muteMenu?: boolean; muted?: boolean;
  recent?: number[]; soundMenu?: boolean; prefs?: boolean; realItems?: boolean; realMenu?: boolean; statusForms?: boolean;
  peerHome?: DmChannel['otherUser']['homeInstance']; features?: string[]; inspectIcons?: boolean; fedLink?: 'broken' | 'ok'; fedNoFiles?: boolean;
  fedVia?: { down: boolean; ready: string[]; self: string }; fedStale?: boolean; selfInstanceName?: string;
  fedGroupHost?: ConvSummary['fedGroupHost']; former?: ConvSummary['former']; groupMembers?: NonNullable<DmChannel['group']>['members'] } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/', width });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    let dm = { id: 'conversation', otherUser: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null },
      pinnedAt: pinned ? '2026-10-08T00:00:00.000Z' : null, archived: false } as DmChannel;
    if (options.kind === 'group') dm = { ...dm, group: { title: 'Группа', avatarUrl: null, ownerId: 'me', members: options.groupMembers ?? [], limit: 5 } };
    if (options.kind === 'saved') dm = { ...dm, saved: true };
    if (options.muted) dm = { ...dm, muted: { until: null } };
    if (options.peerHome) dm = { ...dm, otherUser: { ...dm.otherUser, homeInstance: options.peerHome } };
    const pinCalls: Array<[string, boolean]> = []; const callIds: string[] = [];
    const muteCalls: unknown[][] = []; const savedMute: number[] = [];
    let paneProps: PaneProps | undefined;
    const seenIds: Array<string | null> = [];
    const state = {
      user: { id: 'me', displayName: 'Я', avatarUrl: null, notifyDm: true }, dmMessages: { conversation: [] },
      pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [], convActive: true,
      serverFeatures: [...(options.prefs === false ? [] : ['conv11']), 'conv12', 'archive1', 'search1', 'calls1',
        ...(options.soundMenu ? ['conv13'] : []), ...(options.features ?? [])],
      conv: { summaries: options.fedLink || options.fedNoFiles || options.fedStale || options.fedGroupHost || options.former
        ? { conversation: { fedLink: options.fedLink, fedNoFiles: options.fedNoFiles, fedStale: options.fedStale,
          fedGroupHost: options.fedGroupHost, former: options.former } } : {}, windows: {}, gone: {} }, outbox: {}, drafts: {}, draftRev: {}, places: {},
      dms: [dm],
      fedVia: options.fedVia,
      selfInstanceName: options.selfInstanceName,
      historyFailed: [], blockedUsers: [],
      setPushMuted: async (...args: unknown[]) => { muteCalls.push(args); },
      setConvPinned: async (id: string, next: boolean) => {
        pinCalls.push([id, next]);
        dm = { ...dm, pinnedAt: next ? '2026-10-08T12:00:00.000Z' : null };
      },
    };
    const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
    const useDmStickers = Object.assign((select: (s: { mine: never[]; recent: never[] }) => unknown) => select({ mine: [], recent: [] }),
      { getState: unused });
    const useCall = Object.assign((select: (s: { call: null }) => unknown) => select({ call: null }),
      { getState: () => ({ start: async (id: string) => { callIds.push(id); } }) });
    const dependencies: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx,
      '../dmStickerRules': { serverDmStickers: () => false }, '../dmStickers': { useDmStickers },
      './StickerCatalogPanel': { StickerCatalogPanel: noView },
      '../channelVisit': { useChannelVisit: () => ({ newSince: null, readKey: 0, visitKey: 'visit', started: true }) },
      '../api': { api: { convSearch: unused } }, '../effectsBus': { fireEffect: unused },
      '../chatSearchRules': { SEARCH_PAGE: 50 }, '../uploadProgress': {
        setUploadDone: unused, setUploadProgress: unused, uploadAborted: unused, uploadSignal: unused,
      },
      '../confirm': { confirmAction: unused }, '../strangerBarRules': { serverStranger: () => false, strangerBarShown: () => false },
      '../contactRules': contactRules,
      '../contacts': { useContactList: () => [], useContacts: { getState: unused } },
      '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback,
        dmPeerLabel: (value: DmChannel) => value.otherUser.displayName, peerNameNow: (_id: string, fallback: string) => fallback },
      '../connState': { useConnState: () => null, connLabel: () => null }, '../sockets': { sendTyping: unused },
      '../notifications': { clearOsNotifications: () => {} }, '../store': { useStore },
      '../toast': { toast: unused, toastError: unused, useToasts: { getState: unused } },
      '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
      './Avatar': { Avatar: AvatarBoundary }, '../callStore': { useCall, explainCallPrivacy: unused }, '../callView': callRules,
      './StrangerBar': { StrangerBar: noView, StrangerReportModal: noView }, './ContactEditModal': { removeContactAsk: unused },
      './ContextMenu': { ContextMenu: MenuBoundary, MenuItem: MenuItemBoundary,
        MenuDivider: () => React.createElement('hr', { role: 'separator', className: 'ctx-divider' }) },
      './dmClearActions': { clearHistory: unused, deleteChat: unused, deleteFormerGroup: unused },
      './DmSidebar': { useMuteClock: () => Date.now() }, './FeedLoadError': { FeedLoadError: noView }, './Icon': { Icon: options.inspectIcons
        ? ({ name, size }: { name: string; size: number }) => React.createElement('i', { 'data-header-icon': name, 'data-size': size }) : noView },
      './DmArchive': { archiveDms: unused }, '../dmArchiveRules': archiveRules, './DesktopKeys': { CHAT_MENU_EVENT: 'test-chat-menu' },
      './UserContextMenu': { useUserMenu: () => ({ openAt: unused, menu: null }) }, './MessagePane': { MessagePane: (props: PaneProps) => {
        paneProps = props; return React.createElement(PaneBoundary, props);
      } },
      './ScheduledView': { ScheduledView: noView }, './StatusDot': { StatusDot: DotBoundary }, '../useLastSeen': { useLastSeen: (id: string | null) => {
        seenIds.push(id); return id ? presence?.lastSeen ?? null : null;
      } },
      '../dmOnline': { dmPresent: () => presence?.online ?? false, dmDot: (online: boolean) => online, useLocalOnline: () => false },
      '../lastSeenText': { serverLastSeen: () => !!presence, lastSeenLabel },
      '../statusFit': { lastSeenForms: (v: UserLastSeen) => options.statusForms
        ? lastSeenForms(v, new Date(2026, 9, 12, 20)) : [lastSeenLabel(v, new Date())], useStatusFit: () => {} },
      './SavedAvatar': { SavedAvatar: AvatarBoundary, SavedEmpty: noView },
      '../groupChatRules': groupRules,
      './GroupDialogs': { leaveGroup: unused, openGroupInfo: unused }, '../clientId': { newClientId: unused },
      '../convStore': { feedWindowSwitch: () => true, toOutboxRef: unused }, '../convSyncRules': convRules,
      '../notifyExceptionsRules': { notifyAlwaysAction: () => null }, '../dmListRules': listRules,
      '../muteRecent': { loadMuteRecent: () => options.recent ?? (options.muteMenu ? [900, 93 * 86400] : []),
        saveMuteRecent: (seconds: number) => { savedMute.push(seconds); } }, '../dmBubbles': { dmBubblesSwitch: () => false },
      '../phoneLayout': phoneLayout, '../historyPage': { hasMoreOlder: unused, olderCursor: unused },
    };
    if (options.realItems || options.realMenu) {
      if (options.realMenu) {
        // Проверяем события и уровни, не layout happy-dom: геометрия меню/вьюпорта задана явно.
        Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });
        Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => 900 });
        for (const [name, value] of [['offsetWidth', 196], ['offsetHeight', 240], ['offsetTop', 0], ['offsetLeft', 0]] as const)
          Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => value });
      }
      const menu = { exports: {} as typeof import('./ContextMenu') };
      runInNewContext(ts.transpileModule(readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText, { module: menu, exports: menu.exports, window, document, HTMLElement, Element, Node, Event, DOMRect,
        getComputedStyle, require: (id: string) => {
        if (id === 'react') return React;
        if (id === 'react-dom') return ReactDOM;
        if (id === 'react/jsx-runtime') return jsx;
        if (id === './Icon') return { Icon: noView };
        if (id === '../popover') return popover;
        if (id === '../imageViewer') return { useImageViewerOpen: () => false };
        return new Proxy({}, { get: (_t, key) => { throw new Error(`Неописанная граница меню ${id}.${String(key)}`); } });
      } });
      dependencies['./ContextMenu'] = { ContextMenu: options.realMenu ? menu.exports.ContextMenu : MenuBoundary,
        MenuItem: menu.exports.MenuItem, MenuDivider: menu.exports.MenuDivider };
    }
    const module = { exports: {} as typeof Chat };
    runInNewContext(ts.transpileModule(raw, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, window, document, DOMRect, requestAnimationFrame,
      require: (id: string) => {
        assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${id}`);
        return dependencies[id];
      } });
    const render = async () => { await React.act(async () => root.render(options.muteMenu
      ? React.createElement(module.exports.DmMuteMenuItems, { peerId: 'peer', mute: null, now: 0, onDone: () => {} })
      : React.createElement(module.exports.DmChatView, { dm }))); };
    await render();
    await check({ host, pinCalls, callIds, muteCalls, savedMute, render, currentDm: () => dm,
      seenIds: () => [...seenIds],
      pane: () => { assert.ok(paneProps, 'настоящий DmChatView смонтировал MessagePane'); return paneProps; } });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      try { await GlobalRegistrator.unregister(); }
      finally {
        if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}

async function click(host: HTMLElement, selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, `кнопка ${selector} существует`);
  await React.act(async () => button.click());
}
function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[role="menuitem"]')].map(el => el.textContent ?? '');
}

function checkPhoneMenu(host: HTMLElement) {
  const menu = host.querySelector('[role="menu"]'); assert.ok(menu);
  assert.equal(menu.getAttribute('data-drop'), 'true', 'телефон передаёт drop выпадающему меню');
  assert.equal(menu.getAttribute('data-align'), 'end');
  assert.equal(menu.getAttribute('data-width'), '196');
  assert.equal(menu.getAttribute('data-fit'), 'true');
  assert.notEqual(menu.getAttribute('data-anchor'), null, 'телефон передаёт прямоугольник кнопки');
  assert.equal(menu.getAttribute('data-pos'), null, 'телефон не подменяет якорь точкой');
  const items = labels(host);
  assert.equal(items.filter(label => label === 'Поиск').length, 1, 'поиск ровно один в телефонном меню');
  assert.deepEqual([...menu.children].slice(0, 3).map(el => el.getAttribute('role') === 'separator' ? 'разрыв' : el.textContent),
    ['Уведомления', 'разрыв', 'Поиск'], 'уведомления, разрыв и поиск открывают телефонное меню');
  assert.deepEqual(items.slice(-2), ['Очистить историю', 'Удалить чат'], 'разрушающие действия идут последними после нашего блока');
  const remove = [...menu.querySelectorAll('[role="menuitem"]')].find(el => el.textContent === 'Удалить чат');
  assert.equal(remove?.getAttribute('data-danger'), 'false', 'удаление чата на телефоне обычного цвета');
}

async function choose(host: HTMLElement, label: string) {
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(el => el.querySelector('.ctx-label-main')?.textContent === label || el.textContent === label);
  assert.ok(item, `есть пункт ${label}`); await React.act(async () => item.click());
}
async function notificationSubmenu(raw = source) {
  await fixture(390, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]');
    const before = f.host.querySelector('[role="menu"]'); assert.ok(before);
    const anchor = before.getAttribute('data-anchor');
    await choose(f.host, 'Уведомления');
    const menu = f.host.querySelector('[role="menu"]'); assert.ok(menu, 'подменю не закрывает меню');
    assert.equal(f.host.querySelectorAll('[role="menu"]').length, 1);
    assert.equal(menu.getAttribute('data-anchor'), anchor);
    assert.equal(menu.getAttribute('data-drop'), 'true');
    assert.equal(menu.getAttribute('data-width'), '196');
    assert.deepEqual(labels(f.host), ['Назад', 'Выключить звук', 'Выключить на 15 минут',
      'Выключить на 3 месяца', 'Выключить на время…', 'Выключить уведомления']);
    assert.equal(menu.querySelectorAll('.ctx-divider').length, 0, 'в подменю нет разделителя');
    const forever = [...menu.querySelectorAll('[role="menuitem"]')].find(el => el.textContent === 'Выключить уведомления');
    assert.equal(forever?.classList.contains('danger'), true);
    assert.equal(f.muteCalls.length, 0, 'открытие выбора ничего не заглушает');
    await choose(f.host, 'Выключить на время…');
    assert.deepEqual(labels(f.host), ['Выключить на время', '1 час', '8 часов', '1 день', '2 дня', '1 неделя', 'Свой срок…']);
    assert.equal(!!f.host.querySelector('[role="menu"]'), true);
    await choose(f.host, 'Выключить на время');
    assert.equal(labels(f.host)[0], 'Назад', 'возврат из сроков сохраняет связь с основным меню');
    await choose(f.host, 'Назад');
    assert.equal(labels(f.host)[0], 'Уведомления', 'Назад возвращает исходный список');
    assert.equal(labels(f.host).includes('Поиск'), true);
    assert.equal(!!f.host.querySelector('[role="menu"]'), true);
    await choose(f.host, 'Уведомления'); await choose(f.host, 'Выключить уведомления');
    assert.deepEqual(f.muteCalls, [['dm_user', 'peer', true, undefined, undefined]]);
    assert.equal(!!f.host.querySelector('[role="menu"]'), false);
  }, raw, undefined, { realItems: true, soundMenu: true, recent: [900, 93 * 86400] });
}
it('R170 телефон открывает уведомления на месте меню, сохраняет сроки и красный постоянный запрет, Назад возвращает список', () => {
  // Потеря onBack превращает выбор сроков в тупик, закрытие при входе делает подменю недоступным.
  return notificationSubmenu();
});
it('R170 без поддержки звука и запомненных сроков остаются Назад, выбор времени и постоянный запрет', async () => {
  // Не обещаем серверу неподдерживаемую настройку, но основные способы заглушить не теряются.
  await fixture(390, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]'); await choose(f.host, 'Уведомления');
    assert.deepEqual(labels(f.host), ['Назад', 'Выключить на время…', 'Выключить уведомления']);
    assert.equal(f.host.querySelectorAll('.ctx-divider').length, 0);
  }, source, undefined, { realItems: true });
});
it('R170 Выключить звук передаёт только звуковую заглушку и закрывает подменю', async () => {
  // soundOnly нельзя подменять полным запретом уведомлений: пользователь хотел убрать только тон.
  await fixture(390, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]'); await choose(f.host, 'Уведомления');
    await choose(f.host, 'Выключить звук');
    assert.deepEqual(f.muteCalls, [['dm_user', 'peer', true, undefined, true]]);
    assert.equal(!!f.host.querySelector('[role="menu"]'), false);
  }, source, undefined, { realItems: true, soundMenu: true });
});
it('R170 сервер без сроков сохраняет прямой Отключить уведомления без подменю', async () => {
  // Старые серверы не должны получать интерфейс срока, который они не умеют сохранить.
  await fixture(390, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]');
    assert.equal(labels(f.host)[0], 'Отключить уведомления');
    await choose(f.host, 'Отключить уведомления');
    assert.deepEqual(f.muteCalls, [['dm_user', 'peer', true]]);
    assert.equal(!!f.host.querySelector('[role="menu"]'), false);
  }, source, undefined, { realItems: true, prefs: false });
});
async function instantUnmute(raw = source) {
  await fixture(390, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]');
    assert.equal(labels(f.host)[0], 'Включить уведомления', 'заглушённая беседа сразу предлагает включить');
    await choose(f.host, 'Включить уведомления');
    assert.deepEqual(f.muteCalls, [['dm_user', 'peer', false]]);
    assert.equal(!!f.host.querySelector('[role="menu"]'), false, 'включение закрывает меню без подменю');
  }, raw, undefined, { realItems: true, muted: true });
}
it('R170 заглушённая беседа сразу включает уведомления без захода в подменю', () => {
  // Дополнительный экран для включения ломает быстрый обратный переключатель.
  return instantUnmute();
});
async function desktopNotifications(raw = source) {
  await fixture(1280, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]');
    assert.equal(labels(f.host)[0], 'Выключить уведомления…', 'ПК сохраняет прежнюю подпись');
    await choose(f.host, 'Выключить уведомления…');
    const menu = f.host.querySelector('[role="menu"]'); assert.ok(menu);
    assert.equal(menu.getAttribute('data-drop'), 'false'); assert.equal(menu.getAttribute('data-width'), '256');
    assert.notEqual(menu.getAttribute('data-anchor'), null, 'ПК открывает старый bellAt попап');
    assert.equal(labels(f.host).includes('Назад'), false);
    assert.equal(labels(f.host).includes('Поиск'), false);
    assert.equal(f.muteCalls.length, 0);
  }, raw, undefined, { realItems: true });
}
it('R170 компьютер сохраняет подпись с многоточием и отдельный bellAt попап без Назад', () => {
  // Телефонное переименование не должно изменять привычное меню компьютера.
  return desktopNotifications();
});
for (const [name, anchor, replacement, check] of [
  ['удалённый onBack', 'onBack={() => setMuteSub(false)}', '', notificationSubmenu],
  ['разделитель внутри подменю', '{!onBack && <MenuDivider />}', '{<MenuDivider />}', notificationSubmenu],
  ['подменю у заглушённой беседы', 'phone && moreAt.rect && prefsOn && !pushMuted ? (', 'phone && moreAt.rect && prefsOn ? (', instantUnmute],
  ['телефонная подпись на компьютере', "prefsOn ? 'Выключить уведомления…' : 'Отключить уведомления'", "prefsOn ? 'Уведомления' : 'Отключить уведомления'", desktopNotifications],
] as const) it(`R170 контрфакт ${name} обнаруживается настоящим кликом и DOM`, async () => {
  // Проверяем тот же сценарий на оригинале: отказ неизвестной VM-границы не считается ловлей мутанта.
  await check(source); assert.equal(source.split(anchor).length - 1, 1, 'один точный якорь мутации');
  await assert.rejects(() => check(source.replace(anchor, replacement)), assert.AssertionError);
});

for (const viaKeys of [false, true]) {
  it(`R161 ПК: ${viaKeys ? 'событие Ctrl+\\' : 'кнопка ⋮'} сохраняет точку, порядок и красное удаление`, async () => {
    await fixture(1280, false, async f => {
      const button = f.host.querySelector<HTMLButtonElement>('button[title="Меню беседы"]'); assert.ok(button);
      button.getBoundingClientRect = () => new DOMRect(1100, 12, 40, 36);
      await React.act(async () => viaKeys ? window.dispatchEvent(new Event('test-chat-menu')) : button.click());
      const menu = f.host.querySelector('[role="menu"]'); assert.ok(menu);
      assert.equal(menu.getAttribute('data-anchor'), null);
      assert.equal(menu.getAttribute('data-pos'), JSON.stringify({ x: 876, y: 52 }));
      assert.equal(menu.getAttribute('data-drop'), 'false');
      assert.equal(menu.getAttribute('data-width'), '264');
      assert.equal(menu.getAttribute('data-fit'), 'true');
      assert.deepEqual(labels(f.host), ['Выключить уведомления…', 'В архив', 'Показать профиль', 'Поиск', 'Заблокировать', 'Очистить историю', 'Удалить чат']);
      assert.equal([...menu.querySelectorAll('[role="menuitem"]')].find(el => el.textContent === 'Удалить чат')?.getAttribute('data-danger'), 'true');
    });
  });
}

for (const [name, anchor, replacement, failure] of [
  ['без drop', 'align="end" drop width={196}', 'align="end" width={196}', 'телефон передаёт drop'],
  ['красное удаление телефона', 'danger={!phone}', 'danger', 'удаление чата на телефоне'],
  ['поиск перед уведомлениями', '                    {muteItem}\n                    {muteItem && <MenuDivider />}\n                    {searchItem}',
    '                    {searchItem}\n                    {muteItem}\n                    {muteItem && <MenuDivider />}', 'уведомления, разрыв и поиск'],
  ['разрушающие действия перед нашим блоком', '                    {blockItem}\n                    {formerItem}\n                    {clearItems}',
    '                    {clearItems}\n                    {blockItem}\n                    {formerItem}', 'разрушающие действия идут последними'],
] as const) {
  it(`R161 контрфакт меню телефона: ${name}`, async () => {
    const check = (raw: string) => fixture(390, false, async f => {
      await click(f.host, 'button[title="Меню беседы"]'); checkPhoneMenu(f.host);
    }, raw);
    await check(source);
    assert.equal(source.split(anchor).length - 1, 1, 'один точный якорь мутации');
    await assert.rejects(() => check(source.replace(anchor, replacement)),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes(failure));
  });
}

async function checkOnlineAvatar(width: number, raw = source, online = true) {
  await fixture(width, false, async f => {
    const phone = width <= 760;
    // Используется настоящий usePhoneLayout, не подменённый boolean: граница совпадает с CSS телефона.
    assert.equal(window.matchMedia(phoneLayout.PHONE_LAYOUT_QUERY).matches, phone);
    const avatar = f.host.querySelector('.dm-ava [data-header-avatar-size]');
    assert.ok(avatar, 'аватар собеседника смонтирован в шапке');
    assert.equal(avatar.getAttribute('data-header-avatar-size'), String(phone ? 42 : 28),
      'размер аватара соответствует телефонной или настольной шапке');
    const wrap = f.host.querySelector('.dm-ava .mp-dot-wrap');
    assert.equal(!!wrap, online && !phone, 'точка online показана только на ПК при живом присутствии');
    assert.equal(wrap?.querySelector('[data-header-dot-status]')?.getAttribute('data-header-dot-status') ?? null,
      online && !phone ? 'online' : null);
    if (online) assert.equal(f.host.querySelector('.dm-who-status')?.textContent, 'в сети',
      'на телефоне присутствие остаётся в текстовой подписи, хотя точки нет');
    if (phone) {
      const titles = [...f.host.querySelectorAll('.topbar-actions > button')].map(el => el.getAttribute('title'));
      assert.deepEqual(titles, ['Позвонить', 'Меню беседы'], 'поиск и закреп не занимают телефонную шапку');
      await click(f.host, 'button[title="Меню беседы"]');
      checkPhoneMenu(f.host);
    }
  }, raw, { online, lastSeen: null });
}

it('R139 телефон на границе 760px: аватар 42, online словами без точки, уведомления перед поиском',
  () => checkOnlineAvatar(760));

it('R139 ПК сразу за границей 761px: аватар 28 и точка online сохранены',
  () => checkOnlineAvatar(761));

it('R139 ПК без живого присутствия: аватар остаётся 28, точка online не рисуется',
  () => checkOnlineAvatar(761, source, false));

for (const [name, anchor, replacement, expectedFailure] of [
  ['аватар телефона возвращён к 36', 'size={phone ? 42 : 28}', 'size={phone ? 36 : 28}', 'размер аватара'],
  ['точка online возвращена на телефон', 'peerOnline && !phone && (', 'peerOnline && (', 'точка online'],
] as const) {
  it(`R139 контрфакт: ${name} отвергается настоящей шапкой`, async () => {
    await checkOnlineAvatar(760);
    assert.ok(source.includes(anchor), 'мутант меняет существующий контракт настоящего компонента');
    const mutant = source.replaceAll(anchor, replacement);
    assert.notEqual(mutant, source);
    await assert.rejects(() => checkOnlineAvatar(760, mutant), (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError, 'отказ вызван ожиданием DOM, а не ошибкой загрузки');
      assert.ok(error.message.includes(expectedFailure), 'отказ относится к изменённому поведению');
      return true;
    });
  });
}

for (const kind of ['direct', 'group', 'saved'] as const) {
  it(`R125 поле ${kind === 'direct' ? 'ЛС 1:1' : kind === 'group' ? 'группы' : 'Избранного'} подписано просто «Сообщение»`, async () => {
    // Ловит возврат имени/назначения беседы в подсказку поля, особенно в ветках группы и saved.
    const check = async (raw: string) => fixture(390, false, async f => {
      assert.equal(f.host.querySelector('textarea')?.getAttribute('placeholder'), 'Сообщение');
    }, raw, undefined, { kind });
    await check(source);
    const mutant = source.replace('placeholder="Сообщение"', 'placeholder={`Сообщение для ${peerName}`}');
    assert.notEqual(mutant, source);
    await assert.rejects(() => check(mutant), assert.AssertionError);
  });
}

it('R125 подменю сохраняет старые сроки, а окно времени даёт ровно пять пресетов и передаёт выбранный срок', async () => {
  // Проверяет реальный JSX меню: сокращение правил бесполезно, если компонент продолжит рисовать полную шкалу.
  const check = async (raw: string) => fixture(390, false, async f => {
    assert.ok(labels(f.host).includes('Выключить на 15 минут'));
    assert.ok(labels(f.host).includes('Выключить на 3 месяца'));
    const open = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(el => el.textContent === 'Выключить на время…');
    assert.ok(open); await React.act(async () => open.click());
    assert.deepEqual(labels(f.host), ['Выключить на время', '1 час', '8 часов', '1 день', '2 дня', '1 неделя', 'Свой срок…']);
    const day = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === '1 день');
    assert.ok(day); await React.act(async () => day.click());
    assert.deepEqual(f.savedMute, [86400]);
    assert.deepEqual(f.muteCalls, [['dm_user', 'peer', true, 86400, undefined]]);
  }, raw, undefined, { muteMenu: true });
  await check(source);
  const mutant = source.replace('{DM_MUTE_PRESETS.map((p)', '{DM_MUTE_PERIODS.map((p)')
    .replace('import { DM_MUTE_PRESETS,', 'import { DM_MUTE_PRESETS, DM_MUTE_PERIODS,');
  assert.notEqual(mutant, source);
  await assert.rejects(() => check(mutant), assert.AssertionError);
});

async function phoneCheck(width: number, pinned: boolean, raw = source) {
  await fixture(width, pinned, async f => {
    const titles = [...f.host.querySelectorAll('.topbar-actions > button')].map(el => el.getAttribute('title'));
    assert.deepEqual(titles, ['Позвонить', 'Меню беседы'], 'телефонная шапка содержит только звонок и меню');
    await click(f.host, 'button[title="Меню беседы"]');
    const items = labels(f.host);
    checkPhoneMenu(f.host);
    assert.equal(items.filter(label => label === 'Поиск').length, 1, 'поиск ровно один в телефонном меню');
    const pinLabel = pinned ? 'Открепить' : 'Закрепить';
    assert.ok(items.includes(pinLabel), 'телефонное меню содержит действие закрепления');
    assert.equal(items.indexOf(pinLabel), items.indexOf('В архив') + 1, 'закрепление следует сразу после архива');
    const pin = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === pinLabel)!;
    await React.act(async () => pin.click());
    assert.deepEqual(f.pinCalls, [['conversation', !pinned]], 'нажатие вызывает настоящий toggleDmPinned с обратным состоянием');
    assert.equal(!!f.currentDm().pinnedAt, !pinned, 'экшен изменяет состояние закрепления беседы');
    assert.equal(f.host.querySelector('[role="menu"]') === null, true, 'после закрепления меню закрыто');
    await f.render();
    await click(f.host, 'button[title="Меню беседы"]');
    assert.ok(labels(f.host).includes(pinned ? 'Закрепить' : 'Открепить'), 'после обновления предложено обратное действие');
    const search = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === 'Поиск')!;
    await React.act(async () => search.click());
    assert.ok(f.host.querySelector('[data-search-open]'), 'поиск из меню открывает поиск беседы');
    assert.equal(f.host.querySelector('[role="menu"]') === null, true);
    await click(f.host, 'button[title="Позвонить"]');
    assert.deepEqual(f.callIds, ['conversation'], 'телефонная кнопка звонка сохранила действие');
  }, raw);
}

for (const width of [390, 760]) for (const pinned of [false, true]) {
  it(`телефон ${width}px: ${pinned ? 'закреплённая' : 'незакреплённая'} беседа меняет закреп через меню`, () => phoneCheck(width, pinned));
}

for (const pinned of [false, true]) {
  it(`ПК 761px: ${pinned ? 'открепление' : 'закрепление'} и Поиск · Ctrl+F остаются в шапке`, async () => {
    await fixture(761, pinned, async f => {
      assert.deepEqual([...f.host.querySelectorAll('.topbar-actions > button')].map(el => el.getAttribute('title')),
        [pinned ? 'Открепить беседу' : 'Закрепить беседу в списке', 'Поиск · Ctrl+F', 'Позвонить', 'Меню беседы']);
      assert.equal(f.host.querySelector('.topbar-actions > button')?.getAttribute('aria-pressed'), String(pinned));
      await click(f.host, '.topbar-actions > button');
      assert.deepEqual(f.pinCalls, [['conversation', !pinned]]);
      assert.equal(!!f.currentDm().pinnedAt, !pinned);
      await f.render();
      assert.equal(f.host.querySelector('.topbar-actions > button')?.getAttribute('title'),
        pinned ? 'Закрепить беседу в списке' : 'Открепить беседу');
      assert.equal(f.host.querySelector('.topbar-actions > button')?.getAttribute('aria-pressed'), String(!pinned));
      await click(f.host, 'button[title="Поиск · Ctrl+F"]');
      assert.ok(f.host.querySelector('[data-search-open]'), 'ПК-поиск открывает тот же поиск беседы');
      await click(f.host, 'button[title="Меню беседы"]');
      assert.equal(labels(f.host).filter(label => label === 'Поиск').length, 1, 'в ПК-меню поиск не дублируется');
      assert.equal(labels(f.host).some(label => label === 'Закрепить' || label === 'Открепить'), false);
    });
  });
}

const mutations = [
  ['возвращает закреп и поиск в телефонную шапку', (s: string) => s.replace('prefsOn && !former && !phone && (', 'prefsOn && !former && (')
    .replace('searchOn && !phone && (', 'searchOn && ('), 'телефонная шапка содержит только звонок и меню'],
  ['убирает закрепление из телефонного меню', (s: string) => s.replace('phone && prefsOn && !former && (', 'false && prefsOn && !former && ('),
    'телефонное меню содержит действие закрепления'],
  ['дублирует поиск в телефонном меню', (s: string) => s.replace(
    '                    {searchItem}\n                    {addContactItem}', '                    {searchItem}{searchItem}\n                    {addContactItem}'),
    'поиск ровно один в телефонном меню'],
] as const;

it('R117 шапка сразу заменяет устаревший online снимок на только что или недавно, живое присутствие главнее', async () => {
  const check = async (raw: string) => {
    const snapshot: UserLastSeen = { userId: 'peer', online: true, exact: true,
      at: '2026-01-01T12:34:00.000Z', approx: null, byMe: false };
    const cases: Array<{ online: boolean; lastSeen: UserLastSeen | null; expected: string }> = [
      { online: false, lastSeen: snapshot, expected: 'был(а) только что' },
      { online: false, lastSeen: { ...snapshot, exact: false }, expected: 'был(а) недавно' },
      { online: true, lastSeen: snapshot, expected: 'в сети' },
      { online: true, lastSeen: { ...snapshot, exact: false }, expected: 'в сети' },
      { online: false, lastSeen: { ...snapshot, online: false, exact: false, at: null, approx: 'recently' }, expected: 'был(а) недавно' },
      { online: false, lastSeen: null, expected: '' },
    ];
    for (const row of cases) await fixture(390, false, async f => {
      const status = f.host.querySelector('.dm-who-status'); assert.ok(status);
      assert.equal(status.textContent, row.expected, 'статус не исчезает при запаздывающем снимке и не раскрывает время');
      if (!row.online && row.lastSeen?.exact === false) assert.doesNotMatch(status.textContent ?? '', /\d/);
    }, raw, row);
  };
  await check(source);
  const old = "lastSeen.online ? [lastSeen.exact ? 'был(а) только что' : 'был(а) недавно']";
  assert.equal(source.split(old).length - 1, 1, 'единственный актуальный якорь устаревшего снимка');
  const mutant = source.replace(old, 'lastSeen.online ? []'); assert.notEqual(mutant, source);
  await assert.rejects(() => check(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('статус не исчезает'));
});

for (const [name, mutate, expectedFailure] of mutations) {
  it(`контрфакт шапки: ${name}`, async () => {
    await phoneCheck(760, false);
    const changed = mutate(source);
    assert.notEqual(changed, source, 'изменён настоящий JSX-контракт');
    await assert.rejects(() => phoneCheck(760, false, changed), (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.match(error.message, new RegExp(`^${expectedFailure}`));
      return true;
    });
  });
}

async function realChoose(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.ctx-item')).find(el => el.querySelector('.ctx-label-main')?.textContent === label);
  assert.equal(!!button, true, `настоящий пункт ${label}`); await React.act(async () => button!.click());
}
const realLabels = () => Array.from(document.querySelectorAll('.ctx-item .ctx-label-main')).map(el => el.textContent ?? '');
async function systemEscape() {
  // Именно такое всплывающее событие stepBack отправляет на document для верхнего меню Android.
  await React.act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
}
async function menuBackLevels(raw = source) {
  await fixture(620, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]'); await realChoose('Уведомления'); await realChoose('Выключить на время…');
    assert.equal(realLabels()[0], 'Выключить на время'); assert.equal(realLabels().includes('1 час'), true);
    await systemEscape();
    assert.equal(document.querySelectorAll('.ctx-menu').length, 1, 'Назад из сроков не закрывает меню');
    assert.equal(realLabels()[0], 'Назад'); assert.equal(realLabels().includes('Выключить на время…'), true);
    await systemEscape();
    assert.equal(document.querySelectorAll('.ctx-menu').length, 1, 'Назад из mute сначала возвращает главное меню, не закрывает его');
    assert.equal(realLabels()[0], 'Уведомления'); assert.equal(realLabels().includes('Поиск'), true);
    await systemEscape(); assert.equal(document.querySelectorAll('.ctx-menu').length, 0);
    assert.equal(f.muteCalls.length, 0, 'шаги Назад ничего не заглушают');
  }, raw, undefined, { realMenu: true });
}
// Класс ошибки: системная Назад закрывает общее меню вместо шага по состоянию уведомлений.
it('R179 настоящий ContextMenu на 620 проводит Escape сроки → mute → общее меню → закрытие', () => menuBackLevels());
// Класс ошибки: пункт back не доходит до реального MenuItem data-menu-back.
it('R179 Назад в mute и Выключить на время в сроках имеют настоящий атрибут data-menu-back', () => fixture(620, false, async f => {
  await click(f.host, 'button[title="Меню беседы"]'); await realChoose('Уведомления');
  assert.equal(document.querySelector('[data-menu-back] .ctx-label-main')?.textContent, 'Назад');
  assert.equal(document.querySelectorAll('[data-menu-back]').length, 1);
  await realChoose('Выключить на время…');
  assert.equal(document.querySelector('[data-menu-back] .ctx-label-main')?.textContent, 'Выключить на время');
  assert.equal(document.querySelectorAll('[data-menu-back]').length, 1);
}, source, undefined, { realMenu: true }));
// Класс ошибки: тап мимо проходит назад по уровням вместо закрытия всего меню.
it('R179 тап мимо настоящего меню на любом уровне сразу закрывает его целиком', async () => {
  for (const level of ['main', 'mute', 'time']) await fixture(620, false, async f => {
    await click(f.host, 'button[title="Меню беседы"]');
    if (level !== 'main') await realChoose('Уведомления'); if (level === 'time') await realChoose('Выключить на время…');
    const outside = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    await React.act(async () => { document.body.dispatchEvent(outside); });
    assert.equal(document.querySelectorAll('.ctx-menu').length, 0); assert.equal(outside.defaultPrevented, true);
    assert.equal(f.muteCalls.length, 0);
  }, source, undefined, { realMenu: true });
});
// Класс ошибки: удаление back с Назад превращает выход из mute в закрытие всего меню.
it('R179 мутант без back у Назад обнаруживается именно потерей уровня общего меню', async () => {
  const anchor = '<MenuItem icon="chevron-left" label="Назад" back onClick={onBack} />';
  assert.equal(source.split(anchor).length - 1, 1); await menuBackLevels();
  await assert.rejects(() => menuBackLevels(source.replace(anchor, anchor.replace(' back ', ' '))),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('Назад из mute сначала возвращает главное меню'));
});
