import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mayObserveUser,
  membershipDiff,
  parseEnvelope,
  shouldDeliver,
  typingRoute,
  visibleOnline,
  type Envelope,
} from './gatewayRules.js';

const invalidate = { t: 'server.invalidate' as const, serverId: 'server-1' };

describe('разбор внутреннего конверта gateway', () => {
  it('серверное событие без списка адресатов разбирается', () => {
    // Ловит ошибочное требование `to`, которое погасило бы invalidate для всего сервера.
    assert.deepEqual(parseEnvelope(JSON.stringify({ m: invalidate })), { m: invalidate, to: undefined });
  });

  it('адресный список строк сохраняется без изменения', () => {
    // Ловит потерю аудитории между Redis и фильтром локальных соединений.
    assert.deepEqual(parseEnvelope(JSON.stringify({ m: invalidate, to: ['anna', 'boris'] })), {
      m: invalidate,
      to: ['anna', 'boris'],
    });
  });

  it('пустой адресный список остаётся адресным, а не становится рассылкой всем', () => {
    // Ловит опасное смешение `[]` и отсутствующего `to` на границе пустой аудитории.
    assert.deepEqual(parseEnvelope(JSON.stringify({ m: invalidate, to: [] })), { m: invalidate, to: [] });
  });

  it('не-JSON и примитивы отклоняются закрыто', () => {
    // Ловит fallback «не разобрали — отправляем всем» для повреждённого сообщения шины.
    assert.equal(parseEnvelope('{broken'), null);
    assert.equal(parseEnvelope('null'), null);
    assert.equal(parseEnvelope('42'), null);
    assert.equal(parseEnvelope('"text"'), null);
  });

  it('массив вместо конверта или сообщения отклоняется', () => {
    // Ловит старую проверку typeof object, под которую массивы проходили как WS-payload.
    assert.equal(parseEnvelope('[]'), null);
    assert.equal(parseEnvelope(JSON.stringify({ m: [] })), null);
  });

  it('неизвестный тип серверного сообщения отклоняется', () => {
    // Ловит отправку клиентам внутреннего мусора из ошибочного или устаревшего publisher.
    assert.equal(parseEnvelope(JSON.stringify({ m: { t: 'unknown', secret: 'internal' } })), null);
  });

  it('голое событие старого формата отклоняется', () => {
    // Ловит обход адресной маршрутизации сообщением без обязательного внутреннего конверта.
    assert.equal(parseEnvelope(JSON.stringify(invalidate)), null);
  });

  it('отсутствующее и не-объектное поле сообщения отклоняются', () => {
    // Ловит доставку конверта, из которого нельзя получить WS-событие.
    assert.equal(parseEnvelope(JSON.stringify({})), null);
    assert.equal(parseEnvelope(JSON.stringify({ m: null })), null);
    assert.equal(parseEnvelope(JSON.stringify({ m: 'message' })), null);
  });

  it('не-массив вместо адресатов отклоняется', () => {
    // Ловит строковый `to`, где includes мог бы принять id как подстроку.
    assert.equal(parseEnvelope(JSON.stringify({ m: invalidate, to: 'anna' })), null);
    assert.equal(parseEnvelope(JSON.stringify({ m: invalidate, to: null })), null);
    assert.equal(parseEnvelope(JSON.stringify({ m: invalidate, to: { userId: 'anna' } })), null);
  });

  it('нестроковый элемент адресного списка отклоняет весь конверт', () => {
    // Ловит частичное принятие повреждённой аудитории с неоднозначной проверкой id.
    assert.equal(parseEnvelope(JSON.stringify({ m: invalidate, to: ['anna', 7] })), null);
    assert.equal(parseEnvelope(JSON.stringify({ m: invalidate, to: [null] })), null);
    assert.equal(parseEnvelope(JSON.stringify({ m: invalidate, to: [true] })), null);
  });
});

describe('решение о доставке соединению', () => {
  it('событие без адресатов доступно любому серверному соединению', () => {
    // Ловит случайное применение user-фильтра к server-wide invalidate.
    const env: Envelope = { m: invalidate };
    assert.equal(shouldDeliver(env, 'anna'), true);
    assert.equal(shouldDeliver(env, null), true);
  });

  it('адресное событие доставляется своему пользователю', () => {
    // Ловит недоставку сообщения законному участнику приватного канала.
    assert.equal(shouldDeliver({ m: invalidate, to: ['anna', 'boris'] }, 'anna'), true);
  });

  it('адресное событие не доставляется чужому пользователю', () => {
    // Ловит исходный класс утечки #91 через server subscription без VIEW_CHANNEL.
    assert.equal(shouldDeliver({ m: invalidate, to: ['anna'] }, 'mallory'), false);
  });

  it('анонимное соединение не получает адресное событие', () => {
    // Ловит выдачу приватного payload до установления личности сокета.
    assert.equal(shouldDeliver({ m: invalidate, to: ['anna'] }, null), false);
  });

  it('пустая аудитория не доставляет событие никому', () => {
    // Ловит трактовку пустого массива как отсутствующего ограничения.
    assert.equal(shouldDeliver({ m: invalidate, to: [] }, 'anna'), false);
    assert.equal(shouldDeliver({ m: invalidate, to: [] }, null), false);
  });
});

