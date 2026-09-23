import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLOSE_REASON, accessClosedText, noticeFromRefusal, type AccessNotice } from './accessClosed.js';

const notice = (reason: string): AccessNotice => ({ serverId: 's1', serverName: 'Гуси', reason, contacts: [] });

describe('объяснение закрытого федеративного доступа', () => {
  it('бан на инстансе объясняет потерю всех его серверов и показывает контакты', () => {
    // Ловит текст про один сервер там, где человеку закрыли весь соседний инстанс.
    const text = accessClosedText(notice(CLOSE_REASON.bannedByInstance));
    assert.equal(text.title, 'Вход на этот инстанс закрыт');
    assert.equal(text.showContacts, true);
    assert.match(text.body, /Все его серверы/);
  });

  it('разрыв связки отправляет к админам инстанса без контактов держателя', () => {
    // Ловит предложение обратиться не к тому человеку, который способен восстановить связь.
    const text = accessClosedText(notice(CLOSE_REASON.linkGone));
    assert.equal(text.title, 'Инстансы больше не связаны');
    assert.equal(text.showContacts, false);
  });

  it('закрытие федерации сервера сохраняет отдельное объяснение', () => {
    // Ловит смешение решения держателя сервера с баном самого человека.
    const text = accessClosedText(notice(CLOSE_REASON.federationDisabled));
    assert.equal(text.title, 'Сервер закрыт держателем');
    assert.match(text.body, /закрыл «Гуси»/);
  });

  it('неизвестная причина от нового соседа даёт честный общий текст', () => {
    // Ловит выдуманную клиентом причину при более новой версии протокола соседа.
    const text = accessClosedText(notice('future.reason'));
    assert.match(text.body, /Доступ к «Гуси»/);
  });

  it('окно собирается только из точного отказа 403 и сохраняет контакты', () => {
    // Ловит показ окна закрытого сервера на обычной сетевой ошибке.
    const contacts = [{ kind: 'email', label: 'Почта', value: 'admin@example.com' }];
    assert.deepEqual(
      noticeFromRefusal({ status: 403, message: 'federation.server_closed', reason: CLOSE_REASON.linkGone, contacts }, { id: 's1', name: 'Гуси' }),
      { serverId: 's1', serverName: 'Гуси', reason: CLOSE_REASON.linkGone, contacts },
    );
    assert.equal(noticeFromRefusal({ status: 500, message: 'federation.server_closed' }, { id: 's1', name: 'Гуси' }), null);
    assert.equal(noticeFromRefusal({ status: 403, message: 'other' }, { id: 's1', name: 'Гуси' }), null);
  });
});
