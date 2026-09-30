package tech.gusik.gusvoice

import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Расшифровка пуша по стандарту WebPush (RFC 8291 + aes128gcm из RFC 8188) — #213, этап 0 ЛС.
 *
 * 🔴 Зачем. Пуш о личном сообщении лежал в ntfy открытым текстом, а ntfy отдаёт тему на чтение без входа.
 * Теперь бэкенд шифрует тело открытым ключом ЭТОГО телефона (`packages/backend/src/pushCrypto.ts`), и
 * ntfy видит только шифр. Ключевая пара P-256 и секрет рождаются здесь один раз и живут в личных
 * настройках приложения; наружу уходят только открытый ключ и секрет (`keysJson`, через мост в
 * `/api/push/register`), закрытый ключ телефон не покидает.
 *
 * Обе дороги пуша (внешнее приложение ntfy и наш встроенный распространитель) отдают в
 * [PushNotifier] уже сырые байты; открытый JSON старого бэкенда начинается с `{` и идёт как раньше.
 *
 * ⚠️ Закрытый ключ — в настройках приложения, а не в Android Keystore: ECDH в Keystore есть только с
 * Android 12, а пуши нужны и ниже. Настройки приложения закрыты от других приложений системой.
 */
object PushCrypto {
  private const val TAG = "GusVoicePush"
  private const val PREFS = "gusvoice_push_keys"
  private const val PREF_PRIV = "wp_priv"
  private const val PREF_PUB = "wp_public"
  private const val PREF_AUTH = "wp_auth"
  private const val B64 = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING

  /** `{"p256dh":"…","auth":"…"}` (base64url) для регистрации на бэкенде. Ключи создаются при первом вызове. */
  @Synchronized
  fun keysJson(context: Context): String {
    ensureKeys(context)
    val p = prefs(context)
    return JSONObject()
      .put("p256dh", p.getString(PREF_PUB, ""))
      .put("auth", p.getString(PREF_AUTH, ""))
      .toString()
  }

  /** Похоже на шифр WebPush, а не на открытый JSON старого бэкенда. */
  fun looksEncrypted(message: ByteArray): Boolean =
    message.size >= HEADER_MIN + TAG_LEN && message[0] != '{'.code.toByte()

  /**
   * Расшифровать тело пуша. `null` — ключей ещё нет (пуш пришёл до регистрации) или шифр не сошёлся
   * (не тот ключ, битые байты): уведомление тогда покажет «новое сообщение» без текста.
   */
  @Synchronized
  fun decrypt(context: Context, message: ByteArray): ByteArray? = try {
    decryptOrThrow(context, message)
  } catch (e: Exception) {
    Log.w(TAG, "push decrypt failed: ${e.javaClass.simpleName}")
    null
  }

  private fun decryptOrThrow(context: Context, message: ByteArray): ByteArray? {
    val p = prefs(context)
    val privB64 = p.getString(PREF_PRIV, null) ?: return null
    val uaPublic = Base64.decode(p.getString(PREF_PUB, null) ?: return null, B64)
    val authSecret = Base64.decode(p.getString(PREF_AUTH, null) ?: return null, B64)
    val priv = KeyFactory.getInstance("EC")
      .generatePrivate(PKCS8EncodedKeySpec(Base64.decode(privB64, B64))) as ECPrivateKey

    // Заголовок aes128gcm: соль 16 · размер записи 4 · длина ключа 1 · ключ отправителя.
    val salt = message.copyOfRange(0, 16)
    val idLen = message[20].toInt() and 0xff
    if (idLen != 65 || message.size < 21 + idLen + TAG_LEN) return null
    val asPublic = message.copyOfRange(21, 21 + idLen)
    val sealed = message.copyOfRange(21 + idLen, message.size)

    val asKey = KeyFactory.getInstance("EC").generatePublic(
      ECPublicKeySpec(
        ECPoint(BigInteger(1, asPublic.copyOfRange(1, 33)), BigInteger(1, asPublic.copyOfRange(33, 65))),
        priv.params,
      ),
    )
    val ecdhSecret = KeyAgreement.getInstance("ECDH").run {
      init(priv)
      doPhase(asKey, true)
      generateSecret()
    }

    // RFC 8291 §3.4, та же последовательность, что у бэкенда.
    val prkKey = hmac(authSecret, ecdhSecret)
    val ikm = hmac(prkKey, "WebPush: info\u0000".toByteArray(Charsets.ISO_8859_1) + uaPublic + asPublic + byteArrayOf(1))
    val prk = hmac(salt, ikm)
    val cek = hmac(prk, "Content-Encoding: aes128gcm\u0000\u0001".toByteArray(Charsets.ISO_8859_1)).copyOf(16)
    val nonce = hmac(prk, "Content-Encoding: nonce\u0000\u0001".toByteArray(Charsets.ISO_8859_1)).copyOf(12)

    val plain = Cipher.getInstance("AES/GCM/NoPadding").run {
      init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
      doFinal(sealed)
    }
    // Последняя запись: данные, 0x02, нули добивки.
    var end = plain.size - 1
    while (end >= 0 && plain[end] == 0.toByte()) end--
    if (end < 0 || plain[end] != 2.toByte()) return null
    return plain.copyOf(end)
  }

  private fun ensureKeys(context: Context) {
    val p = prefs(context)
    if (p.contains(PREF_PRIV) && p.contains(PREF_PUB) && p.contains(PREF_AUTH)) return
    val kp = KeyPairGenerator.getInstance("EC").run {
      initialize(ECGenParameterSpec("secp256r1"))
      generateKeyPair()
    }
    val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
    // commit, а не apply: ключ обязан лечь ДО того, как открытая часть уйдёт на бэкенд — иначе пуш,
    // зашифрованный этим ключом, мог бы прийти в процесс, который закрытой части ещё не видит.
    p.edit()
      .putString(PREF_PRIV, Base64.encodeToString(kp.private.encoded, B64))
      .putString(PREF_PUB, Base64.encodeToString(uncompressed(kp.public as ECPublicKey), B64))
      .putString(PREF_AUTH, Base64.encodeToString(auth, B64))
      .commit()
  }

  /** Несжатая точка X9.62: 0x04 · X (32) · Y (32). `BigInteger` бывает короче или с ведущим нулём. */
  private fun uncompressed(k: ECPublicKey): ByteArray {
    fun fixed(v: BigInteger): ByteArray {
      val raw = v.toByteArray()
      return when {
        raw.size == 32 -> raw
        raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
        else -> ByteArray(32 - raw.size) + raw
      }
    }
    return byteArrayOf(4) + fixed(k.w.affineX) + fixed(k.w.affineY)
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run {
      init(SecretKeySpec(key, "HmacSHA256"))
      doFinal(data)
    }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private const val HEADER_MIN = 21 + 65
  private const val TAG_LEN = 16
}
