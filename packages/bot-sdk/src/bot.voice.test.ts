import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as apiModule from './apiClient.js';
import * as contextModule from './context.js';
import * as wireModule from './wire.js';
import * as webhookModule from './webhook.js';
import type { VoiceAddon, VoiceConnection, VoiceHost, VoiceJoinOptions } from './voiceTypes.js';
import type { BotUser, VoiceStateUpdated } from './wire.js';

const source = readFileSync(new URL('./bot.ts', import.meta.url), 'utf8');
const me: BotUser = { id: 'bot', username: 'MusicBot', display_name: 'Музыка', bot: true, description: '', about: '', public: true };
const update: VoiceStateUpdated = { chat: { id: 'voice', type: 'voice', server_id: 'server' }, user: me, action: 'left', date: 1700000000 };
/** Весь bot.ts: единственная динамическая граница дополнения подменена, connection.ts/rtc-node недоступны. */
function harness(raw = source, addon?: VoiceAddon, loadError?: unknown) {
  let loads = 0;
  const logs: string[] = [];
  const imports: Record<string, unknown> = { './apiClient.js': apiModule, './context.js': contextModule, './wire.js': wireModule, './webhook.js': webhookModule };
  const exports = {};
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, Error, AbortController, Date, console, queueMicrotask,
      setInterval: () => { throw new Error('R306 voice: таймер сети в этом сценарии запрещён'); }, clearInterval: () => {},
      require: (name: string) => {
        if (name === '@gusvoice/bot-voice') {
          loads++;
          if (loadError) throw loadError;
          assert.ok(addon, 'R306 voice: загрузка только подменного дополнения'); return addon;
        }
        assert.ok(Object.hasOwn(imports, name), `R306 voice: неописанный импорт ${name}`); return imports[name];
      },
    });
  const mod = exports as typeof import('./bot.js');
  let fetches = 0;
  const bot = new mod.Bot('synthetic-voice-test-token', { baseUrl: 'https://sdk.invalid', discover: false, log: message => { logs.push(message); },
    fetch: async url => {
      assert.equal(String(url), 'https://sdk.invalid/api/bot/v1/getMe', 'R306 voice: только подменный getMe');
      fetches++; return new Response(JSON.stringify({ ok: true, result: me }));
    } });
  return { bot, mod, logs, loads: () => loads, fetches: () => fetches };
}
function connection(leave: () => Promise<void> = async () => {}): VoiceConnection {
  // BotVoice использует только state/leave; отсутствие аудиометодов намеренно ловит расширение границы.
  return { state: 'connected', leave } as VoiceConnection;
}
function notFound(name: string, code = 'ERR_MODULE_NOT_FOUND'): Error & { code: string } {
  return Object.assign(new Error(`Cannot find package '${name}' imported from synthetic/bot.js`), { code });
}

