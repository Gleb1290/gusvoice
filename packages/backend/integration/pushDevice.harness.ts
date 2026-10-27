import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

/** Одноразовый тестовый получатель WebPush; никаких сохранённых ключей или настоящих устройств. */
export function testPushDevice() {
  const receiver = createECDH('prime256v1'); receiver.generateKeys(); const auth = randomBytes(16);
  return { public: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    decode(body: unknown): Record<string, unknown> {
      // Эти фикстуры всегда с ключами: plaintext здесь скрыл бы регрессию шифрования.
      assert.ok(body instanceof Uint8Array, 'шифрованный пуш — байты'); const bytes = Buffer.from(body);
      const salt = bytes.subarray(0, 16), sender = bytes.subarray(21, 21 + bytes[20]!);
      const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
      const prkKey = hmac(auth, receiver.computeSecret(sender));
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), receiver.getPublicKey(), sender]);
      const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])), prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
      const sealed = bytes.subarray(21 + bytes[20]!); const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(sealed.subarray(-16));
      const clear = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
      assert.equal(clear.at(-1), 2, 'получена последняя запись RFC8188');
      return JSON.parse(clear.subarray(0, -1).toString('utf8')) as Record<string, unknown>;
    } };
}
