package ai.alook.plugin.filesave

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest

class FileSaveCopyTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    @Test fun exactStreamingBytesIncludingEmptyFile() {
        for (size in listOf(0, 1, 65_537, 25 * 1024 * 1024)) {
            val input = ByteArray(size) { (it % 251).toByte() }
            val output = ByteArrayOutputStream()
            FileSaveCopy.write(ByteArrayInputStream(input), output, size.toLong(), hash(input)) { false }
            assertArrayEquals(input, output.toByteArray())
        }
    }
    @Test fun rejectsShortLongAndCorruptSource() {
        val bytes = "abc".toByteArray()
        for ((size, sha) in listOf(2L to hash(bytes), 4L to hash(bytes), 3L to "bad")) {
            assertThrows(IllegalStateException::class.java) {
                FileSaveCopy.write(ByteArrayInputStream(bytes), ByteArrayOutputStream(), size, sha) { false }
            }
        }
    }
    @Test fun cancelsBetweenBoundedWrites() {
        val bytes = ByteArray(131_072)
        val output = ByteArrayOutputStream()
        assertThrows(IllegalStateException::class.java) {
            FileSaveCopy.write(ByteArrayInputStream(bytes), output, bytes.size.toLong(), hash(bytes)) { output.size() >= 65_536 }
        }
        assertEquals(65_536, output.size())
    }
    @Test fun propagatesDiskFullWithoutContinuing() {
        val bytes = ByteArray(65_537)
        var calls = 0
        val output = object : OutputStream() {
            override fun write(b: Int) { calls++; throw IOException("full") }
        }
        assertThrows(IOException::class.java) { FileSaveCopy.write(ByteArrayInputStream(bytes), output, bytes.size.toLong(), hash(bytes)) { false } }
        assertEquals(1, calls)
    }
    @Test fun shareCacheSweepEnforcesTtlCapKeepNameAndRepairClear() {
        val root = temporaryFolder.newFolder("alook-share")
        val now = 10_000_000L
        val expired = File(root, "expired").apply {
            mkdirs()
            File(this, "old.bin").writeBytes(ByteArray(16))
            setLastModified(now - 2_000L)
        }
        val older = File(root, "older").apply {
            mkdirs()
            File(this, "a.bin").writeBytes(ByteArray(80))
            setLastModified(now - 500L)
        }
        val newer = File(root, "newer").apply {
            mkdirs()
            File(this, "b.bin").writeBytes(ByteArray(80))
            setLastModified(now - 100L)
        }
        val active = File(root, "active").apply {
            mkdirs()
            File(this, "c.bin").writeBytes(ByteArray(80))
            setLastModified(now - 5_000L)
        }

        FileSaveShareCache.sweep(
            root = root,
            nowMs = now,
            maxAgeMs = 1_000L,
            maxTotalBytes = 100L,
            keepName = "active",
            deleteAllPrior = false,
        )

        assertFalse(expired.exists())
        assertFalse(older.exists())
        assertTrue(newer.exists())
        assertTrue(active.exists())

        FileSaveShareCache.sweep(root = root, nowMs = now, deleteAllPrior = true)
        assertFalse(newer.exists())
        assertFalse(active.exists())
    }
}
