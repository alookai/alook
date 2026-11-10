package ai.alook.android

import android.os.SystemClock
import androidx.annotation.Keep

@Keep
object StartupLog {
    private var entryNanos = 0L
    private var requestedMicros = -1L
    private var completedMicros = -1L
    private var webViewMicros = -1L
    private var blockingSites = -1
    private var outcome = 0
    private var nativeReady = false

    @Synchronized fun applicationEntry() {
        if (entryNanos == 0L) entryNanos = SystemClock.elapsedRealtimeNanos()
    }

    private fun elapsedMicros(): Long =
        if (entryNanos == 0L) -1L else (SystemClock.elapsedRealtimeNanos() - entryNanos) / 1_000L

    @Synchronized fun asyncRequested() {
        if (requestedMicros < 0L) requestedMicros = elapsedMicros()
    }

    @Synchronized fun asyncCompleted(success: Boolean, uiBlockingSites: Int = -1) {
        if (completedMicros >= 0L) return
        completedMicros = elapsedMicros()
        blockingSites = uiBlockingSites
        outcome = if (success) 1 else 2
        publish()
    }

    @Synchronized fun webViewCreated() {
        if (webViewMicros < 0L) webViewMicros = elapsedMicros()
        publish()
    }

    @Synchronized fun nativeLibraryReady() {
        nativeReady = true
        publish()
    }

    private fun publish() {
        if (nativeReady) recordTiming(requestedMicros, completedMicros, webViewMicros, blockingSites, outcome)
    }

    @JvmStatic private external fun recordTiming(requested: Long, completed: Long, webView: Long, blockingSites: Int, outcome: Int)
    @JvmStatic external fun foregroundChanged(active: Boolean)
    @JvmStatic external fun handoffBegin()
    @JvmStatic external fun handoffReturned()
}
