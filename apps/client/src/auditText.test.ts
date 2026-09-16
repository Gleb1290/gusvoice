import { AUDIT_ACTIONS, type AuditAction, type AuditLogEntry } from '@gusvoice/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAudit } from './auditText.js';

function entry(action: AuditAction, data: Record<string, unknown> = {}, target?: string): AuditLogEntry {
  return {
    id: 'a1',
    serverId: 's1',
  actor: { id: 'u1', username: 'super', displayName: 'Маша', avatarUrl: null },
    action,
    targetType: null,
    targetId: null,
  target: target ? { id: 'u2', username: 'petya', displayName: target, avatarUrl: null } : null,
    data,
    createdAt: '2026-09-06T18:00:00.000Z',
  } as AuditLogEntry;
}

/**
 * Перечень берётся ИЗ shared, а не переписывается рядом (просьба Codex): раньше это была вторая
 * копия союза, и забытый в ней элемент TypeScript не заметил бы — покрытие просело бы молча.
 */
const ALL: AuditAction[] = [...AUDIT_ACTIONS];

describe('журнал действий', () => {
  it('реестр действий не содержит дублей', () => {
    // Ловит повтор в runtime-массиве: union его схлопнет, а общий тест молча проверит одну ветку дважды.
    assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length);
  });

  it('🔴 НИ ОДНО действие не печатается кодом', () => {
    // Ловит ровно ту беду, ради которой всё это писалось: до 06.09 пятнадцать действий из сорока
    // одного проваливались в ветку «не знаю» и показывались человеку как `soundboard.price`.
    for (const action of ALL) {
      const text = describeAudit(entry(action, { name: 'звук', event: 'join', roleName: 'Роль' }));
      assert.notEqual(text, action, `«${action}» показывается сырым кодом`);
      assert.ok(!/^[a-z]+\.[a-z.]+$/.test(text), `«${action}» дало похожий на код текст: ${text}`);
      assert.ok(text.length > 0, `«${action}» дало пустую строку`);
    }
  });

  it('саундборд называет и звук, и цену', () => {
    assert.equal(
      describeAudit(entry('soundboard.price', { name: 'Гусь', priceCoins: 25 })),
      'назначил звуку «Гусь» цену 25',
    );
    assert.equal(describeAudit(entry('soundboard.add', { name: 'Гусь' })), 'добавил в саундборд звук «Гусь»');
    assert.equal(describeAudit(entry('soundboard.remove', { name: 'Гусь' })), 'убрал из саундборда звук «Гусь»');
  });

  it('звуковые события зовутся по-человечески, а не ключом', () => {
    assert.equal(describeAudit(entry('sound.set', { event: 'streamStop' })), 'заменил звук сервера «конец показа»');
    assert.equal(
      describeAudit(entry('channel.sound.clear', { event: 'join' })),
      'вернул в канале обычный звук «вход в канал»',
    );
    // Неизвестное событие не должно ронять строку — печатаем как есть.
    assert.equal(describeAudit(entry('sound.set', { event: 'какое-то' })), 'заменил звук сервера «какое-то»');
  });

  it('имя награды берётся из записи, а не из словаря-двойника', () => {
    assert.equal(
      describeAudit(entry('economy.shop', { item: 'mega-poke', label: 'Щипок' })),
      'изменил в лавке «Щипок»',
    );
    // У старых записей имени нет — тогда честнее ключ, чем выдуманное название.
    assert.equal(describeAudit(entry('economy.shop', { item: 'mega-poke' })), 'изменил в лавке «mega-poke»');
  });

  it('ретроначисление называет сумму и людей', () => {
    assert.equal(
      describeAudit(entry('economy.retro', { granted: 4200, paid: 12 })),
      'доначислил за прошлое 4200 монет (12 чел.)',
    );
  });

  it('доначисление при смене настроек не теряется', () => {
    assert.equal(describeAudit(entry('economy.settings', { compensated: 300, people: 5 })),
      'изменил настройки экономики, доначислив 300 монет (5 чел.)');
    // Без доначисления хвоста нет вовсе.
    assert.equal(describeAudit(entry('economy.settings', {})), 'изменил настройки экономики');
  });

  it('настройки сервера называют, что именно тронули', () => {
    assert.equal(
      describeAudit(entry('server.update', { changed: ['name', 'iconUrl'] })),
      'изменил настройки сервера: название, значок',
    );
    // Незнакомое поле печатается ключом, но строка не разваливается.
    assert.equal(describeAudit(entry('server.update', { changed: ['whatever'] })), 'изменил настройки сервера: whatever');
    assert.equal(describeAudit(entry('server.update', {})), 'изменил настройки сервера');
  });

  it('имя берётся из записи, а при её молчании — из соединения', () => {
    // `data` хранит имя на МОМЕНТ события: кикнутого в базе уже нет, join его не найдёт.
    assert.equal(describeAudit(entry('member.kick', { displayName: 'Петя' })), 'кикнул Петя');
    // А голосовые записи имени в `data` не кладут вовсе — там работает соединение.
    assert.equal(describeAudit(entry('voice.mute', {}, 'Петя')), 'замьютил Петя');
    // Не нашлось нигде — подстановка, а не пустое место и не выдуманное имя.
    assert.equal(describeAudit(entry('voice.mute', {})), 'замьютил участника');
  });

  it('перенос канала между категориями сказан отдельно от порядка', () => {
    assert.equal(describeAudit(entry('channel.reorder', { count: 5 })), 'изменил порядок каналов');
    assert.equal(
      describeAudit(entry('channel.reorder', { count: 5, reparented: 2 })),
      'переставил каналы и перенёс их между категориями',
    );
  });

  it('генерал канала описан без выдуманного имени', () => {
    // ⚠️ Запись целится в КАНАЛ, имени участника в ней нет — подставлять его неоткуда.
    assert.equal(describeAudit(entry('channel.general.set', { userId: 'u9' })), 'назначил генерала канала');
    assert.equal(describeAudit(entry('channel.general.clear', {})), 'снял генерала канала');
  });

  it('выход с сервера — про себя, а не про кого-то', () => {
    assert.equal(describeAudit(entry('member.leave')), 'вышел с сервера');
  });

  it('пустая запись не роняет разбор', () => {
    // Журнал читают по факту аварии; строка обязана получиться даже у записи без данных.
    for (const action of ALL) {
      assert.doesNotThrow(() => describeAudit(entry(action)));
    }
  });
});
