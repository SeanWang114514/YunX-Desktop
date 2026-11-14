package com.yunx.app.ui.components

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.yunx.app.data.upload.UploadPhase
import com.yunx.app.data.upload.UploadProgress
import com.yunx.app.data.upload.UploadCandidate
import com.yunx.app.data.upload.UploadFileStatus
import com.yunx.app.ui.BackHandler
import java.util.Locale
import java.io.File
import kotlin.math.roundToLong

@Composable
fun UploadProgressDialog(
    progress: UploadProgress?,
    onCancel: () -> Unit,
    destination: String = "",
    files: List<UploadCandidate> = emptyList(),
    onBackground: (() -> Unit)? = null,
    onAddFiles: (() -> Unit)? = null,
    onDropFiles: ((List<File>) -> Unit)? = null
) {
    BackHandler(enabled = progress != null) { onBackground?.invoke() }
    FadeAlertDialog(
        visible = progress != null,
        // 收起界面不取消任务，取消仍须点击明确的按钮。
        onDismissRequest = { onBackground?.invoke() },
        constrainTextHeight = true,
        title = { Text("正在上传", style = MaterialTheme.typography.headlineSmall) },
        text = {
            progress?.let { p ->
                Column(
                    modifier = (if (onDropFiles == null) Modifier else Modifier.fillMaxWidth().uploadDropTarget(
                        enabled = p.canAppend && !p.cancelling,
                        allowOverlays = true,
                        onFiles = onDropFiles
                    )).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    if (destination.isNotBlank()) UploadDestination(destination)
                    Text(if (p.files.isNotEmpty()) "已完成 ${p.completed} / ${p.count} 个 · 处理中 ${p.activeCount} 个 · 上限 ${p.concurrencyLimit} 个" else "第 ${p.index} / ${p.count} 个文件", style = MaterialTheme.typography.labelLarge)
                    if (p.files.isEmpty()) Text(p.name, style = MaterialTheme.typography.bodyMedium)
                    else Text(
                        "正在传输 ${p.files.count { it.status == UploadFileStatus.UPLOADING }} 个 · 准备 ${p.files.count { it.status == UploadFileStatus.PREPARING }} 个 · 等待确认 ${p.files.count { it.status == UploadFileStatus.FINISHING }} 个 · 排队 ${p.files.count { it.status == UploadFileStatus.WAITING }} 个",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    if (p.cancelling || p.files.isEmpty()) Text(when {
                        p.cancelling -> "正在取消…"
                        p.phase == UploadPhase.PREPARING -> "正在读取文件、计算校验并创建上传任务…"
                        p.phase == UploadPhase.FINISHING -> "文件已发送，正在等待网盘确认…"
                        else -> "正在上传…"
                    })
                    if (p.phase == UploadPhase.UPLOADING) {
                        LinearProgressIndicator(progress = { p.fraction }, modifier = Modifier.fillMaxWidth())
                        Text("${formatUploadBytes(p.sent)} / ${formatUploadBytes(p.size)}（${(p.fraction * 100).toInt()}%）")
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                "${if (p.files.isNotEmpty()) "合计" else "速度"} " + (p.bytesPerSecond?.let { "${formatUploadBytes(it.roundToLong())}/s" } ?: "--"),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Box(modifier = Modifier.size(width = 132.dp, height = 28.dp), contentAlignment = Alignment.CenterEnd) {
                                Text(
                                    "剩余 " + formatUploadRemainingTime(p.remainingSeconds),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    softWrap = false
                                )
                            }
                        }
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                    if (p.files.isNotEmpty()) {
                        Text("文件任务 · 滚动查看全部 ${p.count} 个文件", style = MaterialTheme.typography.labelLarge)
                        UploadFileList(p.files.map { it.candidate }, progresses = p.files)
                    } else if (files.isNotEmpty()) UploadFileList(files, currentIndex = p.index)
                    Text("可拖入文件追加，点击空白处后台上传。取消或退出程序会中止未完成文件，不撤回已保存文件。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        dismissButton = {
            if (onBackground != null) TextButton(onClick = onBackground) { Text("后台上传") }
            if (onAddFiles != null) TextButton(onClick = onAddFiles, enabled = progress?.canAppend == true && progress.cancelling == false) { Text("添加文件") }
        },
        confirmButton = {
            TextButton(onClick = onCancel, enabled = progress?.cancelling == false) {
                Text(if (progress?.cancelling == true) "正在取消…" else "取消上传")
            }
        }
    )
}

internal fun formatUploadRemainingTime(seconds: Long?): String {
    if (seconds == null) return "--:--:--"
    return String.format(Locale.ROOT, "%02d:%02d:%02d", seconds / 3600, seconds % 3600 / 60, seconds % 60)
}

internal fun formatUploadBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> String.format(Locale.ROOT, "%.2f GiB", bytes / (1024.0 * 1024 * 1024))
    bytes >= 1024L * 1024 -> String.format(Locale.ROOT, "%.1f MiB", bytes / (1024.0 * 1024))
    bytes >= 1024 -> String.format(Locale.ROOT, "%.1f KiB", bytes / 1024.0)
    else -> "$bytes B"
}
