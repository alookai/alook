package ai.alook.plugin.touchsetup

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import androidx.appcompat.app.AppCompatActivity
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.espressif.provisioning.ESPConstants
import com.espressif.provisioning.ESPDevice
import com.espressif.provisioning.WiFiAccessPoint
import com.espressif.provisioning.listeners.ProvisionListener
import com.espressif.provisioning.listeners.ResponseListener
import com.espressif.provisioning.listeners.WiFiScanListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.ArrayDeque

@InvokeArg
class ConnectArgs { lateinit var attemptId: String; lateinit var name: String; lateinit var pop: String; lateinit var serviceUuid: String }
@InvokeArg
class AttemptArgs { lateinit var attemptId: String }
@InvokeArg
class ProvisionArgs { lateinit var attemptId: String; lateinit var ssid: String; lateinit var password: String }
@InvokeArg
class ExchangeArgs { lateinit var attemptId: String; lateinit var action: String; var userCode: String? = null }

internal class SecureDevice(activity: Activity) : ESPDevice(activity, ESPConstants.TransportType.TRANSPORT_BLE, ESPConstants.SecurityType.SECURITY_1) {
    override fun initSession(listener: ResponseListener) {
        try {
            val info = JSONObject(versionInfo).getJSONObject("prov")
            check(info.getInt("sec_ver") == 1 && !deviceCapabilities.contains("no_pop"))
            super.initSession(listener)
        } catch (_: Exception) { listener.onFailure(Exception("setup_security_failed")) }
    }
}
private class Attempt(val id: String, val invoke: Invoke) {
    var device: SecureDevice? = null
    var scanning: ScanCallback? = null
    var pending: Invoke? = invoke
    var ready = false
    var deadline: Runnable? = null
}

