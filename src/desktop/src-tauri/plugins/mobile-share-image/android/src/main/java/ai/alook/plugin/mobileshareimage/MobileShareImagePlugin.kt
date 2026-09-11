package ai.alook.plugin.mobileshareimage

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg
class SaveImageArgs {
    lateinit var attemptId: String
    lateinit var pngBase64: String
    lateinit var filename: String
}

@InvokeArg
class CopyImageArgs {
    lateinit var attemptId: String
    lateinit var pngBase64: String
}

@TauriPlugin
class MobileShareImagePlugin(private val activity: Activity) : Plugin(activity) {
    private val executor = Executors.newSingleThreadExecutor()
    private val context = activity.applicationContext

    init {
        MobileShareImage.cleanupDocumentOrphans(context)
        executor.execute {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MobileShareImage.repairJournal(context)
            }
        }
    }

    @Command
    fun copyImage(invoke: Invoke) {
        val args = parse(invoke, CopyImageArgs::class.java) ?: return
        val lease = acquire(invoke, args.attemptId) ?: return
        logNativeReceive(args.attemptId)
        executor.execute {
            var staged: File? = null
            try {
                val bytes = MobileShareImage.validateBase64(args.pngBase64)
                val token = UUID.randomUUID().toString().replace("-", "")
                staged = MobileShareImage.stageClipboard(context, bytes, token)
                val published = staged
                val uri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.mobile_share_image.fileprovider",
                    published,
                )
                val clip = ClipData.newUri(context.contentResolver, "Alook image", uri)
                activity.runOnUiThread {
                    commitMobileShareImageClipboard(
                        publish = {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE)
                                as? ClipboardManager
                                ?: throw MobileShareImageFailure(
                                    "unavailable",
                                    "Clipboard is unavailable",
                                )
                            clipboard.setPrimaryClip(clip)
                        },
                        cleanupAfterPublish = {
                            MobileShareImage.cleanupClipboardAfterPublish(context, published)
                        },
                        resolve = {
                            MobileShareImage.logNativeSettle(args.attemptId)
                            MobileShareImage.resolveCopied(invoke, args.attemptId)
                        },
                        reject = { failure -> MobileShareImage.reject(invoke, failure) },
                        deleteUnpublished = { published.delete() },
                        release = lease::close,
                        reportFailure = {
                            android.util.Log.w(
                                "AlookMobileShareImage",
                                "clipboard post-commit cleanup or response failed",
                            )
                        },
                    )
                }
            } catch (error: Exception) {
                staged?.delete()
                reject(invoke, lease, asFailure(error, "Could not copy image"))
            }
        }
    }

    @Command
    fun saveImage(invoke: Invoke) {
        val args = parse(invoke, SaveImageArgs::class.java) ?: return
        val lease = acquire(invoke, args.attemptId) ?: return
        logNativeReceive(args.attemptId)
        executor.execute {
            try {
                val bytes = MobileShareImage.validateBase64(args.pngBase64)
                val filename = MobileShareImage.sanitizeFilename(args.filename)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val destination = MobileShareImage.save(context, bytes, args.attemptId)
                    try {
                        MobileShareImage.resolveSaved(invoke, args.attemptId, destination)
                    } finally {
                        lease.close()
                    }
                } else {
                    val token = UUID.randomUUID().toString().replace("-", "")
                    val staging = MobileShareImage.stageDocument(context, bytes, token)
                    activity.runOnUiThread {
                        try {
                            MobileShareImageCoordinator.begin(
                                args.attemptId,
                                token,
                                staging,
                                filename,
                                invoke,
                                lease,
                            )
                        } catch (error: Exception) {
                            staging.delete()
                            reject(invoke, lease, asFailure(error, "Could not open document picker"))
                        }
                    }
                }
            } catch (error: Exception) {
                reject(invoke, lease, asFailure(error, "Could not save image"))
            }
        }
    }

    private fun <T> parse(invoke: Invoke, type: Class<T>): T? = try {
        invoke.parseArgs(type)
    } catch (_: Exception) {
        MobileShareImage.reject(invoke, MobileShareImageFailure("invalid_png", "Image request is invalid"))
        null
    }

    private fun acquire(invoke: Invoke, attemptId: String): MobileShareImageNativeLease? = try {
        MobileShareImage.validateAttemptId(attemptId)
        MobileShareImageNativeFlight.acquire()
    } catch (failure: MobileShareImageFailure) {
        MobileShareImage.reject(invoke, failure)
        null
    }

    private fun reject(invoke: Invoke, lease: MobileShareImageNativeLease, failure: MobileShareImageFailure) {
        try {
            MobileShareImage.reject(invoke, failure)
        } finally {
            lease.close()
        }
    }

    private fun asFailure(error: Exception, fallback: String): MobileShareImageFailure =
        if (error is MobileShareImageFailure) error
        else MobileShareImageFailure("write_failed", error.message ?: fallback)

    private fun logNativeReceive(attemptId: String) {
        android.util.Log.d(
            "AlookMobileShareImage",
            "native-receive attempt=$attemptId t=${android.os.SystemClock.elapsedRealtimeNanos()}",
        )
    }
}