describe('маршрут индикатора набора текста', () => {
  const conn = { userId: 'anna', servers: new Set(['server-1']) };

  it('подписчик сервера может отправить typing в его канал', () => {
    // Ловит чрезмерный запрет штатного channel typing после добавления авторизации #88.
    assert.deepEqual(
      typingRoute({ serverId: 'server-1', channelId: 'channel-1' }, conn, () => null),
      { kind: 'channel', serverId: 'server-1', channelId: 'channel-1' },
    );
  });

  it('чужой serverId без подписки не образует маршрут', () => {
    // Ловит подделку typing в сервере, участником которого отправитель не является.
    assert.equal(typingRoute({ serverId: 'server-2', channelId: 'channel-1' }, conn, () => null), null);
  });

  it('неполная пара serverId и channelId отклоняется', () => {
    // Ловит широкую рассылку события без однозначной области канала.
    assert.equal(typingRoute({ serverId: 'server-1' }, conn, () => null), null);
    assert.equal(typingRoute({ channelId: 'channel-1' }, conn, () => null), null);
    assert.equal(typingRoute({}, conn, () => null), null);
  });

  it('маршрут ЛС получает собеседника из состава диалога', () => {
    // Ловит возврат доверия к присланному клиентом recipientId.
    let lookedUp = '';
    const result = typingRoute({ dmId: 'dm-1' }, conn, (dmId) => {
      lookedUp = dmId;
      return 'boris';
    });
    assert.equal(lookedUp, 'dm-1');
    assert.deepEqual(result, { kind: 'dm', dmId: 'dm-1', peerId: 'boris' });
  });

  it('ЛС без подтверждённого собеседника не образует маршрут', () => {
    // Ловит отправку typing в чужой или уже удалённый диалог.
    assert.equal(typingRoute({ dmId: 'foreign-dm' }, conn, () => null), null);
  });

  it('подставленный recipientId не меняет найденного собеседника', () => {
    // Ловит прямую адресацию произвольному пользователю полем из клиентского пакета.
    const spoofed = { dmId: 'dm-1', recipientId: 'mallory' };
    assert.deepEqual(typingRoute(spoofed, conn, () => 'boris'), {
      kind: 'dm',
      dmId: 'dm-1',
      peerId: 'boris',
    });
  });

  it('при смешанном пакете подтверждённый ЛС не превращается в server typing', () => {
    // Ловит неоднозначную маршрутизацию одного пакета сразу в две аудитории.
    assert.deepEqual(
      typingRoute({ dmId: 'dm-1', serverId: 'server-1', channelId: 'channel-1' }, conn, () => 'boris'),
      { kind: 'dm', dmId: 'dm-1', peerId: 'boris' },
    );
  });
});

describe('кому можно знать об онлайне и статусе человека (#136)', () => {
  const peers = new Set(['friend']);

  it('не представившееся соединение не получает ничего', () => {
    // Ловит анонимную слежку: до identify сокет получал user.activity и online.update всего инстанса.
    assert.equal(mayObserveUser(null, 'subject', peers, null), false);
    assert.equal(mayObserveUser(null, 'subject', new Set(['']), 'admin'), false);
  });

  it('человек без общего сервера и ЛС не получает событий', () => {
    // Ловит возврат к рассылке всему инстансу для вошедших.
    assert.equal(mayObserveUser('stranger', 'subject', peers, null), false);
  });

  it('получают сам человек, соседи по серверу или ЛС и супер-админ', () => {
    // Ловит потерю своих же событий и событий у тех, кто законно их видит.
    assert.equal(mayObserveUser('subject', 'subject', new Set(), null), true);
    assert.equal(mayObserveUser('friend', 'subject', peers, null), true);
    assert.equal(mayObserveUser('admin', 'subject', new Set(), 'admin'), true);
  });

  it('снимок онлайна отдаёт только тех, о ком зрителю можно знать', () => {
    // Ловит `online.snapshot` со всем инстансом.
    assert.deepEqual(
      visibleOnline(['viewer', 'friend', 'stranger'], 'viewer', new Set(['friend']), null),
      ['viewer', 'friend'],
    );
    assert.deepEqual(visibleOnline(['viewer', 'friend', 'stranger'], 'admin', new Set(), 'admin'), [
      'viewer',
      'friend',
      'stranger',
    ]);
  });
});

describe('изменение состава сервера для пересборки снимков (#136)', () => {
  it('тот же состав — ничего не пересылаем', () => {
    // Ловит рассылку снимков всему серверу на каждое переименование канала.
    assert.deepEqual(membershipDiff(new Set(['a', 'b']), new Set(['b', 'a'])), { changed: false, affected: [] });
  });

  it('вступивший и ушедший оба попадают в пересборку', () => {
    // Ловит ушедшего, который продолжал видеть онлайн бывших соседей по серверу.
    const d = membershipDiff(new Set(['a', 'gone']), new Set(['a', 'new']));
    assert.equal(d.changed, true);
    assert.deepEqual([...d.affected].sort(), ['a', 'gone', 'new']);
  });

  it('неизвестный прошлый состав считается изменившимся', () => {
    // Ловит новичка, который после вступления видит всех «не в сети» до переподключения.
    assert.deepEqual(membershipDiff(undefined, new Set(['a'])), { changed: true, affected: ['a'] });
  });
});
