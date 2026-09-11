package ai.alook.plugin.mobileshareimage

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MobileShareImageDocumentStateTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val ownerOne = "owner-one"
    private val ownerTwo = "owner-two"
    private val tokenOne = "0123456789abcdef0123456789abcdef"
    private val tokenTwo = "fedcba9876543210fedcba9876543210"

    @Test
    fun launchFailureAndCancellationSettleOnceAndPermitImmediateRetry() {
        val deleted = mutableListOf<File>()
        val launches = mutableListOf<String>()
        val core = core(deleted = deleted)
        core.attach(ownerOne, null) { _, _ -> throw IllegalStateException("launch failed") }

        val failedLaunch = probe(tokenOne, throwOnReject = true)
        core.begin(failedLaunch.request)

        assertEquals(listOf(failedLaunch.staging), deleted)
        assertEquals(listOf("unavailable"), failedLaunch.terminal.rejectionCodes)
        assertEquals(1, failedLaunch.terminal.rejectAttempts)
        assertEquals(1, failedLaunch.releases)
        assertNull(core.liveToken())

        core.attach(ownerTwo, null) { token, filename -> launches += "$token:$filename" }
        val cancelled = probe(tokenTwo)
        core.begin(cancelled.request)
        assertEquals(tokenTwo, core.liveToken())
        core.deliver(ownerTwo, tokenTwo, null) { error("cancel must not clean an orphan") }

        assertEquals(listOf("$tokenTwo:share.png"), launches)
        assertEquals(listOf("cancelled"), cancelled.terminal.rejectionCodes)
        assertEquals(1, cancelled.terminal.rejectAttempts)
        assertEquals(1, cancelled.releases)
        assertNull(core.liveToken())

        val retry = probe(tokenOne)
        core.begin(retry.request)
        core.deliver(ownerTwo, tokenOne, null) { error("retry must not clean an orphan") }
        assertEquals(1, retry.terminal.rejectAttempts)
        assertEquals(1, retry.releases)
    }

    @Test
    fun selectedDocumentRunsOpenWriteFlushCloseAndIgnoresDuplicateWhileWriting() {
        val tasks = mutableListOf<() -> Unit>()
        val deleted = mutableListOf<File>()
        val events = mutableListOf<String>()
        val orphanTokens = mutableListOf<String>()
        val core = core(execute = { tasks += it }, deleted = deleted)
        core.attach(ownerOne, null) { token, _ -> events += "launch:$token" }
        val probe = probe(tokenOne, events = events)
        val destination = RecordingDestination(events = events)

        core.begin(probe.request)
        core.deliver(ownerOne, tokenOne, destination, orphanTokens::add)
        core.deliver(ownerOne, tokenOne, destination, orphanTokens::add)
        val overlap = probe(tokenTwo)
        val busy = assertThrows(MobileShareImageFailure::class.java) {
            core.begin(overlap.request)
        }

        assertEquals(1, tasks.size)
        assertEquals("busy", busy.code)
        assertEquals(tokenOne, core.liveToken())
        assertEquals(0, overlap.terminal.resolveAttempts)
        assertEquals(0, overlap.terminal.rejectAttempts)
        assertEquals(0, overlap.releases)
        assertEquals(0, destination.opens)
        assertTrue(orphanTokens.isEmpty())
        tasks.single().invoke()

        assertEquals(
            listOf("launch:$tokenOne", "open", "write", "flush", "close", "resolve", "release"),
            events,
        )
        assertEquals(1, destination.opens)
        assertEquals(0, destination.returnedUriDeletes)
        assertEquals(listOf(probe.staging), deleted)
        assertEquals(1, probe.terminal.resolveAttempts)
        assertEquals(0, probe.terminal.rejectAttempts)
        assertEquals(1, probe.releases)

        core.deliver(ownerOne, tokenOne, destination, orphanTokens::add)
        assertEquals(listOf(tokenOne), orphanTokens)
        assertEquals(1, destination.opens)
        assertEquals(1, probe.terminal.resolveAttempts)
        assertEquals(1, probe.releases)
    }

    @Test
    fun openWriteFlushAndCloseFailuresRejectOnceWithoutDeletingTheSafUri() {
        for (failurePoint in listOf("open", "write", "flush", "close")) {
            val deleted = mutableListOf<File>()
            val core = core(deleted = deleted)
            core.attach(ownerOne, null) { _, _ -> }
            val failed = probe(tokenOne)
            val destination = RecordingDestination(failurePoint = failurePoint)

            core.begin(failed.request)
            core.deliver(ownerOne, tokenOne, destination) { error("active failure is not orphaned") }

            assertEquals("failure at $failurePoint", listOf("write_failed"), failed.terminal.rejectionCodes)
            assertEquals("failure at $failurePoint", 1, failed.terminal.rejectAttempts)
            assertEquals("failure at $failurePoint", 0, failed.terminal.resolveAttempts)
            assertEquals("failure at $failurePoint", 1, failed.releases)
            assertEquals("failure at $failurePoint", 0, destination.returnedUriDeletes)
            assertEquals("failure at $failurePoint", listOf(failed.staging), deleted)
            assertNull(core.liveToken())

            val retry = probe(tokenTwo)
            core.begin(retry.request)
            core.deliver(ownerOne, tokenTwo, null) { error("retry cancel is not orphaned") }
            assertEquals("retry after $failurePoint", 1, retry.terminal.rejectAttempts)
            assertEquals("retry after $failurePoint", 1, retry.releases)
        }
    }

    @Test
    fun detachAndReattachFenceStaleOwnersAndPreserveThePendingRequest() {
        val events = mutableListOf<String>()
        val orphanTokens = mutableListOf<String>()
        val core = core()
        core.attach(ownerOne, null) { _, _ -> }
        val probe = probe(tokenOne, events = events)
        val destination = RecordingDestination(events = events)
        core.begin(probe.request)

        core.detach(ownerOne)
        core.deliver(ownerOne, tokenOne, destination, orphanTokens::add)
        assertEquals(tokenOne, core.liveToken())
        assertEquals(0, destination.opens)

        core.attach(ownerTwo, tokenOne) { _, _ -> }
        assertEquals(tokenOne, core.tokenForOwner(ownerTwo))
        core.deliver(ownerOne, tokenOne, destination, orphanTokens::add)
        assertEquals(0, destination.opens)
        core.deliver(ownerTwo, tokenOne, destination, orphanTokens::add)

        assertEquals(1, destination.opens)
        assertEquals(1, probe.terminal.resolveAttempts)
        assertEquals(1, probe.releases)
        assertTrue(orphanTokens.isEmpty())
    }

    @Test
    fun mismatchedAndRestoredOrphanCallbacksCannotSettleTheActiveRequest() {
        val orphanTokens = mutableListOf<String>()
        val core = core()
        core.attach(ownerOne, null) { _, _ -> }
        val active = probe(tokenOne)
        core.begin(active.request)

        core.deliver(ownerOne, tokenTwo, RecordingDestination(), orphanTokens::add)
        assertEquals(listOf(tokenTwo), orphanTokens)
        assertEquals(0, active.terminal.resolveAttempts)
        assertEquals(0, active.terminal.rejectAttempts)
        assertEquals(0, active.releases)
        assertEquals(tokenOne, core.liveToken())

        core.deliver(ownerOne, tokenOne, null, orphanTokens::add)
        assertEquals(1, active.terminal.rejectAttempts)
        assertEquals(1, active.releases)
    }

    @Test
    fun activityResultAdapterKeepsLateCallbackBoundToItsOwnLaunchToken() {
        data class Result(val destination: MobileShareImageDocumentDestination?)

        val callbacks = mutableMapOf<String, (Result) -> Unit>()
        val launches = mutableListOf<String>()
        val unregistered = mutableListOf<String>()
        val orphanTokens = mutableListOf<String>()
        val core = core()
        val adapter = MobileShareImageDocumentResultAdapter<String, Result>(
            register = { key, callback ->
                val token = key.substringAfterLast('.')
                callbacks[token] = callback
                object : MobileShareImageDocumentResultRegistration<String> {
                    override fun launch(input: String) {
                        launches += input
                    }

                    override fun unregister() {
                        unregistered += token
                    }
                }
            },
            createInput = { token, filename -> "$token:$filename" },
            deliver = { token, result ->
                core.deliver(ownerOne, token, result.destination, orphanTokens::add)
            },
        )
        core.attach(ownerOne, null, adapter::launch)

        val first = probe(tokenOne)
        core.begin(first.request)
        val lateFirstCallback = callbacks.getValue(tokenOne)
        lateFirstCallback(Result(null))
        assertEquals(1, first.terminal.rejectAttempts)
        assertEquals(1, first.releases)

        val second = probe(tokenTwo)
        val secondDestination = RecordingDestination()
        core.begin(second.request)
        val secondCallback = callbacks.getValue(tokenTwo)
        val lateDestination = RecordingDestination()

        lateFirstCallback(Result(lateDestination))
        assertEquals(tokenTwo, core.liveToken())
        assertEquals(0, lateDestination.opens)
        assertEquals(0, second.terminal.resolveAttempts)
        assertEquals(0, second.terminal.rejectAttempts)
        assertEquals(0, second.releases)
        assertEquals(listOf(tokenOne), orphanTokens)

        secondCallback(Result(secondDestination))
        secondCallback(Result(secondDestination))
        assertEquals(1, secondDestination.opens)
        assertEquals(1, second.terminal.resolveAttempts)
        assertEquals(0, second.terminal.rejectAttempts)
        assertEquals(1, second.releases)
        assertNull(core.liveToken())
        assertEquals(listOf(tokenOne, tokenTwo), orphanTokens)
        assertEquals(
            listOf("$tokenOne:share.png", "$tokenTwo:share.png"),
            launches,
        )
        assertEquals(listOf(tokenOne, tokenTwo), unregistered)
    }

    @Test
    fun responseFailureDoesNotCreateASecondTerminalAndStillReleasesTheLease() {
        val failures = mutableListOf<String>()
        val core = core(reportFailure = { failures += it.message.orEmpty() })
        core.attach(ownerOne, null) { _, _ -> }
        val probe = probe(tokenOne, throwOnResolve = true)

        core.begin(probe.request)
        core.deliver(ownerOne, tokenOne, RecordingDestination()) {
            error("successful write is not orphaned")
        }

        assertEquals(1, probe.terminal.resolveAttempts)
        assertEquals(0, probe.terminal.rejectAttempts)
        assertEquals(1, probe.releases)
        assertEquals(listOf("resolve failed"), failures)
        assertNull(core.liveToken())

        val retry = probe(tokenTwo)
        core.begin(retry.request)
        core.deliver(ownerOne, tokenTwo, null) { error("retry cancel is not orphaned") }
        assertEquals(1, retry.terminal.rejectAttempts)
        assertEquals(1, retry.releases)
    }

    @Test
    fun processDeathCleanupDeletesOnlyOrphansUntilNoLiveCoordinatorExists() {
        val directory = temporaryFolder.newFolder("document")
        val active = File(directory, "$tokenOne.png").apply { writeText("active") }
        val orphan = File(directory, "$tokenTwo.png").apply { writeText("orphan") }
        val temporary = File(directory, "$tokenTwo.tmp").apply { writeText("partial") }
        val activeTemporary = File(directory, "$tokenOne.tmp").apply { writeText("partial") }
        val liveCore = core()
        liveCore.attach(ownerOne, null) { _, _ -> }
        val live = probe(tokenOne, staging = active)
        liveCore.begin(live.request)

        cleanupMobileShareImageDocumentOrphans(directory, liveCore.liveToken())
        assertTrue(active.exists())
        assertFalse(orphan.exists())
        assertFalse(temporary.exists())
        assertFalse(activeTemporary.exists())

        val afterProcessDeath = core()
        val restoredDestination = RecordingDestination()
        val restoredCallbackCleanups = mutableListOf<String>()
        afterProcessDeath.attach(ownerTwo, tokenOne) { _, _ -> }
        afterProcessDeath.deliver(
            ownerTwo,
            tokenOne,
            restoredDestination,
            restoredCallbackCleanups::add,
        )
        assertEquals(listOf(tokenOne), restoredCallbackCleanups)
        assertEquals(0, restoredDestination.opens)

        cleanupMobileShareImageDocumentOrphans(directory, afterProcessDeath.liveToken())
        assertFalse(active.exists())
    }

    @Test
    fun executorRejectionTerminatesTheWriteAndAllowsRetry() {
        val core = core(execute = { throw IllegalStateException("executor stopped") })
        core.attach(ownerOne, null) { _, _ -> }
        val failed = probe(tokenOne)

        core.begin(failed.request)
        core.deliver(ownerOne, tokenOne, RecordingDestination()) {
            error("executor rejection is not orphaned")
        }

        assertEquals(listOf("write_failed"), failed.terminal.rejectionCodes)
        assertEquals(1, failed.terminal.rejectAttempts)
        assertEquals(1, failed.releases)
        assertNull(core.liveToken())
    }

    private fun core(
        execute: ((() -> Unit) -> Unit) = { it() },
        deleted: MutableList<File> = mutableListOf(),
        reportFailure: (Exception) -> Unit = {},
    ) = MobileShareImageDocumentCoordinatorCore(
        execute = execute,
        deleteStaging = { deleted += it; it.delete() },
        reportFailure = reportFailure,
    )

    private fun probe(
        token: String,
        staging: File = temporaryFolder.newFile("$token.png").apply { writeText("png") },
        events: MutableList<String> = mutableListOf(),
        throwOnResolve: Boolean = false,
        throwOnReject: Boolean = false,
    ): RequestProbe {
        val terminal = RecordingTerminal(events, throwOnResolve, throwOnReject)
        var releases = 0
        return RequestProbe(
            staging = staging,
            terminal = terminal,
            releasesValue = { releases },
            request = MobileShareImageDocumentRequest(
                attemptId = "123e4567-e89b-42d3-a456-426614174000",
                token = token,
                staging = staging,
                filename = "share.png",
                terminal = terminal,
                release = {
                    releases += 1
                    events += "release"
                },
            ),
        )
    }

    private data class RequestProbe(
        val staging: File,
        val terminal: RecordingTerminal,
        val releasesValue: () -> Int,
        val request: MobileShareImageDocumentRequest,
    ) {
        val releases: Int get() = releasesValue()
    }

    private class RecordingTerminal(
        private val events: MutableList<String>,
        private val throwOnResolve: Boolean,
        private val throwOnReject: Boolean,
    ) : MobileShareImageDocumentTerminal {
        var resolveAttempts = 0
        var rejectAttempts = 0
        val rejectionCodes = mutableListOf<String>()

        override fun resolve() {
            resolveAttempts += 1
            events += "resolve"
            if (throwOnResolve) throw IllegalStateException("resolve failed")
        }

        override fun reject(failure: MobileShareImageFailure) {
            rejectAttempts += 1
            rejectionCodes += failure.code
            events += "reject:${failure.code}"
            if (throwOnReject) throw IllegalStateException("reject failed")
        }
    }

    private class RecordingDestination(
        private val events: MutableList<String> = mutableListOf(),
        private val failurePoint: String? = null,
    ) : MobileShareImageDocumentDestination {
        var opens = 0
        var returnedUriDeletes = 0

        override fun open(): MobileShareImageDocumentOutput {
            opens += 1
            events += "open"
            failAt("open")
            return object : MobileShareImageDocumentOutput {
                override fun writeFrom(staging: File) {
                    events += "write"
                    assertTrue(staging.exists())
                    failAt("write")
                }

                override fun flush() {
                    events += "flush"
                    failAt("flush")
                }

                override fun close() {
                    events += "close"
                    failAt("close")
                }
            }
        }

        private fun failAt(point: String) {
            if (failurePoint == point) throw IllegalStateException("$point failed")
        }
    }
}
