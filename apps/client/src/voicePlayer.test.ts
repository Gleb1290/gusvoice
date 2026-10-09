import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as playback from './voicePlayback';

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