it('R306 bot.voice: создание, события и stop без join не грузят необязательное дополнение', async () => {
  const h = harness();
  assert.equal(h.loads(), 0); assert.equal(h.bot.voice.connections.length, 0);
  await h.bot.handleUpdate({ update_id: 1, voice_state: update }); await h.bot.stop();
  assert.equal(h.loads(), 0); assert.equal(h.fetches(), 0);
});
async function missingAddon(raw = source) {
  const failure = notFound('@gusvoice/bot-voice'); const h = harness(raw, undefined, failure);
  let caught: unknown;
  try { await h.bot.voice.join('voice'); } catch (e) { caught = e; }
  assert.equal(caught instanceof h.mod.VoiceAddonMissing, true, 'R306 voice отсутствие дополнения даёт VoiceAddonMissing');
  assert.equal((caught as Error).cause, failure);
  assert.match((caught as Error).message, /npm install @gusvoice\/bot-voice/);
  assert.equal(h.loads(), 1); assert.equal(h.fetches(), 0);
}
it('R306 bot.voice: отсутствующее дополнение даёт VoiceAddonMissing с причиной и командой установки', () => missingAddon());
for (const failure of [notFound('@livekit/rtc-node'), notFound('native-binding'), Object.assign(new Error("Cannot find package '@gusvoice/bot-voice'"), { code: 'EACCES' })]) {
  it(`R306 bot.voice: зависимость или другая ошибка ${failure.message} остаётся исходной`, async () => {
    const h = harness(source, undefined, failure);
    await assert.rejects(h.bot.voice.join('voice'), error => error === failure);
  });
}
it('R306 bot.voice: детектор не считает строку, null и случайный MODULE_NOT_FOUND отсутствием дополнения', () => {
  const { mod } = harness();
  for (const value of [null, undefined, 'ERR_MODULE_NOT_FOUND', {}, notFound('@livekit/rtc-node'), { code: 'MODULE_NOT_FOUND', message: 4 }]) assert.equal(mod.isAddonNotFound(value), false);
  assert.equal(mod.isAddonNotFound(notFound('@gusvoice/bot-voice', 'MODULE_NOT_FOUND')), true);
});
it('R306 bot.voice: ленивое дополнение кешируется, channel/options/host передаются без потерь', async () => {
  const calls: Array<{ host: VoiceHost; id: string; options: VoiceJoinOptions }> = [];
  const vc = connection();
  const h = harness(source, { joinVoice: async (host, id, options) => { calls.push({ host, id, options }); return vc; } });
  const options = { bitrate: 96000, normalize: false, followMoves: false, ffmpegPath: 'synthetic-ffmpeg' };
  assert.equal(await h.bot.voice.join('voice', options), vc); await h.bot.voice.join('other');
  assert.equal(h.loads(), 1); assert.equal(calls[0].id, 'voice'); assert.equal(calls[0].options, options);
  assert.equal(calls[0].host.api, h.bot.api);
  assert.deepEqual(await calls[0].host.getMe(), me); assert.deepEqual(await calls[0].host.getMe(), me);
  assert.equal(h.fetches(), 1, 'сам бот кешируется');
  calls[0].host.log('synthetic log'); assert.deepEqual(h.logs, ['synthetic log']);
  assert.equal(h.bot.voice.connections.length, 1, 'одна и та же связь не дублируется');
  await h.bot.stop();
});
async function dispatch(raw = source) {
  const seen: string[] = []; let host!: VoiceHost;
  const h = harness(raw, { joinVoice: async value => { host = value; return connection(); } });
  await h.bot.voice.join('voice');
  const off = host.onVoiceState(value => { assert.equal(value, update); seen.push('addon'); });
  host.onVoiceState(() => { throw new Error('synthetic listener error'); });
  host.onVoiceState(() => { seen.push('second'); });
  h.bot.on('voice_state', ctx => { assert.equal(ctx.update.voice_state, update); seen.push('user'); });
  await h.bot.handleUpdate({ update_id: 1, voice_state: update });
  assert.deepEqual(seen, ['addon', 'second', 'user'], 'R306 voice дополнение получает событие до обработчика пользователя');
  assert.equal(h.logs.length, 1); assert.match(h.logs[0], /synthetic listener error/);
  off(); off(); seen.length = 0;
  await h.bot.handleUpdate({ update_id: 2, voice_state: update });
  assert.deepEqual(seen, ['second', 'user']);
  await h.bot.stop();
}
it('R306 bot.voice: voice_state до пользовательского callback, исключение слушателя изолировано и отписка работает', () => dispatch());
async function shutdown(raw = source) {
  const seen: string[] = []; let next = 0;
  const h = harness(raw, { joinVoice: async () => {
    const id = ++next; return connection(async () => { seen.push(`leave:${id}`); if (id === 1) throw new Error('synthetic leave failure'); });
  }, dispose: async () => { seen.push('dispose'); throw new Error('synthetic dispose failure'); } });
  await h.bot.voice.join('one'); await h.bot.voice.join('two');
  await h.bot.stop();
  assert.deepEqual(seen, ['leave:1', 'leave:2', 'dispose'], 'R306 voice stop закрывает все соединения и освобождает дополнение');
  assert.equal(h.bot.voice.connections.length, 0);
}
it('R306 bot.voice: stop до start всё равно закрывает голос, ошибки leave/dispose не мешают остальным', () => shutdown());
it('R306 bot.voice: closed связи удаляются из снимка connections, потребитель не меняет внутренний набор', async () => {
  const first = connection(); const second = connection(); let next = 0;
  const h = harness(source, { joinVoice: async () => next++ ? second : first });
  await h.bot.voice.join('one'); await h.bot.voice.join('two');
  const snapshot = h.bot.voice.connections as VoiceConnection[]; snapshot.length = 0;
  assert.equal(h.bot.voice.connections.length, 2);
  (first as { state: string }).state = 'closed';
  assert.deepEqual(Array.from(h.bot.voice.connections), [second]);
  await h.bot.stop();
});

for (const c of [
  { name: 'нет VoiceAddonMissing', needle: 'if (isAddonNotFound(e)) throw new VoiceAddonMissing({ cause: e });', replacement: '/* мутант: исходная ошибка вместо подсказки */',
    probe: missingAddon, message: 'R306 voice отсутствие дополнения даёт VoiceAddonMissing' },
  { name: 'событие не доставлено дополнению', needle: "if (type === 'voice_state' && update.voice_state) this.voice.handleVoiceState(update.voice_state);", replacement: '/* мутант: не доставляем голосу */',
    probe: dispatch, message: 'R306 voice дополнение получает событие до обработчика пользователя' },
  { name: 'stop оставил голос', needle: 'await this.voice.shutdown();', replacement: '/* мутант: забыли голос */',
    probe: shutdown, message: 'R306 voice stop закрывает все соединения и освобождает дополнение' },
]) it(`R306 bot.voice контрфакт: ${c.name}, оригинал проходит первым`, async () => {
  await c.probe(source);
  assert.equal(source.split(c.needle).length - 1, 1, 'bot.voice: точный уникальный якорь');
  await assert.rejects(() => c.probe(source.replace(c.needle, c.replacement)), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.message.split('\n', 1)[0] === c.message);
});
