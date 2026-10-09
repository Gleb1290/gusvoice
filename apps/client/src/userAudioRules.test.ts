import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './userAudioRules';

function load(source: string): typeof rules {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as typeof rules };
  runInNewContext(code, { module, exports: module.exports });
  return module.exports;
}

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./userAudioRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), `найдено место мутации: ${from}`);
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, 'мутант действительно изменил исходник');
  return load(changed);
}

it('личная громкость видна только не себе и при любом подтверждённом признаке голоса', () => {
  // Пункт громкости в текстовой группе не должен выглядеть рабочим, когда голосового участника рядом нет.
  const check = (api: typeof rules) => {
    assert.equal(api.showUserAudio({ isSelf: true, hasParticipant: true, voiceChannelId: 'voice', inPresence: true }), false);
    assert.equal(api.showUserAudio({ isSelf: false, hasParticipant: true, inPresence: false }), true);
    assert.equal(api.showUserAudio({ isSelf: false, hasParticipant: false, voiceChannelId: 'voice', inPresence: false }), true);
    assert.equal(api.showUserAudio({ isSelf: false, hasParticipant: false, inPresence: true }), true);
    assert.equal(api.showUserAudio({ isSelf: false, hasParticipant: false, voiceChannelId: null, inPresence: false }), false);
  };
  check(rules);
  const source = readFileSync(new URL('./userAudioRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  check(load(source));
  assert.throws(() => check(mutant('if (opts.isSelf) return false;', '')), assert.AssertionError);
  assert.throws(() => check(mutant('opts.hasParticipant || ', '')), assert.AssertionError);
  assert.throws(() => check(mutant('|| !!opts.voiceChannelId ', '')), assert.AssertionError);
  assert.throws(() => check(mutant('|| opts.inPresence', '')), assert.AssertionError);
});
