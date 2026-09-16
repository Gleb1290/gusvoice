package tech.gusik.gusvoice

import android.content.Context
import android.util.Log
import org.unifiedpush.android.connector.MessagingReceiver

/**
 * Receives UnifiedPush events from an EXTERNAL distributor (e.g. the ntfy app). Fires even when
 * GusVoice's OWN process is dead. This is the FALLBACK path; the generic multi-instance build prefers
 * the embedded distributor ([PushDistributorService]) so no second app is needed. Notification building
 * is shared via [PushNotifier].
 *
 * - onNewEndpoint: stash the endpoint URL in prefs; the web client reads it via the GusVoiceNative
 *   bridge (getPushEndpoint) and POSTs it to /api/push/register with the user's auth token (only the
 *   authed client knows which account this device is → registration lives on the JS side, not here).
 * - onMessage: hand the raw payload to PushNotifier (parse + foreground-suppress + notify + deep-link).
 */
class UnifiedPushReceiver : MessagingReceiver() {
  override fun onNewEndpoint(context: Context, endpoint: String, instance: String) {
    prefs(context).edit().putString(KEY_ENDPOINT, endpoint).apply()
    Log.i(TAG, "new endpoint stored (len=${endpoint.length})")
  }

  override fun onRegistrationFailed(context: Context, instance: String) {
    prefs(context).edit().remove(KEY_ENDPOINT).apply()
    Log.w(TAG, "registration failed")
  }

  override fun onUnregistered(context: Context, instance: String) {
    prefs(context).edit().remove(KEY_ENDPOINT).apply()
    Log.i(TAG, "unregistered")
  }

  override fun onMessage(context: Context, message: ByteArray, instance: String) {
    PushNotifier.show(context, message)
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  companion object {
    const val PREFS = "gusvoice_push"
    const val KEY_ENDPOINT = "up_endpoint"
    const val KEY_DEEPLINK = "pending_deeplink"
    const val EXTRA_DM = "gv_dm"
    const val EXTRA_CHANNEL = "gv_channel"
    const val EXTRA_SERVER = "gv_server"
    private const val TAG = "GusVoicePush"
  }
}
