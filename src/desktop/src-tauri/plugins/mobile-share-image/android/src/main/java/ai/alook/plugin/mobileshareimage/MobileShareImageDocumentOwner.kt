package ai.alook.plugin.mobileshareimage

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import app.tauri.plugin.Invoke
import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors

class MobileShareImageDocumentOwner(private val activity: ComponentActivity) {
    private val generation = UUID.randomUUID().toString()
    private var restoredToken: String? = null
    private val resultAdapter = MobileShareImageDocumentResultAdapter<Intent, ActivityResult>(
        register = { key, callback ->
            val launcher = activity.activityResultRegistry.register(
                key,
                ActivityResultContracts.StartActivityForResult(),
                callback,
            )
            object : MobileShareImageDocumentResultRegistration<Intent> {
                override fun launch(input: Intent) {
                    launcher.launch(input)
                }

                override fun unregister() {
                    launcher.unregister()
                }
            }
        },
        createInput = { _, filename ->
            Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/png"
                putExtra(Intent.EXTRA_TITLE, filename)
            }
        },
        deliver = { token, result ->
            MobileShareImageCoordinator.deliver(generation, token, result, activity)
            if (restoredToken == token) restoredToken = null
        },
    )

    fun attach(savedInstanceState: Bundle?) {
        restoredToken = savedInstanceState?.getString(STATE_TOKEN)
        MobileShareImageCoordinator.attach(this, generation, restoredToken)
        resultAdapter.restore(restoredToken)
    }

    fun saveState(outState: Bundle) {
        val token = MobileShareImageCoordinator.tokenForOwner(generation) ?: restoredToken
        if (token != null) outState.putString(STATE_TOKEN, token)
    }

    fun detach() {
        MobileShareImageCoordinator.detach(generation)
        resultAdapter.detach()
    }

    internal fun launch(token: String, filename: String) {
        restoredToken = token
        try {
            resultAdapter.launch(token, filename)
        } catch (error: Exception) {
            if (restoredToken == token) restoredToken = null
            throw error
        }
    }

    companion object {
        private const val STATE_TOKEN = "alook.mobileShareImage.documentToken"
    }
}

internal object MobileShareImageCoordinator {
    private val executor = Executors.newSingleThreadExecutor()
    private val core = MobileShareImageDocumentCoordinatorCore(
        execute = { task -> executor.execute { task() } },
        reportFailure = {
            android.util.Log.w(
                "AlookMobileShareImage",
                "document coordinator post-terminal failure",
            )
        },
    )

    fun attach(nextOwner: MobileShareImageDocumentOwner, generation: String, restoredToken: String?) {
        core.attach(generation, restoredToken) { token, filename ->
            nextOwner.launch(token, filename)
        }
    }

    fun detach(generation: String) {
        core.detach(generation)
    }

    fun liveToken(): String? = core.liveToken()

    fun tokenForOwner(generation: String): String? = core.tokenForOwner(generation)

    fun begin(
        attemptId: String,
        token: String,
        staging: File,
        filename: String,
        invoke: Invoke,
        nativeLease: MobileShareImageNativeLease,
    ) {
        core.begin(
            MobileShareImageDocumentRequest(
                attemptId = attemptId,
                token = token,
                staging = staging,
                filename = filename,
                terminal = object : MobileShareImageDocumentTerminal {
                    override fun resolve() {
                        MobileShareImage.logNativeSettle(attemptId)
                        MobileShareImage.resolveSaved(invoke, attemptId, "document")
                    }

                    override fun reject(failure: MobileShareImageFailure) {
                        MobileShareImage.reject(invoke, failure)
                    }
                },
                release = nativeLease::close,
            ),
        )
    }

    fun deliver(generation: String, token: String?, result: ActivityResult, activity: Activity) {
        val uri = result.data?.data
            ?.takeIf { result.resultCode == Activity.RESULT_OK }
        core.deliver(
            generation = generation,
            token = token,
            destination = uri?.let { AndroidDocumentDestination(activity, it) },
            cleanupOrphan = { orphanToken ->
                File(
                    activity.cacheDir,
                    "mobile-share-image/document/$orphanToken.png",
                ).delete()
            },
        )
    }

    private class AndroidDocumentDestination(
        private val activity: Activity,
        private val uri: Uri,
    ) : MobileShareImageDocumentDestination {
        override fun open(): MobileShareImageDocumentOutput {
            val output = activity.contentResolver.openOutputStream(uri, "w")
                ?: throw MobileShareImageFailure(
                    "write_failed",
                    "Could not open selected document",
                )
            return AndroidDocumentOutput(output)
        }
    }

    private class AndroidDocumentOutput(
        private val output: OutputStream,
    ) : MobileShareImageDocumentOutput {
        override fun writeFrom(staging: File) {
            FileInputStream(staging).use { input -> input.copyTo(output) }
        }

        override fun flush() {
            output.flush()
        }

        override fun close() {
            output.close()
        }
    }
}
