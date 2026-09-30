import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentPreview, endpointAllowed, redactPushPayload } from './pushRules.js';

describe('SSRF-гард push endpoint', () => {
  const base = 'https://ntfy.example.test';

  it('пустая база запрещает любой endpoint', () => {
    // Ловит превращение выключенной push-конфигурации в разрешение произвольной сети.
    assert.equal(endpointAllowed(`${base}/topic`, ''), false);
  });

  it('HTTPS endpoint того же origin с любым путём принимается', () => {
    // Ловит отказ легитимных персональных ntfy topic внутри своего шлюза.
    assert.equal(endpointAllowed(`${base}/user/device-topic`, base), true);
  });

  it('HTTP отклоняется даже на том же host', () => {
    // Ловит утечку bearer-токена через незашифрованный push-запрос.
    assert.equal(endpointAllowed('http://ntfy.example.test/topic', base), false);
  });

  it('дописанный домен и user-info не маскируются под свой origin', () => {
    // Ловит две классические startsWith-ловушки, отправляющие POST на хост атакующего.
    assert.equal(endpointAllowed('https://ntfy.example.test.evil.test/topic', base), false);
    assert.equal(endpointAllowed('https://ntfy.example.test@evil.test/topic', base), false);
  });

  it('другой порт считается другим origin', () => {
    // Ловит доступ к соседнему сервису на том же hostname через подмену порта.
    assert.equal(endpointAllowed('https://ntfy.example.test:8443/topic', base), false);
  });

  it('невалидные endpoint и base возвращают false без исключения', () => {
    // Ловит падение отправки сообщения от повреждённой регистрации устройства или конфигурации.
    assert.equal(endpointAllowed('not a url', base), false);
    assert.equal(endpointAllowed(`${base}/topic`, 'not a url'), false);
  });
});

describe('текст push-превью', () => {
  it('непустой текст обрезается по краям', () => {
    // Ловит push из одних пробелов вокруг нормального сообщения.
    assert.equal(contentPreview('  привет  ', 0), 'привет');
  });

  it('ровно 140 символов проходят без многоточия', () => {
    // Ловит ошибку на единицу, преждевременно режущую допустимую границу.
    assert.equal(contentPreview('a'.repeat(140), 0), 'a'.repeat(140));
  });

  it('141 символ сокращается до итоговых 140 с многоточием', () => {
    // Ловит превью длиннее лимита либо потерю маркера обрезки.
    const result = contentPreview('a'.repeat(141), 0);
    assert.equal(result, `${'a'.repeat(139)}…`);
    assert.equal(result.length, 140);
  });

  it('пустой текст различает сообщение с вложением и полностью пустое', () => {
    // Ловит невидимый push о файле и ложную скрепку у пустого сообщения.
    assert.equal(contentPreview('   ', 1), '📎 Вложение');
    assert.equal(contentPreview('', 0), '');
  });
});

describe('пуш без ключей шифрования', () => {
  it('личное сообщение и упоминание теряют текст, но сохраняют адрес перехода', () => {
    // Ловит как утечку текста через открытый ntfy topic, так и поломанный тап по обезличенному пушу.
    const dm = {
      type: 'dm' as const,
      title: 'Иван',
      body: 'секрет',
      dmId: 'dm-1',
      instanceId: 'peer-1',
    };
    const mention = {
      type: 'mention' as const,
      title: 'Сервер',
      body: '@me секрет',
      channelId: 'ch-1',
      serverId: 'srv-1',
      instanceId: 'peer-2',
    };
    assert.deepEqual(redactPushPayload(dm), { ...dm, body: 'Новое личное сообщение' });
    assert.deepEqual(redactPushPayload(mention), { ...mention, body: 'Вас упомянули' });
  });
});
