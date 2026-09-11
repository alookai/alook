package ai.alook.plugin.mobileshareimage

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import app.tauri.plugin.Invoke
import java.io.File
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.Executors

internal enum class MobileShareImageDocumentPhase {
    LAUNCHING,
    WAITING,
    WRITING,
    TERMINAL,
}

internal enum class MobileShareImageDocumentDelivery {
    ORPHAN,
    STALE,
    CANCEL,
    WRITE,
}

internal fun classifyMobileShareImageDocumentDelivery(
    currentToken: String?,
    currentOwnerGeneration: String?,
    currentPhase: MobileShareImageDocumentPhase?,
    attachedOwnerGeneration: String?,
    hasOwner: Boolean,
    callbackToken: String,
    callbackOwnerGeneration: String,
    successfulSelection: Boolean,
): MobileShareImageDocumentDelivery {
    if (currentToken == null || currentToken != callbackToken) {
        return MobileShareImageDocumentDelivery.ORPHAN
    }
    if (
        currentOwnerGeneration != callbackOwnerGeneration ||
        attachedOwnerGeneration != callbackOwnerGeneration ||
        !hasOwner ||
        currentPhase != MobileShareImageDocumentPhase.WAITING
    ) {
        return MobileShareImageDocumentDelivery.STALE
    }
    return if (successfulSelection) {
        MobileShareImageDocumentDelivery.WRITE
    } else {
        MobileShareImageDocumentDelivery.CANCEL
    }
}

class MobileShareImageDocumentOwner(private val activity: ComponentActivity) {
    private val generation = UUID.randomUUID().toString()
    private var restoredToken: String? = null
    private val launcher = activity.registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val token = MobileShareImageCoordinator.tokenForOwner(generation) ?: restoredToken
        MobileShareImageCoordinator.deliver(generation, token, result, activity)
        restoredToken = null
    }

    fun attach(savedInstanceState: Bundle?) {
        restoredToken = savedInstanceState?.getString(STATE_TOKEN)
        MobileShareImageCoordinator.attach(this, generation, restoredToken)
    }

    fun saveState(outState: Bundle) {
        val token = MobileShareImageCoordinator.tokenForOwner(generation) ?: restoredToken
        if (token != null) outState.putString(STATE_TOKEN, token)
    }

    fun detach() {
        MobileShareImageCoordinator.detach(generation)
    }

    internal fun launch(token: String, filename: String) {
        restoredToken = token
        launcher.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/png"
            putExtra(Intent.EXTRA_TITLE, filename)
        })
    }

    companion object {
        private const val STATE_TOKEN = "alook.mobileShareImage.documentToken"
    }
}

internal object MobileShareImageCoordinator {
    private data class PendingDocument(
        val attemptId: String,
        val token: String,
        val staging: File,
        val invoke: Invoke,
        val nativeLease: MobileShareImageNativeLease,
        var phase: MobileShareImageDocumentPhase,
        var ownerGeneration: String,
    )

    private val executor = Executors.newSingleThreadExecutor()
    private var owner: MobileShareImageDocumentOwner? = null
    private var ownerGeneration: String? = null
    private var pending: PendingDocument? = null

    @Synchronized
    fun attach(nextOwner: MobileShareImageDocumentOwner, generation: String, restoredToken: String?) {
        owner = nextOwner
        ownerGeneration = generation
        val active = pending
        if (
            active != null &&
            restoredToken == active.token &&
            active.phase in setOf(
                MobileShareImageDocumentPhase.LAUNCHING,
                MobileShareImageDocumentPhase.WAITING,
            )
        ) {
            active.ownerGeneration = generation
        }
    }

    @Synchronized
    fun detach(generation: String) {
        if (ownerGeneration == generation) {
            owner = null
            ownerGeneration = null
        }
    }

    @Synchronized
    fun liveToken(): String? = pending?.token

    @Synchronized
    fun tokenForOwner(generation: String): String? {
        val active = pending ?: return null
        return if (active.ownerGeneration == generation) active.token else null
    }

