/*
 * Adapted from YunX Android UploadRunner, Copyright (C) 2026 CYQawa.
 * Licensed under the GNU Affero General Public License, version 3 or later.
 */
package com.yunx.app.data.upload

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yunx.app.data.prefs.SettingsRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.awaitCancellation
import okhttp3.OkHttpClient
import java.io.File
import kotlin.math.roundToLong

data class UploadProgress(
    val index: Int,
    val count: Int,
    val name: String,
    val sent: Long,
    val size: Long,
    val phase: UploadPhase,
    val cancelling: Boolean = false,
    val bytesPerSecond: Double? = null,
    val platform: String = "",
    val files: List<UploadFileProgress> = emptyList(),
    val completed: Int = 0,
    val activeCount: Int = 0,
    val batchId: Long = 0L,
    val canAppend: Boolean = true,
    val concurrencyLimit: Int = SettingsRepository.DEFAULT_MAX_CONCURRENT_UPLOADS
) {
    val fraction: Float get() = if (size <= 0) 0f else (sent.toDouble() / size).toFloat().coerceIn(0f, 1f)
    val remainingSeconds: Long? get() = bytesPerSecond
        ?.takeIf { phase == UploadPhase.UPLOADING && it > 0.0 && it.isFinite() }
        ?.let { ((size - sent).coerceAtLeast(0L) / it).roundToLong() }
}

data class UploadOutcome(
    val uploaded: Int,
    val failed: Int,
    val cancelled: Boolean,
    val error: String?,
    val notStarted: Int = 0
) {
    fun message(): String = buildString {
        append(if (cancelled) "上传已取消" else if (failed > 0 || error != null) "上传失败" else "上传完成")
        append("：成功 ").append(uploaded).append(" 个")
        if (failed > 0) append("，失败 ").append(failed).append(" 个")
        if (notStarted > 0) append("，未开始 ").append(notStarted).append(" 个")
        if (!error.isNullOrBlank()) append("。 ").append(error)
    }
}