@SuppressLint("MissingPermission")
@TauriPlugin(permissions = [
    Permission(strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT], alias = "bluetooth"),
    Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = "location"),
])
class TouchSetupPlugin(private val activity: Activity) : Plugin(activity) {
    private val handler = Handler(Looper.getMainLooper())
    private var current: Attempt? = null
    private val retired = ArrayDeque<String>()
    private fun remember(id: String) { if (!retired.contains(id)) retired.addLast(id); if (retired.size > 256) retired.removeFirst() }
    private val service = "b4df5a1c-3f6b-f4bf-ea4a-820304901a02"
    private fun fail(invoke: Invoke) { invoke.reject("Touch setup failed", "setup_failed") }
    private fun live(s: Attempt) = current === s
    private fun stopScan(s: Attempt) {
        val callback = s.scanning ?: return
        s.scanning = null
        try { activity.getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner?.stopScan(callback) } catch (_: Exception) { }
    }
    private fun finish(s: Attempt, result: JSObject? = null, error: Boolean = false) {
        if (!live(s)) return
        s.deadline?.let(handler::removeCallbacks); s.deadline = null
        val invoke = s.pending ?: return
        s.pending = null
        if (error) { fail(invoke); close(s) }
        else if (result == null) invoke.resolve() else invoke.resolve(result)
    }
    private fun respond(s: Attempt, invoke: Invoke, result: JSObject? = null, error: Boolean = false) {
        if (s.pending === invoke) finish(s, result, error)
    }
    private fun close(s: Attempt) {
        remember(s.id)
        if (current === s) current = null
        s.deadline?.let(handler::removeCallbacks); s.deadline = null
        stopScan(s)
        s.pending?.let(::fail); s.pending = null
        s.device?.disconnectDevice(); s.device = null
    }
    private fun arm(s: Attempt, millis: Long) {
        s.deadline?.let(handler::removeCallbacks)
        val pending = s.pending
        s.deadline = Runnable { if (live(s) && s.pending === pending) finish(s, error = true) }.also { handler.postDelayed(it, millis) }
    }
    private fun use(invoke: Invoke, id: String, run: (Attempt) -> Unit) {
        val s = current
        if (s == null || s.id != id || !s.ready || s.pending != null) { fail(invoke); return }
        s.pending = invoke; arm(s, 65000)
        try { run(s) } catch (_: Exception) { finish(s, error = true) }
    }
    @Command fun connect(invoke: Invoke) = activity.runOnUiThread {
        try {
            val args = invoke.parseArgs(ConnectArgs::class.java)
            check(args.attemptId.matches(Regex("[0-9a-f-]{36}")) && args.name.matches(Regex("ALOOK_TOUCH_[A-F0-9]{6}")) && args.pop.matches(Regex("[a-f0-9]{32}")) && args.serviceUuid == service)
            check(!retired.contains(args.attemptId))
            current?.let(::close)
            val s = Attempt(args.attemptId, invoke); current = s; arm(s, 30000)
            val alias = if (Build.VERSION.SDK_INT >= 31) "bluetooth" else "location"
            if (getPermissionState(alias) == PermissionState.GRANTED) beginScan(s, args)
            else requestPermissionForAlias(alias, invoke, "permissionResult")
        } catch (_: Exception) { fail(invoke) }
    }
    @PermissionCallback private fun permissionResult(invoke: Invoke) = activity.runOnUiThread {
        val s = current
        if (s?.pending !== invoke) return@runOnUiThread
        val alias = if (Build.VERSION.SDK_INT >= 31) "bluetooth" else "location"
        if (getPermissionState(alias) != PermissionState.GRANTED) { finish(s, error = true); return@runOnUiThread }
        try { beginScan(s, invoke.parseArgs(ConnectArgs::class.java)) } catch (_: Exception) { finish(s, error = true) }
    }
    private fun beginScan(s: Attempt, args: ConnectArgs) {
        if (!live(s)) return
        val scanner = activity.getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner
        if (scanner == null) { finish(s, error = true); return }
        val callback = object : ScanCallback() {
            override fun onScanFailed(errorCode: Int) { if (live(s) && s.scanning === this) finish(s, error = true) }
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                if (!live(s) || s.scanning !== this || result.scanRecord?.deviceName != args.name) return
                stopScan(s)
                val device = SecureDevice(activity); s.device = device
                device.proofOfPossession = args.pop
                try { device.connectBLEDevice(result.device, service) } catch (_: Exception) { finish(s, error = true); return }
                val deadline = System.currentTimeMillis() + 15000
                fun awaitVersion() {
                    if (!live(s)) return
                    if (!device.versionInfo.isNullOrEmpty()) {
                        device.initSession(object : ResponseListener {
                            override fun onSuccess(returnData: ByteArray?) = activity.runOnUiThread { if (live(s) && s.pending === s.invoke) { s.ready = true; finish(s) } }
                            override fun onFailure(e: Exception?) = activity.runOnUiThread { respond(s, s.invoke, error = true) }
                        })
                    } else if (System.currentTimeMillis() >= deadline) finish(s, error = true)
                    else handler.postDelayed({ awaitVersion() }, 100)
                }
                awaitVersion()
            }
        }
        s.scanning = callback
        scanner.startScan(listOf(ScanFilter.Builder().setDeviceName(args.name).setServiceUuid(ParcelUuid(UUID.fromString(service))).build()), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
    }
    @Command fun scanNetworks(invoke: Invoke) = activity.runOnUiThread {
        try { use(invoke, invoke.parseArgs(AttemptArgs::class.java).attemptId) { s ->
            s.device!!.scanNetworks(object : WiFiScanListener {
                override fun onWifiListReceived(wifiList: ArrayList<WiFiAccessPoint>?) = activity.runOnUiThread {
                    val rows = JSONArray()
                    wifiList.orEmpty().filter { it.wifiName.isNotEmpty() && it.wifiName.toByteArray().size <= 32 && !it.wifiName.contains('\u0000') }.sortedByDescending { it.rssi }.distinctBy { it.wifiName }.take(100).forEach { rows.put(JSONObject().put("ssid", it.wifiName).put("rssi", it.rssi).put("secured", it.security != 0)) }
                    respond(s, invoke, JSObject().apply { put("networks", rows) })
                }
                override fun onWiFiScanFailed(e: Exception?) = activity.runOnUiThread { respond(s, invoke, error = true) }
            })
        } } catch (_: Exception) { fail(invoke) }
    }
    @Command fun provision(invoke: Invoke) = activity.runOnUiThread {
        try { val args = invoke.parseArgs(ProvisionArgs::class.java); use(invoke, args.attemptId) { s ->
            check(args.ssid.toByteArray().size in 1..32 && !args.ssid.contains('\u0000') && (args.password.isEmpty() || args.password.toByteArray().size in 8..63) && !args.password.contains('\u0000'))
            s.device!!.provision(args.ssid, args.password, object : ProvisionListener {
                override fun createSessionFailed(e: Exception?) = failure()
                override fun wifiConfigSent() { }
                override fun wifiConfigFailed(e: Exception?) = failure()
                override fun wifiConfigApplied() { }
                override fun wifiConfigApplyFailed(e: Exception?) = failure()
                override fun provisioningFailedFromDevice(reason: ESPConstants.ProvisionFailureReason?) = failure()
                override fun deviceProvisioningSuccess() = activity.runOnUiThread { respond(s, invoke) }
                override fun onProvisioningFailed(e: Exception?) = failure()
                private fun failure() = activity.runOnUiThread { respond(s, invoke, error = true) }
            })
        } } catch (_: Exception) { fail(invoke) }
    }
    @Command fun exchange(invoke: Invoke) = activity.runOnUiThread {
        try { val args = invoke.parseArgs(ExchangeArgs::class.java); use(invoke, args.attemptId) { s ->
            val request = JSONObject().put("action", args.action)
            check(args.action == "code" || (args.action == "ack" && args.userCode?.matches(Regex("[A-Z0-9]{4}-?[A-Z0-9]{4}")) == true))
            if (args.action == "ack") request.put("user_code", args.userCode)
            s.device!!.sendDataToCustomEndPoint("alook-auth", request.toString().toByteArray(), object : ResponseListener {
                override fun onSuccess(returnData: ByteArray?) = activity.runOnUiThread {
                    if (returnData == null || returnData.size > 256) respond(s, invoke, error = true)
                    else respond(s, invoke, JSObject().apply { put("response", returnData.toString(Charsets.UTF_8)) })
                }
                override fun onFailure(e: Exception?) = activity.runOnUiThread { respond(s, invoke, error = true) }
            })
        } } catch (_: Exception) { fail(invoke) }
    }
    @Command fun cancel(invoke: Invoke) = activity.runOnUiThread {
        try { val id = invoke.parseArgs(AttemptArgs::class.java).attemptId; remember(id); current?.takeIf { it.id == id }?.let(::close); invoke.resolve() }
        catch (_: Exception) { fail(invoke) }
    }
    override fun onDestroy(activity: AppCompatActivity) { current?.let(::close) }
}
