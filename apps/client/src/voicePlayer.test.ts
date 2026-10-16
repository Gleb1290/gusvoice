import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as playback from './voicePlayback';
import * as React from 'react';

const playerSource = readFileSync(new URL('./voicePlayer.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function musicPlayer(raw = playerSource) {
  const audios: FakeAudio[] = [];
  const unexpected: string[] = [];
  class FakeAudio extends EventTarget {
    src = ''; preload = ''; currentTime = 0; playbackRate = 1; duration = NaN;
    constructor() { super(); audios.push(this); }
    play() { this.dispatchEvent(new Event('play')); return Promise.resolve(); }
    pause() { this.dispatchEvent(new Event('pause')); }
    removeAttribute() { this.src = ''; } load() {}
  }
  const mediaSession = { metadata: null as { title: string; artist: string } | null, playbackState: 'none', setActionHandler: () => {} };
  class Metadata {
    title: string; artist: string;
    constructor(value: { title: string; artist: string }) { this.title = value.title; this.artist = value.artist; }
  }
  const deps: Record<string, unknown> = { react: React, './voicePlayback': playback,
    './api': { api: { convListened: async () => { unexpected.push('convListened'); } } } };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Audio: FakeAudio, MediaMetadata: Metadata, navigator: { mediaSession },
    document: { querySelectorAll: () => [] }, require: (id: string) => {
      assert.equal(Object.hasOwn(deps, id), true, `R230 явный импорт плеера ${id}`); return deps[id];
    },
  });
  return { player: module.exports as typeof import('./voicePlayer'), audios, mediaSession, unexpected };
}
function musicDuration(raw = playerSource) {
  const { player, audios, unexpected } = musicPlayer(raw);
  player.toggleVoice({ key: 'unknown', url: '/music.wav', durationMs: 0, title: 'Музыка' });
  for (const invalid of [NaN, Infinity, 0, -1]) {
    audios[0].duration = invalid; audios[0].dispatchEvent(new Event('durationchange'));
    assert.equal(player.getVoicePlayerState().track?.durationMs, 0, 'R230 метаданные: неверная длительность не записывается');
  }
  audios[0].duration = 12.3456; audios[0].dispatchEvent(new Event('durationchange'));
  assert.equal(player.getVoicePlayerState().track?.durationMs, 12_346, 'R230 метаданные: неизвестная длительность округляется в мс');
  audios[0].duration = 100; audios[0].dispatchEvent(new Event('durationchange'));
  assert.equal(player.getVoicePlayerState().track?.durationMs, 12_346, 'R230 длительность: уже известное значение не переписывается');
  player.toggleVoice({ key: 'known', url: '/voice.ogg', durationMs: 4000 });
  audios[0].duration = 8; audios[0].dispatchEvent(new Event('durationchange'));
  assert.equal(player.getVoicePlayerState().track?.durationMs, 4000, 'R230 голосовое: серверная длительность остаётся точной');
  player.closeVoice(); audios[0].duration = 3; audios[0].dispatchEvent(new Event('durationchange'));
  assert.equal(player.getVoicePlayerState().track, null, 'закрытый плеер не воскрешает дорожку метаданными');
  assert.deepEqual(unexpected, [], 'R230 длительность не сообщает прослушано для файла или записи без источника');
}
function musicSession(raw = playerSource) {
  const { player, mediaSession, unexpected } = musicPlayer(raw);
  player.toggleVoice({ key: 'music', url: '/track.wav', durationMs: 0, title: 'Ночной гусь',
    source: { conversationId: 'conv', messageId: 'msg', mine: false, listened: undefined, author: 'Автор' } });
  assert.equal(mediaSession.metadata?.title, 'Ночной гусь', 'R230 медиасессия: название трека вместо голосового');
  assert.equal(mediaSession.metadata?.artist, 'Автор');
  player.toggleVoice({ key: 'voice', url: '/voice.ogg', durationMs: 1000 });
  assert.equal(mediaSession.metadata?.title, 'Голосовое сообщение', 'без title сохраняется прежний тип голосового');
  player.closeVoice(); assert.equal(mediaSession.metadata, null); assert.equal(mediaSession.playbackState, 'none');
  // Ошибка внутри api была бы проглочена reportListened.catch; журнал проверяется снаружи приложения.
  assert.deepEqual(unexpected, [], 'R230 музыкальная медиасессия не отправляет голосовой отчёт прослушано');
}
function playerChange(anchor: string, replacement: string) {
  assert.equal(playerSource.split(anchor).length - 1, 1, 'R230 единственный якорь изменения плеера');
  return playerSource.replace(anchor, replacement);
}

