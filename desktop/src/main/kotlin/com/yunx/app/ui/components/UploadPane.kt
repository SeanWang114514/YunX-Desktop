package com.yunx.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.TooltipArea
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.awtTransferable
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.yunx.app.data.upload.UploadCandidate
import com.yunx.app.data.prefs.SettingsRepository
import com.yunx.app.data.upload.UploadFileProgress
import com.yunx.app.data.upload.UploadFileStatus
import com.yunx.app.data.upload.UploadProgress
import com.yunx.app.data.upload.UploadSelection
import com.yunx.app.ui.BackHandler
import com.yunx.app.ui.SnackbarController
import com.yunx.app.util.DesktopActions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.datatransfer.DataFlavor
import java.awt.dnd.DnDConstants
import java.awt.dnd.DropTargetDropEvent
import java.io.File
import kotlin.math.roundToLong

@Stable
class UploadUiState internal constructor(private val scope: CoroutineScope) {
    var visible by mutableStateOf(false)
        private set
    var checking by mutableStateOf(false)
        private set
    var files by mutableStateOf(emptyList<UploadCandidate>())
        private set
    var notice by mutableStateOf<String?>(null)
        private set
    var dragging by mutableStateOf(false)
        internal set
    var destination by mutableStateOf("")
        private set
    var submitted by mutableStateOf(emptyList<UploadCandidate>())
        private set
    var appendMode by mutableStateOf(false)
        private set
    internal var enabled by mutableStateOf(false)
    internal var currentDestination = ""
    internal var currentAppendMode = false
    internal var onUpload: (List<File>) -> Unit = {}
    private var submit: (List<File>) -> Unit = {}
    private var selectionJob: Job? = null
    private var selectionToken = 0

    fun open() {
        if (!enabled || checking) return
        if (!visible) {
            destination = currentDestination
            appendMode = currentAppendMode
            // 确认期间批次可能结束，固定提交动作，不能把追加误发到下一批或新目录。
            submit = onUpload
        }
        visible = true
    }

    fun dismiss() {
        selectionToken++
        selectionJob?.cancel()
        visible = false
        checking = false
        dragging = false
        files = emptyList()
        notice = null
    }

    fun pick() {
        if (!enabled || checking) return
        open()
        checking = true
        val token = ++selectionToken
        selectionJob = scope.launch {
            try {
                val picked = DesktopActions.pickFiles()
                if (picked.isNotEmpty()) merge(picked)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = e.message ?: "无法打开文件选择器"
            } finally {
                if (token == selectionToken) checking = false
            }
        }
    }

    fun stage(incoming: List<File>) {
        if (!enabled || checking || incoming.isEmpty()) return
        open()
        checking = true
        val token = ++selectionToken
        selectionJob = scope.launch {
            try {
                merge(incoming)
            } finally {
                if (token == selectionToken) checking = false
            }
        }
    }

    internal fun dropFailed() {
        open()
        notice = "无法读取拖入的文件，请使用“选择文件”重试"
    }

    private suspend fun merge(incoming: List<File>) {
        val previous = files
        val selection = withContext(Dispatchers.IO) { UploadSelection.merge(previous, incoming) }
        files = selection.files
        notice = selection.notice
    }

    fun remove(file: UploadCandidate) {
        if (!checking) files = files - file
    }

    fun start() {
        if (!enabled || checking || files.isEmpty()) return
        if (!appendMode) submitted = files
        val batch = files.map { it.file }
        val action = submit
        dismiss()
        action(batch)
    }
}

@Composable
fun rememberUploadUi(
    destinationKey: Any?,
    destination: String,
    enabled: Boolean,
    progress: UploadProgress? = null,
    onAppend: ((List<File>, Long) -> Int)? = null,
    onUpload: (List<File>) -> Unit
): UploadUiState {
    val scope = rememberCoroutineScope()
    val state = remember(scope) { UploadUiState(scope) }
    val batch = progress?.takeIf { onAppend != null }
    SideEffect {
        state.enabled = enabled && batch?.canAppend != false && batch?.cancelling != true
        state.currentDestination = batch?.let { UploadPresentationRegistry.entries[it.platform]?.destination }
            ?.takeIf { it.isNotBlank() } ?: destination
        state.currentAppendMode = batch != null
        state.onUpload = if (batch == null) onUpload else { files ->
            showUploadAppendResult(onAppend!!.invoke(files, batch.batchId))
        }
    }
    // 目录被刷新/切换时关闭预选，避免把确认窗口中的文件发到新目录。
    LaunchedEffect(destinationKey) { state.dismiss() }
    return state
}

/** 只接收系统本地文件列表，不接受网页文本/链接；源文件始终按复制处理。 */
@OptIn(ExperimentalFoundationApi::class, ExperimentalComposeUiApi::class)
@Composable
fun Modifier.uploadDropTarget(state: UploadUiState, allowOverlays: Boolean = false): Modifier = uploadDropTarget(
    enabled = state.enabled && !state.checking,
    allowOverlays = allowOverlays,
    onFiles = state::stage,
    onDragging = { state.dragging = it },
    onError = state::dropFailed
)

