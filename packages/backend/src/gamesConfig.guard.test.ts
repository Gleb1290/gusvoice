import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Только публичные шаблоны конфигурации, не реальный .env и не окружение машины.
const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function paired(title: string, raw: string, check: (s: string) => void, from: string, to: string) {
  test(`R343 безопасный конфиг: ${title}`, () => {
    check(raw); gatedCounterfact(() => { assert.equal(raw.split(from).length, 2, 'R343 setup: один якорь публичного шаблона');
    assert.throws(() => check(raw.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith('R343 config:')); });
    check(raw);
  });
}
paired('пример не включает принудительный джекпот', example, raw => {
  const lines = raw.split('\n').filter(line => /^WHEEL_FORCE_JACKPOT=/.test(line));
  assert.deepEqual(lines, ['WHEEL_FORCE_JACKPOT='], 'R343 config: dev-флаг пуст, никакого готового секрета не читается');
}, 'WHEEL_FORCE_JACKPOT=\n', 'WHEEL_FORCE_JACKPOT=1\n');
paired('compose не навязывает dev-режим без переменной', compose, raw => {
  const values = raw.split('\n').filter(line => /^\s+WHEEL_FORCE_JACKPOT:/.test(line)).map(line => line.trim());
  assert.deepEqual(values, ['WHEEL_FORCE_JACKPOT: ${WHEEL_FORCE_JACKPOT:-}'], 'R343 config: backend наследует только явно заданный dev-флаг');
}, 'WHEEL_FORCE_JACKPOT: ${WHEEL_FORCE_JACKPOT:-}', 'WHEEL_FORCE_JACKPOT: ${WHEEL_FORCE_JACKPOT:-1}');
paired('пример сохраняет замок закрытым по умолчанию', example, raw => {
  assert.deepEqual(raw.split('\n').filter(line => /^GAMES_OPEN=/.test(line)), ['GAMES_OPEN=false'], 'R343 config: запуск игр не открыт сам собой');
}, 'GAMES_OPEN=false\n', 'GAMES_OPEN=true\n');
paired('compose сохраняет замок без явного решения владельца', compose, raw => {
  assert.deepEqual(raw.split('\n').filter(line => /^\s+GAMES_OPEN:/.test(line)).map(line => line.trim()),
    ['GAMES_OPEN: ${GAMES_OPEN:-false}'], 'R343 config: отсутствующая переменная означает закрытый замок');
}, 'GAMES_OPEN: ${GAMES_OPEN:-false}', 'GAMES_OPEN: ${GAMES_OPEN:-true}');
