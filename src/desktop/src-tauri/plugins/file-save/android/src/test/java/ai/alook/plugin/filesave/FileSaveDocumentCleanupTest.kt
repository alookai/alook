package ai.alook.plugin.filesave

import java.io.File
import java.util.Properties
import org.junit.Assert.*
import org.junit.Test

class FileSaveDocumentCleanupTest {
    private class Store(val file: File) : DocumentCleanupStore {
        var failRemove = false
        var failPut = false
        override fun entries(): Map<String, DocumentCleanupRecord> {
            val props = Properties()
            if (file.exists()) file.inputStream().use { props.load(it) }
            return props.stringPropertyNames().associateWith {
                val value = props.getProperty(it)
                DocumentCleanupRecord(value.substring(1), value.startsWith("1"))
            }
        }
        private fun write(records: Map<String, DocumentCleanupRecord>) {
            val props = Properties()
            records.forEach { (key, value) -> props[key] = (if (value.releaseOnly) "1" else "0") + value.uri }
            file.outputStream().use { props.store(it, null) }
        }
        override fun put(token: String, record: DocumentCleanupRecord) {
            check(!failPut)
            write(entries() + (token to record))
        }
        override fun remove(token: String) {
            check(!failRemove)
            write(entries() - token)
        }
    }
    private class Provider : DocumentCleanupProvider {
        val documents = mutableSetOf("uri:A", "uri:B")
        val grants = mutableSetOf<String>()
        val failures = mutableSetOf<String>()
        var throwDelete = false
        var failRetain = false
        override fun retain(uri: String) { check(!failRetain); grants.add(uri) }
        override fun delete(uri: String): Boolean {
            if (uri in failures) { if (throwDelete) error("provider failed"); return false }
            documents.remove(uri)
            return true
        }
        override fun release(uri: String) { grants.remove(uri) }
    }
    private fun fixture(test: (Store, Provider) -> Unit) {
        val dir = kotlin.io.path.createTempDirectory("file-save-cleanup").toFile()
        try { test(Store(File(dir, "journal")), Provider()) } finally { dir.deleteRecursively() }
    }
    @Test fun failedLateCleanupSurvivesRestartWithoutAffectingNextSave() = fixture { store, provider ->
        provider.failures.add("uri:A")
        assertFalse(FileSaveDocumentCleanup(store, provider).discard("A", "uri:A"))
        assertTrue("uri:A" in provider.grants)
        val next = FileSaveDocumentCleanup(Store(store.file), provider)
        next.acquire("B", "uri:B")
        assertTrue(next.published("B", "uri:B"))
        assertFalse(next.repair())
        assertEquals(setOf("A"), store.entries().keys)
        provider.failures.clear()
        assertTrue(FileSaveDocumentCleanup(Store(store.file), provider).repair())
        assertEquals(setOf("uri:B"), provider.documents)
        assertTrue(provider.grants.isEmpty())
        assertTrue(store.entries().isEmpty())
    }
    @Test fun throwingProviderKeepsRecoveryRecord() = fixture { store, provider ->
        provider.throwDelete = true
        provider.failures.add("uri:A")
        assertFalse(FileSaveDocumentCleanup(store, provider).discard("A", "uri:A"))
        assertEquals(DocumentCleanupRecord("uri:A"), Store(store.file).entries()["A"])
        provider.failures.clear()
        assertTrue(FileSaveDocumentCleanup(Store(store.file), provider).repair())
    }
    @Test fun failedJournalRemovalRetriesReleaseWithoutDeletingPublishedFile() = fixture { store, provider ->
        val cleanup = FileSaveDocumentCleanup(store, provider)
        cleanup.acquire("A", "uri:A")
        store.failRemove = true
        assertFalse(cleanup.published("A", "uri:A"))
        assertTrue(store.entries()["A"]!!.releaseOnly)
        assertTrue(FileSaveDocumentCleanup(Store(store.file), provider).repair())
        assertTrue("uri:A" in provider.documents)
    }
    @Test fun alreadyDeletedDocumentCanFinishAfterJournalRemovalFailure() = fixture { store, provider ->
        store.failRemove = true
        assertFalse(FileSaveDocumentCleanup(store, provider).discard("A", "uri:A"))
        assertFalse("uri:A" in provider.documents)
        assertTrue(FileSaveDocumentCleanup(Store(store.file), provider).repair())
        assertTrue(store.entries().isEmpty())
    }
    @Test fun persistenceFailureIsReportedEvenIfImmediateDeletionSucceeds() = fixture { store, provider ->
        store.failPut = true
        assertFalse(FileSaveDocumentCleanup(store, provider).discard("A", "uri:A"))
        assertFalse("uri:A" in provider.documents)
    }
    @Test fun permissionFailureKeepsFailedDeletionVisibleForRecovery() = fixture { store, provider ->
        provider.failRetain = true
        provider.failures.add("uri:A")
        assertFalse(FileSaveDocumentCleanup(store, provider).discard("A", "uri:A"))
        assertEquals(DocumentCleanupRecord("uri:A"), Store(store.file).entries()["A"])
        provider.failRetain = false
        provider.failures.clear()
        assertTrue(FileSaveDocumentCleanup(Store(store.file), provider).repair())
    }
}
