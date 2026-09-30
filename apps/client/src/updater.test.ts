import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const stored = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } },
});

const { downloadAndInstall, endShareBeforeExit, relaunchApp } = await import('./updater.js');

describe('штатная остановка показа перед выходом процесса', () => {
  it('ошибка остановки не срывает продолжение операции', async () => {
    // Ловит зависшее обновление из-за уже закрытой или сломанной сессии показа.
    await assert.doesNotReject(endShareBeforeExit(async () => { throw new Error('already stopped'); }));
  });

  it('обновление делает download → stop → install и продолжает после отказа stop', async () => {
    // Ловит ложную crash-метку, если установщик закрывает процесс раньше штатной остановки показа.
    const calls: string[] = [];
    const update = {
      version: '9.9.9',
      download: async () => { calls.push('download'); },
      install: async () => { calls.push('install'); },
    };
    await downloadAndInstall(update, async () => { calls.push('stop'); throw new Error('busy'); });
    assert.deepEqual(calls, ['download', 'stop', 'install']);
    assert.equal(stored.get('gv:just-updated'), '9.9.9');
  });

  it('перезапуск останавливает показ раньше relaunch даже при ошибке остановки', async () => {
    // Ловит переставленные шаги, после которых следующий показ ошибочно считается аварийным.
    const calls: string[] = [];
    await relaunchApp(
      async () => { calls.push('stop'); throw new Error('busy'); },
      async () => { calls.push('relaunch'); },
    );
    assert.deepEqual(calls, ['stop', 'relaunch']);
  });
});
