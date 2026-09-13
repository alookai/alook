package ai.alook.plugin.filesave

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest

class FileSaveCopyTest {
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
}
