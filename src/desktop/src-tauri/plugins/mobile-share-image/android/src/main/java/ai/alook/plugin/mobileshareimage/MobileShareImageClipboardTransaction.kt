package ai.alook.plugin.mobileshareimage

internal fun commitMobileShareImageClipboard(
    publish: () -> Unit,
    cleanupAfterPublish: () -> Unit,
    resolve: () -> Unit,
    reject: (MobileShareImageFailure) -> Unit,
    deleteUnpublished: () -> Unit,
    release: () -> Unit,
    reportFailure: (Exception) -> Unit = {},
) {
    try {
        publish()
    } catch (error: Exception) {
        runCatching(deleteUnpublished).onFailure { failure ->
            reportClipboardFailure(failure, reportFailure)
        }
        try {
            reject(
                if (error is MobileShareImageFailure) error
                else MobileShareImageFailure(
                    "write_failed",
                    error.message ?: "Could not copy image",
                ),
            )
        } catch (failure: Exception) {
            reportClipboardFailure(failure, reportFailure)
        } finally {
            releaseClipboardLease(release, reportFailure)
        }
        return
    }

    runCatching(cleanupAfterPublish).onFailure { failure ->
        reportClipboardFailure(failure, reportFailure)
    }
    try {
        resolve()
    } catch (failure: Exception) {
        reportClipboardFailure(failure, reportFailure)
    } finally {
        releaseClipboardLease(release, reportFailure)
    }
}

private fun releaseClipboardLease(
    release: () -> Unit,
    reportFailure: (Exception) -> Unit,
) {
    try {
        release()
    } catch (failure: Exception) {
        reportClipboardFailure(failure, reportFailure)
    }
}

private fun reportClipboardFailure(
    failure: Throwable,
    reportFailure: (Exception) -> Unit,
) {
    if (failure is Exception) runCatching { reportFailure(failure) }
}
