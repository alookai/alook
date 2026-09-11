package ai.alook.plugin.mobileshareimage

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MobileShareImageIntegrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val insertedUris = mutableListOf<Uri>()

    @After
    fun cleanUp() {
        insertedUris.forEach { uri -> runCatching { context.contentResolver.delete(uri, null, null) } }
        context.getSharedPreferences("mobile-share-image-journal", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
        File(context.cacheDir, "mobile-share-image").deleteRecursively()
    }

    @Test
    fun fileProviderExposesOnlyClipboardStagingDirectory() {
        val authority = "${context.packageName}.mobile_share_image.fileprovider"
        val allowed = File(context.cacheDir, "mobile-share-image/clipboard/allowed.png")
        assertTrue(allowed.parentFile!!.mkdirs() || allowed.parentFile!!.isDirectory)
        allowed.writeBytes(byteArrayOf(1))

        val allowedUri = FileProvider.getUriForFile(context, authority, allowed)
        assertEquals(authority, allowedUri.authority)

        val outside = File(context.cacheDir, "outside.png").apply { writeBytes(byteArrayOf(1)) }
        assertProviderRejects(authority, outside)
        val traversal = File(allowed.parentFile, "../outside.png")
        assertProviderRejects(authority, traversal)
        context.getExternalFilesDir(null)?.let { external ->
            assertProviderRejects(
                authority,
                File(external, "external.png").apply { writeBytes(byteArrayOf(1)) },
            )
        }
    }

    @Test
    fun repairDeletesOnlyTheExactOwnedPendingMediaStoreRow() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val row = insertPendingRow()
        val prefs = writeJournal(row, includeUri = true)

        assertTrue(MobileShareImage.repairJournal(context))
        assertFalse(prefs.contains("token"))
        assertFalse(rowExists(row.uri))
        insertedUris.remove(row.uri)
    }

    @Test
    fun repairFindsTheExactPendingRowWhenProcessDiesBeforeUriCommit() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val row = insertPendingRow()
        val prefs = writeJournal(row, includeUri = false)

        assertTrue(MobileShareImage.repairJournal(context))
        assertFalse(prefs.contains("token"))
        assertFalse(rowExists(row.uri))
        insertedUris.remove(row.uri)
    }

    @Test
    fun repairClearsPublishedJournalWithoutDeletingTheImage() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val row = insertPendingRow()
        assertEquals(
            1,
            context.contentResolver.update(
                row.uri,
                ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
                null,
                null,
            ),
        )
        val prefs = writeJournal(row, includeUri = true)

        assertTrue(MobileShareImage.repairJournal(context))
        assertFalse(prefs.contains("token"))
        assertTrue(rowExists(row.uri))
    }

    @Test
    fun preparedJournalNeverDeletesAnUnrelatedPendingRow() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val unrelated = insertPendingRow()
        val missing = JournalRow(
            token = UUID.randomUUID().toString().replace("-", ""),
            name = "",
            createdAt = System.currentTimeMillis(),
            uri = unrelated.uri,
        ).let { it.copy(name = "alook-message-share-${it.token}.png") }
        val prefs = writeJournal(missing, includeUri = false)

        assertTrue(MobileShareImage.repairJournal(context))
        assertFalse(prefs.contains("token"))
        assertTrue(rowExists(unrelated.uri))
    }

    private data class JournalRow(
        val token: String,
        val name: String,
        val createdAt: Long,
        val uri: Uri,
    )

    private fun insertPendingRow(): JournalRow {
        val token = UUID.randomUUID().toString().replace("-", "")
        val name = "alook-message-share-$token.png"
        val createdAt = System.currentTimeMillis()
        val uri = context.contentResolver.insert(
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Alook/")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            },
        ) ?: error("MediaStore did not create the pending test row")
        insertedUris += uri
        context.contentResolver.openOutputStream(uri, "w")!!.use { it.write(byteArrayOf(1, 2, 3)) }
        return JournalRow(token, name, createdAt, uri)
    }

    private fun writeJournal(row: JournalRow, includeUri: Boolean) =
        context.getSharedPreferences("mobile-share-image-journal", Context.MODE_PRIVATE).also { prefs ->
            val editor = prefs.edit()
                .putString("token", row.token)
                .putString("displayName", row.name)
                .putString("relativePath", "Pictures/Alook/")
                .putLong("createdAt", row.createdAt)
            if (includeUri) editor.putString("uri", row.uri.toString()) else editor.remove("uri")
            assertTrue(editor.commit())
        }

    private fun assertProviderRejects(authority: String, file: File) {
        var rejected = false
        try {
            FileProvider.getUriForFile(context, authority, file)
        } catch (_: IllegalArgumentException) {
            rejected = true
        }
        assertTrue("FileProvider must reject ${file.path}", rejected)
    }

    private fun rowExists(uri: Uri): Boolean =
        context.contentResolver.query(uri, arrayOf(MediaStore.Images.Media._ID), null, null, null)
            ?.use { it.moveToFirst() }
            ?: false
}
