import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { encryptWebPush, validWebPushKeys, type WebPushKeys } from './pushCrypto.js';

const RFC_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const RFC_UA_PRIVATE = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94';
const RFC_UA_PUBLIC =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const RFC_AS_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const RFC_SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const RFC_BODY =
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function decryptWebPush(body: Buffer, receiverPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const keyLength = body[20]!;
  const senderPublic = body.subarray(21, 21 + keyLength);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(receiverPrivate);
  const receiverPublic = receiver.getPublicKey();
  const shared = receiver.computeSecret(senderPublic);
  const prkKey = hmac(auth, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), receiverPublic, senderPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const sealed = body.subarray(21 + keyLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const clear = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.equal(clear.at(-1), 2, 'последняя запись обязана оканчиваться разделителем 0x02');
  return clear.subarray(0, -1);
}

describe('WebPush aes128gcm', () => {
  const rfcKeys: WebPushKeys = { p256dh: RFC_UA_PUBLIC, auth: RFC_AUTH };

  it('фиксированные ключ и соль дают опубликованный в RFC 8291 пакет байт в байт', () => {
    // Ловит любую несовместимость HKDF, заголовка или AES-GCM, которую круговой тест с тем же алгоритмом скрыл бы.
    const actual = encryptWebPush(Buffer.from('When I grow up, I want to be a watermelon'), rfcKeys, {
      salt: Buffer.from(RFC_SALT, 'base64url'),
      senderPrivateKey: Buffer.from(RFC_AS_PRIVATE, 'base64url'),
    });
    assert.equal(actual.toString('base64url'), RFC_BODY);
  });

  it('случайный пакет расшифровывается закрытым ключом получателя', () => {
    // Ловит пакет, совпадающий с одним вектором, но не пригодный для произвольных сообщений и соли.
    const clear = Buffer.from('Привет, это закрытое ЛС');
    const encrypted = encryptWebPush(clear, rfcKeys);
    assert.deepEqual(
      decryptWebPush(encrypted, Buffer.from(RFC_UA_PRIVATE, 'base64url'), Buffer.from(RFC_AUTH, 'base64url')),
      clear,
    );
  });

  it('повторная отправка меняет и соль, и одноразовый ключ отправителя', () => {
    // Ловит повтор криптографического материала, при котором одинаковые пуши становятся сопоставимыми.
    const one = encryptWebPush(Buffer.from('same'), rfcKeys);
    const two = encryptWebPush(Buffer.from('same'), rfcKeys);
    assert.notDeepEqual(one.subarray(0, 16), two.subarray(0, 16));
    assert.notDeepEqual(one.subarray(21, 86), two.subarray(21, 86));
  });

  it('3993 байта дают ровно 4096 на проводе, а 3994 уже отклоняются', () => {
    // Ловит ошибку на один байт, из-за которой ntfy ответит 413 и удалится регистрация устройства.
    assert.equal(encryptWebPush(Buffer.alloc(3_993), rfcKeys).length, 4_096);
    assert.throws(() => encryptWebPush(Buffer.alloc(3_994), rfcKeys), /too large/);
  });
});

describe('форма ключей WebPush', () => {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const key = receiver.getPublicKey();
  const keys = (pub: Buffer, auth = Buffer.alloc(16)): WebPushKeys => ({
    p256dh: pub.toString('base64url'),
    auth: auth.toString('base64url'),
  });

  it('несжатая точка P-256 из 65 байт и секрет из 16 байт принимаются', () => {
    // Ловит отказ корректной регистрации нового устройства из-за неверного формата base64url.
    assert.equal(validWebPushKeys(keys(key)), true);
  });

  it('неверная длина, сжатая точка и секрет соседней длины отклоняются', () => {
    // Ловит сохранение ключей, которые упадут уже в фоне и оставят устройство без текста пуша.
    assert.equal(validWebPushKeys(keys(key.subarray(0, 64))), false);
    assert.equal(validWebPushKeys(keys(Buffer.concat([key, Buffer.from([0])]))), false);
    assert.equal(validWebPushKeys(keys(Buffer.concat([Buffer.from([2]), Buffer.alloc(64)]))), false);
    assert.equal(validWebPushKeys(keys(key, Buffer.alloc(15))), false);
    assert.equal(validWebPushKeys(keys(key, Buffer.alloc(17))), false);
  });

  it('точка верной формы, но вне эллиптической кривой не регистрируется', () => {
    // Ловит ключ, который проходит проверку длины, но падает при каждом вычислении секрета.
    assert.equal(validWebPushKeys(keys(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]))), false);
  });
});
