import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideDmOpen } from './dmRules.js';

describe('открытие личной переписки (F0, #139)', () => {
  it('новую беседу без общего сервера открыть нельзя', () => {
    // Ловит возврат к «POST /dm с любым id»: спам в личку кому угодно на инстансе.
    assert.equal(decideDmOpen({ exists: false, sharedServer: false, initiatorIsSuperAdmin: false }), 'no-shared-server');
  });

  it('с общим сервером новая беседа создаётся', () => {
    // Ловит перегиб, при котором личка пропала бы и у законных соседей по серверу.
    assert.equal(decideDmOpen({ exists: false, sharedServer: true, initiatorIsSuperAdmin: false }), 'create');
  });

  it('существующая беседа открывается и без общего сервера', () => {
    // Ловит потерю истории у двоих, когда один из них вышел из общего сервера.
    assert.equal(decideDmOpen({ exists: true, sharedServer: false, initiatorIsSuperAdmin: false }), 'open-existing');
  });

  it('супер-админ может написать любому', () => {
    // Ловит отказ держателю инстанса связаться с человеком, с которым у него нет сервера.
    assert.equal(decideDmOpen({ exists: false, sharedServer: false, initiatorIsSuperAdmin: true }), 'create');
  });
});