    fun begin(
        attemptId: String,
        token: String,
        staging: File,
        filename: String,
        invoke: Invoke,
        nativeLease: MobileShareImageNativeLease,
    ) {
        val launchOwner: MobileShareImageDocumentOwner
        synchronized(this) {
            if (pending != null) throw MobileShareImageFailure("busy", "Another document save is active")
            launchOwner = owner ?: throw MobileShareImageFailure("unavailable", "Document picker is unavailable")
            val generation = ownerGeneration ?: throw MobileShareImageFailure("unavailable", "Document picker is unavailable")
            pending = PendingDocument(
                attemptId,
                token,
                staging,
                invoke,
                nativeLease,
                MobileShareImageDocumentPhase.LAUNCHING,
                generation,
            )
        }
        try {
            launchOwner.launch(token, filename)
            synchronized(this) {
                val active = pending
                if (
                    active?.token == token &&
                    active.phase == MobileShareImageDocumentPhase.LAUNCHING
                ) {
                    active.phase = MobileShareImageDocumentPhase.WAITING
                }
            }
        } catch (error: Exception) {
            val failed = synchronized(this) {
                val active = pending
                if (
                    active?.token == token &&
                    active.phase == MobileShareImageDocumentPhase.LAUNCHING
                ) {
                    active.phase = MobileShareImageDocumentPhase.TERMINAL
                    pending = null
                    active
                } else null
            }
            failed?.staging?.delete()
            failed?.let {
                try {
                    MobileShareImage.reject(it.invoke, MobileShareImageFailure("unavailable", error.message ?: "Could not open document picker"))
                } finally {
                    it.nativeLease.close()
                }
            }
        }
    }

    fun deliver(generation: String, token: String?, result: ActivityResult, activity: Activity) {
        if (token == null) return
        val claim = synchronized(this) {
            val current = pending
            when (
                classifyMobileShareImageDocumentDelivery(
                    currentToken = current?.token,
                    currentOwnerGeneration = current?.ownerGeneration,
                    currentPhase = current?.phase,
                    attachedOwnerGeneration = ownerGeneration,
                    hasOwner = owner != null,
                    callbackToken = token,
                    callbackOwnerGeneration = generation,
                    successfulSelection = result.resultCode == Activity.RESULT_OK && result.data?.data != null,
                )
            ) {
                MobileShareImageDocumentDelivery.ORPHAN -> DeliveryClaim.Orphan
                MobileShareImageDocumentDelivery.STALE -> DeliveryClaim.Stale
                MobileShareImageDocumentDelivery.CANCEL -> {
                    current!!.phase = MobileShareImageDocumentPhase.TERMINAL
                    pending = null
                    DeliveryClaim.Active(current)
                }
                MobileShareImageDocumentDelivery.WRITE -> {
                    current!!.phase = MobileShareImageDocumentPhase.WRITING
                    DeliveryClaim.Active(current)
                }
            }
        }
        val active = when (claim) {
            DeliveryClaim.Orphan -> {
                if (token.matches(Regex("[0-9a-f]{32}"))) {
                    File(activity.cacheDir, "mobile-share-image/document/$token.png").delete()
                }
                return
            }
            DeliveryClaim.Stale -> return
            is DeliveryClaim.Active -> claim.pending
        }
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            active.staging.delete()
            try {
                MobileShareImage.reject(active.invoke, MobileShareImageFailure("cancelled", "Document save was cancelled"))
            } finally {
                active.nativeLease.close()
            }
            return
        }
        executor.execute {
            val failure = try {
                activity.contentResolver.openOutputStream(uri, "w")?.use { output ->
                    FileInputStream(active.staging).use { input -> input.copyTo(output) }
                    output.flush()
                } ?: throw MobileShareImageFailure("write_failed", "Could not open selected document")
                null
            } catch (error: Exception) {
                if (error is MobileShareImageFailure) error
                else MobileShareImageFailure("write_failed", error.message ?: "Could not write selected document")
            }
            val terminal = synchronized(this) {
                val current = pending
                if (
                    current?.token == active.token &&
                    current.phase == MobileShareImageDocumentPhase.WRITING
                ) {
                    current.phase = MobileShareImageDocumentPhase.TERMINAL
                    pending = null
                    current
                } else null
            } ?: return@execute
            terminal.staging.delete()
            try {
                if (failure == null) {
                    MobileShareImage.logNativeSettle(terminal.attemptId)
                    MobileShareImage.resolveSaved(terminal.invoke, terminal.attemptId, "document")
                } else {
                    MobileShareImage.reject(terminal.invoke, failure)
                }
            } finally {
                terminal.nativeLease.close()
            }
        }
    }

    private sealed interface DeliveryClaim {
        data object Orphan : DeliveryClaim
        data object Stale : DeliveryClaim
        data class Active(val pending: PendingDocument) : DeliveryClaim
    }
}
