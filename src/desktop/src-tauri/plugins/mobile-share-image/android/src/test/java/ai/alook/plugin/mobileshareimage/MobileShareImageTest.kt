package ai.alook.plugin.mobileshareimage

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MobileShareImageTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun validatesCanonicalPngStructureAndRejectsCrcCorruption() {
        val png = png(width = 2, height = 3)
        assertEquals(MobileShareImage.PngDimensions(2, 3), MobileShareImage.validatePngStructure(png))

        png[png.lastIndex - 4] = (png[png.lastIndex - 4].toInt() xor 1).toByte()
        assertFailure("invalid_png") { MobileShareImage.validatePngStructure(png) }
    }

    @Test
    fun rejectsAnimatedTrailingAndDimensionBombPngs() {
        assertFailure("invalid_png") {
            MobileShareImage.validatePngStructure(
                png(extraChunks = listOf(chunk("acTL", ByteArray(8)))),
            )
        }
        assertFailure("invalid_png") {
            MobileShareImage.validatePngStructure(png() + byteArrayOf(0))
        }
        assertFailure("invalid_png") {
            MobileShareImage.validatePngStructure(png(width = 16_384, height = 16_384))
        }
    }

    @Test
    fun sanitizesFilenameToNfcPngWithinUtf8Limit() {
        assertEquals("Café.png", MobileShareImage.sanitizeFilename("../Cafe\u0301\u0000.png"))
        assertEquals("alook-message-share.png", MobileShareImage.sanitizeFilename("../...\u0000"))

        val bounded = MobileShareImage.sanitizeFilename("🚀".repeat(100) + ".PNG")
        assertTrue(bounded.endsWith(".png"))
        assertTrue(bounded.toByteArray(Charsets.UTF_8).size <= 180)

        val mixed = MobileShareImage.sanitizeFilename("a" + "🚀".repeat(100) + ".PNG")
        assertTrue(mixed.endsWith(".png"))
        assertTrue(mixed.toByteArray(Charsets.UTF_8).size <= 180)
        assertEquals(mixed, mixed.toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8))
        assertEquals(179, MobileShareImage.sanitizeFilename("a".repeat(175)).toByteArray().size)
        assertEquals(180, MobileShareImage.sanitizeFilename("a".repeat(176)).toByteArray().size)
        assertEquals(180, MobileShareImage.sanitizeFilename("a".repeat(177)).toByteArray().size)
    }

    @Test
    fun acceptsOnlyCanonicalLowercaseUuidV4AttemptIds() {
        MobileShareImage.validateAttemptId("123e4567-e89b-42d3-a456-426614174000")
        assertFailure("invalid_png") {
            MobileShareImage.validateAttemptId("123E4567-E89B-42D3-A456-426614174000")
        }
        assertFailure("invalid_png") {
            MobileShareImage.validateAttemptId("123e4567-e89b-12d3-a456-426614174000")
        }
        assertFailure("invalid_png") { MobileShareImage.validateAttemptId("not-a-uuid") }
    }

    @Test
    fun nativeFlightRejectsOverlapAndLeaseCloseIsIdempotent() {
        val first = MobileShareImageNativeFlight.acquire()
        try {
            assertFailure("busy") { MobileShareImageNativeFlight.acquire() }
        } finally {
            first.close()
            first.close()
        }
        MobileShareImageNativeFlight.acquire().close()
    }

    @Test
    fun clipboardCleanupKeepsPublishedFileUntilReplacementIsReady() {
        val directory = temporaryFolder.newFolder("clipboard")
        val old = File(directory, "old.png").apply {
            writeText("old")
            setLastModified(0)
        }
        val temporary = File(directory, "next.tmp").apply { writeText("partial") }
        val unrelated = File(directory, "keep.txt").apply { writeText("keep") }

        MobileShareImage.cleanupClipboardTemporaries(directory)
        assertTrue(old.exists())
        assertFalse(temporary.exists())

        val published = File(directory, "next.png").apply { writeText("new") }
        MobileShareImage.cleanupClipboardAfterPublish(directory, published)
        MobileShareImage.cleanupClipboardAfterPublish(directory, published)
        assertFalse(old.exists())
        assertTrue(published.exists())
        assertTrue(unrelated.exists())
    }

    @Test
    fun clipboardStagingFailurePreservesThePreviousBackingFile() {
        val directory = temporaryFolder.newFolder("clipboard-failure")
        val old = File(directory, "old.png").apply {
            writeText("old")
            setLastModified(0)
        }
        assertTrue(File(directory, "blocked.png").mkdir())

        assertFailure("write_failed") {
            MobileShareImage.stageClipboard(directory, byteArrayOf(1, 2, 3), "blocked")
        }

        assertTrue(old.exists())
        assertEquals("old", old.readText())
        assertFalse(File(directory, "blocked.tmp").exists())
    }

    private fun assertFailure(code: String, block: () -> Unit) {
        val failure = assertThrows(MobileShareImageFailure::class.java, block)
        assertEquals(code, failure.code)
    }

    private fun png(
        width: Int = 1,
        height: Int = 1,
        extraChunks: List<ByteArray> = emptyList(),
    ): ByteArray {
        val header = ByteBuffer.allocate(13).order(ByteOrder.BIG_ENDIAN)
            .putInt(width)
            .putInt(height)
            .put(8)
            .put(6)
            .put(0)
            .put(0)
            .put(0)
            .array()
        return ByteArrayOutputStream().apply {
            write(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10))
            write(chunk("IHDR", header))
            extraChunks.forEach(::write)
            write(chunk("IDAT", byteArrayOf(0)))
            write(chunk("IEND", byteArrayOf()))
        }.toByteArray()
    }

    private fun chunk(type: String, data: ByteArray): ByteArray {
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        val crc = CRC32().apply {
            update(typeBytes)
            update(data)
        }.value
        return ByteBuffer.allocate(12 + data.size).order(ByteOrder.BIG_ENDIAN)
            .putInt(data.size)
            .put(typeBytes)
            .put(data)
            .putInt(crc.toInt())
            .array()
    }
}
