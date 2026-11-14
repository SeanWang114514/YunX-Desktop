package com.yunx.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yunx.app.data.upload.UploadCandidate
import com.yunx.app.data.upload.UploadFileStatus
import com.yunx.app.data.upload.UploadPhase
import com.yunx.app.data.upload.UploadProgress
import java.io.File
import kotlin.math.roundToLong

internal data class UploadTaskDisplay(val progress: UploadProgress, val onCancel: () -> Unit, val onAppend: (List<File>, Long) -> Int)
internal data class UploadPresentation(val destination: String, val files: List<UploadCandidate>)

internal object UploadPresentationRegistry {
    val entries = mutableStateMapOf<String, UploadPresentation>()
}

/** 窗口内非模态上传卡片，任务继续由原 ViewModel 执行。 */
@Composable
internal fun UploadProgressHost(tasks: List<UploadTaskDisplay>) {
    var expandedPlatform by remember { mutableStateOf<String?>(null) }
    var appendBatch by remember { mutableStateOf<Pair<String, Long>?>(null) }
    var appendRequest by remember { mutableStateOf(0) }
    var droppedFiles by remember { mutableStateOf<List<File>?>(null) }
    val previousBatches = remember { mutableSetOf<Pair<String, Long>>() }
    val platforms = tasks.map { it.progress.platform }
    val batches = tasks.map { it.progress.platform to it.progress.batchId }
    LaunchedEffect(batches) {
        val started = batches.filterNot { it in previousBatches }
        if (started.isNotEmpty()) expandedPlatform = started.last().first
        else if (expandedPlatform !in platforms) expandedPlatform = null
        previousBatches.clear()
        previousBatches.addAll(batches)
        UploadPresentationRegistry.entries.keys.toList().filterNot { it in platforms }.forEach {
            UploadPresentationRegistry.entries.remove(it)
        }
    }

    val appendTask = tasks.firstOrNull { (it.progress.platform to it.progress.batchId) == appendBatch }
    val appendUi = rememberUploadUi(
        destinationKey = appendBatch,
        destination = appendTask?.let { UploadPresentationRegistry.entries[it.progress.platform]?.destination }.orEmpty(),
        enabled = appendTask?.progress?.let { it.canAppend && !it.cancelling } == true,
        onUpload = { files ->
            val added = appendTask?.let { it.onAppend(files, it.progress.batchId) } ?: -1
            showUploadAppendResult(added)
        }
    )
    LaunchedEffect(appendRequest) {
        if (appendRequest > 0 && appendTask != null) {
            // 先提交本次批次的目标和回调，再打开原生多选，避免首次点击读到旧状态。
            withFrameNanos { }
            val files = droppedFiles
            if (files == null) appendUi.pick() else appendUi.stage(files)
        }
    }
    LaunchedEffect(appendTask != null) { if (appendTask == null) appendUi.dismiss() }
    fun requestAppend(task: UploadTaskDisplay, files: List<File>? = null) {
        appendBatch = task.progress.platform to task.progress.batchId
        droppedFiles = files
        appendRequest++
        expandedPlatform = null
    }

    val backgroundTasks = tasks.filter { it.progress.platform != expandedPlatform }
    if (backgroundTasks.isNotEmpty()) Box(Modifier.fillMaxSize().padding(16.dp)) {
        Column(
            modifier = Modifier.align(Alignment.BottomEnd).widthIn(max = 360.dp).fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            backgroundTasks.forEach { task ->
                val p = task.progress
                Surface(
                    modifier = Modifier.fillMaxWidth()
                        .uploadDropTarget(enabled = p.canAppend && !p.cancelling, onFiles = { requestAppend(task, it) })
                        .clickable { expandedPlatform = p.platform },
                    shape = MaterialTheme.shapes.large,
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    shadowElevation = 4.dp
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(when {
                                p.cancelling -> "正在取消…"
                                p.phase == UploadPhase.FINISHING -> "等待网盘确认 · ${p.completed}/${p.count}"
                                else -> "后台上传 · 完成 ${p.completed}/${p.count}"
                            }, modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            TextButton(onClick = { expandedPlatform = p.platform }, modifier = Modifier.height(24.dp), contentPadding = PaddingValues(horizontal = 4.dp)) {
                                Text("查看任务", style = MaterialTheme.typography.labelSmall)
                            }
                            TextButton(onClick = { requestAppend(task) }, enabled = p.canAppend && !p.cancelling, modifier = Modifier.height(24.dp), contentPadding = PaddingValues(0.dp)) {
                                Text("添加文件", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                        Text("处理中 ${p.activeCount} 个 · 并发上限 ${p.concurrencyLimit} 个", style = MaterialTheme.typography.bodySmall)
                        if (p.files.isEmpty()) Text(p.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        else p.files.filter { it.isActive || it.status == UploadFileStatus.WAITING }
                            .sortedBy { !it.isActive }.take(3).forEach { item ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(item.candidate.file.name, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        uploadFileStatusText(item.status) + if (item.status == UploadFileStatus.UPLOADING && item.candidate.size > 0)
                                            " ${(item.sent * 100.0 / item.candidate.size).roundToLong()}%" else "",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary
                                    )
                                }
                            }
                        if (p.phase == UploadPhase.UPLOADING) {
                            LinearProgressIndicator(progress = { p.fraction }, modifier = Modifier.fillMaxWidth())
                        } else {
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                (if (p.phase == UploadPhase.UPLOADING) "${(p.fraction * 100).toInt()}% · " else "") +
                                    (p.bytesPerSecond?.let { "${formatUploadBytes(it.roundToLong())}/s" } ?: "--"),
                                style = MaterialTheme.typography.bodySmall
                            )
                            Box(Modifier.size(width = 132.dp, height = 28.dp), contentAlignment = Alignment.CenterEnd) {
                                Text(formatUploadRemainingTime(p.remainingSeconds), style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, maxLines = 1, softWrap = false)
                            }
                        }
                    }
                }
            }
        }
    }

    val expanded = tasks.firstOrNull { it.progress.platform == expandedPlatform }
    val presentation = expanded?.let { UploadPresentationRegistry.entries[it.progress.platform] }
    UploadProgressDialog(
        progress = expanded?.progress,
        onCancel = { expanded?.onCancel?.invoke() },
        destination = presentation?.destination.orEmpty(),
        files = presentation?.files.orEmpty(),
        onBackground = { expandedPlatform = null },
        onAddFiles = expanded?.let { { requestAppend(it) } },
        onDropFiles = expanded?.let { task -> { files -> requestAppend(task, files) } }
    )
    UploadDialogs(appendUi, progress = null, onCancel = {}, appendMode = true)
}