/** 每个平台一个批次，文件并发数跟随设置，追加文件沿用批次的目录与账号。 */
class UploadRunner(
    private val scope: CoroutineScope,
    private val clientProvider: () -> OkHttpClient,
    private val onFinished: (UploadOutcome) -> Unit
) {
    var progress by mutableStateOf<UploadProgress?>(null)
        private set

    private class Item(val file: File) {
        var progress = UploadFileProgress(UploadCandidate(file, file.length().coerceAtLeast(0L)))
        var io: UploadIo? = null
        var lastEmit = 0L
        var speedSampleTime = 0L
        var speedSampleSent = 0L
    }

    private val lock = Any()
    private val queue = mutableListOf<Item>()
    private var queueSignal: Channel<Unit>? = null
    private var acceptingFiles = false
    private var batchError: String? = null
    private var batchId = 0L
    @Volatile private var cancelRequested = false
    private var job: Job? = null
    private var uploadPlatform = ""
    private var concurrencyLimit = SettingsRepository.DEFAULT_MAX_CONCURRENT_UPLOADS
    val isRunning: Boolean get() = progress != null

    fun cancel() {
        if (!isRunning) return
        synchronized(lock) {
            cancelRequested = true
            acceptingFiles = false
            publishLocked()
        }
        cancelActive()
        job?.cancel()
    }

    /** 返回新增数量；-1 表示原批次已停止接收，不能把迟到的文件加进下一批。 */
    fun append(files: List<File>, expectedBatchId: Long): Int = synchronized(lock) {
        if (!acceptingFiles || cancelRequested || batchError != null || expectedBatchId != batchId) return@synchronized -1
        val known = queue.mapTo(mutableSetOf()) { it.file.toPath().toAbsolutePath().normalize() }
        val added = files.filter { known.add(it.toPath().toAbsolutePath().normalize()) }
        queue.addAll(added.map(::Item))
        publishLocked()
        queueSignal?.trySend(Unit)
        added.size
    }

    fun start(
        files: List<File>,
        platform: String,
        accountIdProvider: suspend () -> String? = { UploadSessions.primaryAccountId(platform) },
        upload: suspend (UploadIo, UploadSource) -> Unit
    ) {
        if (isRunning || files.isEmpty()) return
        if (!UploadSessions.acquire(platform, ::cancel)) {
            onFinished(UploadOutcome(0, 0, false, "该网盘已有上传任务", files.size))
            return
        }
        val signal = Channel<Unit>(Channel.CONFLATED)
        synchronized(lock) {
            cancelRequested = false
            uploadPlatform = platform
            concurrencyLimit = SettingsRepository.uploadConcurrency.value
            batchId++
            batchError = null
            acceptingFiles = true
            queueSignal = signal
            queue.clear()
            queue.addAll(files.distinctBy { it.toPath().toAbsolutePath().normalize() }.map(::Item))
            publishLocked()
        }
        val worker = scope.launch(start = CoroutineStart.LAZY) {
            var cancelled = false
            val cancellationWatcher = launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() } finally { cancelActive() }
            }
            val concurrencyWatcher = launch(start = CoroutineStart.UNDISPATCHED) {
                SettingsRepository.uploadConcurrency.collect { limit ->
                    synchronized(lock) {
                        concurrencyLimit = limit
                        publishLocked()
                    }
                    signal.trySend(Unit)
                }
            }
            try {
                val identity = withContext(Dispatchers.IO) { accountIdProvider() }
                check(!identity.isNullOrBlank()) { "请先登录该网盘" }
                coroutineScope {
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val (ready, finished) = synchronized(lock) {
                            val running = queue.filter { it.progress.isActive }
                            val names = running.mapTo(mutableSetOf()) { it.file.name }
                            // 同名文件保持原先的顺序，避免并发覆盖同一个远端文件名。
                            val ready = if (batchError != null || cancelRequested) emptyList() else queue
                                .filter { it.progress.status == UploadFileStatus.WAITING && names.add(it.file.name) }
                                .take((concurrencyLimit - running.size).coerceAtLeast(0))
                            ready.forEach { it.progress = it.progress.copy(status = UploadFileStatus.PREPARING) }
                            val finished = running.isEmpty() && ready.isEmpty()
                            if (finished) acceptingFiles = false
                            publishLocked()
                            ready to finished
                        }
                        ready.forEach { item ->
                            launch(Dispatchers.IO) { uploadOne(item, identity, accountIdProvider, upload, signal) }
                        }
                        if (finished) break
                        signal.receive()
                    }
                }
            } catch (e: CancellationException) {
                cancelled = true
            } catch (e: Exception) {
                if (cancelRequested || !currentCoroutineContext().isActive) cancelled = true
                else synchronized(lock) { batchError = e.message ?: "网络错误" }
            } finally {
                cancelActive()
                cancellationWatcher.cancel()
                concurrencyWatcher.cancel()
                val outcome = synchronized(lock) {
                    val outcome = UploadOutcome(
                        queue.count { it.progress.status == UploadFileStatus.COMPLETED },
                        queue.count { it.progress.status == UploadFileStatus.FAILED },
                        cancelled || cancelRequested,
                        batchError,
                        queue.count { it.progress.status == UploadFileStatus.WAITING }
                    )
                    acceptingFiles = false
                    progress = null
                    queue.clear()
                    queueSignal = null
                    outcome
                }
                signal.close()
                UploadSessions.release(platform)
                onFinished(outcome)
            }
        }
        job = worker
        // 即使 scope 在 lazy 协程进入前已销毁，也不能遗留账号锁。
        worker.invokeOnCompletion {
            if (job === worker && progress != null) {
                cancelActive()
                synchronized(lock) {
                    acceptingFiles = false
                    progress = null
                    queue.clear()
                    queueSignal = null
                }
                signal.close()
                UploadSessions.release(platform)
            }
        }
        worker.start()
    }

    private suspend fun uploadOne(
        item: Item,
        identity: String,
        accountIdProvider: suspend () -> String?,
        upload: suspend (UploadIo, UploadSource) -> Unit,
        signal: Channel<Unit>
    ) {
        var io: UploadIo? = null
        try {
            currentCoroutineContext().ensureActive()
            check(accountIdProvider() == identity) { "账号已变化，上传已停止，请重新选择文件" }
            val source = UploadSource.resolve(item.file)
            val transfer = UploadIo(source, clientProvider) { phase, sent -> emit(item, source, phase, sent) }
            io = transfer
            synchronized(lock) {
                item.io = transfer
                item.progress = item.progress.copy(candidate = UploadCandidate(item.file, source.size))
            }
            transfer.job = currentCoroutineContext()[Job]
            if (cancelRequested) transfer.cancel()
            transfer.checkpoint()
            transfer.progress(UploadPhase.PREPARING)
            withContext(transfer.contextElement()) { upload(transfer, source) }
            currentCoroutineContext().ensureActive()
            // 请求体写完不算成功，仍须协议确认并检查本地文件未变化。
            source.verifyUnchanged()
            synchronized(lock) {
                item.progress = item.progress.copy(status = UploadFileStatus.COMPLETED, sent = source.size, bytesPerSecond = null)
            }
        } catch (e: CancellationException) {
            synchronized(lock) { item.progress = item.progress.copy(status = UploadFileStatus.CANCELLED, bytesPerSecond = null) }
            cancel()
            throw e
        } catch (e: Exception) {
            val cancelled = cancelRequested || !currentCoroutineContext().isActive
            synchronized(lock) {
                item.progress = item.progress.copy(
                    status = if (cancelled) UploadFileStatus.CANCELLED else UploadFileStatus.FAILED,
                    bytesPerSecond = null,
                    error = if (cancelled) null else e.message ?: "网络错误"
                )
                if (!cancelled) {
                    acceptingFiles = false
                    if (batchError == null) batchError = "${item.file.name}：${e.message ?: "网络错误"}"
                }
            }
        } finally {
            io?.cancel()
            synchronized(lock) {
                item.io = null
                publishLocked()
            }
            signal.trySend(Unit)
        }
    }

    private fun cancelActive() {
        val transfers = synchronized(lock) { queue.mapNotNull { it.io } }
        transfers.forEach { it.cancel() }
    }

    private fun emit(item: Item, source: UploadSource, phase: UploadPhase, sent: Long) = synchronized(lock) {
        val now = System.nanoTime()
        val current = item.progress
        val status = when (phase) {
            UploadPhase.PREPARING -> UploadFileStatus.PREPARING
            UploadPhase.UPLOADING -> UploadFileStatus.UPLOADING
            UploadPhase.FINISHING -> UploadFileStatus.FINISHING
        }
        val boundedSent = when (phase) {
            UploadPhase.PREPARING -> 0L
            UploadPhase.UPLOADING -> sent.coerceIn(0L, source.size)
            UploadPhase.FINISHING -> source.size
        }
        val changed = current.status != status || boundedSent < current.sent
        if (!changed && boundedSent != source.size && now - item.lastEmit < 120_000_000L) return@synchronized
        item.lastEmit = now
        var speed = current.bytesPerSecond
        if (changed) {
            item.speedSampleTime = now
            item.speedSampleSent = boundedSent
            speed = null
        } else if (phase == UploadPhase.UPLOADING) {
            val elapsed = now - item.speedSampleTime
            if (elapsed >= 500_000_000L || (boundedSent == source.size && boundedSent > item.speedSampleSent && elapsed > 0L)) {
                speed = (boundedSent - item.speedSampleSent) * 1_000_000_000.0 / elapsed
                item.speedSampleTime = now
                item.speedSampleSent = boundedSent
            }
        }
        item.progress = current.copy(status = status, sent = boundedSent, bytesPerSecond = speed)
        publishLocked()
    }

    /** 仅在 lock 内生成不可变快照，避免不同文件的字节数、阶段和速度相互覆盖。 */
    private fun publishLocked() {
        if (queue.isEmpty()) return
        val files = queue.map { it.progress }
        val active = files.filter { it.isActive }
        val current = active.firstOrNull() ?: files.firstOrNull { it.status == UploadFileStatus.WAITING } ?: files.last()
        val phase = when {
            active.any { it.status == UploadFileStatus.UPLOADING } -> UploadPhase.UPLOADING
            active.isNotEmpty() && active.all { it.status == UploadFileStatus.FINISHING } && files.none { it.status == UploadFileStatus.WAITING } -> UploadPhase.FINISHING
            else -> UploadPhase.PREPARING
        }
        val speeds = active.mapNotNull { it.bytesPerSecond }
        progress = UploadProgress(
            files.indexOf(current) + 1, files.size, current.candidate.file.name,
            files.sumOf { it.sent }, files.sumOf { it.candidate.size }, phase, cancelRequested,
            speeds.takeIf { it.isNotEmpty() }?.sum(), uploadPlatform, files,
            files.count { it.status == UploadFileStatus.COMPLETED }, active.size, batchId,
            acceptingFiles && !cancelRequested && batchError == null, concurrencyLimit
        )
    }
}
