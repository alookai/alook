package ai.alook.plugin.filesave

internal data class DocumentCleanupRecord(val uri: String, val releaseOnly: Boolean = false)
internal interface DocumentCleanupStore {
    fun entries(): Map<String, DocumentCleanupRecord>
    fun put(token: String, record: DocumentCleanupRecord)
    fun remove(token: String)
}
internal interface DocumentCleanupProvider {
    fun retain(uri: String)
    fun delete(uri: String): Boolean
    fun release(uri: String)
}
internal class FileSaveDocumentCleanup(private val store: DocumentCleanupStore, private val provider: DocumentCleanupProvider) {
    fun acquire(token: String, uri: String) {
        val existing = store.entries()[token]
        check(existing == null || existing == DocumentCleanupRecord(uri))
        store.put(token, DocumentCleanupRecord(uri))
        provider.retain(uri)
    }
    fun discard(token: String, uri: String): Boolean {
        var durable = true
        val existing = try { store.entries()[token] } catch (_: Exception) { durable = false; null }
        if (existing != null && existing.uri != uri) return false
        if (existing?.releaseOnly == true) return release(token, existing)
        try { store.put(token, DocumentCleanupRecord(uri)) } catch (_: Exception) { durable = false }
        try { provider.retain(uri) } catch (_: Exception) { }
        val deleted = try { provider.delete(uri) } catch (_: Exception) { false }
        if (!deleted) return false
        val record = DocumentCleanupRecord(uri, releaseOnly = true)
        if (durable) {
            try { store.put(token, record) } catch (_: Exception) { return false }
            return release(token, record)
        }
        return try { provider.release(uri); false } catch (_: Exception) { false }
    }
    fun published(token: String, uri: String): Boolean {
        val record = DocumentCleanupRecord(uri, releaseOnly = true)
        store.put(token, record)
        return release(token, record)
    }
    fun repair(): Boolean {
        val entries = try { store.entries() } catch (_: Exception) { return false }
        var complete = true
        for ((token, record) in entries) {
            val done = if (record.releaseOnly) release(token, record) else discard(token, record.uri)
            if (!done) complete = false
        }
        return complete
    }
    private fun release(token: String, record: DocumentCleanupRecord): Boolean {
        return try { provider.release(record.uri); store.remove(token); true } catch (_: Exception) { false }
    }
}
