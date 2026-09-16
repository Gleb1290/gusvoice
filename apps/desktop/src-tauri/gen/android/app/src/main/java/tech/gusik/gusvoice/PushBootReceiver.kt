package tech.gusik.gusvoice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restart the EMBEDDED push distributor after a device reboot, so background notifications survive a
 * restart without the user reopening the app. No-op unless embedded push was enabled (prefs hold the
 * ntfy base + topic). The external-distributor path needs no boot receiver — the ntfy app handles its
 * own restart.
 */
class PushBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val base = context
      .getSharedPreferences(UnifiedPushReceiver.PREFS, Context.MODE_PRIVATE)
      .getString(PushDistributorService.KEY_NTFY_BASE, "")
      .orEmpty()
    if (base.isNotEmpty()) PushDistributorService.start(context)
  }
}
