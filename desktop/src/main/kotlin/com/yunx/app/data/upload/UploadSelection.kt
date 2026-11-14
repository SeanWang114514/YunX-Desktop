package com.yunx.app.data.upload

import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable
import java.io.File

data class UploadCandidate(val file: File, val size: Long)

/** 选择器和系统拖放共用的预检；只读取元数据，不读取文件内容。 */
data class UploadSelection(val files: List<UploadCandidate>, val notice: String?) {
    companion object {
        fun readDrop(transferable: Transferable): List<File> {
            require(transferable.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) { "请从文件管理器拖入本地文件" }
            val value = transferable.getTransferData(DataFlavor.javaFileListFlavor)
            require(value is List<*> && value.all { it is File }) { "无法读取拖入的文件列表" }
            return value.filterIsInstance<File>()
        }

        fun merge(existing: List<UploadCandidate>, incoming: List<File>): UploadSelection {
            val selected = existing.associateByTo(linkedMapOf()) { it.file.toPath() }
            var folders = 0
            var invalid = 0
            var duplicates = 0
            for (file in incoming) {
                try {
                    val resolved = file.toPath().toRealPath().toFile()
                    when {
                        resolved.isDirectory -> folders++
                        !resolved.isFile || !resolved.canRead() -> invalid++
                        selected.containsKey(resolved.toPath()) -> duplicates++
                        else -> selected[resolved.toPath()] = UploadCandidate(resolved, resolved.length())
                    }
                } catch (_: Exception) {
                    invalid++
                }
            }
            val notices = buildList {
                if (folders > 0) add("已跳过 $folders 个文件夹，暂不支持递归上传")
                if (invalid > 0) add("已跳过 $invalid 个不存在或不可读取的文件")
                if (duplicates > 0) add("已忽略 $duplicates 个重复文件")
            }
            return UploadSelection(selected.values.toList(), notices.takeIf { it.isNotEmpty() }?.joinToString("；"))
        }
    }
}