it('R230 метаданные музыки заполняют только неизвестную длительность и не переписывают длительность голосового', () => {
  // Класс ошибки: поздние/повторные события Audio меняют уже известный размер шкалы или приносят Infinity.
  musicDuration();
});
it('R230 системный плеер получает название музыки, а голосовое сохраняет прежнюю подпись', () => {
  // Класс ошибки: единый аудиоплеер ошибочно подписывает музыкальный файл как голосовое сообщение.
  musicSession();
});
it('R230 контрфакт перезаписи известной длительности обнаруживается повторным событием Audio', () => {
  // Класс ошибки: метаданные браузера затмевают сохранённую сервером или первым событием длительность.
  musicDuration();
  assert.throws(() => musicDuration(playerChange('t && !(t.durationMs > 0) && Number.isFinite(a.duration)',
    't && Number.isFinite(a.duration)')), (e: unknown) => e instanceof assert.AssertionError
      && e.message.startsWith('R230 длительность:') && e.operator === 'strictEqual' && e.actual === 100_000 && e.expected === 12_346);
});
it('R230 контрфакт потери музыкального названия обнаруживается в настоящей медиасессии плеера', () => {
  // Класс ошибки: удачный запуск файла скрывает регрессию системной шторки и медиаклавиш.
  musicSession();
  assert.throws(() => musicSession(playerChange("title: track.title ?? 'Голосовое сообщение'", "title: 'Голосовое сообщение'")),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R230 медиасессия:') && e.operator === 'strictEqual'
      && e.actual === 'Голосовое сообщение' && e.expected === 'Ночной гусь');
});

it('серия непрослушанных пропускает свои и услышанные, ручное переключение возвращает обычную очередь', async () => {
  // Ловит смешение фильтрованной автосерии и ручного выбора следующей записи.
  GlobalRegistrator.register({ url: 'http://localhost/' });
  try {
    const audios: FakeAudio[] = [];
    class FakeAudio extends EventTarget {
      src = ''; preload = ''; currentTime = 0; playbackRate = 1;
      constructor() { super(); audios.push(this); }
      play() { this.dispatchEvent(new Event('play')); return Promise.resolve(); }
      pause() { this.dispatchEvent(new Event('pause')); }
      removeAttribute() {} load() {}
    }
    const module = { exports: {} };
    const source = readFileSync(new URL('./voicePlayer.ts', import.meta.url), 'utf8');
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Audio: FakeAudio, document, require: (id: string) => {
        if (id === 'react') return { useCallback: (f: unknown) => f, useRef: () => ({ current: null }), useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() };
        if (id === './voicePlayback') return playback;
        assert.equal(id, './api'); return { api: { convListened: async () => {} } };
      } });
    const api = module.exports as typeof import('./voicePlayer');
    const tracks = ['a', 'b', 'c', 'd', 'e'].map((key, i) => ({ key, url: `/${key}.ogg`, durationMs: 1000,
      source: { conversationId: 'conv', messageId: key, mine: i === 2, listened: i === 1 || i === 4 } }));
    document.body.innerHTML = '<div class="messages">' + tracks.map(t => `<div class="voice-msg" data-voice="${t.key}"></div>`).join('') + '</div>';
    tracks.forEach(api.rememberVoice); api.toggleVoice(tracks[0]);
    audios[0].dispatchEvent(new Event('ended')); assert.equal(api.getVoicePlayerState().track?.key, 'd');
    api.skipVoice(-1); assert.equal(api.getVoicePlayerState().track?.key, 'c');
    audios[0].dispatchEvent(new Event('ended')); assert.equal(api.getVoicePlayerState().track?.key, 'd');
    audios[0].dispatchEvent(new Event('ended')); assert.equal(api.getVoicePlayerState().track?.key, 'e');
    api.closeVoice(); assert.equal(api.getVoicePlayerState().track, null);
    api.toggleVoice(tracks[1]); audios[0].dispatchEvent(new Event('ended'));
    assert.equal(api.getVoicePlayerState().track?.key, 'c');
    api.closeVoice();
  } finally { document.body.replaceChildren(); GlobalRegistrator.unregister(); }
});

