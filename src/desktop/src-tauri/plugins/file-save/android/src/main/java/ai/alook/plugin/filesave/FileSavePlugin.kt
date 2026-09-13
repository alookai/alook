package ai.alook.plugin.filesave

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.DocumentsContract
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import app.tauri.plugin.JSObject
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class ExportArgs {
    lateinit var attemptId: String
    lateinit var path: String
    lateinit var name: String
    lateinit var mime: String
    var bytes: Long = -1
    lateinit var sha256: String
}
@InvokeArg
class CancelArgs { lateinit var attemptId: String }

private class ExportSession(val args: ExportArgs, val invoke: Invoke) {
    val token: String = UUID.randomUUID().toString()
    val cancelled = AtomicBoolean(false)
    var terminal = false
    var waitingPicker = false
}

class FileSaveDocumentOwner(private val activity: ComponentActivity) {
    private val launchers = mutableMapOf<String, ActivityResultLauncher<Intent>>()
    private val tokens = linkedSetOf<String>()
    fun attach(saved: Bundle?) {
        FileExporter.owner = this
        tokens.addAll(saved?.getStringArrayList("alook.fileSave.tokens") ?: emptyList())
        tokens.toList().forEach { register(it) }
    }
    private fun register(id: String): ActivityResultLauncher<Intent> {
        launchers[id]?.let { return it }
        var delivered = false
        val launcher = activity.activityResultRegistry.register("alook.file-save.$id", ActivityResultContracts.StartActivityForResult()) { result ->
            delivered = true
            val uri = result.data?.data?.takeIf { result.resultCode == Activity.RESULT_OK }
            FileExporter.deliver(activity.applicationContext, id, uri)
            launchers.remove(id)?.unregister()
            tokens.remove(id)
        }
        if (delivered) launcher.unregister() else launchers[id] = launcher
        return launcher
    }
    fun launch(args: ExportArgs, token: String) {
        tokens.add(token)
        register(token).launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE); type = args.mime; putExtra(Intent.EXTRA_TITLE, args.name)
        })
    }
    fun saveState(out: Bundle) { out.putStringArrayList("alook.fileSave.tokens", ArrayList(tokens)) }
    fun detach() {
        if (FileExporter.owner === this) { FileExporter.owner = null; FileExporter.cancelActive() }
        launchers.values.forEach { it.unregister() }; launchers.clear()
    }
}

