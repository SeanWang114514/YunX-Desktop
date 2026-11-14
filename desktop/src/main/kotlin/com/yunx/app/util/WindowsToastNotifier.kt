package com.yunx.app.util

import com.sun.jna.platform.win32.Advapi32Util
import com.sun.jna.platform.win32.WinReg
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Windows 通知中心下载进度（toast 进度条）：
 * - 常驻 PowerShell 子进程持有 WinRT ToastNotificationManager，Kotlin 通过 stdin 逐行喂进度；
 * - AUMID 注册在 HKCU\Software\Classes\AppUserModelId\YunX.Desktop.NativeUpload，与上游通知身份分开；
 * - 同 tag/group 重发会原地替换 Action Center 里的既有 toast（进度条原地刷新，不刷屏）。
 * 非 Windows 平台全部 no-op。
 */
object WindowsToastNotifier {
    private const val AUMID = "YunX.Desktop.NativeUpload"
    private const val UPDATE_THROTTLE_MS = 1000L

    private val isWindows = System.getProperty("os.name").lowercase().contains("win")
    /** 测试/无头环境可关闭通知交互（默认开启；不影响下载本身） */
    @Volatile
    var enabled: Boolean = true
    private var proc: Process? = null
    private var writer: BufferedWriter? = null
    private val starting = AtomicBoolean(false)
    private val lastUpdateTs = AtomicLong(0)

    /** 会话内最后一次发送的聚合进度（会话结束时判断是否弹完成通知） */
    @Volatile private var lastDoneSum = 0L
    @Volatile private var lastTotalSum = 0L

    /** 本会话是否已发过第一条进度通知（用于触发「通知是否真的送达」的自检） */
    private val fallbackChecked = AtomicBoolean(false)

    /**
     * 读 Windows 为每个应用维护的「最近一次通知被添加」时间戳。
     * 发送通知前后若该值不变，说明系统把通知静默丢弃了（Show 不报错但什么都不会出现）。
     */
    private fun readOracle(): Long? = runCatching {
        val v = Advapi32Util.registryGetValue(
            WinReg.HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\$AUMID",
            "LastNotificationAddedTime"
        )
        (v as? Number)?.toLong()
    }.getOrNull()

    /**
     * 通知送达自检：某台机器上如果系统不接受通知，就建一个带 AUMID 的开始菜单快捷方式兜底
     * （微软文档要求未打包桌面应用具备该快捷方式）。仅在「通知确实没送达」时才动用户的开始菜单，
     * 正常情况下什么都不做。
     */
    private fun scheduleDeliveryCheck(oracleBefore: Long?) {
        if (!fallbackChecked.compareAndSet(false, true)) return
        Thread {
            try {
                Thread.sleep(4000) // 给系统落账留时间
                val now = readOracle()
                if (now != null && oracleBefore != null && now > oracleBefore) {
                    Log.i(TAG, "通知送达自检通过（oracle 已前进）")
                    return@Thread
                }
                if (now == null) {
                    Log.w(TAG, "通知送达自检：读不到 oracle，跳过兜底")
                    return@Thread
                }
                Log.w(TAG, "通知未被系统接受（oracle 未前进），尝试创建开始菜单快捷方式兜底")
                when (setShortcutEnabled(true)) {
                    ShortcutResult.CREATED -> Log.i(TAG, "已创建开始菜单快捷方式，后续通知应可送达")
                    ShortcutResult.ALREADY_PRESENT -> Log.i(TAG, "开始菜单快捷方式已存在，无需创建")
                    else -> Log.w(TAG, "兜底创建开始菜单快捷方式失败（详见上方日志）")
                }
            } catch (t: Throwable) {
                Log.w(TAG, "delivery check failed: ${t.message}")
            }
        }.apply {
            isDaemon = true
            name = "yunx-toast-delivery-check"
        }.start()
    }

