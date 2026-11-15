package ai.alook.plugin.mobileorientation

import android.app.Activity
import android.content.res.Configuration
import android.hardware.SensorManager
import android.view.OrientationEventListener
import android.view.Surface
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlin.math.abs
import kotlin.math.roundToInt

internal fun mobileOrientationAngle(value: Int, previous: Int?): Int? {
    if (value !in 0..359) return previous
    if (previous != null) {
        val distance = abs(value - previous)
        if (minOf(distance, 360 - distance) < 60) return previous
    }
    return ((value / 90.0).roundToInt() * 90) % 360
}

@InvokeArg
class OrientationListenArgs {
    var registrationId: Long = 0
    lateinit var channel: Channel
}
@InvokeArg
class OrientationStopArgs {
    var registrationId: Long = 0
}

@TauriPlugin
class MobileOrientationPlugin(private val activity: Activity) : Plugin(activity) {
    private var highestId: Long = 0
    private var currentId: Long? = null
    private var listener: Channel? = null
    private var sensor: OrientationEventListener? = null
    private var physicalAngle: Int? = null
    private var lastSnapshot: String? = null
    private var foreground = true
    private var accessDenied = false
    private var generation = 0L

    override fun onPause(activity: AppCompatActivity) {
        foreground = false
        pauseSensor()
        super.onPause(activity)
    }
    override fun onResume(activity: AppCompatActivity) {
        super.onResume(activity)
        foreground = true
        startSensor()
    }
    override fun onDestroy(activity: AppCompatActivity) {
        stop()
        super.onDestroy(activity)
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        publish()
    }
    @Command
    fun listen(invoke: Invoke) {
        val args = try { invoke.parseArgs(OrientationListenArgs::class.java) } catch (_: Exception) {
            invoke.reject("Orientation listener is invalid", "invalid_request"); return
        }
        activity.runOnUiThread {
            if (args.registrationId <= highestId) { invoke.resolve(); return@runOnUiThread }
            stop()
            highestId = args.registrationId
            currentId = args.registrationId
            listener = args.channel
            startSensor()
            publish()
            invoke.resolve()
        }
    }
    @Command
    fun unlisten(invoke: Invoke) {
        val args = try { invoke.parseArgs(OrientationStopArgs::class.java) } catch (_: Exception) {
            invoke.reject("Orientation listener is invalid", "invalid_request"); return
        }
        activity.runOnUiThread {
            if (currentId == args.registrationId) stop()
            invoke.resolve()
        }
    }
    @Command
    fun retire(invoke: Invoke) {
        val args = try { invoke.parseArgs(OrientationStopArgs::class.java) } catch (_: Exception) {
            invoke.reject("Orientation listener is invalid", "invalid_request"); return
        }
        activity.runOnUiThread {
            if (args.registrationId >= highestId) {
                highestId = args.registrationId
                stop()
            }
            invoke.resolve()
        }
    }
    private fun startSensor() {
        val id = currentId ?: return
        if (!foreground || accessDenied || sensor != null || listener == null) return
        val current = ++generation
        sensor = object : OrientationEventListener(activity, SensorManager.SENSOR_DELAY_NORMAL) {
            override fun onOrientationChanged(value: Int) {
                if (!foreground || currentId != id || generation != current) return
                physicalAngle = mobileOrientationAngle(value, physicalAngle)
                publish()
            }
        }
        publish()
        if (sensor?.canDetectOrientation() == true) {
            try { sensor?.enable() } catch (error: Exception) {
                pauseSensor()
                accessDenied = error is SecurityException
                publish()
            }
        }
    }
    private fun pauseSensor() {
        generation += 1
        sensor?.disable()
        sensor = null
    }
    private fun stop() {
        pauseSensor()
        listener = null
        currentId = null
        physicalAngle = null
        lastSnapshot = null
        accessDenied = false
    }
    @Suppress("DEPRECATION")
    private fun publish() {
        val interfaceAngle = when (activity.windowManager.defaultDisplay.rotation) {
            Surface.ROTATION_90 -> 270
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 90
            else -> 0
        }
        val availability = if (accessDenied) "denied" else if (sensor?.canDetectOrientation() == true) "available" else "unavailable"
        val key = "$availability:$physicalAngle:$interfaceAngle"
        if (key == lastSnapshot) return
        lastSnapshot = key
        val snapshot = JSObject()
        snapshot.put("availability", availability)
        snapshot.put("physicalAngle", physicalAngle ?: org.json.JSONObject.NULL)
        snapshot.put("interfaceAngle", interfaceAngle)
        runCatching { listener?.send(snapshot) }.onFailure { stop() }
    }
}
