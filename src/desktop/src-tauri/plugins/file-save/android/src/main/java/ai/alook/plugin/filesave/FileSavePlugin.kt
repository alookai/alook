package ai.alook.plugin.filesave

import android.app.Activity
import android.content.ClipData
import androidx.core.content.FileProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.DocumentsContract
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
    val cancelled = AtomicBoolean(false)
    var terminal = false
}

private object FileExporter {
    val executor = Executors.newSingleThreadExecutor()
    private var session: ExportSession? = null
    private val cancelled = mutableSetOf<String>()
    @Synchronized fun cancel(id: String) {
        val active = session
        if (active?.args?.attemptId == id) {
            active.cancelled.set(true)
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
                val root = File(activity.cacheDir, "alook-share")
                root.mkdirs()
                root.listFiles()?.filter { it.lastModified() < System.currentTimeMillis() - 86_400_000L }?.forEach { it.deleteRecursively() }
                val directory = File(root, args.attemptId)
                check(directory.mkdirs())
                val destination = File(directory, args.name)
                try {
                    FileInputStream(args.path).use { input ->
                        destination.outputStream().use { output ->
                            FileSaveCopy.write(input, output, args.bytes, args.sha256) { s.cancelled.get() }
                        }
                    }
                    activity.runOnUiThread {
                        synchronized(this) {
                            try {
                                if (s.cancelled.get()) {
                                    directory.deleteRecursively()
                                    settle(s, "cancelled")
                                } else {
                                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.file-share", destination)
                                    val send = Intent(Intent.ACTION_SEND).apply {
                                        type = args.mime
                                        putExtra(Intent.EXTRA_STREAM, uri)
                                        putExtra(Intent.EXTRA_TITLE, args.name)
                                        clipData = ClipData.newRawUri(args.name, uri)
                                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                    }
                                    activity.startActivity(Intent.createChooser(send, null))
                                    settle(s, "started", "share")
                                }
                            } catch (_: Exception) {
                                directory.deleteRecursively()
                                settle(s, "error")
                            }
                        }
                    }
                } catch (error: Exception) {
                    directory.deleteRecursively()
                    throw error
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
