package ai.alook.plugin.filesave

import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

internal object FileSaveCopy {
    fun write(input: InputStream, output: OutputStream, size: Long, sha256: String, cancelled: () -> Boolean) {
        val hash = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
        val buffer = ByteArray(65_536)
        while (true) {
            check(!cancelled())
            val n = input.read(buffer)
            if (n < 0) break
            bytes += n
            check(bytes <= size)
            output.write(buffer, 0, n)
            hash.update(buffer, 0, n)
        }
        output.flush()
        check(!cancelled() && bytes == size && hash.digest().joinToString("") { "%02x".format(it) } == sha256)
    }
}