it('один Audio переживает исчезновение пузырей, учитывает seek и закрывает серию; отчёт и jump одноразовые', async () => {
  // Виртуализация ленты не должна останавливать очередное голосовое или повторять серверный отчёт.
  GlobalRegistrator.register({ url: 'http://localhost/' });
  try {
    const audios: FakeAudio[] = []; const reports: string[] = []; let rejectReport = false;
    class FakeAudio extends EventTarget {
      src = ''; preload = ''; currentTime = 0; playbackRate = 1; paused = true;
      constructor() { super(); audios.push(this); }
      play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
      pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
      removeAttribute() { this.src = ''; } load() {}
    }
    const module = { exports: {} };
    const source = readFileSync(new URL('./voicePlayer.ts', import.meta.url), 'utf8');
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Audio: FakeAudio, document, require: (id: string) => {
        if (id === 'react') return { useCallback: (f: unknown) => f, useRef: () => ({ current: null }), useSyncExternalStore: (_sub: unknown,get: () => unknown) => get() };
        if (id === './voicePlayback') return playback;
        assert.equal(id,'./api'); return { api: { convListened: async (_c: string,m: string) => { reports.push(m); if (rejectReport) throw new Error('offline'); } } };
      } });
    const api = module.exports as typeof import('./voicePlayer');
    const a = { key:'a', url:'/a.ogg', durationMs:10000, source:{ conversationId:'c',messageId:'a',mine:false,listened:false } };
    const b = { ...a,key:'b',url:'/b.ogg',source:{ ...a.source,messageId:'b' } };
    document.body.innerHTML = '<div class="messages"><div class="voice-msg" data-voice="a"></div><div class="voice-msg" data-voice="b"></div></div>';
    api.rememberVoice(a); api.rememberVoice(b); api.seekVoice('a',7); api.toggleVoice(a);
    assert.equal(audios.length,1); assert.equal(audios[0].currentTime,7); assert.equal(api.getVoicePlayerState().at,7000);
    api.toggleCurrentVoice(); api.toggleCurrentVoice(); await new Promise<void>(r => setImmediate(r));
    assert.deepEqual(reports,['a'], 'повтор pause/play не пишет ещё один отчёт');
    document.body.replaceChildren(); audios[0].dispatchEvent(new Event('ended'));
    assert.equal(api.getVoicePlayerState().track?.key,'b'); assert.equal(audios.length,1);
    audios[0].dispatchEvent(new Event('ended')); assert.equal(api.getVoicePlayerState().track,null);
    rejectReport = true; api.toggleVoice({ ...a,key:'failed',source:{ ...a.source,messageId:'failed' } });
    await new Promise<void>(r => setImmediate(r)); assert.equal(api.getVoicePlayerState().heard.has('c:failed'),false);
    api.closeVoice(); assert.equal(api.getVoicePlayerState().track,null);
    api.requestVoiceJump('c','a'); assert.equal(api.takeVoiceJump('other'),null); assert.equal(api.takeVoiceJump('c'),'a'); assert.equal(api.takeVoiceJump('c'),null);
  } finally { document.body.replaceChildren(); GlobalRegistrator.unregister(); }
});
