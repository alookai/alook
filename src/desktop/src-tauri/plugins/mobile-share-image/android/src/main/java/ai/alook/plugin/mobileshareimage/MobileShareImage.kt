package ai.alook.plugin.mobileshareimage

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal object MobileShareImage {
    const val MAX_PNG_BYTES = 10 * 1024 * 1024
    internal const val STAGING_DIR_NAME = "mobile-share-image-staging"
    internal const val CLOCK_SKEW_TOLERANCE_SECONDS = 60L
    private const val JOURNAL = "mobile-share-image-journal"
    private const val RELATIVE_PATH = "Pictures/Alook/"
    private const val MEDIA_NAME_PREFIX = "alook-message-share-"
    private val PNG_SIGNATURE = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)
    private val SHA256_REGEX = Regex("[0-9a-f]{64}")

    fun validateAttemptId(value: String) {
        val canonical = runCatching { UUID.fromString(value).toString() }.getOrNull()
        if (canonical != value || value[14] != '4' || value[19] !in setOf('8', '9', 'a', 'b')) {
            throw MobileShareImageFailure("invalid_png", "Invalid attempt identifier")
        }
    }

    fun loadValidatedFile(
        context: Context,
        attemptId: String,
        path: String,
        expectedBytes: Long,
        sha256: String,
    ): ByteArray = loadValidatedFile(
        File(context.cacheDir, STAGING_DIR_NAME),
        attemptId,
        path,
        expectedBytes,
        sha256,
    )

    internal fun loadValidatedFile(
        allowedRoot: File,
        attemptId: String,
        path: String,
        expectedBytes: Long,
        sha256: String,
    ): ByteArray {
        validateAttemptId(attemptId)
        if (expectedBytes <= 0L) {
            throw MobileShareImageFailure("invalid_png", "Image payload is empty")
        }
        if (expectedBytes > MAX_PNG_BYTES.toLong()) {
            throw MobileShareImageFailure("image_too_large", "Image exceeds the mobile limit")
        }
        if (!SHA256_REGEX.matches(sha256)) {
            throw MobileShareImageFailure("invalid_png", "Image digest is invalid")
        }
        val canonicalRoot = allowedRoot.canonicalFile
        val canonicalSource = File(path).canonicalFile
        if (canonicalSource.parentFile != canonicalRoot || canonicalSource.name != "$attemptId.png" || !canonicalSource.isFile) {
            throw MobileShareImageFailure("invalid_png", "Staged image path is invalid")
        }
        if (canonicalSource.length() != expectedBytes) {
            throw MobileShareImageFailure("invalid_png", "Staged image size mismatch")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        val output = ByteArrayOutputStream(expectedBytes.toInt())
        val buffer = ByteArray(65_536)
        var total = 0L
        try {
            FileInputStream(canonicalSource).use { input ->
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read.toLong()
                    if (total > expectedBytes) {
                        throw MobileShareImageFailure("invalid_png", "Staged image size mismatch")
                    }
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
            }
        } catch (error: MobileShareImageFailure) {
            throw error
        } catch (_: Exception) {
            throw MobileShareImageFailure("write_failed", "Could not read staged image")
        }
        val bytes = output.toByteArray()
        if (total != expectedBytes || bytes.size < PNG_SIGNATURE.size || !bytes.copyOfRange(0, PNG_SIGNATURE.size).contentEquals(PNG_SIGNATURE)) {
            throw MobileShareImageFailure("invalid_png", "Image payload is not a valid PNG")
        }
        val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
        if (actualSha256 != sha256) {
            throw MobileShareImageFailure("invalid_png", "Staged image digest mismatch")
        }
        return bytes
    }

    fun sanitizeFilename(value: String): String {
        val normalized = Normalizer.normalize(value, Normalizer.Form.NFC)
        val basename = normalized.split('/', '\\').lastOrNull().orEmpty()
            .dropWhile { it == '.' || it.isWhitespace() }
        var stem = basename.filter { !it.isISOControl() && it != '/' && it != '\\' }.trim()
        while (stem.lowercase().endsWith(".png")) stem = stem.dropLast(4)
        if (stem.isBlank()) stem = "alook-message-share"
        while ((stem + ".png").toByteArray(Charsets.UTF_8).size > 180) {
            stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1))
        }
        return if (stem.isBlank()) "alook-message-share.png" else "$stem.png"
    }

    fun save(context: Context, bytes: ByteArray, attemptId: String): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw MobileShareImageFailure("unavailable", "MediaStore requires Android 10")
        }
        if (!repairJournal(context)) {
            throw MobileShareImageFailure("write_failed", "A previous image save could not be repaired")
        }

        val resolver = context.contentResolver
        val token = UUID.randomUUID().toString().replace("-", "")
        val displayName = "$MEDIA_NAME_PREFIX$token.png"
        val createdAt = System.currentTimeMillis()
        val prefs = context.getSharedPreferences(JOURNAL, Context.MODE_PRIVATE)
        if (!prefs.edit()
                .putString("token", token)
                .putString("displayName", displayName)
                .putString("relativePath", RELATIVE_PATH)
                .putLong("createdAt", createdAt)
                .remove("uri")
                .commit()
        ) {
            throw MobileShareImageFailure("write_failed", "Could not prepare image save")
        }

        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, RELATIVE_PATH)
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = try {
            resolver.insert(collection, values)
        } catch (error: Exception) {
            prefs.edit().clear().commit()
            throw MobileShareImageFailure("write_failed", error.message ?: "Could not create image row")
        } ?: run {
            prefs.edit().clear().commit()
            throw MobileShareImageFailure("write_failed", "Could not create image row")
        }

        if (!prefs.edit().putString("uri", uri.toString()).commit()) {
            cleanupInsertedRow(context, uri, prefs)
            throw MobileShareImageFailure("write_failed", "Could not record image row")
        }

        try {
            resolver.openOutputStream(uri, "w")?.use { stream ->
                stream.write(bytes)
                stream.flush()
            } ?: throw MobileShareImageFailure("write_failed", "Could not open image destination")
            val published = resolver.update(
                uri,
                ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
                null,
                null,
            )
            if (published != 1) throw MobileShareImageFailure("write_failed", "Could not publish image")
        } catch (error: Exception) {
            cleanupInsertedRow(context, uri, prefs)
            if (error is MobileShareImageFailure) throw error
            throw MobileShareImageFailure("write_failed", error.message ?: "Could not save image")
        }

        // The row is already durably public. If this clear fails, the next exact repair
        // recognizes that fact and clears the journal without deleting the image.
        prefs.edit().clear().commit()
        logNativeSettle(attemptId)
        return "pictures"
    }

    fun stageClipboard(context: Context, bytes: ByteArray, token: String): File {
        return stageClipboard(
            File(context.cacheDir, "mobile-share-image/clipboard"),
            bytes,
            token,
        )
    }

    internal fun stageClipboard(directory: File, bytes: ByteArray, token: String): File {
        if (!directory.mkdirs() && !directory.isDirectory) {
            throw MobileShareImageFailure("write_failed", "Could not prepare clipboard image")
        }
        cleanupClipboardTemporaries(directory)
        return try {
            writeStagedPng(directory, bytes, token, "Could not publish clipboard image")
        } catch (error: Exception) {
            if (error is MobileShareImageFailure) throw error
            throw MobileShareImageFailure("write_failed", error.message ?: "Could not stage clipboard image")
        }
    }

    fun cleanupClipboardAfterPublish(context: Context, published: File) {
        cleanupClipboardAfterPublish(
            File(context.cacheDir, "mobile-share-image/clipboard"),
            published,
        )
    }

    internal fun cleanupClipboardTemporaries(directory: File) {
        directory.listFiles()?.forEach { candidate ->
            if (candidate.isFile && candidate.extension == "tmp") candidate.delete()
        }
    }

    internal fun cleanupClipboardAfterPublish(directory: File, published: File) {
        directory.listFiles()?.forEach { candidate ->
            if (candidate.isFile && candidate.extension == "png" && candidate != published) {
                candidate.delete()
            }
        }
    }

    fun stageDocument(context: Context, bytes: ByteArray, token: String): File {
        val directory = File(context.cacheDir, "mobile-share-image/document")
        if (!directory.mkdirs() && !directory.isDirectory) {
            throw MobileShareImageFailure("write_failed", "Could not prepare private image staging")
        }
        return try {
            writeStagedPng(directory, bytes, token, "Could not publish private image staging")
        } catch (error: Exception) {
            if (error is MobileShareImageFailure) throw error
            throw MobileShareImageFailure("write_failed", error.message ?: "Could not stage document image")
        }
    }

    private fun writeStagedPng(directory: File, bytes: ByteArray, token: String, publishError: String): File {
        val temporary = File(directory, "$token.tmp")
        val final = File(directory, "$token.png")
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(bytes)
                stream.flush()
                stream.fd.sync()
            }
            if (!temporary.renameTo(final)) throw MobileShareImageFailure("write_failed", publishError)
            return final
        } catch (error: Exception) {
            temporary.delete()
            final.delete()
            throw error
        }
    }

    fun cleanupDocumentOrphans(context: Context) {
        cleanupMobileShareImageDocumentOrphans(
            File(context.cacheDir, "mobile-share-image/document"),
            MobileShareImageCoordinator.liveToken(),
        )
    }

    fun resolveSaved(invoke: Invoke, attemptId: String, destination: String) {
        invoke.resolve(JSObject().apply {
            put("attemptId", attemptId)
            put("status", "saved")
            put("destination", destination)
        })
    }

    fun resolveCopied(invoke: Invoke, attemptId: String) {
        invoke.resolve(JSObject().apply {
            put("attemptId", attemptId)
            put("status", "copied")
            put("destination", "clipboard")
        })
    }

    fun reject(invoke: Invoke, failure: MobileShareImageFailure) {
        invoke.reject(failure.message, failure.code)
    }

    fun logNativeSettle(attemptId: String) {
        android.util.Log.d(
            "AlookMobileShareImage",
            "native-settle attempt=$attemptId t=${android.os.SystemClock.elapsedRealtimeNanos()}",
        )
    }

    internal fun repairJournal(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
        val prefs = context.getSharedPreferences(JOURNAL, Context.MODE_PRIVATE)
        val token = prefs.getString("token", null) ?: return true
        val expectedName = "$MEDIA_NAME_PREFIX$token.png"
        val name = prefs.getString("displayName", null) ?: return false
        val path = prefs.getString("relativePath", null) ?: return false
        val createdAt = prefs.getLong("createdAt", 0)
        if (!token.matches(Regex("[0-9a-f]{32}")) || name != expectedName || path != RELATIVE_PATH || createdAt <= 0) {
            return false
        }

        val storedUri = prefs.getString("uri", null)?.let { runCatching { Uri.parse(it) }.getOrNull() }
        val queried = if (storedUri != null) {
            queryRows(context, pendingAwareUri(storedUri), null, null) { storedUri }
        } else {
            findPreparedRows(context, name, path, createdAt)
        }
        val rows = when (queried) {
            QueryResult.Failed -> return false
            is QueryResult.Rows -> queried.value
        }
        if (rows.size > 1) return false
        if (rows.isEmpty()) return prefs.edit().clear().commit()

        val row = rows.single()
        if (!journalOwnsRow(context, row, token, name, path, createdAt)) return false
        if (!row.pending) return prefs.edit().clear().commit()
        val deleted = try {
            context.contentResolver.delete(row.uri, null, null)
        } catch (_: Exception) {
            return false
        }
        return (deleted == 1 || (deleted == 0 && rowConfirmedMissing(context, row.uri))) &&
            prefs.edit().clear().commit()
    }

    internal fun journalOwnsRow(
        packageName: String,
        row: JournalRow,
        token: String,
        name: String,
        path: String,
        createdAt: Long,
        nowSeconds: Long = System.currentTimeMillis() / 1000L,
    ): Boolean {
        val createdFloor = createdAt / 1000L - 5L
        val upperBound = nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS
        return row.owner == packageName &&
            row.name == name &&
            row.name == "$MEDIA_NAME_PREFIX$token.png" &&
            row.path == path &&
            row.path == RELATIVE_PATH &&
            row.createdSeconds in createdFloor..upperBound
    }

    private fun journalOwnsRow(
        context: Context,
        row: JournalRow,
        token: String,
        name: String,
        path: String,
        createdAt: Long,
    ): Boolean = journalOwnsRow(context.packageName, row, token, name, path, createdAt)

    private fun cleanupInsertedRow(context: Context, uri: Uri, prefs: SharedPreferences) {
        val deleted = try {
            context.contentResolver.delete(uri, null, null)
        } catch (_: Exception) {
            return
        }
        if (deleted == 1 || (deleted == 0 && rowConfirmedMissing(context, uri))) {
            prefs.edit().clear().commit()
        }
    }

    private sealed interface QueryResult {
        data object Failed : QueryResult
        data class Rows(val value: List<JournalRow>) : QueryResult
    }

    internal data class JournalRow(
        val uri: Uri,
        val owner: String,
        val pending: Boolean,
        val path: String,
        val name: String,
        val createdSeconds: Long,
    )

    private fun findPreparedRows(
        context: Context,
        name: String,
        path: String,
        createdAt: Long,
    ): QueryResult {
        val base = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) MediaStore.setIncludePending(base) else base
        val selection = "${MediaStore.Images.Media.OWNER_PACKAGE_NAME} = ? AND " +
            "${MediaStore.Images.Media.IS_PENDING} = ? AND " +
            "${MediaStore.Images.Media.RELATIVE_PATH} = ? AND " +
            "${MediaStore.Images.Media.DISPLAY_NAME} = ? AND " +
            "${MediaStore.Images.Media.DATE_ADDED} BETWEEN ? AND ?"
        val args = arrayOf(
            context.packageName,
            "1",
            path,
            name,
            (createdAt / 1000L - 5L).toString(),
            (System.currentTimeMillis() / 1000L + CLOCK_SKEW_TOLERANCE_SECONDS).toString(),
        )
        return queryRows(context, uri, selection, args) { id -> ContentUris.withAppendedId(base, id) }
    }

    private fun queryRows(
        context: Context,
        uri: Uri,
        selection: String?,
        selectionArgs: Array<String>?,
        rowUri: (Long) -> Uri,
    ): QueryResult {
        val columns = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.OWNER_PACKAGE_NAME,
            MediaStore.Images.Media.IS_PENDING,
            MediaStore.Images.Media.RELATIVE_PATH,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_ADDED,
        )
        val cursor = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                context.contentResolver.query(
                    uri,
                    columns,
                    Bundle().apply {
                        putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE)
                        selection?.let { putString(ContentResolver.QUERY_ARG_SQL_SELECTION, it) }
                        selectionArgs?.let { putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, it) }
                    },
                    null,
                )
            } else {
                context.contentResolver.query(uri, columns, selection, selectionArgs, null)
            }
        } catch (_: Exception) {
            return QueryResult.Failed
        } ?: return QueryResult.Failed

        return try {
            cursor.use { value ->
                val rows = mutableListOf<JournalRow>()
                while (value.moveToNext()) {
                    rows += value.toJournalRow(rowUri(value.getLong(0)))
                    if (rows.size > 1) break
                }
                QueryResult.Rows(rows)
            }
        } catch (_: Exception) {
            QueryResult.Failed
        }
    }

    private fun Cursor.toJournalRow(uri: Uri) = JournalRow(
        uri = uri,
        owner = getString(1) ?: "",
        pending = getInt(2) == 1,
        path = getString(3) ?: "",
        name = getString(4) ?: "",
        createdSeconds = getLong(5),
    )

    private fun pendingAwareUri(uri: Uri): Uri =
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) MediaStore.setIncludePending(uri) else uri

    private fun rowConfirmedMissing(context: Context, uri: Uri): Boolean =
        when (val result = queryRows(context, pendingAwareUri(uri), null, null) { uri }) {
            QueryResult.Failed -> false
            is QueryResult.Rows -> result.value.isEmpty()
        }
}

internal class MobileShareImageFailure(val code: String, override val message: String) : Exception(message)

internal object MobileShareImageNativeFlight {
    private val busy = AtomicBoolean(false)

    fun acquire(): MobileShareImageNativeLease {
        if (!busy.compareAndSet(false, true)) {
            throw MobileShareImageFailure("busy", "Another image action is active")
        }
        return MobileShareImageNativeLease(busy)
    }
}

internal class MobileShareImageNativeLease(private val busy: AtomicBoolean) {
    private val closed = AtomicBoolean(false)

    fun close() {
        if (closed.compareAndSet(false, true)) busy.set(false)
    }
}
