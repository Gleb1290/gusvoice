import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = readFileSync(new URL('./VoiceChannelView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Person = { userId: string; bot?: boolean };
type Props = { channel: { id: string; name: string }; connected?: boolean };
// Как в существующих stage/watchFit-харнессах, исполняется ЦЕЛЫЙ модуль и перечень границ закрыт.
// SSR достаточен для неприсоединённого канала: он не подписывается на LiveKit и не использует DOM.
const dormant = new Set(`@livekit/components-react livekit-client ../api ../hotkeys ../cameraSettings
../memberName ../economyClient ../streamAudioRules ../streamPipRules ../streamCardRules ../toast
../tipMode ../tipGesture ../voiceSelf ./Avatar ./Crown ../avatarAnimation ./BottomSheet
./UserContextMenu ./VoiceParticipants ../localUserAudio ./StreamTipFeed ./StreamVolumeControl ./StreamPipView
../pendingWatch ../streamCue ../watchGrace ../streamQuality ../windowCovered ../badPicture ./ContextMenu
../stageGridRules ../stageViewPrefs ../stageLayoutPrefs ../stageLayoutRules ../voiceRules ../useStageSpeaker ./StageLayoutPicker
../phoneLayout ../stageAutoShowRules ../useStageAutoShow ../stageOrderRules ../stageOrderPrefs ../useStageDrag`.split(/\s+/));
function render(participants?: Person[], raw = source) {
  const unexpected: string[] = [];
  const state: { presence: Record<string, Person[]>; joinVoice(): Promise<void> } = {
    presence: participants ? { lounge: participants } : {}, joinVoice: async () => {},
  };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../store': { useStore: (select: (state: { presence: Record<string, Person[]>; joinVoice(): Promise<void> }) => unknown) => select(state) },
    './Goose': { Goose: ({ pose }: { pose: string }) => React.createElement('i', { 'data-goose-pose': pose }) },
    './Icon': { ChannelGlyph: () => null },
  };
  const module = { exports: {} as { VoiceChannelView: React.ComponentType<Props> } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, require(id: string) {
    if (Object.hasOwn(deps, id)) return deps[id];
    assert.equal(dormant.has(id), true, `Неописанная граница голосового канала ${id}`);
    return new Proxy({}, { get: (_object, key) => {
      const boundary = `${id}.${String(key)}`; unexpected.push(boundary); throw Error(`Неожиданный вызов ${boundary}`);
    } });
  } });
  const html = renderToStaticMarkup(React.createElement(module.exports.VoiceChannelView,
    { channel: { id: 'lounge', name: 'Гостиная' }, connected: false }));
  assert.deepEqual(unexpected, [], 'заглушка не вызывает dormant-подсистемы даже с проглоченной ошибкой');
  return html;
}
const bots = [{ userId: 'music', bot: true }, { userId: 'radio', bot: true }, { userId: 'announcer', bot: true }];
function emptyContract(raw = source) {
  const html = render(bots, raw);
  assert.equal(html.includes('В голосовом канале пока никого'), true, 'R306_IDLE_EMPTY: боты не означают, что уже есть люди');
  assert.equal(html.includes('data-goose-pose="nap"'), true, 'пустой для людей канал оставляет спящего гуся');
  assert.equal(html.includes('уже на связи'), false);
}
function humanContract(raw = source) {
  const html = render([bots[0], { userId: 'human' }, bots[1], { userId: 'legacy', bot: false }, bots[2]], raw);
  assert.equal(html.includes('2 уже на связи — присоединяйтесь.'), true, 'R306_IDLE_COUNT: число людей не включает ботов');
  assert.equal(html.includes('В голосовом канале уже есть люди'), true);
  assert.equal(html.includes('data-goose-pose="honk"'), true);
}

it('R306 пустой presence и отсутствующая запись канала дают приглашение зайти первым', () => {
  for (const participants of [undefined, []]) {
    const html = render(participants);
    assert.equal(html.includes('В голосовом канале пока никого'), true);
    assert.equal(html.includes('Зайдите первым — разбудите гуся.'), true);
    assert.equal(html.includes('Присоединиться к Гостиная'), true);
  }
});
it('R306 канал с тремя ботами остаётся пустым для входящего человека', () => emptyContract());
it('R306 один человек среди трёх ботов считается одним, а не четырьмя участниками', () => {
  const html = render([bots[0], { userId: 'human' }, bots[1], bots[2]]);
  assert.equal(html.includes('1 уже на связи — присоединяйтесь.'), true);
  assert.equal(html.includes('В голосовом канале уже есть люди'), true);
});
it('R306 две человеческие записи, в том числе legacy bot:false, дают ровно два уже на связи', () => humanContract());
it('R306 без ботов неприсоединённый голосовой канал сохраняет прежний счётчик людей', () => {
  const html = render([{ userId: 'one' }, { userId: 'two' }]);
  assert.equal(html.includes('2 уже на связи — присоединяйтесь.'), true);
});

function mutant(anchor: string, replacement: string, contract: (raw?: string) => void, marker: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'уникальный якорь'); contract();
  assert.throws(() => contract(source.replace(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.startsWith(marker));
}
it('R306 контрфакт participants.length для пустоты канала отвергается настоящим компонентом', () =>
  mutant('humans.length === 0', 'participants.length === 0', emptyContract, 'R306_IDLE_EMPTY:'));
it('R306 контрфакт participants.length для числа уже на связи отвергается настоящим компонентом', () =>
  mutant('${humans.length} уже на связи', '${participants.length} уже на связи', humanContract, 'R306_IDLE_COUNT:'));
