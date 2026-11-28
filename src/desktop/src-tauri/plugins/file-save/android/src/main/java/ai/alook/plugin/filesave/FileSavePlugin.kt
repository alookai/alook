package ai.alook.plugin.filesave

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
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

internal object FileSaveShareCache {
    const val DIRECTORY_NAME = "alook-share"
    const val DEFAULT_MAX_AGE_MS = 24L * 60L * 60L * 1000L
    const val DEFAULT_MAX_TOTAL_BYTES = 256L * 1024L * 1024L

    fun sweep(
        root: File,
        nowMs: Long = System.currentTimeMillis(),
        maxAgeMs: Long = DEFAULT_MAX_AGE_MS,
        maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
        keepName: String? = null,
        deleteAllPrior: Boolean = false,
    ) {
        val children = root.listFiles() ?: return
        val cutoff = nowMs - maxAgeMs
        val retained = mutableListOf<Pair<File, Long>>()
        var totalBytes = 0L

        for (entry in children) {
            if (keepName != null && entry.name == keepName) continue
            if (deleteAllPrior || entry.lastModified() < cutoff) {
                entry.deleteRecursively()
                continue
            }
            val size = directoryBytes(entry)
            totalBytes += size
            retained += entry to size
        }

        if (totalBytes <= maxTotalBytes) return
        retained.sortBy { it.first.lastModified() }
        for ((entry, size) in retained) {
            if (totalBytes <= maxTotalBytes) break
            entry.deleteRecursively()
            totalBytes -= size
        }
    }

    private fun directoryBytes(file: File): Long {
        if (!file.exists()) return 0L
        if (file.isFile) return file.length()
        return file.listFiles()?.sumOf { directoryBytes(it) } ?: 0L
    }
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
    private fun deleteAsync(directory: File) {
        executor.execute { directory.deleteRecursively() }
    }
    fun start(activity: Activity, args: ExportArgs, invoke: Invoke) {
        val s = acquire(args, invoke) ?: return
        executor.execute {
            try {
                validate(activity, args)
                if (s.cancelled.get() || activity.isFinishing || activity.isDestroyed) {
                    settle(s, if (s.cancelled.get()) "cancelled" else "error")
                    return@execute
                }
                val root = File(activity.cacheDir, FileSaveShareCache.DIRECTORY_NAME)
                root.mkdirs()
                FileSaveShareCache.sweep(root, keepName = args.attemptId)
                val directory = File(root, args.attemptId)
                check(directory.mkdirs())
                val destination = File(directory, args.name)
                try {
                    FileInputStream(args.path).use { input ->
                        destination.outputStream().use { output ->
                            FileSaveCopy.write(input, output, args.bytes, args.sha256) { s.cancelled.get() }
                        }
                    }
                    if (s.cancelled.get() || activity.isFinishing || activity.isDestroyed) {
                        directory.deleteRecursively()
                        settle(s, if (s.cancelled.get()) "cancelled" else "error")
                        return@execute
                    }
                    activity.runOnUiThread {
                        synchronized(this) {
                            try {
                                if (s.cancelled.get()) {
                                    deleteAsync(directory)
                                    settle(s, "cancelled")
                                } else if (activity.isFinishing || activity.isDestroyed) {
                                    deleteAsync(directory)
                                    settle(s, "error")
                                } else {
                                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.file-share", destination)
                                    val send = Intent(Intent.ACTION_SEND).apply {
                                        type = args.mime
                                        putExtra(Intent.EXTRA_STREAM, uri)
                                        putExtra(Intent.EXTRA_TITLE, args.name)
                                        clipData = ClipData.newRawUri(args.name, uri)
                                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                    }
                                    val chooser = Intent.createChooser(send, null).apply {
                                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                    }
                                    activity.startActivity(chooser)
                                    settle(s, "started", "share")
                                }
                            } catch (_: Exception) {
                                deleteAsync(directory)
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
    fun repair(context: Context) {
        val activeId = synchronized(this) { session?.args?.attemptId }
        val shareRoot = File(context.cacheDir, FileSaveShareCache.DIRECTORY_NAME)
        FileSaveShareCache.sweep(
            root = shareRoot,
            keepName = activeId,
            deleteAllPrior = activeId == null,
        )
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
