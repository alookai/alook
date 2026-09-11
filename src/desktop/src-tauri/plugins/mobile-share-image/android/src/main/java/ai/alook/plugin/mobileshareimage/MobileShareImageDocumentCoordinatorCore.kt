package ai.alook.plugin.mobileshareimage

import java.io.File

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

internal fun interface MobileShareImageDocumentLauncher {
    fun launch(token: String, filename: String)
}

internal interface MobileShareImageDocumentOutput {
    fun writeFrom(staging: File)
    fun flush()
    fun close()
}

internal fun interface MobileShareImageDocumentDestination {
    fun open(): MobileShareImageDocumentOutput
}

internal interface MobileShareImageDocumentTerminal {
    fun resolve()
    fun reject(failure: MobileShareImageFailure)
}

internal data class MobileShareImageDocumentRequest(
    val attemptId: String,
    val token: String,
    val staging: File,
    val filename: String,
    val terminal: MobileShareImageDocumentTerminal,
    val release: () -> Unit,
)

internal class MobileShareImageDocumentCoordinatorCore(
    private val execute: ((() -> Unit) -> Unit),
    private val deleteStaging: (File) -> Unit = { it.delete() },
    private val reportFailure: (Exception) -> Unit = {},
) {
    private data class Owner(
        val generation: String,
        val launcher: MobileShareImageDocumentLauncher,
    )

    private data class PendingDocument(
        val request: MobileShareImageDocumentRequest,
        var phase: MobileShareImageDocumentPhase,
        var ownerGeneration: String,
    )

    private val lock = Any()
    private var owner: Owner? = null
    private var pending: PendingDocument? = null

    fun attach(
        generation: String,
        restoredToken: String?,
        launcher: MobileShareImageDocumentLauncher,
    ) {
        synchronized(lock) {
            owner = Owner(generation, launcher)
            val active = pending
            if (
                active != null &&
                restoredToken == active.request.token &&
                active.phase != MobileShareImageDocumentPhase.TERMINAL
            ) {
                active.ownerGeneration = generation
            }
        }
    }

    fun detach(generation: String) {
        synchronized(lock) {
            if (owner?.generation == generation) owner = null
        }
    }

    fun liveToken(): String? = synchronized(lock) { pending?.request?.token }

    fun tokenForOwner(generation: String): String? = synchronized(lock) {
        val active = pending ?: return@synchronized null
        if (active.ownerGeneration == generation) active.request.token else null
    }

    fun begin(request: MobileShareImageDocumentRequest) {
        val launchOwner = synchronized(lock) {
            if (pending != null) {
                throw MobileShareImageFailure("busy", "Another document save is active")
            }
            val attached = owner
                ?: throw MobileShareImageFailure("unavailable", "Document picker is unavailable")
            pending = PendingDocument(
                request = request,
                phase = MobileShareImageDocumentPhase.LAUNCHING,
                ownerGeneration = attached.generation,
            )
            attached
        }

        try {
            launchOwner.launcher.launch(request.token, request.filename)
        } catch (error: Exception) {
            val failed = synchronized(lock) {
                val active = pending
                if (
                    active?.request?.token == request.token &&
                    active.phase == MobileShareImageDocumentPhase.LAUNCHING
                ) {
                    active.phase = MobileShareImageDocumentPhase.TERMINAL
                    pending = null
                    if (owner?.generation == active.ownerGeneration) owner = null
                    active
                } else {
                    null
                }
            }
            failed?.let {
                settleFailure(
                    it,
                    MobileShareImageFailure(
                        "unavailable",
                        error.message ?: "Could not open document picker",
                    ),
                )
            }
            return
        }

        synchronized(lock) {
            val active = pending
            if (
                active?.request?.token == request.token &&
                active.phase == MobileShareImageDocumentPhase.LAUNCHING
            ) {
                active.phase = MobileShareImageDocumentPhase.WAITING
            }
        }
    }

    fun deliver(
        generation: String,
        token: String?,
        destination: MobileShareImageDocumentDestination?,
        cleanupOrphan: (String) -> Unit,
    ) {
        if (token == null) return
        val claim = synchronized(lock) {
            val current = pending
            when (
                classifyMobileShareImageDocumentDelivery(
                    currentToken = current?.request?.token,
                    currentOwnerGeneration = current?.ownerGeneration,
                    currentPhase = current?.phase,
                    attachedOwnerGeneration = owner?.generation,
                    hasOwner = owner != null,
                    callbackToken = token,
                    callbackOwnerGeneration = generation,
                    successfulSelection = destination != null,
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

        when (claim) {
            DeliveryClaim.Orphan -> {
                if (isValidNativeToken(token)) runCatching { cleanupOrphan(token) }
                    .onFailure(::report)
            }
            DeliveryClaim.Stale -> Unit
            is DeliveryClaim.Active -> {
                if (destination == null) {
                    settleFailure(
                        claim.pending,
                        MobileShareImageFailure("cancelled", "Document save was cancelled"),
                    )
                } else {
                    try {
                        execute { writeAndSettle(claim.pending, destination) }
                    } catch (error: Exception) {
                        finishWrite(claim.pending, writeFailure(error, "Could not write selected document"))
                    }
                }
            }
        }
    }

    private fun writeAndSettle(
        active: PendingDocument,
        destination: MobileShareImageDocumentDestination,
    ) {
        var output: MobileShareImageDocumentOutput? = null
        var failure: MobileShareImageFailure? = null
        try {
            output = destination.open()
        } catch (error: Exception) {
            failure = writeFailure(error, "Could not open selected document")
        }
        if (failure == null) {
            try {
                output!!.writeFrom(active.request.staging)
            } catch (error: Exception) {
                failure = writeFailure(error, "Could not write selected document")
            }
        }
        if (failure == null) {
            try {
                output!!.flush()
            } catch (error: Exception) {
                failure = writeFailure(error, "Could not flush selected document")
            }
        }
        if (output != null) {
            try {
                output.close()
            } catch (error: Exception) {
                if (failure == null) {
                    failure = writeFailure(error, "Could not close selected document")
                } else {
                    report(error)
                }
            }
        }
        finishWrite(active, failure)
    }

    private fun finishWrite(active: PendingDocument, failure: MobileShareImageFailure?) {
        val terminal = synchronized(lock) {
            val current = pending
            if (current === active && current.phase == MobileShareImageDocumentPhase.WRITING) {
                current.phase = MobileShareImageDocumentPhase.TERMINAL
                pending = null
                current
            } else {
                null
            }
        } ?: return

        delete(terminal.request.staging)
        try {
            if (failure == null) terminal.request.terminal.resolve()
            else terminal.request.terminal.reject(failure)
        } catch (error: Exception) {
            report(error)
        } finally {
            release(terminal.request)
        }
    }

    private fun settleFailure(active: PendingDocument, failure: MobileShareImageFailure) {
        delete(active.request.staging)
        try {
            active.request.terminal.reject(failure)
        } catch (error: Exception) {
            report(error)
        } finally {
            release(active.request)
        }
    }

    private fun delete(file: File) {
        try {
            deleteStaging(file)
        } catch (error: Exception) {
            report(error)
        }
    }

    private fun release(request: MobileShareImageDocumentRequest) {
        try {
            request.release()
        } catch (error: Exception) {
            report(error)
        }
    }

    private fun report(error: Throwable) {
        if (error is Exception) runCatching { reportFailure(error) }
    }

    private fun writeFailure(error: Exception, fallback: String): MobileShareImageFailure =
        if (error is MobileShareImageFailure) error
        else MobileShareImageFailure("write_failed", error.message ?: fallback)

    private sealed interface DeliveryClaim {
        data object Orphan : DeliveryClaim
        data object Stale : DeliveryClaim
        data class Active(val pending: PendingDocument) : DeliveryClaim
    }
}

internal fun cleanupMobileShareImageDocumentOrphans(directory: File, liveToken: String?) {
    directory.listFiles()?.forEach { file ->
        if (liveToken == null || file.name != "$liveToken.png") file.delete()
    }
}

private fun isValidNativeToken(token: String): Boolean =
    token.length == 32 && token.all { it in '0'..'9' || it in 'a'..'f' }