    /** 下载会话开始（首个任务启动时调用；上一个 PowerShell 进程已退出时会重新拉起） */
    @Synchronized
    fun sessionStart() {
        if (!enabled) return
        if (!isWindows) return
        if (proc?.isAlive == true) return
        if (!starting.compareAndSet(false, true)) return
        try {
            closeQuietly() // 清掉可能已死掉的旧会话
            val script = extractResource("toast_progress.ps1", "yunx-native-upload-toast.ps1")
            if (script == null) {
                Log.w(TAG, "toast_progress.ps1 资源缺失，通知中心进度不可用")
                return
            }
            registerAumid()
            val pb = ProcessBuilder("powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script.absolutePath)
                .redirectErrorStream(false)
            val p = pb.start()
            // 必须持续消费两个输出流：否则 PowerShell 写入稍多就会把管道写满、把子进程卡死；
            // 同时把它的报错与诊断（通知 Setting / 是否被系统收下）写进应用日志便于排查
            drain(p, "yunx-toast-out", isError = false)
            drain(p, "yunx-toast-err", isError = true)
            writer = BufferedWriter(OutputStreamWriter(p.outputStream, Charsets.UTF_8))
            proc = p
            Log.i(TAG, "toast session started")
        } catch (e: Exception) {
            Log.w(TAG, "toast session start failed: ${e.message}")
        } finally {
            starting.set(false)
        }
    }

    /**
     * 聚合进度更新（内部 1s 节流）。
     * @param line1 主标题（文件名 / N 个任务）
     * @param statusLine 第二行说明（大小信息）
     * @param speedText 速度文本（空串则只显示百分比）
     * @param statusLabel 进度条状态标签
     */
    @Synchronized
    fun updateProgress(doneSum: Long, totalSum: Long, line1: String, statusLine: String, speedText: String, statusLabel: String) {
        if (!enabled) return
        lastDoneSum = doneSum
        lastTotalSum = totalSum
        if (!isWindows || writer == null) return
        val now = System.currentTimeMillis()
        if (now - lastUpdateTs.get() < UPDATE_THROTTLE_MS) return
        lastUpdateTs.set(now)
        val pct = if (totalSum > 0) ((doneSum * 100) / totalSum).toInt().coerceIn(0, 99) else 0
        val value = if (speedText.isBlank()) "$pct%" else "$speedText · $pct%"
        // 首次发送前记下 oracle，发送后自检是否真被系统接受（未被接受才启用快捷方式兜底）
        val firstSend = !fallbackChecked.get()
        val oracleBefore = if (firstSend) readOracle() else null
        sendLine("prog|${esc(line1)}|$pct|${esc(statusLine)}|${esc(value)}|${esc(statusLabel)}")
        if (firstSend) scheduleDeliveryCheck(oracleBefore)
    }

    /**
     * 下载会话结束（全部任务停止：完成/暂停/失败）。
     * 全部下载完成时弹完成通知，否则静默清理进度条。
     */
    @Synchronized
    fun sessionEnd() {
        if (!enabled) return
        if (!isWindows) return
        val completed = lastTotalSum > 0 && lastDoneSum >= lastTotalSum
        lastDoneSum = 0; lastTotalSum = 0
        if (completed) {
            sendLine("done|${esc("云析 · 下载完成")}|${esc("全部任务已下载完毕")}")
            closeQuietly()
        } else {
            sendLine("exit")
            closeQuietly()
        }
    }

    private fun sendLine(line: String) {
        try {
            val w = writer ?: return
            w.write(line)
            w.newLine()
            w.flush()
        } catch (e: Exception) {
            Log.w(TAG, "toast write failed: ${e.message}")
        }
    }

    private fun closeQuietly() {
        runCatching { writer?.close() }
        writer = null
        proc = null
    }

    /** 通知显示名「云析」+ 图标（存在 exe 旁的 ico 时） */
    private fun registerAumid() {
        try {
            val key = "Software\\Classes\\AppUserModelId\\$AUMID"
            Advapi32Util.registryCreateKey(WinReg.HKEY_CURRENT_USER, key)
            Advapi32Util.registrySetStringValue(WinReg.HKEY_CURRENT_USER, key, "DisplayName", "云析·原生上传版")
            iconFile()?.toURI()?.toString()?.let {
                Advapi32Util.registrySetStringValue(WinReg.HKEY_CURRENT_USER, key, "IconUri", it)
            }
        } catch (e: Exception) {
            Log.w(TAG, "AUMID register failed: ${e.message}")
        }
    }

    /** 便携版/安装版的 ico 在程序根目录，而 java.exe 在 runtime\bin 下，所以要逐级向上找 */
    private fun iconFile(): File? {
        val javaBin = currentJavaBin() ?: return null
        return listOfNotNull(
            javaBin,                        // 开发运行（java.exe 与 ico 同级）
            javaBin.parentFile,             // runtime\
            javaBin.parentFile?.parentFile  // 程序根目录（便携版 / 安装版）
        ).map { File(it, "YunX-Desktop.ico") }.firstOrNull { it.isFile }
    }

    /**
     * 便携版/安装版的启动器 exe（程序根目录下的 YunX-Desktop.exe）。
     * 开发运行时不满足 "runtime\bin\java.exe" 这层布局，返回 null，此时不建快捷方式。
     */
    private fun launcherPath(): String? {
        val root = currentJavaBin()?.parentFile?.parentFile ?: return null
        val exe = File(root, "YunX-Desktop.exe")
        return if (exe.isFile) exe.absolutePath else null
    }

    private fun currentJavaBin(): File? = runCatching {
        ProcessHandle.current().info().command().orElse(null)
    }.getOrNull()?.let { File(it).parentFile }

    /** 持续消费子进程输出，避免管道写满卡死；内容写进应用日志便于排查 */
    private fun drain(p: Process, threadName: String, isError: Boolean) {
        Thread {
            runCatching {
                val reader = (if (isError) p.errorStream else p.inputStream)
                    .bufferedReader(Charsets.UTF_8)
                reader.forEachLine { line ->
                    if (line.isNotBlank()) {
                        if (isError) Log.w(TAG, "powershell: $line") else Log.i(TAG, line)
                    }
                }
            }
        }.apply {
            isDaemon = true
            name = threadName
        }.start()
    }

    /** 从 classpath 解包脚本到临时目录（jar 内资源无法直接执行） */
    private fun extractResource(resource: String, tempName: String): File? {
        return try {
            val stream = WindowsToastNotifier::class.java.classLoader.getResourceAsStream(resource)
                ?: return null
            val out = File(System.getProperty("java.io.tmpdir"), tempName)
            stream.use { input -> out.outputStream().use { input.copyTo(it) } }
            out
        } catch (e: Exception) {
            Log.w(TAG, "extract $resource failed: ${e.message}")
            null
        }
    }

    /** 开始菜单快捷方式处理结果 */
    enum class ShortcutResult { CREATED, ALREADY_PRESENT, REMOVED, ALREADY_ABSENT, FAILED }

    /**
     * 创建/删除「带 AUMID 的开始菜单快捷方式」—— Windows 对未打包桌面应用发通知的硬性前提。
     * 同步跑一次 PowerShell（约 1s），调用方需自行放到后台线程。
     */
    @Synchronized
    fun setShortcutEnabled(enabled: Boolean): ShortcutResult {
        if (!isWindows) return ShortcutResult.FAILED
        val script = extractResource("toast_shortcut.ps1", "yunx-native-upload-toast-shortcut.ps1")
            ?: run {
                Log.w(TAG, "toast_shortcut.ps1 资源缺失")
                return ShortcutResult.FAILED
            }
        val cmd = mutableListOf(
            "powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
            "-File", script.absolutePath
        )
        if (enabled) {
            val launcher = launcherPath()
            if (launcher == null) {
                // 开发运行没有启动器 exe，不建快捷方式（否则开始菜单里会出现指向 java.exe 的条目）
                Log.w(TAG, "未找到启动器 exe，跳过快捷方式创建")
                return ShortcutResult.FAILED
            }
            cmd += listOf("-Action", "create", "-Launcher", launcher)
            iconFile()?.absolutePath?.let { cmd += listOf("-Icon", it) }
        } else {
            cmd += listOf("-Action", "remove")
        }
        return runCatching {
            val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
            if (!p.waitFor(20, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                Log.w(TAG, "shortcut script timeout")
                return@runCatching ShortcutResult.FAILED
            }
            val out = p.inputStream.bufferedReader(Charsets.UTF_8).readText().trim()
            val code = p.exitValue()
            val last = out.lines().lastOrNull { it.isNotBlank() }?.trim().orEmpty()
            Log.i(TAG, "shortcut enabled=$enabled -> '$last' (exit=$code)")
            if (code != 0) ShortcutResult.FAILED
            else when (last) {
                "created" -> ShortcutResult.CREATED
                "exists" -> ShortcutResult.ALREADY_PRESENT
                "removed" -> ShortcutResult.REMOVED
                "absent" -> ShortcutResult.ALREADY_ABSENT
                else -> ShortcutResult.FAILED
            }
        }.onFailure {
            Log.w(TAG, "shortcut script failed: ${it.message}")
        }.getOrDefault(ShortcutResult.FAILED)
    }

    /** XML 转义（文件名可能含 & < > 等） */
    private fun esc(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    private const val TAG = "YunX-Toast"
}