@OptIn(ExperimentalFoundationApi::class, ExperimentalComposeUiApi::class)
@Composable
internal fun Modifier.uploadDropTarget(
    enabled: Boolean,
    allowOverlays: Boolean = false,
    onFiles: (List<File>) -> Unit,
    onDragging: (Boolean) -> Unit = {},
    onError: () -> Unit = { SnackbarController.show("无法读取拖入的文件，请使用“添加文件”重试") }
): Modifier {
    val canDrop by rememberUpdatedState(enabled && (allowOverlays || OverlayDialogRegistry.entries.isEmpty()))
    val receiveFiles by rememberUpdatedState(onFiles)
    val updateDragging by rememberUpdatedState(onDragging)
    val reportError by rememberUpdatedState(onError)
    val target = remember {
        object : DragAndDropTarget {
            override fun onEntered(event: DragAndDropEvent) { updateDragging(true) }
            override fun onExited(event: DragAndDropEvent) { updateDragging(false) }
            override fun onEnded(event: DragAndDropEvent) { updateDragging(false) }
            override fun onDrop(event: DragAndDropEvent): Boolean {
                updateDragging(false)
                if (!canDrop) return false
                return try {
                    // Compose 1.7.3 默认沿用 Explorer 的 MOVE；明确改成 COPY，绝不删除本地源文件。
                    val native = event.nativeEvent as? DropTargetDropEvent ?: return false
                    if (native.sourceActions and DnDConstants.ACTION_COPY == 0) return false
                    native.acceptDrop(DnDConstants.ACTION_COPY)
                    val files = UploadSelection.readDrop(event.awtTransferable)
                    if (files.isEmpty()) return false
                    receiveFiles(files)
                    true
                } catch (_: Exception) {
                    reportError()
                    false
                }
            }
        }
    }
    return dragAndDropTarget(
        shouldStartDragAndDrop = { event ->
            canDrop &&
                event.awtTransferable.isDataFlavorSupported(DataFlavor.javaFileListFlavor)
        },
        target = target
    )
}

internal fun showUploadAppendResult(added: Int) {
    SnackbarController.show(when {
        added > 0 -> "已追加 $added 个文件到上传队列"
        added == 0 -> "所选文件已经在本批次队列中"
        else -> "本批次已结束或停止接收文件，请重新开始上传"
    })
}

internal fun showUploadRetryResult(count: Int) {
    SnackbarController.show(if (count > 0) "已重新排队 $count 个失败文件" else "任务已变化或已有上传正在执行，请查看当前任务")
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
fun UploadIconButton(onClick: () -> Unit, enabled: Boolean) {
    TooltipArea(
        tooltip = {
            Surface(
                shape = MaterialTheme.shapes.extraSmall,
                color = MaterialTheme.colorScheme.inverseSurface,
                contentColor = MaterialTheme.colorScheme.inverseOnSurface,
                shadowElevation = 4.dp
            ) {
                Text("上传文件", Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
            }
        },
        delayMillis = 500
    ) {
        IconButton(
            onClick = onClick,
            enabled = enabled,
            colors = IconButtonDefaults.iconButtonColors(contentColor = MaterialTheme.colorScheme.primary)
        ) {
            Icon(Icons.Outlined.UploadFile, contentDescription = "上传文件")
        }
    }
}

@Composable
fun UploadDropHint(state: UploadUiState, enabled: Boolean) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        shape = MaterialTheme.shapes.medium,
        color = if (state.dragging) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, if (state.dragging) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(if (state.dragging) "松开文件，添加到上传列表" else "拖拽文件到此页面上传", style = MaterialTheme.typography.titleSmall)
                Text("支持多文件 · 上传前可预览和移除 · 暂不支持文件夹", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            OutlinedButton(onClick = state::pick, enabled = enabled && !state.checking) { Text("选择文件") }
        }
    }
}