private object FileExporter {
    val executor = Executors.newSingleThreadExecutor()
    @Volatile var owner: FileSaveDocumentOwner? = null
    private var session: ExportSession? = null
    private val cancelled = mutableSetOf<String>()
    @Synchronized fun cancelActive() { session?.let { cancel(it.args.attemptId) } }
    @Synchronized fun cancel(id: String) {
        val active = session
        if (active?.args?.attemptId == id) {
            active.cancelled.set(true)
            if (active.waitingPicker) settle(active, "cancelled")
        } else { if (cancelled.size > 128) cancelled.clear(); cancelled.add(id) }
    }
    @Synchronized fun acquire(args: ExportArgs, invoke: Invoke): ExportSession? {
        if (session != null) { invoke.reject("Another file is being saved", "busy"); return null }
        if (cancelled.remove(args.attemptId)) { resolve(invoke, args.attemptId, "cancelled", ""); return null }
        cancelled.clear()
        return ExportSession(args, invoke).also { session = it }
    }
    @Synchronized private fun settle(s: ExportSession, status: String, destination: String = "") {
        if (s.terminal) return
        s.terminal = true
        if (session === s) session = null
        if (status == "error") s.invoke.reject("File export failed", "write_failed")
        else resolve(s.invoke, s.args.attemptId, status, destination)
    }
    private fun resolve(invoke: Invoke, id: String, status: String, destination: String) {
        invoke.resolve(JSObject().apply { put("attemptId", id); put("status", status); put("destination", destination) })
    }
    fun start(activity: Activity, args: ExportArgs, invoke: Invoke) {
        val s = acquire(args, invoke) ?: return
        executor.execute {
            try {
                validate(activity, args)
                if (s.cancelled.get()) { settle(s, "cancelled"); return@execute }
                if (Build.VERSION.SDK_INT >= 29) saveDownloads(activity.applicationContext, s)
                else activity.runOnUiThread {
                    try {
                        if (s.cancelled.get()) settle(s, "cancelled")
                        else synchronized(this) {
                            check(!s.cancelled.get())
                            s.waitingPicker = true
                            (owner ?: throw IllegalStateException()).launch(args, s.token)
                        }
                    } catch (_: Exception) { settle(s, "error") }
                }
            } catch (_: Exception) { settle(s, if (s.cancelled.get()) "cancelled" else "error") }
        }
    }
    private fun validate(context: Context, args: ExportArgs) {
        require(UUID.fromString(args.attemptId).toString() == args.attemptId)
        require(args.bytes >= 0 && args.name.isNotEmpty() && File(args.name).name == args.name && args.name != "." && args.name != "..")
        val source = File(args.path).canonicalFile
        require(source.path.startsWith(context.cacheDir.canonicalPath + "/") && source.parentFile?.name == "user-file-save" && source.name == args.attemptId + ".partial")
        require(source.length() == args.bytes)
    }
    private fun copy(context: Context, s: ExportSession, uri: Uri) {
        context.contentResolver.openOutputStream(uri, "w")?.use { output ->
            FileInputStream(s.args.path).use { input ->
                FileSaveCopy.write(input, output, s.args.bytes, s.args.sha256) { s.cancelled.get() }
            }
        } ?: throw IllegalStateException()
    }
    private fun prefs(context: Context) = context.getSharedPreferences("alook-file-save", Context.MODE_PRIVATE)
    fun repair(context: Context) {
        val prefs = prefs(context)
        if (Build.VERSION.SDK_INT >= 29) try {
            context.contentResolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.IS_PENDING}=1 AND ${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ? AND ${MediaStore.MediaColumns.OWNER_PACKAGE_NAME}=?",
                arrayOf("Download/Alook/", ".alook-%.partial", context.packageName), null,
            )?.use { cursor ->
                while (cursor.moveToNext()) context.contentResolver.delete(
                    android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cursor.getLong(0)), null, null)
            }
        } catch (_: Exception) { }
        for ((key, value) in prefs.all) {
            if (key.startsWith("document:")) continue
            val uri = Uri.parse(value as? String ?: continue)
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.IS_PENDING), null, null, null)?.use {
                        if (it.moveToFirst() && it.getInt(0) == 1) check(context.contentResolver.delete(uri, null, null) > 0)
                    }
                }
                check(prefs.edit().remove(key).commit())
            } catch (_: Exception) { }
        }
        reportCleanup(documentCleanup(context).repair())
    }

    private fun saveDownloads(context: Context, s: ExportSession) {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, ".alook-${s.args.attemptId}.partial")
            put(MediaStore.MediaColumns.MIME_TYPE, s.args.mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Alook")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException()
        var published = false
        try {
            check(prefs(context).edit().putString(s.args.attemptId, uri.toString()).commit())
            copy(context, s, uri)
            synchronized(this) {
                check(!s.cancelled.get())
                check(resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0); put(MediaStore.MediaColumns.DISPLAY_NAME, s.args.name) }, null, null) == 1)
                published = true
                settle(s, "saved", "downloads")
            }
        } finally {
            if (published || resolver.delete(uri, null, null) > 0) prefs(context).edit().remove(s.args.attemptId).commit()
        }
    }
    fun deliver(context: Context, id: String, uri: Uri?) {
        val s = synchronized(this) { session?.takeIf { it.token == id && !it.terminal }?.also { it.waitingPicker = false } }
        executor.execute {
            if (s == null || s.cancelled.get()) {
                if (uri != null) reportCleanup(documentCleanup(context).discard(id, uri.toString()))
                if (s != null) settle(s, "cancelled")
                return@execute
            }
            if (uri == null) { settle(s, "cancelled"); return@execute }
            val cleanup = documentCleanup(context)
            try {
                cleanup.acquire(id, uri.toString())
                copy(context, s, uri)
                synchronized(this) {
                    check(!s.cancelled.get())
                    reportCleanup(cleanup.published(id, uri.toString()))
                    settle(s, "saved", "document")
                }
            } catch (_: Exception) {
                reportCleanup(cleanup.discard(id, uri.toString()))
                settle(s, if (s.cancelled.get()) "cancelled" else "error")
            }
        }
    }
    private fun reportCleanup(complete: Boolean) {
        if (!complete) android.util.Log.w("AlookFileSave", "Document cleanup incomplete; recovery required")
    }
    private fun documentCleanup(context: Context): FileSaveDocumentCleanup {
        val preferences = prefs(context)
        val store = object : DocumentCleanupStore {
            override fun entries(): Map<String, DocumentCleanupRecord> = preferences.all.entries
                .filter { it.key.startsWith("document:") }
                .associate { (key, value) ->
                    val text = value as String
                    val record = if (text.startsWith("{")) {
                        val json = org.json.JSONObject(text)
                        DocumentCleanupRecord(json.getString("uri"), json.getBoolean("releaseOnly"))
                    } else DocumentCleanupRecord(text)
                    key.removePrefix("document:") to record
                }
            override fun put(token: String, record: DocumentCleanupRecord) {
                val json = org.json.JSONObject().put("uri", record.uri).put("releaseOnly", record.releaseOnly)
                check(preferences.edit().putString("document:$token", json.toString()).commit())
            }
            override fun remove(token: String) { check(preferences.edit().remove("document:$token").commit()) }
        }
        val provider = object : DocumentCleanupProvider {
            override fun retain(uri: String) {
                context.contentResolver.takePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            override fun delete(uri: String): Boolean {
                val parsed = Uri.parse(uri)
                return try {
                    if (DocumentsContract.deleteDocument(context.contentResolver, parsed)) true
                    else context.contentResolver.query(parsed, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.count == 0 } ?: false
                } catch (_: java.io.FileNotFoundException) { true }
            }
            override fun release(uri: String) {
                val parsed = Uri.parse(uri)
                if (context.contentResolver.persistedUriPermissions.any { it.uri == parsed }) {
                    context.contentResolver.releasePersistableUriPermission(parsed, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
            }
        }
        return FileSaveDocumentCleanup(store, provider)
    }

}

@TauriPlugin
class FileSavePlugin(private val activity: Activity) : Plugin(activity) {
    init { FileExporter.executor.execute { FileExporter.repair(activity.applicationContext) } }
    @Command fun exportFile(invoke: Invoke) {
        try { FileExporter.start(activity, invoke.parseArgs(ExportArgs::class.java), invoke) }
        catch (_: Exception) { invoke.reject("Invalid file export", "invalid_request") }
    }
    @Command fun cancel(invoke: Invoke) {
        try { FileExporter.cancel(invoke.parseArgs(CancelArgs::class.java).attemptId); invoke.resolve() }
        catch (_: Exception) { invoke.reject("Invalid save cancellation", "invalid_request") }
    }
}
