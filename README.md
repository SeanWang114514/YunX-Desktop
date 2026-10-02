# 云析 YunX 桌面版

**粘贴分享链接，直接高速下载** —— [CYQawa/YunX](https://github.com/CYQawa/YunX) 的 Windows 桌面移植版。

原项目是 Kotlin + Jetpack Compose 的 Android 应用。本仓库用 **Electron + TypeScript** 重写了核心的网盘解析与下载链路，产出可分发的 Windows `.exe`。

> 本项目同样以 **AGPL-3.0** 开源，遵守原项目的开源协议。

---

## 这是什么

原版 YunX 是一款 Android 网盘解析下载 App：粘贴网盘分享链接，自动识别提取码，获取文件直链并高速下载。

Android 应用没有可以直接「转换成 exe」的跨平台层 —— Compose UI、Room 数据库、Service 后台下载都绑定 Android 运行时。所以本移植版**重写了核心链路**：

| 层 | 原版（Android） | 本移植版（桌面） |
|---|---|---|
| UI | Jetpack Compose + Material 3 | 原生 DOM + 深色主题（无框架） |
| 运行时 | Android / Kotlin 协程 | Electron 主进程 / Node.js |
| HTTP | OkHttp 4.12 | Node 内置 `fetch`（undici） |
| 持久化 | Room + SharedPreferences | JSON + Electron `safeStorage`（DPAPI 加密） |
| 后台下载 | 前台 Service + 通知 | 主进程 TaskManager |
| 登录 | WebView 抓 Cookie | BrowserWindow 抓 Cookie（同思路） |
| 网盘解析 | Kotlin 实现 | **1:1 逐行移植** |

**网盘解析与下载逻辑是忠实移植的**，包括各平台的签名算法、分片规划、转存清理时序等细节。

## 支持平台

| 平台 | 分享列表 | 获取直链 | 说明 |
|---|---|---|---|
| 夸克网盘 | 需登录 | 需登录 | 转存到临时目录后取链，含「唯一子目录」去重修复 |
| UC 网盘 | 需登录 | 需登录 | 支持 HLS 转码流（绕过非会员视频限制） |
| 迅雷网盘 | 需登录 | 需登录 | 含设备指纹 |
| 百度网盘 | **可匿名浏览** | 需登录 | 取链后立即清理转存 |
| 139 网盘 | **可匿名浏览** | 需登录 | AES-128-CBC 加密通道；分享密码明文可见 |
| 123 云盘 | **可匿名浏览** | 需登录 | CRC-32 签名；无转存步骤 |

## 下载

到 [Releases](https://github.com/SeanWang114514/YunX-Desktop/releases) 下载最新版（Windows x64）：

| 文件 | 说明 |
|---|---|
| `YunX-Desktop-<版本>-x64-Setup.exe` | NSIS 安装包，可选安装目录、自动创建快捷方式 |
| `YunX-Desktop-<版本>-x64-Portable.exe` | 单文件便携版，双击即用，无需安装 |

> 未做代码签名，Windows SmartScreen 可能提示"未知发布者"，选择"仍要运行"即可。

## 构建

要求：Node.js ≥ 18。

```bash
npm install
npm run build      # 编译主进程 + 打包渲染层
npm run dev        # 构建并启动
npm run dist       # 打包为 Windows 安装包 + 便携版 exe
npm test           # 运行全部测试（89 项断言）
```

产物在 `release/`：
- `YunX-Desktop-<版本>-x64-Setup.exe` —— NSIS 安装包（可选安装目录、桌面快捷方式）
- `YunX-Desktop-<版本>-x64-Portable.exe` —— 单文件便携版，双击即用

推 `v*` tag 会触发 GitHub Actions 自动跑测试并构建、发布 Release。

## 使用

1. 「账号」页登录需要的网盘（点击「登录」会打开官网，登录后自动提取 Cookie；也可手动粘贴 Cookie）
2. 「解析」页粘贴分享链接（可带提取码，或直接粘贴整段分享文案）
3. 浏览分享内容，点击文件「下载」
4. 「下载」页查看进度，支持暂停 / 继续 / 删除 / 打开

## 技术要点

### 分片下载

移植自原版 `ChunkDownloader.kt` 的契约：

- **Range 分片 + 并发**：按文件大小切分（目标 4MB/片，上限 64 片），并发数可配（默认 16）
- **断点续传**：每片落盘为独立 `.part` 文件，重试时从 `part.length()` 续传
- **拒绝整文件陷阱**：服务器忽略 Range（返回 200）时**绝不为单片下载整个文件**，而是回退单流
- **严格校验**：写入后校验「已写字节 == 预期字节」，杜绝空洞/损坏文件
- **HTML 检测**：响应为 `text/html` 视为防盗链/过期页，直接失败，绝不存盘
- **边写边删合并**：合并分片时写完一片立即删除，峰值占用 ≈ 文件大小 + 1 片

### 各平台签名（移植关键点）

- **123 云盘**：`auth-key` = CRC32(UTC +16h 的时间戳经替换表映射)，**hex 不补零**（对齐 Kotlin `Long.toHexString`）；`auth-value` = `ts-random-crc32(...)`
- **139 网盘**：AES-128-CBC，固定密钥 `PVGDwmcvfs1uV3d1`，随机 IV 前置，`mcloud-sign` 对**明文** body 计算后再加密
- **夸克**：`__puus`/`__pus` 响应回写 + 转存到唯一临时子目录绕过去重（避免二次转存返回已删除 fid）
- **百度**：`psign` 为固定常量，无需客户端签名算法

## 免责声明

本项目仅供个人学习与技术交流，请勿用于商业用途。下载内容版权归原作者所有，请在下载后 24 小时内删除。使用本项目产生的任何后果由使用者自行承担。

原项目 README 中的提醒同样适用：**不建议使用百度网盘，可能导致账号被风控。**

## 开源协议

[GNU AGPL-3.0](./LICENSE) —— 与原项目一致。如果你使用了本项目的代码，请同样以 AGPL-3.0 开放源代码。

原项目：https://github.com/CYQawa/YunX （作者 CYQawa）