@Composable
fun UploadDialogs(state: UploadUiState, progress: UploadProgress?, onCancel: () -> Unit, appendMode: Boolean = state.appendMode) {
    val concurrency by SettingsRepository.uploadConcurrency.collectAsState()
    BackHandler(enabled = state.visible) { state.dismiss() }
    FadeAlertDialog(
        visible = state.visible,
        onDismissRequest = state::dismiss,
        title = { Text(if (appendMode) "追加上传文件" else "上传文件", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(modifier = Modifier.fillMaxWidth().uploadDropTarget(state, allowOverlays = true), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                UploadDestination(state.destination)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("已选 " + state.files.size + " 个 · " + formatUploadBytes(state.files.sumOf { it.size }), style = MaterialTheme.typography.labelLarge)
                    TextButton(onClick = state::pick, enabled = !state.checking && state.enabled) { Text("添加文件") }
                }
                if (state.files.isEmpty()) {
                    Text("选择或拖入本地文件后，在这里确认上传。", modifier = Modifier.padding(vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    UploadFileList(state.files, onRemove = if (state.checking) null else state::remove)
                }
                state.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                if (state.checking) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("正在选择或检查文件…", style = MaterialTheme.typography.bodySmall)
                }
                Text(if (state.dragging) "松开文件，继续添加到此列表" else "可继续拖入多个文件，确认后加入上传队列。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                Text(if (appendMode) "加入本批次固定的账号与目录，当前文件并发上限 $concurrency 个。" else "当前文件并发上限 $concurrency 个，可在设置中调整；同名文件依次上传，单个文件内的分片按顺序发送。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        dismissButton = { TextButton(onClick = state::dismiss) { Text("取消") } },
        confirmButton = { Button(onClick = state::start, enabled = state.enabled && !state.checking && state.files.isNotEmpty()) { Text(if (appendMode) "加入上传队列" else "开始上传") } }
    )
    if (progress != null && progress.platform.isNotEmpty() && state.submitted.isNotEmpty()) {
        // 详情由主窗口常驻组件显示，切换页面后仍保留本批次的目标和文件列表。
        SideEffect {
            UploadPresentationRegistry.entries[progress.platform] = UploadPresentation(state.destination, state.submitted)
        }
    } else if (progress?.platform.isNullOrEmpty()) {
        UploadProgressDialog(progress, onCancel, state.destination, state.submitted)
    }
}

@Composable
internal fun UploadDestination(destination: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("上传到", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(destination, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun UploadFileList(files: List<UploadCandidate>, currentIndex: Int? = null, onRemove: ((UploadCandidate) -> Unit)? = null, progresses: List<UploadFileProgress> = emptyList(), modifier: Modifier = Modifier) {
    val listState = rememberLazyListState()
    LaunchedEffect(currentIndex) {
        if (progresses.isEmpty() && currentIndex != null && files.isNotEmpty()) listState.scrollToItem((currentIndex - 1).coerceIn(files.indices))
    }
    Box(modifier.fillMaxWidth().heightIn(max = 200.dp)) {
        LazyColumn(Modifier.fillMaxWidth().padding(end = 12.dp), state = listState, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            itemsIndexed(files, key = { _, file -> file.file.path }) { index, file ->
                val item = progresses.getOrNull(index)
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text("${index + 1}. ${file.file.name}", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                            Text(if (item?.isActive == true) "${formatUploadBytes(item.sent)} / ${formatUploadBytes(file.size)}" else formatUploadBytes(file.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (item != null) Text(uploadFileStatusText(item.status), style = MaterialTheme.typography.labelSmall, color = if (item.status == UploadFileStatus.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                        else if (currentIndex != null) Text(when {
                            index < currentIndex - 1 -> "已完成"
                            index == currentIndex - 1 -> "处理中"
                            else -> "等待中"
                        }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        onRemove?.let { remove -> IconButton(onClick = { remove(file) }) { Icon(Icons.Default.Close, contentDescription = "移除 " + file.file.name) } }
                    }
                    if (item?.isActive == true) {
                        val fraction = if (file.size <= 0) 0f else (item.sent.toDouble() / file.size).toFloat().coerceIn(0f, 1f)
                        if (item.status == UploadFileStatus.PREPARING && item.sent == 0L) LinearProgressIndicator(Modifier.fillMaxWidth())
                        else LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                if (item.stalled) "网络等待，暂无速度"
                                else if (item.status == UploadFileStatus.UPLOADING) "${(fraction * 100).roundToLong()}% · " +
                                    (item.bytesPerSecond?.let { "${formatUploadBytes(it.roundToLong())}/s" } ?: "--")
                                else if (item.status == UploadFileStatus.PREPARING) "读取文件 / 计算校验"
                                else "文件已发送，等待网盘确认",
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            val remaining = item.bytesPerSecond
                                ?.takeIf { item.status == UploadFileStatus.UPLOADING && it > 0.0 && it.isFinite() }
                                ?.let { ((file.size - item.sent).coerceAtLeast(0L) / it).roundToLong() }
                            Box(Modifier.size(width = 132.dp, height = 28.dp), contentAlignment = Alignment.CenterEnd) {
                                Text(formatUploadRemainingTime(remaining), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 1, softWrap = false)
                            }
                        }
                    }
                    item?.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        if (files.isNotEmpty()) VerticalScrollbar(rememberScrollbarAdapter(listState), Modifier.align(Alignment.CenterEnd))
    }
}

internal fun uploadFileStatusText(status: UploadFileStatus): String = when (status) {
    UploadFileStatus.WAITING -> "等待中"
    UploadFileStatus.PREPARING -> "准备中"
    UploadFileStatus.UPLOADING -> "上传中"
    UploadFileStatus.FINISHING -> "等待确认"
    UploadFileStatus.COMPLETED -> "已完成"
    UploadFileStatus.FAILED -> "失败"
    UploadFileStatus.CANCELLED -> "已取消"
}
