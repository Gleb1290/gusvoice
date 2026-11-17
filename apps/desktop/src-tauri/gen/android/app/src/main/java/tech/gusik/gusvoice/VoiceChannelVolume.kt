package tech.gusik.gusvoice

import android.app.Activity
import android.content.Context
import android.media.AudioManager
import android.util.Log
import android.view.KeyEvent

/**
 * Routes foreground channel volume buttons/HUD to MUSIC without changing the audio route.
 * Volume levels change only in response to a volume-key DOWN, never on channel join/leave.
 * All entry points run on the main thread (the JS bridge posts there).
 *
 * Channel WebAudio plays as MEDIA even when Chromium uses MODE_IN_COMMUNICATION for AEC.
 * A private 1:1 call takes priority. Until JS first calls setChannelActive, even private-call
 * hooks are observation only, preserving the behavior of older embedded JS in a newer APK.
 *
 * Activity.setVolumeControlStream is a window-scoped suggestion, not a background guarantee;
 * MODE_IN_COMMUNICATION overrides that suggestion in AOSP getActiveStreamType, so foreground
 * channel keys use adjustStreamVolume(MUSIC) directly. A PLAYING MediaSession is deliberately
 * absent: API 26+ sessions cannot opt out of media-button selection and could steal play/pause.
 * https://developer.android.com/reference/android/app/Activity#setVolumeControlStream(int)
 * https://developer.android.com/reference/android/media/session/MediaSession#FLAG_HANDLES_MEDIA_BUTTONS
 */
internal class VoiceChannelVolume(private val activity: Activity) {
  private var bridgeSeen = false
  private var channelActive = false
  private var privateCallActive = false
  private var previousStream: Int? = null
  private var released = false
  private var foreground = false
  private val handledVolumeKeys = mutableSetOf<Pair<Int, Int>>() // device id + key code
  private val audioManager: AudioManager by lazy {
    activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  }

  fun setChannelActive(active: Boolean) {
    if (released) return
    bridgeSeen = true
    channelActive = active
    applyStream()
  }

  fun setPrivateCallActive(active: Boolean) {
    if (released) return
    privateCallActive = active
    applyStream()
  }

  fun setForeground(active: Boolean) {
    if (released) return
    foreground = active
    if (!active) handledVolumeKeys.clear()
  }

  /** Only volume keys delivered to our resumed, focused window; play/pause always goes to super. */
  fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (released || !foreground) return false
    if (!activity.hasWindowFocus()) {
      handledVolumeKeys.clear()
      return false
    }
    if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return false
    val direction = when (event.keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> AudioManager.ADJUST_RAISE
      KeyEvent.KEYCODE_VOLUME_DOWN -> AudioManager.ADJUST_LOWER
      KeyEvent.KEYCODE_VOLUME_MUTE -> AudioManager.ADJUST_TOGGLE_MUTE
      else -> return false
    }
    val key = event.deviceId to event.keyCode
    // Finish our own press even if channel leave / private-call start occurred between DOWN/UP.
    // No adjustment on UP; do not let the default handler flash the call-volume HUD for our press.
    if (event.action == KeyEvent.ACTION_UP) return handledVolumeKeys.remove(key)
    if (!bridgeSeen || !channelActive || privateCallActive) {
      // Consume only the remaining repeats of an already owned press, without changing any level.
      return handledVolumeKeys.contains(key)
    }
    // A held key which began outside our scope remains with the normal handler until its UP.
    if (event.repeatCount == 0) handledVolumeKeys.add(key)
    else if (!handledVolumeKeys.contains(key)) return false
    // Repeated DOWNs adjust UP/DOWN normally; holding MUTE must not toggle back and forth.
    if (event.keyCode != KeyEvent.KEYCODE_VOLUME_MUTE || event.repeatCount == 0) {
      try {
        audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
      } catch (e: SecurityException) {
        // Do not fall through to the call stream if platform policy rejects this adjustment.
        Log.w("GusVoice", "channel volume key rejected", e)
      }
    }
    return true
  }

  private fun applyStream() {
    if (!bridgeSeen) return
    val stream = when {
      privateCallActive -> AudioManager.STREAM_VOICE_CALL
      channelActive -> AudioManager.STREAM_MUSIC
      else -> {
        restoreStream()
        return
      }
    }
    // Capture only on first ownership, not when switching channel -> call -> channel.
    if (previousStream == null) previousStream = activity.volumeControlStream
    if (activity.volumeControlStream != stream) activity.setVolumeControlStream(stream)
  }

  private fun restoreStream() {
    // No ownership (including an initial false) means no setter call at all.
    val stream = previousStream ?: return
    previousStream = null
    if (activity.volumeControlStream != stream) activity.setVolumeControlStream(stream)
  }

  fun release() {
    if (released) return
    released = true // Ignore JS bridge work already queued when onDestroy ran.
    foreground = false
    handledVolumeKeys.clear()
    channelActive = false
    privateCallActive = false
    restoreStream()
  }
}
