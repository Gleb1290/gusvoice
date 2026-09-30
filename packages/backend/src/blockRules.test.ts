import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dmDeliveryPlan, reachesPeer, visibleToViewer } from './blockRules.js';

describe('доставка ЛС при чёрном списке', () => {
  it('заблокированное сообщение сохраняется только для автора и не выдаёт себя получателю', () => {
    // Ловит сдвиг беседы или уведомление, по которым блокировщик всё же узнаёт о новой попытке связи.
    assert.deepEqual(dmDeliveryPlan(true), {
      withheld: true,
      notifyRecipient: false,
      bumpConversation: false,
    });
  });

  it('обычное сообщение доходит, уведомляет и поднимает беседу', () => {
    // Ловит инверсию признака блокировки, которая молча придерживает всю обычную переписку.
    assert.deepEqual(dmDeliveryPlan(false), {
      withheld: false,
      notifyRecipient: true,
      bumpConversation: true,
    });
  });

  it('придержанное видит только автор, а обычное — оба участника', () => {
    // Ловит утечку старого придержанного сообщения блокировщику после снятия блокировки.
    assert.equal(visibleToViewer({ withheld: true, authorId: 'b' }, 'a'), false);
    assert.equal(visibleToViewer({ withheld: true, authorId: 'b' }, 'b'), true);
    assert.equal(visibleToViewer({ withheld: false, authorId: 'b' }, 'a'), true);
  });

  it('реакция и набор текста доходят только без блокировки', () => {
    // Ловит побочные события, которыми заблокированный мог бы продолжать тревожить собеседника.
    assert.equal(reachesPeer(true), false);
    assert.equal(reachesPeer(false), true);
  });

  it('шлюз передаёт признак блокировки без отрицания в ветке «печатает»', () => {
    // Ловит прежний реальный баг: обычный собеседник не видел набор текста, а блокировщик видел.
    const gateway = readFileSync(new URL('./gateway.ts', import.meta.url), 'utf8');
    const typing = readFileSync(new URL('./gatewayTyping.ts', import.meta.url), 'utf8');
    assert.match(gateway, /case 'typing':[\s\S]*?relayTyping\(typingDeps/);
    assert.match(typing, /reachesPeer\(await deps\.isBlockedBy\(route\.peerId, uid\)\)/);
    assert.doesNotMatch(typing, /reachesPeer\(!/);
  });
});
