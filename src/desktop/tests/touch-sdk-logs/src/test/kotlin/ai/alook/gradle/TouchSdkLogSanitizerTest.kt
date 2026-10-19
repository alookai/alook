package ai.alook.gradle

import java.io.PrintWriter
import java.io.StringWriter
import java.util.jar.JarInputStream
import java.util.zip.ZipFile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.ClassWriter
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes
import org.objectweb.asm.util.CheckClassAdapter

class TouchSdkLogSanitizerTest {
    private fun sanitize(bytes: ByteArray): ByteArray {
        val writer = ClassWriter(0)
        ClassReader(bytes).accept(TouchSdkLogVisitor(writer), 0)
        return writer.toByteArray()
    }
    private fun emissions(bytes: ByteArray): Int {
        var count = 0
        ClassReader(bytes).accept(object : ClassVisitor(Opcodes.ASM9) {
            override fun visitMethod(access: Int, name: String, descriptor: String, signature: String?, exceptions: Array<out String>?) =
                object : MethodVisitor(Opcodes.ASM9) {
                    override fun visitMethodInsn(opcode: Int, owner: String, name: String, descriptor: String, isInterface: Boolean) {
                        if ((owner == "android/util/Log" && name in setOf("v", "d", "i", "w", "e", "wtf", "println")) || name == "printStackTrace") count++
                    }
                }
        }, 0)
        return count
    }
    @Test fun validJvmStackAndNoEmissionAcrossOverloads() {
        val writer = ClassWriter(ClassWriter.COMPUTE_FRAMES or ClassWriter.COMPUTE_MAXS)
        writer.visit(Opcodes.V11, Opcodes.ACC_PUBLIC, "Sample", null, "java/lang/Object", null)
        val method = writer.visitMethod(Opcodes.ACC_PUBLIC or Opcodes.ACC_STATIC, "run", "()I", null, null)
        method.visitCode()
        for (name in listOf("v", "d", "i", "w", "e", "wtf")) {
            method.visitLdcInsn("tag"); method.visitLdcInsn("private-proof")
            method.visitMethodInsn(Opcodes.INVOKESTATIC, "android/util/Log", name, "(Ljava/lang/String;Ljava/lang/String;)I", false)
            method.visitInsn(Opcodes.POP)
            method.visitLdcInsn("tag"); method.visitLdcInsn("private-proof")
            method.visitTypeInsn(Opcodes.NEW, "java/lang/Exception"); method.visitInsn(Opcodes.DUP)
            method.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/Exception", "<init>", "()V", false)
            method.visitMethodInsn(Opcodes.INVOKESTATIC, "android/util/Log", name, "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I", false)
            method.visitInsn(Opcodes.POP)
        }
        method.visitInsn(Opcodes.ICONST_4); method.visitLdcInsn("tag"); method.visitLdcInsn("private-proof")
        method.visitMethodInsn(Opcodes.INVOKESTATIC, "android/util/Log", "println", "(ILjava/lang/String;Ljava/lang/String;)I", false)
        method.visitInsn(Opcodes.POP)
        for (name in listOf("w", "wtf")) {
            method.visitLdcInsn("tag"); method.visitTypeInsn(Opcodes.NEW, "java/lang/Exception"); method.visitInsn(Opcodes.DUP)
            method.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/Exception", "<init>", "()V", false)
            method.visitMethodInsn(Opcodes.INVOKESTATIC, "android/util/Log", name, "(Ljava/lang/String;Ljava/lang/Throwable;)I", false)
            method.visitInsn(Opcodes.POP)
        }
        method.visitTypeInsn(Opcodes.NEW, "java/lang/Exception"); method.visitInsn(Opcodes.DUP);method.visitLdcInsn("private-proof")
        method.visitMethodInsn(Opcodes.INVOKESPECIAL,"java/lang/Exception","<init>","(Ljava/lang/String;)V",false)
        method.visitMethodInsn(Opcodes.INVOKEVIRTUAL,"java/lang/Exception","printStackTrace","()V",false)
        for (stream in listOf("out", "err")) {
            method.visitTypeInsn(Opcodes.NEW, "java/lang/Exception"); method.visitInsn(Opcodes.DUP)
            method.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/Exception", "<init>", "()V", false)
            method.visitFieldInsn(Opcodes.GETSTATIC, "java/lang/System", stream, "Ljava/io/PrintStream;")
            method.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Exception", "printStackTrace", "(Ljava/io/PrintStream;)V", false)
        }
        method.visitTypeInsn(Opcodes.NEW, "java/lang/Exception"); method.visitInsn(Opcodes.DUP)
        method.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/Exception", "<init>", "()V", false)
        method.visitTypeInsn(Opcodes.NEW, "java/io/PrintWriter"); method.visitInsn(Opcodes.DUP)
        method.visitFieldInsn(Opcodes.GETSTATIC, "java/lang/System", "out", "Ljava/io/PrintStream;")
        method.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/io/PrintWriter", "<init>", "(Ljava/io/OutputStream;)V", false)
        method.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Exception", "printStackTrace", "(Ljava/io/PrintWriter;)V", false)
        method.visitInsn(Opcodes.ICONST_5);method.visitInsn(Opcodes.IRETURN);method.visitMaxs(0,0);method.visitEnd();writer.visitEnd()
        val bytes = sanitize(writer.toByteArray())
        assertEquals(0, emissions(bytes))
        val errors = StringWriter()
        CheckClassAdapter.verify(ClassReader(bytes), false, PrintWriter(errors))
        assertEquals("", errors.toString())
        val loaded = object : ClassLoader() { fun load() = defineClass("Sample",bytes,0,bytes.size) }.load()
        assertEquals(5, loaded.getMethod("run").invoke(null))
    }
    @Test fun actualPinnedSdkHasNoRemainingLogOrStackTraceCalls() {
        val path = System.getProperty("touchSdkAar")
        var before = 0; var after = 0; var classes = 0
        ZipFile(path).use { aar ->
            JarInputStream(aar.getInputStream(aar.getEntry("classes.jar"))).use { jar ->
                while (true) {
                    val entry = jar.nextJarEntry ?: break
                    if (!entry.name.startsWith("com/espressif/provisioning/") || !entry.name.endsWith(".class")) continue
                    val bytes = jar.readBytes();before += emissions(bytes);after += emissions(sanitize(bytes));classes++
                }
            }
        }
        assertTrue(classes > 20)
        assertTrue(before > 20)
        assertEquals(0, after)
    }
}
