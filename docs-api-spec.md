# Cloud-Drive Share-Link Resolution API Specification

**Source of truth:** `D:\VibeCoding\云析转exe\repo` — YunX (云析) Android app, Kotlin, AGPL-3.0.
**Purpose:** implementation-ready specification for a TypeScript / Windows desktop port.
**Method:** every value below is quoted verbatim from the Kotlin source. Anything not present in the source is marked `UNCERTAIN` and is **not** invented.

## 0. Files read (complete list of evidence)

| File | Role |
|---|---|
| `app/src/main/kotlin/com/yunx/app/data/network/ShareLinkParser.kt` | Link/regex parsing for all platforms |
| `app/src/main/kotlin/com/yunx/app/data/network/model/ShareModels.kt` | `ShareSession`, `ShareFile`, `DownloadLink` data shapes |
| `app/src/main/kotlin/com/yunx/app/data/network/BaiduConstants.kt` | Baidu constants |
| `app/src/main/kotlin/com/yunx/app/data/network/BaiduApi.kt` | Baidu HTTP implementation |
| `app/src/main/kotlin/com/yunx/app/data/repository/BaiduResolveRepository.kt` | Baidu resolve orchestration |
| `app/src/main/kotlin/com/yunx/app/data/network/Pan123Constants.kt` | 123 constants |
| `app/src/main/kotlin/com/yunx/app/data/network/Pan123Api.kt` | 123 HTTP implementation + signing |
| `app/src/main/kotlin/com/yunx/app/data/repository/Pan123ResolveRepository.kt` | 123 resolve orchestration |
| `app/src/main/kotlin/com/yunx/app/data/network/C139Constants.kt` | 139 constants + cookie extraction |
| `app/src/main/kotlin/com/yunx/app/data/network/C139Api.kt` | 139 HTTP implementation + AES |
| `app/src/main/kotlin/com/yunx/app/data/repository/C139ResolveRepository.kt` | 139 resolve orchestration |
| `app/src/main/kotlin/com/yunx/app/data/network/HttpClients.kt` | HTTP client timeouts / retry policy |
| `app/src/main/kotlin/com/yunx/app/data/repository/ShareResolveRepository.kt` | Common resolve interface |
| `app/src/main/kotlin/com/yunx/app/ui/viewmodel/ResolveViewModel.kt` | Which credential is passed, download headers, login gating |
| `app/src/main/kotlin/com/yunx/app/data/network/BaiduApiException.kt` | Error type |

## 1. Shared: link parsing (`ShareLinkParser.kt`)

All regexes are Kotlin `Regex` with `RegexOption.IGNORE_CASE` except where noted. Group 1 is always the share id.

```kotlin
private val urlRegex = Regex("""https?://[^\s]+""")
private val baiduShareIdRegex   = Regex("""pan\.baidu\.com/s/(1[A-Za-z0-9_-]+)""", RegexOption.IGNORE_CASE)
private val c139ShareIdRegex    = Regex("""yun\.139\.com/shareweb/.*?/w/i/([A-Za-z0-9_-]+)""", RegexOption.IGNORE_CASE)
private val pan123ShareIdRegex  = Regex("""123(?:865|pan)\.(?:com|cn)/s/([A-Za-z0-9]+-[A-Za-z0-9]+)""", RegexOption.IGNORE_CASE)
private val pan123ShareSubRegex = Regex("""share\.123pan\.cn/123pan/([A-Za-z0-9-]+)""", RegexOption.IGNORE_CASE)
private val pan123SrrRegex      = Regex("""api/srr\?sk=([A-Za-z0-9-]+)""", RegexOption.IGNORE_CASE)
private val pwdInUrlRegex       = Regex("""[?&]pwd=([A-Za-z0-9]+)""")            // NO ignore-case
private val pwdInTextRegex      = Regex("""(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})""")  // NO ignore-case
```

Parsing algorithm (`parse(text: String): ParsedShare?`):

1. `trim()` the input text.
2. Find the **first** URL: `urlRegex.find(text.trim())?.value`, then strip trailing punctuation:
   `.trimEnd('。', '，', ',', '；', ';', ')', ']', '}', '"', '\'')`.
   If no URL is found → return `null` (no share).
3. Try platform regexes **in this exact order** — first match wins:
   `quark → uc → xunlei → baidu → c139 → pan123ShareIdRegex → pan123ShareSubRegex → pan123SrrRegex`.
4. For the matched platform, password resolution order is:
   `pwdInUrlRegex.find(url)?.groupValues?.getOrNull(1)` **first**, else
   `pwdInTextRegex.find(text)?.groupValues?.getOrNull(1)` **second**, else `null`.
   Note the text-password regex is applied to the **whole original text**, not just the URL.
5. Baidu only — `surl` handling:

```kotlin
baiduShareIdRegex.find(url)?.groupValues?.getOrNull(1)?.let { sid ->
    // 百度 surl 不包含开头的 "1"（verify/list 接口用 1 后面的部分）
    val surl = sid.removePrefix("1")
    ...
    return ParsedShare(shareId = surl, pwd = pwd, platform = SharePlatform.BAIDU)
}
```

   The regex requires the id to **start with `1`**; the leading `1` is then removed with `removePrefix("1")`. So
   `https://pan.baidu.com/s/1AbCdEf?pwd=xyzw` → `shareId = "AbCdEf"`, `pwd = "xyzw"`.
   `UNCERTAIN:` if a share id begins with `1` followed by more characters that also form `1`, `removePrefix` removes only the first character. This matches Kotlin `String.removePrefix` semantics exactly (removes one leading occurrence).

```kotlin
data class ParsedShare(val shareId: String, val pwd: String?, val platform: SharePlatform)
enum class SharePlatform { QUARK, UC, XUNLEI, BAIDU, C139, PAN123, GITHUB }
```

### 1.1 Common model shapes (`ShareModels.kt`)

```kotlin
data class ShareSession(val shareId: String, val stoken: String, val title: String)

data class ShareFile(
    val fid: String,
    val fname: String,
    val fsize: Long,
    val isdir: Boolean,
    val pdirFid: String,
    val fidToken: String,
    val modifyTime: String = ""
)

data class DownloadLink(
    val fid: String,
    val filename: String,
    val downloadUrl: String,
    val size: Long,
    val cleanupDirFid: String? = null,
    val isHls: Boolean = false
)
```

`ShareSession.stoken` is **overloaded per platform** — it is not always a token:

| Platform | `shareId` holds | `stoken` holds |
|---|---|---|
| BAIDU | `surl` (share id without leading `1`) | `sekey` = `randsk` from `share/verify` (empty string when public) |
| PAN123 | `shareKey` | the share password (`sharePwd`), possibly `""` |
| C139 | `linkID` | the share password (`passwd`), possibly `""` |

### 1.2 HTTP client policy (`HttpClients.kt`)

```kotlin
OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .retryOnConnectionFailure(true)
```

`retryOnConnectionFailure(true)` is the **only** automatic retry for API calls. There is **no** per-request retry loop for resolve calls on any of the three platforms. Optional HTTP proxy support exists (`setProxy(host, port)`).

### 1.3 Login gating (applies to all three platforms)

`ResolveViewModel.startResolve()` short-circuits before any network call:

```kotlin
val credential = currentCredential()
if (credential.isNullOrBlank()) {
    uiState = ResolveUiState.Error("请先在「网盘」页登录${platformName()}")
    return@launch
}
```

Credential source per platform (`currentCredential()`):

```kotlin
SharePlatform.BAIDU  -> baiduAccountRepository.getAccount()?.cookie
SharePlatform.C139   -> c139AccountRepository.getAccount()?.cookie
SharePlatform.PAN123 -> pan123AccountRepository.getAccount()?.accessToken
```

Default directory ids (`currentDefaultDirFid()`): `BAIDU -> ""`, `C139 -> "0"`, `PAN123 -> "0"`.

---

# Platform 1 — BAIDU (百度网盘)

## B.1 Authentication requirement

**Authentication is REQUIRED for the end-to-end flow, with a partial exception.**

- `createSession` + `listFiles` can work **unauthenticated for public (no-password) shares**. The source states explicitly:
  > `// 公共分享（pwd 为空）不强制提取码——跳过 verify，sekey 置空，`
  > `// listShare 将不带 sekey 直接列出（抓包实证：公共分享无需 sekey/Cookie 即 errno=0）`
- However the **app as shipped refuses to start** without a Baidu cookie (see §1.3), because the download path requires it.
- **`transfer` + `locatedownload` require a logged-in Cookie containing `BDUSS`.** `BDUSS` is the only mandatory cookie field:

```kotlin
/** 关键 Cookie 字段，缺失 BDUSS 则视为未登录 */
fun isValidCookie(cookie: String?): Boolean =
    cookie != null && cookie.contains("BDUSS=")
```

- `locatedownload` additionally requires `bdstoken` for the **transfer** step (via `getBdstoken`), and the final CDN URL itself requires `BDUSS` + the phone UA at download time (see §1.2 header map):

```kotlin
isBaidu -> mapOf(
    "Cookie" to credential,
    "User-Agent" to BaiduConstants.UA_NETDISK
)
```

**Verdict for the port:** public Baidu share *listing* is possible unauthenticated; getting a *download URL* is not.

## B.2 Constants (verbatim, `BaiduConstants.kt`)

```kotlin
const val LOGIN_URL = "https://pan.baidu.com/"
const val COOKIE_DOMAIN = "https://pan.baidu.com"

const val UA_WEB =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const val UA_NETDISK =
    "netdisk;12.24.6;piano;android-android;16;JSbridge4.4.0;jointBridge;1.1.0"

const val APP_ID = "250528"

const val TEMP_DIR_NAME = "YunX临时转存"
```

## B.3 Signing / crypto

**There is NO client-computed signing for Baidu in this codebase.** This is important and must not be invented:

- The share/verify/list/transfer endpoints use `BDCLND` (== `randsk` == `sekey`) as the only share-verification credential; there is no `sign` parameter.
- `locatedownload` carries a **hardcoded constant `psign`** and fixed device identifiers, with only `time` computed:

```kotlin
val time = System.currentTimeMillis() / 1000
"&time=$time" +
"&rand=5ed606e9da222cde0474cdf70eda884b" +
"&devuid=0F1E9FC2E084472DA5A61C4CF4C759AF" +
"&cuid=0F1E9FC2E084472DA5A61C4CF4C759AF" +
"&deviceid=348642637967375013" +
"&psign=860a071f77c860e8cea06e4e54c518f3" +
"&version=2.2.111.34&version_app=12.24.6&vip=0"
```

  Source comment: `// 抓包常量：psign 写死；rand/devuid/cuid/deviceid 有 BDUSS 登录态时可直接复用`
  There is **no salt / appkey / MD5 signing** anywhere in `BaiduApi.kt`. If the port's planning notes assumed a Baidu "sign = md5(...salt...appkey...)", that algorithm is **not present in this source** — mark it `UNCERTAIN` / not needed.
- The returned CDN direct links **carry their own `sign`/`expires`** and require no client computation:
  > `响应 urls[] 按 rank 返回多个候选 CDN 直链（自带 sign/expires，无需计算）`
- **No AES decryption is implemented for the Baidu download link.** The code deliberately *avoids* the encrypted channel:
  > `rank1 常为 d2-ant.baidu.com（encrypt=1 加密通道，内容需 AES-CTR 解密，且部分网络 TLS 握手失败）`
  > `rank1 的 d2-ant 为 encrypt=1 加密通道（需 AES-CTR 解密且部分网络 TLS 握手失败），直接排除`

  So the port must **filter for `encrypt == 0`** and must **not** need an AES-CTR implementation. `UNCERTAIN:` the exact AES-CTR parameters are never given in the source.

## B.4 `bdstoken` (required for transfer/create/delete/filemetas)

`bdstoken` is fetched lazily via `gettemplatevariable` and cached in memory for the process lifetime (`@Volatile private var cachedBdstoken: String? = null`; comment `// bdstoken 缓存（登录态内长期有效）`).

```
GET https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=<urlencoded fields>
Headers:
  Cookie: <cookie>
  User-Agent: <UA_WEB>
URL-encode of the fields string (Kotlin URLEncoder.encode(fields, "UTF-8")).
For bdstoken the raw fields value is: ["bdstoken"]
For nickname:                            ["username"]
```

URL-encoded, `["bdstoken"]` becomes `%5B%22bdstoken%22%5D`.

Success condition: `json.optInt("errno") == 0`; read `json.optJSONObject("result")` then `result.optString("bdstoken")` (or `optString("username")`). Blank → failure. Any exception → `null` (non-fatal).

## B.5 Step-by-step resolve sequence

### Step B-1 — (Optional) verify the share password

Only performed when an effective password is present **and non-blank**.

```kotlin
val effectivePwd = pwd?.takeIf { it.isNotBlank() } ?: parsed.pwd
val sekey = if (effectivePwd.isNullOrBlank()) { "" } else { api.verifyShare(surl, effectivePwd, cookie) }
```

```
POST https://pan.baidu.com/share/verify?surl=<surl>
Headers:
  Cookie: <cookie>
  User-Agent: <UA_WEB>
  Referer: https://pan.baidu.com/s/<surl>
  Content-Type: application/x-www-form-urlencoded
Body (raw string, note literal empty vcode_str and vcode):
  pwd=<urlEncode(pwd)>&vcode_str=&vcode=
```

Read: `json.optString("randsk")` → this is the **sekey**. Non-blank required, else throw `BaiduApiException("未返回分享密钥")`.
Error check: `errno != 0` → throw with message `err_msg` else `show_msg` else `"验证提取码失败"`, formatted `"$msg（errno=$errno）"`.

**Important:** `randsk` is documented as already URL-encoded and is used raw:
> `返回 randsk（URL 编码形式，直接作为 sekey 使用）`

So the port must **not** re-encode `randsk` when placing it into `&sekey=` or the `BDCLND` cookie.

### Step B-2 — list share files (paginated)

```
GET https://pan.baidu.com/rest/2.0/xpan/share?method=list
    &shorturl=<surl>
    &page=<page>
    &num=100
    &root=<root>
    &dir=<URLEncoder.encode(dirOrSlash, "UTF-8")>
    [&sekey=<sekey>]        // omitted entirely when sekey is blank
Headers:
  Cookie: <authCookie>
  User-Agent: <UA_WEB>
  Referer: https://pan.baidu.com/s/<surl>
```

Derived values:

```kotlin
val isRoot = dir.isBlank() || dir == "/"
val root = if (isRoot) "1" else "0"
val sekeyPart = if (sekey.isNotBlank()) "&sekey=$sekey" else ""
val url = "...&dir=" + URLEncoder.encode(if (dir.isBlank()) "/" else dir, "UTF-8") + sekeyPart
```

`authCookie` construction:

```kotlin
val authCookie = if (sekey.isNotBlank() && !cookie.contains("BDCLND="))
    "$cookie; BDCLND=$sekey" else cookie
```

Source comments state the rules:
> `顶层 root=1，子目录 root=0（root=1 下百度忽略 dir → 子文件夹进不去）；`
> `子目录（root=0）必须携带 BDCLND cookie（= verify 返回的 randsk），否则 errno=2；`
> `sekey 为空（公共分享）时省略 &sekey= 参数；`
> `无 sekey 却 errno!=0 → 实为加密分享，抛"该分享需要提取码"。`

`dir` semantics: root is `"/"`, subdirectory is its **path** such as `"/folder"` (see `BaiduResolveRepository.listFiles` comment: `顶层 dirFid 为空/"/"；子目录 dirFid 为目录 path（如 /folder）`).

**Error handling:** if `errno != 0`:
- if `sekey.isBlank()` → throw `BaiduApiException("该分享需要提取码")`
- else → throw with `err_msg`/`show_msg` fallback `"获取分享文件列表失败"`.

**Response parsing** (this is the exact field-path contract):

| Read from response | Meaning |
|---|---|
| `errno` (int) | 0 = success |
| `title` (string) | share title |
| `share_id` (string) | numeric share id — **required for transfer** |
| `uk` (string) | owner user id — **required for transfer** |
| `list` (array) | file entries |

Per `list[i]` item:

| JSON path | Type | Mapped to |
|---|---|---|
| `isdir` | **string**, compared with `== "1"` | `isdir: Boolean` |
| `path` | string | `pdirFid`; and **used as `fid` when `isdir`** |
| `fs_id` | **string** | `fid` for **files** only |
| `server_filename` | string | `fname` |
| `size` | long | `fsize` |
| `server_mtime` | string | `modifyTime` |

```kotlin
fid = if (isdir) path else item.optString("fs_id"),
fname = item.optString("server_filename"),
fsize = item.optLong("size"),
isdir = isdir,
pdirFid = path,
fidToken = "",           // always empty for Baidu
modifyTime = item.optString("server_mtime")
```

**Note the type trap:** `isdir` is compared as a **string** `"1"`, whereas in `listCloudFiles` for the personal drive it is compared as an **int** `optInt("isdir") == 1`. A TypeScript port must accept both forms defensively.

**Pagination loop** (`BaiduResolveRepository.listFiles`):

```kotlin
var page = 1
do {
    result = api.listShare(session.shareId, sekey, dirFid, cookie, page)
    all += result.files
    page++
} while (result.files.size == 100 && page <= 100)
```

Rules: page starts at 1; request `num=100`; continue while the returned page has **exactly 100** entries; hard cap `page <= 100` (max 100 pages = 10,000 entries). `share_id`/`uk` come from the **last** page response (they are identical each page).

An unconditional re-list helper exists when `share_id`/`uk` were not cached:

```kotlin
private suspend fun requireShareInfo(session: ShareSession, cookie: String): Pair<String, String> {
    shareInfos[session.shareId]?.let { return it }
    val sekey = session.stoken.ifBlank { sekeys[session.shareId] ?: "" }
    val result = api.listShare(session.shareId, sekey, "/", cookie)
    ...
}
```

Note the default `page` parameter of `listShare` is `page: Int = 1`.

### Step B-3 — ensure temp transfer directory

```kotlin
val dir = "/${BaiduConstants.TEMP_DIR_NAME}"   // "/YunX临时转存"
val exists = runCatching { api.listDir("/", cookie).any { it == dir } }.getOrDefault(false)
val ok = exists || api.createDir(dir, cookie)
if (ok) dir else "/"
```

List the personal drive root:

```
GET https://yun.baidu.com/api/list?clienttype=0&app_id=250528&web=1&order=time&desc=1&dir=<urlenc dir>&num=100&page=1
Headers:
  Cookie: <cookie>
  User-Agent: <UA_NETDISK>
```

Read `errno` (must be 0) and `list[i].path` strings. (`dir` is `"/"` here, URL-encoded as `%2F`.)

Create the directory if absent:

```
POST https://pan.baidu.com/api/create?a=commit&channel=chunlei&web=1&app_id=250528&clienttype=0&bdstoken=<bdstoken>
Headers:
  Cookie: <cookie>
  User-Agent: <UA_NETDISK>
  Referer: https://yun.baidu.com/disk/main
  Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Body (raw string):
  path=<urlEncode(path)>&isdir=1&size&block_list=%5B%5D&method=post&dataType=json
```

Note the body literally contains `&size&` with an empty value and the literal `%5B%5D` for `block_list`.
Source comment explains why this endpoint rather than filemanager:
> `官方新建文件夹用的是 api/create?a=commit（对齐抓包）：`
> `filemanager?opera=mkdir 在纯 Cookie 认证下恒 errno=2（接口校验路径不同）。`
> `UA 用 netdisk 客户端 + Referer yun.baidu.com/disk/main + body 完整参数`

Success: `errno == 0`. Exceptions swallowed → `false`.

**Fallback behaviour:** if creation fails, `toDir` becomes `"/"` (root) — resolution continues.

### Step B-4 — transfer the file into the temp dir

```kotlin
val bdstoken = getBdstoken(cookie) ?: throw BaiduApiException("获取 bdstoken 失败，请重新登录")
val url = "https://pan.baidu.com/share/transfer?shareid=$shareId&from=$uk" +
    "&channel=chunlei&sekey=$sekey&ondup=newcopy&web=1&app_id=250528" +
    "&bdstoken=$bdstoken&clienttype=0"
val body = "fsidlist=%5B%22$fsId%22%5D&path=${urlEncode(toDir)}"
val authCookie = if (cookie.contains("BDCLND=")) cookie else "$cookie; BDCLND=$sekey"
```

```
POST https://pan.baidu.com/share/transfer?shareid=<shareId>&from=<uk>&channel=chunlei&sekey=<sekey>&ondup=newcopy&web=1&app_id=250528&bdstoken=<bdstoken>&clienttype=0
Headers:
  Cookie: <authCookie>
  User-Agent: <UA_WEB>
  Origin: https://pan.baidu.com
  Referer: https://pan.baidu.com/s/
  Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Body (raw string):
  fsidlist=%5B%22<fsId>%22%5D&path=<urlEncode(toDir)>
```

Body decoding: `fsidlist=["<fsId>"]`, `path=<toDir>` (the directory, e.g. `/YunX临时转存`).
`sekey` is interpolated **raw** (not re-encoded) — the same `randsk` value.
`Referer` is exactly `https://pan.baidu.com/s/` with **no** surl appended.
Source comment:
> `verify 响应会 Set-Cookie: BDCLND=<randsk>，transfer 必须携带（分享验证标识），`
> `缺失会 errno=2；BDCLND 值即 sekey（randsk），手动补齐`

Success: `errno == 0`, else throw with `err_msg`/`show_msg` fallback `"转存失败"`.

**Response parsing:**

| JSON path | Meaning |
|---|---|
| `extra.list[0].to_fs_id` | new fs_id after transfer |
| `extra.list[0].to` | new full path after transfer |

```kotlin
val extra = json.optJSONObject("extra")
val list = extra?.optJSONArray("list")
val first = list?.optJSONObject(0)
val fsIdNew = first?.optString("to_fs_id")?.takeIf { it.isNotBlank() }
    ?: throw BaiduApiException("转存失败：未返回新文件")
val pathNew = first?.optString("to")?.takeIf { it.isNotBlank() } ?: "$toDir/"
```

Result shape: `BaiduTransferResult(fsId = fsIdNew, path = pathNew)`.
`UNCERTAIN:` the source does not show the `value` (path) equality check; `to` is trusted as-is.

### Step B-5 — obtain the high-speed CDN direct link (`locatedownload`)

```kotlin
val time = System.currentTimeMillis() / 1000
val url = "https://d.pcs.baidu.com/rest/2.0/pcs/file" +
    "?method=locatedownload" +
    "&app_id=250528" +
    "&clienttype=17&ver=4.0" +
    "&ant=1&check_blue=1&es=1&esl=1&apn_id=1_-1" +
    "&freeisp=0&queryfree=0&use=1&dtype=1&eck=1&ehps=1" +
    "&err_ver=1.0&network_type=WIFI&channel=0" +
    "&path=" + URLEncoder.encode(path, "UTF-8") +
    "&time=" + time +
    "&rand=5ed606e9da222cde0474cdf70eda884b" +
    "&devuid=0F1E9FC2E084472DA5A61C4CF4C759AF" +
    "&cuid=0F1E9FC2E084472DA5A61C4CF4C759AF" +
    "&deviceid=348642637967375013" +
    "&psign=860a071f77c860e8cea06e4e54c518f3" +
    "&version=2.2.111.34&version_app=12.24.6&vip=0"
```

```
POST https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload&app_id=250528&clienttype=17&ver=4.0&ant=1&check_blue=1&es=1&esl=1&apn_id=1_-1&freeisp=0&queryfree=0&use=1&dtype=1&eck=1&ehps=1&err_ver=1.0&network_type=WIFI&channel=0&path=<urlenc path>&time=<unixSeconds>&rand=5ed606e9da222cde0474cdf70eda884b&devuid=0F1E9FC2E084472DA5A61C4CF4C759AF&cuid=0F1E9FC2E084472DA5A61C4CF4C759AF&deviceid=348642637967375013&psign=860a071f77c860e8cea06e4e54c518f3&version=2.2.111.34&version_app=12.24.6&vip=0
Headers:
  Cookie: <cookie>
  User-Agent: <UA_NETDISK>
  Content-Type: application/x-www-form-urlencoded
Body (raw string, literally the single character zero):
  0
```

Key facts:
- **Method is POST**, not GET, with a non-empty body `"0"`.
- `path` is the **transferred** full path (`transferred.path`), not the share path.
- `time` = current unix time in **seconds** (`System.currentTimeMillis() / 1000`).
- The `_` in `apn_id=1_-1` is literal.

**Response parsing:**

| JSON path | Meaning |
|---|---|
| `errno` (int) | 0 = success |
| `urls` (array) | candidate list |
| `urls[i].url` (string) | candidate direct URL |
| `urls[i].encrypt` (int, default 1) | 1 = AES-CTR encrypted channel; 0 = plaintext |
| `urls[i].rank` | mentioned in comments (`按 rank 返回`) but **not read in code** |

Selection algorithm (verbatim logic):

```kotlin
val candidates = (0 until (urls?.length() ?: 0))
    .mapNotNull { urls?.optJSONObject(it) }
    .filter { it.optString("url").isNotBlank() }
val directUrl = candidates
    .filter { it.optInt("encrypt", 1) == 0 }
    .sortedBy { !it.optString("url").startsWith("https") }
    .firstOrNull()?.optString("url")
    ?: candidates.firstOrNull { it.optString("url").startsWith("https") }?.optString("url")
    ?: candidates.firstOrNull()?.optString("url")
    ?: throw BaiduApiException("未返回下载链接")
```

i.e.:
1. Keep candidates with non-blank `url`.
2. Prefer `encrypt == 0`; among those sort so `https` comes first (stable sort on the boolean "not https"), take the first.
3. Fallback: first candidate whose url starts with `https`.
4. Fallback: first candidate at all.
5. Else throw `"未返回下载链接"`.
Error check runs before selection with fallback message `"获取高速下载链接失败"`.

The returned URL is:
> `appallNN.baidupcs.com CDN 直链（自带 sign/expires，删除转存后仍有效；仅需 BDUSS + 手机 UA 即可满速下载）`

### Step B-6 — cleanup (executed BEFORE the download, not after)

This is unusual and must be ported literally. `getShareDownloadLink` calls `deleteTransferred` **immediately after** obtaining the link:

```kotlin
val dlink = api.locateDownload(transferred.path, cookie)
// appall 直链不依赖转存文件存活：取链成功后立即删除临时转存，网盘不留残留
deleteTransferred(transferred.path, cookie)
```

```kotlin
private suspend fun deleteTransferred(path: String, cookie: String) {
    runCatching { api.deleteFile(path, cookie) }
    val tempDir = "/${BaiduConstants.TEMP_DIR_NAME}"
    if (path.startsWith("$tempDir/")) {
        runCatching { api.deleteFile(tempDir, cookie) }
    }
}
```

Both deletions are wrapped in `runCatching` — **failures do not block** the resolve.

Delete request:

```
POST https://pan.baidu.com/api/filemanager?async=2&onnest=fail&opera=delete&bdstoken=<bdstoken>&newVerify=1&clienttype=0&app_id=250528&web=1
Headers:
  Cookie: <cookie>
  User-Agent: <UA_NETDISK>
  Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Body:
  filelist=<URLEncoder.encode("""["$path"]""", "UTF-8")>
```

Body decodes to `filelist=["<path>"]`. Success: `errno == 0`; exceptions → `false`.

### Step B-7 — resulting DownloadLink

```kotlin
DownloadLink(
    fid = transferred.fsId,
    filename = file.fname,
    downloadUrl = dlink,
    size = file.fsize
)
```

`cleanupDirFid` is **not** set for Baidu (the repository defaults it to `null`); cleanup already happened inline.

## B.6 Baidu: listing the personal drive (for the dir picker)

```
GET https://yun.baidu.com/api/list?clienttype=0&app_id=250528&web=1&order=time&desc=1&dir=<urlenc dir>&num=100&page=<page>
Headers:
  Cookie: <cookie>
  User-Agent: <UA_NETDISK>
  X-Requested-With: XMLHttpRequest
  Referer: https://yun.baidu.com/disk/main
```

Pagination (`listCloudFiles`): page starts at 1, `num=100`; stop when a page is empty **or** a page returns fewer than 100 entries **or** `page >= 100`. Item fields: `fs_id` (fid), `server_filename` (fname), `size`, `isdir` (**int**, `== 1`), `path` (→ `fidToken`), `server_mtime`.

## B.7 Baidu: pagination / polling / retry summary

| Aspect | Value |
|---|---|
| Share list pagination | `page` 1..100, `num=100`, continue while page size `== 100` |
| Cloud list pagination | `page` 1..100, `num=100`, stop on empty page or `< 100` |
| Polling loops | **None** for resolve. `share/transfer` is synchronous and returns `extra.list[0]` immediately. |
| Server-side retries | none |
| Client retries | only `retryOnConnectionFailure(true)`; plus up to 3 download-engine retries after a link is obtained (`download_retry_count`, default 3, range 0-10) — not part of resolve |
| Timeouts | connect 15s, read 60s, write 30s |

## B.8 Baidu: error codes referenced in the source

```kotlin
// 常见：errno=-12 提取码错误 / 403 分享已失效 / 31066 文件不存在
val msg = json.optString("err_msg").ifBlank { json.optString("show_msg") }.ifBlank { fallback }
throw BaiduApiException("$msg（errno=$errno）")
```

Also referenced in comments: `errno=2` = missing `BDCLND` / wrong listing mode.

---

# Platform 2 — PAN123 (123云盘 / 123pan)

## P.1 Authentication requirement

**Split: listing is fully anonymous; getting a download URL REQUIRES a Bearer JWT.**

- `GET /b/api/share/get` — source comment: `分享文件列表（GET /b/api/share/get，匿名、无签名）`. It sends only a `User-Agent` (`DART_UA`) and **no** token, no signature, no Cookie.
- `POST /b/api/share/download/info` — source comment: `分享下载信息（POST /b/api/share/download/info，需登录+签名）`. **A logged-in `authorToken` (Bearer JWT) is mandatory.** The repository enforces it:

```kotlin
val token = cookie.ifBlank { tokenProvider() ?: "" }
if (token.isBlank()) throw IllegalStateException("请先登录123云盘")
```

- **No transfer/temp-dir step** is needed to get a link: `ensureTempDir` returns `UnsupportedOperationException("123 分享无需转存")` and the source comment says `123 分享下载无需转存（文档 §4.2）`.
- Credential form: the raw JWT string used as `Authorization: Bearer <token>`. Stored from `yun.123pan.cn` **localStorage key `authorToken`**:
  > `凭证 = authorToken（Bearer JWT，与旧 sign_in 接口返回的 data.token 同源同形，约 90 天过期）`

**Verdict for the port:** anonymous browsing of public 123 shares (names/sizes/tree) works with zero credentials; the direct link does not.

## P.2 Constants (verbatim, `Pan123Constants.kt`)

```kotlin
const val API_BASE = "https://yun.123pan.cn"
const val DOWNLOAD_BASE = "https://www.123865.com"

const val WEB_LOGIN_URL = "https://yun.123pan.cn/"
const val LOCAL_STORAGE_TOKEN_KEY = "authorToken"

const val SHARE_GET_URL = "$API_BASE/b/api/share/get"                                  // https://yun.123pan.cn/b/api/share/get
const val SHARE_DOWNLOAD_INFO_URL = "$DOWNLOAD_BASE/b/api/share/download/info"          // https://www.123865.com/b/api/share/download/info
const val FILE_LIST_URL = "$API_BASE/b/api/file/list/new"
const val FILE_DOWNLOAD_INFO_URL = "$API_BASE/api/file/download_info"                   // NOTE: no /b/
const val TRAFFIC_CHECK_URL = "$API_BASE/b/api/file/download/traffic/check"
const val FILE_TRASH_URL = "$API_BASE/b/api/file/trash"
const val FILE_RENAME_URL = "$API_BASE/b/api/file/rename"
const val FILE_MOD_PID_URL = "$API_BASE/b/api/file/mod_pid"
const val SHARE_CREATE_URL = "$API_BASE/b/api/share/create"
const val USER_INFO_URL = "$API_BASE/b/api/user/info"

const val WEB_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
const val DART_UA = "Dart/3.12 (dart:io)"

const val PLATFORM_WEB = "web"
const val PLATFORM_ANDROID = "android"
const val APP_VERSION_WEB = "3"
const val APP_VERSION_ANDROID = "39"

const val DOWNLOAD_REFERER = "https://yun.123pan.cn/"

const val SIGN_TABLE = "adefghlmyijnopkqrstubcvwsz"
const val SIGN_OS = "web"
const val SIGN_VER = "3"
const val SIGN_OFFSET_SECONDS = 57600L

const val EXPIRATION_FOREVER = "2099-12-12T08:00:00+08:00"
```

`newLoginUuid()` returns 32 random characters from `"0123456789abcdef"` (per-process constant; not part of the signature).

## P.3 The signature algorithm (this is the critical crypto)

Exact source:

```kotlin
/** 标准 CRC-32（IEEE 802.3）→ 8 位小写十六进制 */
private fun crc32Hex(s: String): String {
    val crc = CRC32()
    crc.update(s.toByteArray(Charsets.UTF_8))
    return java.lang.Long.toHexString(crc.value and 0xFFFFFFFFL)
}

fun makeSign(path: String, ts: Long = System.currentTimeMillis() / 1000): Pair<String, String> {
    // 1) auth-key (timeSign)：ts + 16h 以 UTC 格式化为 YYYYMMDDHHmm，逐数字替换
    val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
        timeInMillis = (ts + Pan123Constants.SIGN_OFFSET_SECONDS) * 1000L
    }
    val minute = String.format(
        "%04d%02d%02d%02d%02d",
        cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH),
        cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE)
    )
    val substituted = minute.map { Pan123Constants.SIGN_TABLE[it - '0'] }.joinToString("")
    val authKey = crc32Hex(substituted)

    // 2) auth-value：ts|random|path|web|3|auth_key 的 crc32
    val random = ThreadLocalRandom.current().nextInt(0, 10_000_000)
    val data = "$ts|$random|$path|${Pan123Constants.SIGN_OS}|${Pan123Constants.SIGN_VER}|$authKey"
    val authValue = "$ts-$random-${crc32Hex(data)}"
    return authKey to authValue
}
```

Exact rules to reimplement:

1. **`ts`** = current time as unix **seconds** (`System.currentTimeMillis() / 1000`).
2. **Shift:** `shiftedMs = (ts + 57600) * 1000`. `57600s = +16h`. Source comment: `timeSign 时间基准偏移：ts + 57600 秒（+16h，UTC 格式化；抓包实证，文档 §6.3）`.
3. **Format** `shiftedMs` in **UTC** as `YYYYMMDDHHmm` → 12 characters, zero-padded (`%04d%02d%02d%02d%02d`).
4. **Digit substitution:** map each digit character `d` (0-9) to `SIGN_TABLE[d]` where
   `SIGN_TABLE = "adefghlmyijnopkqrstubcvwsz"`. Index mapping:
   `0→a, 1→d, 2→e, 3→f, 4→g, 5→h, 6→l, 7→m, 8→y, 9→i`.
   The result is a 12-character lowercase letter string.
5. **`auth-key` = `crc32Hex(substituted)`** — standard CRC-32 (IEEE 802.3, the same polynomial as `zlib.crc32`), computed over the **UTF-8 bytes** of the substituted string, then masked with `0xFFFFFFFF` and rendered as **lowercase hex via `Long.toHexString`**.
   ⚠️ **Critical TypeScript detail:** `Long.toHexString` **does not zero-pad**. Values whose CRC-32 has leading zero nibbles produce **shorter than 8 characters**. A port must reproduce this exactly (use `crc >>> 0` then `toString(16)`) and must **not** pad to 8.
   The Kotlin comment states: `标准 CRC-32（IEEE 802.3）→ 8 位小写十六进制（与 Python zlib.crc32 & 0xFFFFFFFF format 'x' 一致）` — note the comment says "8-digit" but the code does not pad, and the parenthetical confirms it equals Python's unpadded `format(x, 'x')`.
6. **`random`** = uniform random int in `[0, 10_000_000)` (exclusive upper bound).
7. **`data` = `` `${ts}|${random}|${path}|web|3|${authKey}` ``** — `SIGN_OS = "web"` and `SIGN_VER = "3"` are used **regardless** of the request's `platform`/`app-version` headers. Source comment: `签名内部固定 OS=web / VER=3（与请求头 platform/app-version 无关，文档 §6.3）`.
8. **`auth-value` = `` `${ts}-${random}-${crc32Hex(data)}` ``** (again unpadded lowercase hex).
9. **`path`** must be: URL path including the `/b` prefix, **excluding host and excluding query**. Examples from the code: `/b/api/share/download/info`, `/b/api/file/list/new`, `/b/api/user/info`, `/b/api/file/trash`, `/b/api/file/rename`, `/b/api/file/mod_pid`, `/b/api/share/create`, and `/api/file/download_info` (no `/b`).
10. **Headers emitted:** `auth-key: <authKey>` and `auth-value: <authValue>`.

> Reference target if the port wants a unit test: the values are per-request random (`random`) and time-dependent, so exact vectors are not reproducible from this source. `UNCERTAIN:` no test vector is provided in the repository.

## P.4 Step-by-step resolve sequence

### Step P-1 — list share files (ANONYMOUS, unsigned)

```kotlin
val url = buildString {
    append(Pan123Constants.SHARE_GET_URL)
    append("?limit=100")
    append("&next=").append(next)
    append("&orderBy=file_name")
    append("&orderDirection=asc")
    append("&shareKey=").append(URLEncoder.encode(shareKey, "UTF-8"))
    append("&ParentFileId=").append(parentFileId)
    append("&Page=").append(page)
    if (sharePwd.isNotBlank()) {
        append("&SharePwd=").append(URLEncoder.encode(sharePwd, "UTF-8"))
    }
}
```

```
GET https://yun.123pan.cn/b/api/share/get?limit=100&next=<next>&orderBy=file_name&orderDirection=asc&shareKey=<urlenc shareKey>&ParentFileId=<parentFileId>&Page=<page>[&SharePwd=<urlenc sharePwd>]
Headers:
  User-Agent: Dart/3.12 (dart:io)
Body: none
```

**Exact parameter order matters** — the source notes `参数顺序与抓包一致（§5.2 文件夹分享/有提取码）`.
Case is mixed deliberately: `shareKey`, `ParentFileId`, `Page`, `SharePwd`, `limit`, `next`, `orderBy`, `orderDirection`.

⚠️ **Critical rule:**
> `⚠️ 无提取码时不传 SharePwd（传空值会 400 "请输入Next"）`

So `SharePwd` must be **omitted entirely** when blank — not sent as an empty string.

**Initial call** (`Pan123ResolveRepository.createSession`):

```kotlin
val (files, _) = api.getShareFiles(parsed.shareId, sharePwd, "0", "0", 1)
val title = files.firstOrNull()?.fname?.takeIf { it.isNotBlank() } ?: parsed.shareId
ShareSession(shareId = parsed.shareId, stoken = sharePwd, title = title)
```

i.e. first call is `parentFileId = "0"`, `next = "0"`, `page = 1`. The title is the first entry's filename, else the shareKey (source marks this as `文档待验证 #4` — i.e. itself flagged as unverified).

Password priority: `val sharePwd = pwd?.takeIf { it.isNotBlank() } ?: parsed.pwd.orEmpty()` (user-supplied wins over link-embedded).

**Response parsing:**

| JSON path | Meaning |
|---|---|
| `code` (int) | 0 = success; non-zero → throw `"<message>（code=<code>）"` |
| `data.Expired` (bool) | if true → throw `IllegalStateException("分享已失效")` |
| `data.Next` (string) | pagination cursor |
| `data.InfoList` (array) | entries |

Per `data.InfoList[i]`:

| JSON path | Type | Mapped to |
|---|---|---|
| `Type` | int (`optInt("Type", 0)`) | `isdir = (type == 1)` |
| `FileId` | string | `fid` |
| `FileName` | string | `fname` |
| `Size` | long | `fsize` |
| `ParentFileId` | string | `pdirFid` |
| `S3KeyFlag` | string | part 0 of `fidToken` |
| `Etag` | string | part 1 of `fidToken` |
| `StorageNode` | string | part 2 of `fidToken` |
| `UpdateAt` | string | `modifyTime` |

```kotlin
fidToken = "${item.optString("S3KeyFlag")}|${item.optString("Etag")}|${item.optString("StorageNode")}"
```

`fidToken` is a **pipe-joined triple**: `"S3KeyFlag|Etag|StorageNode"`. Decoder:

```kotlin
private fun decodeToken(fidToken: String): Triple<String, String, String> {
    val parts = fidToken.split('|')
    return Triple(parts.getOrNull(0) ?: "", parts.getOrNull(1) ?: "", parts.getOrNull(2) ?: "")
}
```

(`S3KeyFlag` may itself contain `-`; only `|` is the separator. Old two-part tokens yield empty StorageNode.)

**`Next` semantics:**
```kotlin
val nextCursor = data.optString("Next").takeIf { it != "-1" }
```
> `文档 §5.2：Next=="-1" 无下一页，空串 "" 表示还有下一页。`

So: `"-1"` → no more pages (`null`); `""` → more pages; any other value → that cursor.

**Pagination loop** (`Pan123ResolveRepository.listFiles`):

```kotlin
var page = 1
do {
    val (files, nextCursor) = api.getShareFiles(session.shareId, session.stoken, dirFid, "0", page)
    all += files
    val hasMore = files.isNotEmpty() && nextCursor != null
    page++
} while (hasMore && page < 50)
```

Critical detail: **`next` is always the literal string `"0"`; paging is driven by incrementing `Page`.** Source:
> `alist 实证（drivers/123_share/util.go）：next 参数始终固定 "0"，翻页靠 Page 递增；`
> `结束条件：Next=="-1" 或列表为空（Next=="" 表示还有，继续翻页）`

Loop bounds: continue while the page is non-empty **and** `Next != "-1"`; `page < 50` cap. `limit=100` per page.

### Step P-2 — get the share download URL (AUTHENTICATED + SIGNED)

Request body (JSON object, field order as Kotlin `JSONObject` insertion order):

```kotlin
val (s3KeyFlag, etag, _) = decodeToken(file.fidToken)
val body = JSONObject()
    .put("ShareKey", shareKey)
    .put("FileID", file.fid)
    .put("S3KeyFlag", s3KeyFlag)
    .put("Size", file.fsize)
    .put("Etag", etag)
```

```json
{"ShareKey":"<shareKey>","FileID":"<file.fid>","S3KeyFlag":"<s3KeyFlag>","Size":<fsize>,"Etag":"<etag>"}
```

Types: `ShareKey` string, `FileID` string (the Kotlin `ShareFile.fid` is a String), `S3KeyFlag` string, `Size` number (long), `Etag` string.

```
POST https://www.123865.com/b/api/share/download/info
Headers:
  platform: android
  app-version: 39
  authorization: Bearer <JWT>
  loginuuid: <32-hex device id>
  auth-key: <authKey from makeSign("/b/api/share/download/info")>
  auth-value: <authValue from makeSign("/b/api/share/download/info")>
  Content-Type: application/json;charset=UTF-8
  User-Agent: <WEB_UA>          // note: WEB_UA even though platform=android
Body: the JSON above
```

Note the header/platform mismatch, which is deliberate:
> `分享下载信息走 android 平台头，签名内部仍固定 web/3（文档 §6.3）`

`postAuth(..., platform = PLATFORM_ANDROID, appVersion = APP_VERSION_ANDROID)` sets `platform: android`, `app-version: 39`, and the signature path `/b/api/share/download/info`.

Note the **host is `www.123865.com`**, a different host from the `API_BASE` `yun.123pan.cn`. Source: `分享下载信息（抓包实证；alist 用 yun.123pan.com 等价）`.

**Response parsing:**

| JSON path | Meaning |
|---|---|
| `code` (int) | 0 = success |
| `data.DownloadURL` (string) | possibly a wrapper URL |

Blank `DownloadURL` → return `null` (caller throws `"获取下载链接失败"`).

### Step P-3 — decode the `DownloadURL` wrapper

`decodeDownloadUrl` handles two forms:

```kotlin
private fun decodeDownloadUrl(downloadUrl: String): String? {
    val trimmed = downloadUrl.trim()
    // 形态 1：整段 base64（不含协议头的串）
    if (!trimmed.contains("://")) {
        return runCatching {
            String(Base64.decode(trimmed, Base64.DEFAULT), Charsets.UTF_8)
                .takeIf { it.startsWith("http", ignoreCase = true) }
        }.getOrNull()
    }
    // 形态 2：download-v2?params=<base64>
    val idx = trimmed.indexOf("params=")
    if (idx < 0) return null
    val params = trimmed.substring(idx + "params=".length).substringBefore("&")
    return runCatching {
        val normalized = params.replace('-', '+').replace('_', '/')
        String(Base64.decode(normalized, Base64.DEFAULT), Charsets.UTF_8)
    }.getOrNull()
}
```

Rules:
- **Form 1:** if the string contains no `://`, treat the whole string as base64. Decode; accept only if the result starts with `http` (case-insensitive). Else `null`.
- **Form 2:** if it contains `://`, find the **first** `params=`; take the substring after it up to the next `&`. **URL-safe → standard base64 normalization**: `-` → `+`, `_` → `/`. Then decode.
- If decoding fails or `params=` is absent → `null`; the caller falls back to the raw value:
  `val decoded = decodeDownloadUrl(downloadUrl) ?: downloadUrl`

⚠️ Explicit warning in the source:
> `绝不能用 startsWith("http") 短路：中转页 URL 同样以 http 开头，无法区分。`

Base64 decoding uses Android `Base64.DEFAULT`, which tolerates missing padding in practice; a TypeScript port should be lenient about padding (`=`).

### Step P-4 — follow `redirect_url` hops (polling-style loop)

```kotlin
private fun followRedirectUrl(initialUrl: String): String {
    var url = initialUrl
    repeat(5) {
        val next = probeJsonRedirect(url) ?: return url
        url = next
    }
    return url
}
```

Single probe:

```kotlin
private fun probeJsonRedirect(url: String): String? = runCatching {
    val request = Request.Builder()
        .url(url)
        .header("Referer", Pan123Constants.DOWNLOAD_REFERER)   // https://yun.123pan.cn/
        .header("User-Agent", Pan123Constants.DART_UA)          // Dart/3.12 (dart:io)
        .get()
        .build()
    client.newCall(request).execute().use { response ->
        val len = response.header("Content-Length")?.toLongOrNull() ?: -1L
        if (len >= 0 && len <= 8192) {
            val body = response.body?.string() ?: return@use null
            if (body.trimStart().startsWith("{")) {
                runCatching {
                    JSONObject(body).optJSONObject("data")
                        ?.optString("redirect_url")
                        ?.takeIf { it.isNotBlank() }
                }.getOrNull()
            } else null
        } else null
    }
}.getOrNull()
```

Algorithm exactly:
- **Max 5 hops** (`repeat(5)`), i.e. at most 5 probes; if a probe returns non-null it becomes the new URL.
- Each probe is a **GET** with `Referer: https://yun.123pan.cn/` and `User-Agent: Dart/3.12 (dart:io)`.
- Read the `Content-Length` header. **Only if `0 <= len <= 8192`** is the body read and parsed. If the header is missing (`-1`) or larger than 8192, this is treated as a real file stream → the current URL is final.
- Body must start with `{` after leading whitespace trimming.
- Extract `data.redirect_url`; non-blank → next hop.
- Any exception → `null` → stop and return the current URL.

Source rationale:
> `带 auto_redirect=0 时，GET 直链返回 JSON {"code":0,"data":{"redirect_url":"https://...pd1.cjjd19.com/..."}} 而非直接文件，且 redirect_url 自身也可能带 auto_redirect=0（可能多跳）`

⚠️ This probe issues a **real GET against the CDN file URL**, consuming bandwidth for the 8 KB window when it is a file. The port must preserve the size-guard so it does not download whole files.

### Step P-5 — result + required download headers

```kotlin
DownloadLink(fid = file.fid, filename = file.fname, downloadUrl = realUrl, size = file.fsize)
```

Then `link.copy(filename = file.fname.ifBlank { link.filename })`.

At download time the 123 CDN requires:

```kotlin
isPan123 -> mapOf(
    "User-Agent" to Pan123Constants.WEB_UA,
    "Referer" to Pan123Constants.DOWNLOAD_REFERER
)
```

> `分享下载真实 CDN 直链下载时必须携带的 Referer（文档 §5.3.1）` = `https://yun.123pan.cn/`

(Note: the *probe* uses `DART_UA`, while the *download* uses `WEB_UA` — reproduce both.)

**No temp-file/transfer cleanup exists for 123 share resolution.** `ensureTempDir` deliberately fails:
```kotlin
override suspend fun ensureTempDir(cookie: String): Result<String> =
    Result.failure(UnsupportedOperationException("123 分享无需转存"))
```

## P.5 The 123 cloud-save (`copy/save`) path — the only polling loop

Included because the port may need "save to my drive". **No client signature is required on the `mshare` host**:

> `⚠️ mshare 子域无需任何客户端签名（源码实证 + 实测 code:0），仅带 Bearer + LoginUuid。`

```
POST https://<shareId>.mshare.123pan.cn/b/api/restful/goapi/v1/file/copy/save
Headers:
  Authorization: Bearer <token>
  LoginUuid: <32-hex>
  platform: web
  Content-Type: application/json;charset=UTF-8
  User-Agent: Dart/3.12 (dart:io)
```

`shareId` derivation:
```kotlin
/** 从分享列表项提取数值 ShareId（S3KeyFlag 形如 "1816216065-0"，前缀即 mshare 子域数字） */
private fun shareIdOf(file: ShareFile): String {
    val s3 = file.fidToken.substringBefore('|')
    return s3.substringBefore('-')
}
```

Body:
```json
{
  "fileList": [{
    "fileID": <long>, "fileId": <long>, "size": <long>, "etag": "<etag>",
    "type": <1 if dir else 0>, "parentFileID": <long>, "parentFileId": <long>,
    "fileName": "<name>", "driveID": 0, "driveId": 0,
    "s3keyFlag": "<s3>", "S3KeyFlag": "<s3>", "StorageNode": "<storageNode>"
  }],
  "shareKey": "<shareKey>",
  "sharePwd": "<pwd or empty string>",
  "currentLevel": 1,
  "superAdmin": null
}
```
> `无提取码发空串 ""，不要发 null（文档 §4.3）`
`fileId`/`parentFileId` are numeric (`file.fid.toLongOrNull() ?: 0L`, `toDirFid.toLongOrNull() ?: 0L`).

Read `data.taskID` (number, `optLong`).

**Polling loop:**
```
GET https://<shareId>.mshare.123pan.cn/b/api/restful/goapi/v1/file/copy/save/get?taskID=<taskId>
Headers: Authorization: Bearer <token>, LoginUuid, platform: web, User-Agent: Dart/3.12 (dart:io)
```
```kotlin
repeat(15) {
    kotlinx.coroutines.delay(1000)   // 1s between attempts
    ...
}
```
- **15 attempts, 1 second apart** (≈15s max), no exponential backoff.
- Non-zero `code` → if `message` is non-blank, throw `"转存失败：$message"`; **if message is blank, continue polling** (`return@repeat`).
- Completion condition (the source explicitly says the response shape is not fully captured and is tolerant):
```kotlin
val status = data.optInt("status", -1)
val state = data.optString("state").lowercase()
val done = data.optBoolean("finished", false) ||
    status == 2 || status == 3 ||
    state == "success" || state == "done" || state == "2" ||
    data.has("fileId") || data.has("FileId") || data.has("newFileId")
```
- On done, return the new id with fallback chain:
```kotlin
data.optString("newFileId").ifBlank { data.optString("FileId") }
    .ifBlank { data.optString("fileId") }
    .ifBlank { taskId.toString() }
```
- Timeout (15 iterations exhausted) → `null` → caller throws `"转存超时或失败"`.

Source caveat verbatim: `完成标志（响应格式未在抓包完整呈现，容错多种形态）` — mark this `UNCERTAIN` in fidelity terms.

## P.6 123: constants for other endpoints (complete header sets)

Authenticated **GET** (`getAuth`):

```
Headers:
  platform: web
  app-version: 3
  authorization: Bearer <token>
  loginuuid: <32-hex>
  auth-key: <authKey>          // sign path = actual URL path
  auth-value: <authValue>
  User-Agent: <WEB_UA>
  Accept: application/json, text/plain, */*
```

Authenticated **POST** (`postAuth`, defaults):

```
Headers: same as getAuth but with
  Content-Type: application/json;charset=UTF-8
  (and no Accept header)
```

Cloud file list: `GET https://yun.123pan.cn/b/api/file/list/new?driveId=0&limit=100&next=<next>&orderBy=update_time&orderDirection=desc&parentFileId=<id>&trashed=false&SearchData=&Page=1&OnlyLookAbnormalFile=0&event=homeListFile&operateType=1&inDirectSpace=false` — pagination starts `next = "0"`, `Next == "-1"` ends, capped `repeat(200)`; items use the **same `InfoList` structure** as the share list (`parseInfoList`).

Cloud download info: `POST https://yun.123pan.cn/api/file/download_info` (sign path `/api/file/download_info`, **no `/b`**), body:
```json
{"driveId":0,"etag":"<etag>","fileId":<long>,"s3keyFlag":"<s3>","type":0,"fileName":"<name>","size":<long>}
```
— note **lowercase** key names here (`driveId`/`etag`/`fileId`/`s3keyFlag`), vs the share endpoint's PascalCase (`ShareKey`/`FileID`/`S3KeyFlag`). Response field is `data.DownloadUrl` (**lowercase `l`**) vs the share endpoint's `data.DownloadURL` (**uppercase `L`**) — these differ in the source and must be ported exactly.

`user/info` (quota): `data.SpaceUsed`, `data.SpacePermanent`, `data.SpaceTemp`; used = `SpaceUsed`, total = `SpacePermanent + SpaceTemp`. Nickname = `data.Nickname`.

## P.7 123: error handling + retry summary

```kotlin
private fun checkOk(json: JSONObject, fallback: String) {
    val code = json.optInt("code", -1)
    if (code == 0) return
    val msg = json.optString("message").ifBlank { fallback }
    throw IllegalStateException("$msg（code=$code）")
}
```
> `成功判定：code == 0（登录接口除外，为 200）`

`executeJson` accepts any HTTP status as long as the body is non-blank and parses as JSON; a blank body with a non-2xx status throws `"请求失败（HTTP <code>）"`, and a null body throws `"请求失败：响应为空（<code>）"`.

| Aspect | Value |
|---|---|
| Share list pagination | `Page` 1..49, `limit=100`, `next` fixed `"0"`, stop on `Next=="-1"` or empty page |
| Cloud list pagination | `next` cursor, stop on `Next=="-1"`, cap 200 iterations |
| Polling | only cloud-save: 15 × 1s |
| Redirect follow | up to 5 hops |
| Retries | none beyond `retryOnConnectionFailure(true)` |

---

# Platform 3 — C139 (和彩云 / 139网盘)

## C.1 Authentication requirement

**The share LISTING endpoint is fully ANONYMOUS. Getting the download URL requires an account string.**

This is stated twice in the source, once in the API class comment and once on `getShareFiles`:

> `分享接口请求/响应均经 AES-CBC 加密（§14）；mcloud-sign 按「明文 body」计算（§4），加密只是传输包装；mcloud-skey 可省略。`

> `分享列目录：getOutLinkInfoV6 —— 官方为「匿名」调用（§9530修复文档 §2/§3）：`
> `不带 authorization、不带 mcloud-sign、不带 mcloud-* 头；body account 固定空串；`

The listing call goes through `sharePostAnonymous`, which sets **no** `Authorization` and **no** `mcloud-sign`.

**However**, the repository **requires** an account before it will even create a session:

```kotlin
override suspend fun createSession(link: String, pwd: String?, cookie: String): Result<ShareSession> {
    val parsed = ShareLinkParser.parse(link) ?: return Result.failure(...)
    if (C139Constants.extractAccountFull(cookie).isNullOrBlank()) {
        return Result.failure(IllegalStateException("登录态缺少账号信息，请重新登录"))
    }
    ...
}
```

and `getShareDownloadLink` also requires it:

```kotlin
val account = C139Constants.extractAccountFull(cookie)
    ?: throw IllegalStateException("登录态缺少账号信息，请重新登录")
val authorization = C139Constants.extractAuthorization(cookie)
val link = api.getShareDownloadLink(file.fid, session.shareId, account, authorization)
```

Critically: **`authorization` is nullable** in `getShareDownloadLink` (`authorization: String?`), and `sharePostEncrypted` only adds the header when non-blank:

```kotlin
.apply { if (!authorization.isNullOrBlank()) header("Authorization", authorization) }
```

But the **account string is embedded in the request body** and is required (it goes into `account` and `commonAccountInfo.account`).

**Verdict for the port:** the *listing* step is genuinely unauthenticated (testable without any login). The *download URL* step embeds a real 139 account (full phone number) in the body — it is effectively authenticated even though the `Authorization` header is optional. Mark: **listing = public; link = requires account**. Whether a fabricated/blank account would be accepted by the server is **`UNCERTAIN`** — the source never tries it, and always passes a real account from the cookie.

## C.2 Constants (verbatim, `C139Constants.kt`)

```kotlin
const val LOGIN_URL = "https://yun.139.com/m/#/login"
const val COOKIE_DOMAIN = "https://mail.10086.cn"
const val COOKIE_DOMAIN_BACKUP = "https://yun.139.com"

const val SHARE_BASE = "https://share-kd-njs.yun.139.com"
const val SHARE_LIST_URL = "$SHARE_BASE/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6"
const val SHARE_LINK_URL = "$SHARE_BASE/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3"
const val SHARE_GENERAL_URL = "$SHARE_BASE/yun-share/richlifeApp/devapp/IOutLink/getOutLinkGeneral"

const val SHARE_AES_KEY = "PVGDwmcvfs1uV3d1"

const val CLOUD_BASE = "https://personal-kd-njs.yun.139.com"

const val YUN_CHANNEL_SOURCE = "10000034"
const val MCLOUD_VERSION = "7.17.9"
const val MCLOUD_CLIENT = "10701"
const val MCLOUD_CHANNEL = "1000101"
const val YUN_MODULE_TYPE = "100"
const val M4C_SRC = "10002"
const val M4C_CALLER = "PC"

const val X_DEVICEINFO = "||9|7.17.9|chrome|116.0.0.0|2cdaf7ada9e353c70eba99092e177991||windows 10||zh-CN|||"
const val X_CLIENT_INFO = "||9|7.17.9|chrome|116.0.0.0|2cdaf7ada9e353c70eba99092e177991||windows 10||zh-CN|||dW5kZWZpbmVk||"

const val FILE_LIST_URL = "$CLOUD_BASE/hcy/file/list"
const val FILE_UPDATE_URL = "$CLOUD_BASE/hcy/file/update"
const val BATCH_MOVE_URL = "$CLOUD_BASE/hcy/file/batchMove"
const val BATCH_TRASH_URL = "$CLOUD_BASE/hcy/recyclebin/batchTrash"
const val DOWNLOAD_URL = "$CLOUD_BASE/hcy/file/getDownloadUrl"
const val TASK_GET_URL = "$CLOUD_BASE/hcy/task/get"

const val OUTLINK_CREATE_URL =
    "https://yun.139.com/orchestration/personalCloud-rebuild/outlink/v1.0/getOutLink"

const val TRANSFER_CREATE_URL =
    "$SHARE_BASE/yun-share/richlifeApp/devapp/IBatchOprTask/createOuterLinkBatchOprTask"
const val TRANSFER_QUERY_URL =
    "$SHARE_BASE/yun-share/richlifeApp/devapp/IBatchOprTask/queryBatchOprTaskDetail"

const val SHARE_X_DEVICEINFO = "||3|12.27.0|||||chrome 150.0.0.0|360X444|zh-cn|||"
const val SHARE_X_HUAWEI_CHANNELSRC = "10245500"
const val SHARE_X_MM_SOURCE = "0002"

const val SHARE_MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.0.0 Mobile Safari/537.36"

const val PC_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Safari/537.36"
```

## C.3 AES-CBC encryption of the share-interface body (mandatory)

Exact source:

```kotlin
private val shareAesKey: SecretKeySpec =
    SecretKeySpec(C139Constants.SHARE_AES_KEY.toByteArray(Charsets.UTF_8), "AES")

private fun encryptBody(plaintext: String): String {
    val iv = ByteArray(16).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
    cipher.init(Cipher.ENCRYPT_MODE, shareAesKey, IvParameterSpec(iv))
    val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(iv + ct, Base64.NO_WRAP)
}
```

| Parameter | Exact value |
|---|---|
| Algorithm | `AES/CBC/PKCS5Padding` |
| Key | `"PVGDwmcvfs1uV3d1"` — UTF-8 bytes, **16 bytes** |
| Key encoding | raw ASCII/UTF-8 of that literal (`toByteArray(Charsets.UTF_8)`), **not** base64-decoded, not hex |
| IV | **16 random bytes per request** (`SecureRandom().nextBytes`) |
| Key/IV source | fixed key; random IV |
| Padding | PKCS5/PKCS7 |
| Serialization | `base64(IV ‖ ciphertext)` |
| Base64 flavour | Android `Base64.NO_WRAP` (standard alphabet, no line breaks, with `=` padding) |

Source comment: `§14 分享接口 AES-CBC 固定密钥（16 字节，所有账号共用）` and
`base64(IV(16B) ‖ AES_CBC(KEY=PVGDwmcvfs1uV3d1, IV, 明文))`.

Decryption:

```kotlin
private fun decryptBody(b64: String): String {
    val raw = Base64.decode(b64, Base64.NO_WRAP)
    val iv = raw.copyOfRange(0, 16)
    val ct = raw.copyOfRange(16, raw.size)
    val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
    cipher.init(Cipher.DECRYPT_MODE, shareAesKey, IvParameterSpec(iv))
    var d = cipher.doFinal(ct)  // PKCS5Padding 自动去填充
    // alist YunCrypto 同款：解密后若为 gzip 则解压（首 2 字节 0x1f 0x8b）
    if (d.size > 2 && d[0] == 0x1f.toByte() && d[1] == 0x8b.toByte()) {
        d = GZIPInputStream(ByteArrayInputStream(d)).use { it.readBytes() }
    }
    return String(d, Charsets.UTF_8)
}
```

**Post-decryption gzip:** if the decrypted plaintext begins with bytes `0x1f 0x8b`, gunzip it. (Source says this matches alist's `YunCrypto`.)

**Response handling is defensive:**
```kotlin
// 响应体应为加密 base64（§14）；网关透传明文时兜底
return runCatching { JSONObject(decryptBody(body)) }.getOrElse { JSONObject(body) }
```
So: try decrypt-then-parse; on **any** failure, parse the raw body as plain JSON.

For a TypeScript port: `crypto.createDecipheriv('aes-128-cbc', Buffer.from('PVGDwmcvfs1uV3d1','utf8'), iv)` with auto-padding enabled, plus a `zlib.gunzipSync` fallback on the `1f 8b` magic.

## C.4 `mcloud-sign` signing (used by the *share link* call, and by all management calls)

```kotlin
private fun md5(s: String): String {
    val digest = MessageDigest.getInstance("MD5")
    return digest.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

/** §4.1：encodeURIComponent（+→%20，并还原 ! ' ( ) *） */
private fun encodeURIComponent(s: String): String =
    URLEncoder.encode(s, "UTF-8")
        .replace("+", "%20")
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%2A", "*")

fun calSign(bodyJson: String, ts: String, rand: String): String {
    val encoded = encodeURIComponent(bodyJson)
    val sorted = encoded.toCharArray().sorted().joinToString("")
    val b64 = Base64.encodeToString(sorted.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    val res = md5(b64) + md5("$ts:$rand")
    return md5(res).uppercase()
}

fun signHeader(bodyJson: String): String {
    val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
    val rand = buildString {
        val pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        repeat(16) { append(pool.random()) }
    }
    return "$ts,$rand,${calSign(bodyJson, ts, rand)}"
}
```

Exact algorithm:

1. **`ts`** = current local time formatted `yyyy-MM-dd HH:mm:ss` using the **system default locale/timezone** (`Locale.getDefault()`, default timezone). Format literal: `YYYY-MM-DD HH:mm:ss` with a space separator and zero-padded fields.
2. **`rand`** = exactly **16** random characters from the 62-char pool `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`.
3. **`encoded` = `encodeURIComponent(bodyJson)`** — i.e. Java `URLEncoder.encode(s, "UTF-8")` **then** post-processing:
   - `+` → `%20`
   - `%21` → `!`
   - `%27` → `'`
   - `%28` → `(`
   - `%29` → `)`
   - `%2A` → `*`
   Note `URLEncoder.encode` encodes spaces as `+`, and `!`, `'`, `(`, `)`, `*` as `%21`,`%27`,`%28`,`%29`,`%2A`; the replacements restore JS `encodeURIComponent` behaviour. Order of replacement matters: `+`→`%20` first.
4. **`sorted`** = the **characters** of `encoded`, sorted in **ascending single-character ASCII** order (`toCharArray().sorted()` — Kotlin `Char` ordering is by code unit). This is a byte-wise sort of the URL-encoded string, which is safe since it is ASCII.
5. **`b64` = `base64(sorted)`** — standard base64, `Base64.NO_WRAP` (no line breaks), of the UTF-8 bytes of `sorted`.
6. **`res` = `md5(b64) + md5(ts + ":" + rand)`** — lowercase hex MD5 of `b64`, concatenated with lowercase hex MD5 of the string `` `${ts}:${rand}` `` (colon separator).
7. **`sign` = `md5(res).toUpperCase()`** — MD5 of that concatenation, lowercase hex, then **uppercased**.
8. **Header value** = `` `${ts},${rand},${sign}` `` (comma-separated, three parts).
9. Header name is `mcloud-sign`.

⚠️ The source warns the signed string must match what is sent:
> `注意：签名必须基于与实际发送一致的「明文 JSON」字符串（字段顺序、无空格）。`

i.e. even though the body is AES-encrypted on the wire, `mcloud-sign` is computed over the **plaintext JSON string**, and the JSON must have identical key order/formatting to what is encrypted. In TypeScript this means you must serialize the plaintext body **once**, sign that exact string, and encrypt that exact same string.

## C.5 Cookie / account extraction requirements

Two accepted login forms (`isValidCookie`):

- **Path B:** any cookie segment starting with `authorization=` and longer than `"authorization="` → valid.
- **Path A:** cookie must contain **both** `Os_SSo_Sid=` and `RMKEY=` (non-empty). `REQUIRED_FAST_KEYS = setOf("Os_SSo_Sid", "RMKEY")`.

Cookie domains and extraction:
```kotlin
const val COOKIE_DOMAIN = "https://mail.10086.cn"
const val COOKIE_DOMAIN_BACKUP = "https://yun.139.com"
```
`extractCookies` reads `mail.10086.cn` **first**, then `yun.139.com`, keeping only first-seen values of a whitelist (`KEEP_KEYS`), joined as `"k=v; k=v"`.

Kept keys verbatim: `Os_SSo_Sid`, `RMKEY`, `UserData`, `Login_UserNumber`, `_139_index_isLoginType`, `UUIDToken`, `JSESSIONID`, `areaCode8011`, `provCode8011`, `authorization`, `auth_token`, `token`, `ud_id`, `ORCHES-I-ACCOUNT-SIMPLIFY`, `ORCHES-I-ACCOUNT-ENCRYPT`, `nation_code`, `platform`, `cutover_status`, `isUserDomainError`, `a_k`, `skey`, `WT_FPC`, `hecaiyun_stay_url`, `hecaiyun_stay_time`, `hecaiyundata2021jssdkcross`, `sajssdk_2015_cross_new_user`.

**`authorization` extraction:** first cookie segment starting with `authorization=`; value is the remainder after `=`. Format per the source: `形如 "Basic cGM6..."` and `§3.2 最终态：Authorization = base64("pc:<account>:<authToken>")`.

**Full account extraction (`extractAccountFull`)** — required as the `account` body field. Priority order:
1. `ORCHES-I-ACCOUNT-ENCRYPT` → Base64-decode → that is the full phone number.
2. `authorization` → strip the leading literal `"Basic"` (`removePrefix("Basic").trim()`), Base64-decode, then `split(":").getOrNull(1)` — **index 1**, i.e. the middle field of `pc:<account>:<authToken>`.
3. `Login_UserNumber` → raw value.

Returns `null` if none. **This must be the full (unmasked) phone number.**

(`extractAccount` is a separate, display-only variant preferring `ORCHES-I-ACCOUNT-SIMPLIFY`, a masked value like `177****8634` — **not** for API use.)

## C.6 Step-by-step resolve sequence

### Step C-1 — get share title + leaked password (`getOutLinkGeneral`, ANONYMOUS, encrypted)

Plaintext JSON (built by `JSONObject` insertion order):
```json
{"getOutLinkGeneralReq":{"linkID":"<linkId>","isPasswd":1,"account":""}}
```
Types: `linkID` string, `isPasswd` number `1`, `account` string `""`.

```
POST https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkGeneral
Body: base64(IV ‖ AES_CBC(json))
Headers (sharePostAnonymous):
  hcy-cool-flag: 1
  x-deviceinfo: ||3|12.27.0|||||chrome 150.0.0.0|360X444|zh-cn|||
  x-huawei-channelsrc: 10245500
  x-mm-source: 0002
  Content-Type: application/json;charset=UTF-8
  User-Agent: Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36
  Origin: https://yun.139.com
  Referer: https://yun.139.com/
  Accept: application/json, text/plain, */*
```

**No `Authorization`, no `mcloud-sign`, no `mcloud-*` headers.**

Success check:
```kotlin
val resultCode = respJson.optString("resultCode")
if (resultCode.isNotBlank() && resultCode != "0") return@withContext null
if (!respJson.optBoolean("success", true)) return@withContext null
```

Read paths:

| Field | JSON path |
|---|---|
| title | `data.getOutLinkGeneralResp.outLinkGeneral[0].lkName` |
| passwd | `data.getOutLinkGeneralResp.outLinkGeneral[0].passwd` |

(Read only when `outLinkGeneral` array length > 0; blank → `null`.)

Source note on the leaked password:
> `139 会在该接口明文回吐提取码（官方 Web 同样自动填），用于自动填入、避免下载因缺密码报 9188。`

Repository usage:
```kotlin
val leakedPwd = api.getOutLinkPassword(parsed.shareId)
val passwd = pwd?.takeIf { it.isNotBlank() } ?: leakedPwd.orEmpty()
val title = api.getOutLinkTitle(parsed.shareId)?.takeIf { it.isNotBlank() } ?: parsed.shareId
ShareSession(parsed.shareId, passwd, title)
```
Note **two separate calls** are made to the same endpoint (one for password, one for title). A port can collapse them into one.

### Step C-2 — list the share directory (`getOutLinkInfoV6`, ANONYMOUS, encrypted)

Plaintext JSON:
```json
{"getOutLinkInfoReq":{
  "account":"",
  "linkID":"<linkId>",
  "passwd":"<passwd>",
  "caSrt":1,
  "coSrt":1,
  "srtDr":0,
  "bNum":<begin>,
  "pCaID":"<pcaId>",
  "eNum":<end>
}}
```
Types: `account` string `""` (mandatory empty), `linkID` string, `passwd` string (empty when none), `caSrt` number `1`, `coSrt` number `1`, `srtDr` number `0`, `bNum` number, `pCaID` string, `eNum` number.

Field order as produced by the Kotlin builder: `account`, `linkID`, `passwd`, `caSrt`, `coSrt`, `srtDr`, `bNum`, `pCaID`, `eNum`. (Relevant if you want a byte-identical `mcloud-sign`, though this call is anonymous and unsigned.)

```
POST https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6
Body: base64(IV ‖ AES_CBC(json))
Headers: same as Step C-1 (sharePostAnonymous)
```

Source rules:
> `不带 authorization、不带 mcloud-sign、不带 mcloud-* 头；body account 固定空串；`
> `带完整字段（caSrt/coSrt/srtDr/bNum/eNum），否则 9530；passwd 填错返回 9188。`

`pCaID` semantics: root is the literal string **`"root"`** (never empty):
```kotlin
val pcaId = if (dirFid == "0" || dirFid.isBlank()) "root" else dirFid
```
> `pCaID 根目录必须传 "root"（§16.2：空串会报 pCaID不能为空），子目录传父 caID / coID`

**Response parsing:**

```kotlin
val resultCode = respJson.optString("resultCode")
if (resultCode.isNotBlank() && resultCode != "0") { throw ... }   // message from respJson "desc"
if (!respJson.optBoolean("success", true)) { throw ... }
val data = respJson.optJSONObject("data") ?: return emptyList()
```

| JSON path | Meaning |
|---|---|
| `data.caLst` (array) | **sub-folders** |
| `data.coLst` (array) | **files** (and possibly folders with `coType == 2`) |

`caLst[i]`:

| JSON path | Type | Mapped to |
|---|---|---|
| `caID` | string | `fid` |
| `caName` | string | `fname` |
| — | — | `fsize = 0`, `isdir = true` |
| — | — | `pdirFid = pcaId`, `fidToken = ""` |
| `udTime` then `ctTime` | string | `modifyTime` |

`coLst[i]`:

| JSON path | Type | Mapped to |
|---|---|---|
| `coID` | string | `fid` |
| `coName` | string | `fname` |
| `coSize` | long | `fsize` |
| `isdir` (bool) OR `coType` (int, `== 2`) | bool/int | `isdir` |
| `udTime` then `ctTime` | string | `modifyTime` |

```kotlin
isdir = item.optBoolean("isdir", item.optInt("coType", 1) == 2)
```

⚠️ **This is the single most important C139 detail** — folders appear in BOTH `caLst` and `coLst`; the port must read both and merge, folders first:
> `⚠️ 139 把【子文件夹】放在 caLst、【文件】放在 coLst（coType==2 也可能是文件夹）。`
> `原实现只读了 coLst，导致「顶层是文件夹 / 顶层只挂子文件夹」的分享显示为空。`
> `现同时解析 caLst + coLst 并合并返回（文件夹在前）。`

`modifyTime` uses `udTime` with `ctTime` as fallback: `item.optString("udTime").ifBlank { item.optString("ctTime") }`.

Empty directory → empty list (semantic preserved: UI shows "此目录为空").

**Pagination loop** (`C139ResolveRepository.listFiles`) — **offset-based**, not cursor-based:

```kotlin
var begin = 1
do {
    val batch = api.getShareFiles(session.shareId, pcaId, session.stoken, begin, begin + 199)
    all += batch
    begin += 200
} while (batch.size == 200 && begin <= 20_000)
```

- `bNum = begin`, `eNum = begin + 199` → a **200-item window** (inclusive bounds).
- `begin` starts at 1 and increments by 200.
- Continue while the returned batch has **exactly 200** items; hard cap `begin <= 20_000` (i.e. 100 pages / 20,000 entries).
- Default parameter values in the API signature are `begin: Int = 1, end: Int = 200`.

### Step C-3 — get the share download URL (`dlFromOutLinkV3`, encrypted, `mcloud-sign` over plaintext)

Plaintext JSON:
```json
{"dlFromOutLinkReqV3":{
  "account":"<full account>",
  "linkID":"<linkId>",
  "coIDLst":{"item":["<coId>"]},
  "commonAccountInfo":{"account":"<full account>","accountType":1}
}}
```
Types: `account` string, `linkID` string, `coIDLst.item` array of strings (single element), `commonAccountInfo.account` string, `commonAccountInfo.accountType` number `1`.

```
POST https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3
Body: base64(IV ‖ AES_CBC(json))
Headers (sharePostEncrypted):
  [Authorization: <authorization>]     // only if non-blank
  hcy-cool-flag: 1
  x-deviceinfo: ||3|12.27.0|||||chrome 150.0.0.0|360X444|zh-cn|||
  x-huawei-channelsrc: 10245500
  x-mm-source: 0002
  mcloud-sign: <ts>,<rand>,<sign>      // computed over the PLAINTEXT json
  Content-Type: application/json;charset=UTF-8
  User-Agent: Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36
  Origin: https://yun.139.com
  Referer: https://yun.139.com/
  Accept: application/json, text/plain, */*
```

Note this is the ONLY share call that computes `mcloud-sign` (over the plaintext body), and it does **not** send the `mcloud-*` channel headers that `cloudPost` sends.

Source warning about `hcy-cool-flag`:
> `必须带 hcy-cool-flag: 1（网关解密开关，缺它业务层拿不到明文 → 9530）`

**Response parsing:**

| JSON path | Meaning |
|---|---|
| `resultCode` (string) | blank or `"0"` = OK |
| `success` (bool) | default true |
| `data.redrUrl` (string) | the OBS pre-signed direct URL |
| `data.fileName` (string) | may be absent |
| `data.coName` (string) | fallback filename |
| `data.coSize` / `data.size` | size |

```kotlin
if (resultCode.isNotBlank() && resultCode != "0") throw IllegalStateException(desc)  // fallback "获取下载链接失败（<resultCode>）"
if (!success) throw ...                                                             // fallback "获取下载链接失败"
val data = respJson.optJSONObject("data") ?: return null
val url = data.optString("redrUrl")
if (url.isBlank()) return null
DownloadLink(
    fid = coId,
    filename = data.optString("fileName").ifEmpty { data.optString("coName").ifEmpty { coId } },
    downloadUrl = url,
    size = data.optLong("coSize", data.optLong("size"))
)
```

Repository override — the filename from the listing wins:
```kotlin
link.copy(filename = file.fname.ifBlank { link.filename })
```
> `文件名用列表里的 coName（dlFromOutLinkV3 响应不含文件名，否则会 fallback 成 coID 乱码）`

The URL is documented as `data.redrUrl（OBS S3 签名直链，900s 有效）` — **900 second validity**. `UNCERTAIN:` the exact clock-skew tolerance is not specified.

Note `coId` is the `coID` obtained in Step C-2 (`file.fid`). Folders from `caLst` have `caID` as their fid, which would be passed as `coID` if a directory were downloaded — the source does not handle that case explicitly.

### Step C-4 — required download headers + cleanup

```kotlin
isC139 -> mapOf("User-Agent" to C139Constants.PC_UA)
```

Only a User-Agent; **no Cookie, no Referer**. The URL is a self-signed OBS URL.

**No temp-file/transfer cleanup for share links** — `ensureTempDir` deliberately fails:
```kotlin
override suspend fun ensureTempDir(cookie: String): Result<String> =
    Result.failure(UnsupportedOperationException("139 分享无需转存"))
```
and `getShareDownloadLink` never transfers. (A separate `transferFile` path exists via `createTransferTask`/`queryTransferTask`, described below, but it is opt-in "save to my drive", not part of resolving a direct URL.)

## C.7 C139 cloud-save (`transfer`) path — polling loop

Create task (share host, AES, `mcloud-sign`):

```
POST https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IBatchOprTask/createOuterLinkBatchOprTask
```
Plaintext body:
```json
{"createOuterLinkBatchOprTaskReq":{
   "msisdn":"<account>","ownerAccount":"","taskType":1,
   "taskInfo":{
     "contentInfoList":["/<coId>"],"catalogInfoList":[],
     "newCatalogID":"<toFolderId>","linkID":"<linkId>",
     "newCatalogName":"手机图片","needPassword":true},
   "linkID":"<linkId>","needPassword":true},
 "commonAccountInfo":{"account":"<account>","accountType":1}}
```
Note `contentInfoList` entries are **prefixed with `/`** (`put("/$it")`), and `newCatalogName` is the hardcoded literal `"手机图片"`.
Success code: `resultCode` else `code`, must be blank or `"0"`. Read `data.taskID`.

Query result (share host, AES, `mcloud-sign`):
```
POST https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IBatchOprTask/queryBatchOprTaskDetail
```
Plaintext body:
```json
{"queryBatchOprTaskDetailReq":{"taskID":"<taskID>","msisdn":"<account>","commonAccountInfo":{"account":"<account>","accountType":1}}}
```
Completion condition:
```kotlin
val task = data.optJSONObject("batchOprTask")
val done = (task?.optInt("progress") ?: 0) >= 100 && (task?.optInt("taskStatus") ?: 0) == 2
```
Result mapping:
```kotlin
data.contentList.idRspInfo[i]  → if (item.optString("reason") == "0000") map[item.optString("srcId")] = item.optString("rstId")
```
Polling loop (`C139ResolveRepository.transferFile`):
```kotlin
for (i in 0 until 30) {
    kotlinx.coroutines.delay(800)
    val result = api.queryTransferTask(taskId, account, authorization)
    if (result.done) { newId = result.mapping[file.fid]; break }
}
newId ?: throw IllegalStateException("转存超时或失败")
```
**30 attempts × 800 ms = 24 s max**, no backoff. `srcId` keys are matched against `file.fid`.

## C.8 C139 personal-drive endpoints (`cloudPost`, plaintext JSON + full header set)

All management calls use `cloudPost`, which sends **plaintext JSON** (no AES) with `Authorization` + `mcloud-sign` over the plaintext body + the full channel-header set. Source:
> `⚠️ 修复（《139网盘管理认证失败修复》）：APISIX 网关鉴权层强制要求全套 x-yun-* / mcloud-* 渠道头，`
> `仅有 Authorization+mcloud-sign 会返回 HTTP 404 + code:"04000005" 认证失败。`

Full header set verbatim:

```
Authorization: <authorization>
mcloud-sign: <signHeader(plainBody)>
x-yun-channel-source: 10000034
x-yun-app-channel: 10000034
x-huawei-channelSrc: 10000034
mcloud-version: 7.17.9
mcloud-client: 10701
mcloud-channel: 1000101
mcloud-route: 001
x-yun-module-type: 100
x-yun-api-version: v1
x-yun-svc-type: 1
x-SvcType: 1
caller: web
x-inner-ntwk: 2
CMS-DEVICE: default
x-m4c-src: 10002
x-m4c-caller: PC
X-Deviceinfo: ||9|7.17.9|chrome|116.0.0.0|2cdaf7ada9e353c70eba99092e177991||windows 10||zh-CN|||
x-yun-client-info: ||9|7.17.9|chrome|116.0.0.0|2cdaf7ada9e353c70eba99092e177991||windows 10||zh-CN|||dW5kZWZpbmVk||
INNER-HCY-ROUTER-HTTPS: 1
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
X-Requested-With: mark.via
Content-Type: application/json;charset=UTF-8
User-Agent: <PC_UA>
Origin: https://yun.139.com
Referer: https://yun.139.com/
Accept: application/json, text/plain, */*
[Cookie: <cookie>]                 // only when cookie != null
[mcloud-skey: <skey from Cookie>]  // only when needSkey==true and skey present
```

`needSkey` is true only for `createShare` (getOutLink) and `getQuota`. `skey` is taken from the Cookie segment `skey=<value>`.

Success check:
```kotlin
private fun checkCloud(json: JSONObject, fallback: String) {
    val code = json.optString("code")
    if (json.optBoolean("success", true) && (code == "0000" || code == "0")) return
    ...
}
```
**Both** `success == true` (default true) **and** `code ∈ {"0000","0"}` are required.

Cloud file list: `POST https://personal-kd-njs.yun.139.com/hcy/file/list`
```json
{"pageInfo":{"pageSize":100,"pageCursor":null},"orderBy":"updated_at","orderDirection":"DESC",
 "parentFileId":"<id>","imageThumbnailStyleList":["Small","Large"]}
```
⚠️ **`pageCursor` must be a real JSON `null`**, never the string `"null"`:
> `⚠️ pageCursor 必须是真正的 JSON null；若误传字符串 "null"，服务端会当作无效游标忽略并回吐第一页，导致翻页原地打转`

And on the response side:
> `⚠️ Android org.json 陷阱：响应中 "nextPageCursor": null 时，optString 返回的是字符串 "null" …必须先用 isNull() 判断真 JSON null，并额外过滤字符串 "null"。`

Pagination: start cursor `null`; read `data.nextPageCursor`; stop if it is JSON null, empty, `"null"`, or unchanged from the current cursor (guard added because 139 may echo the same cursor); cap `repeat(200)`; **dedupe by `fid`** using a `HashSet` (`139 按 updated_at 排序翻页，大量文件时间相同时游标可能重复返回边界项`).
Item fields: `fileId` (fid, also `fidToken`), `name`, `size`, `type` (`== "folder"` → isdir), `updatedAt`.

Personal drive download URL: `POST …/hcy/file/getDownloadUrl` with body `{"fileId":"<id>"}` → `data.url`, `data.size`; source notes `getDownloadUrl 响应不含 name（§4.6 仅 url/expiration/size）`. Described as `OBS 预签名，900s 有效`.

Async tasks (move/delete): `POST …/hcy/file/batchMove` body `{"fileIds":[...],"toParentFileId":"<id>"}` and `POST …/hcy/recyclebin/batchTrash` body `{"fileIds":[...]}` → `data.taskId`. Poll `POST …/hcy/task/get` body `{"taskId":"<id>"}` → `data.taskInfo.status`, `data.taskInfo.progress`, `data.batchFileResults[i].fileId` + `.errCode`. (`C139CloudViewModel` polls with 1500 ms then 1200 ms delays and an 800 ms delay elsewhere, but the exact loop counts are in the ViewModel, not the API layer — see the ViewModel if the port needs the personal-drive UI loop.)

## C.9 C139: pagination / polling / retry summary

| Aspect | Value |
|---|---|
| Share list pagination | offset window `bNum=begin`, `eNum=begin+199`, step 200, start 1, stop when batch `< 200`, cap `begin <= 20000` |
| Cloud list pagination | `pageCursor`, stop on JSON `null`/`"null"`/unchanged, cap 200, dedupe by fid |
| Transfer polling | 30 × 800 ms |
| GetOutLink general | 2 calls in the repo (title + password); collapsing to 1 is behaviour-preserving |
| Retries | none beyond `retryOnConnectionFailure(true)` |

## C.10 C139: referenced error codes

From source comments only (not decoded further):
- `9530` — missing device/channel context headers on share endpoints; also returned when `hcy-cool-flag: 1` is absent. Comment: `分享接口必带设备/渠道上下文头（设备头修复文档 §3：缺任一即 9530）`.
- `9188` — wrong share password (`passwd 填错返回 9188`).
- `04000005` — gateway authentication failure on the personal-drive host when the `x-yun-*`/`mcloud-*` header set is incomplete.

---

# 4. Cross-platform comparison

| | BAIDU | PAN123 | C139 |
|---|---|---|---|
| Anonymous share listing | **Yes** (public shares, no `sekey`) | **Yes** | **Yes** |
| Auth needed for direct link | **Yes** — `BDUSS` cookie | **Yes** — Bearer JWT (`authorToken`) | **Account required in body** (Authorization header optional) |
| Crypto the port must implement | **None** (no client signing, no AES; just filter `encrypt == 0`) | **CRC-32 ×2 + `+16h` UTC time formatting + digit substitution** | **AES-128-CBC (fixed key, random IV, base64 `IV‖CT`) + optional gunzip; MD5-based `mcloud-sign`** |
| Share password handling | `POST /share/verify` → `randsk` → `sekey` + `BDCLND` cookie | passed as `SharePwd` query param; **omit when blank** | passed as `passwd` JSON field; leaked by `getOutLinkGeneral` |
| Transfer/temp step | **Yes** — create `/YunX临时转存`, transfer, get link, **delete immediately** | No | No |
| Polling | none | cloud-save only (15 × 1 s) | transfer only (30 × 800 ms) |
| Post-link cleanup | delete file, then delete temp dir if path is inside it; failures non-blocking | none | none |
| Page size / cap | 100 / 100 pages | 100 / 49 pages | 200 / 100 pages |
| URL host(s) used | `pan.baidu.com`, `yun.baidu.com`, `d.pcs.baidu.com` | `yun.123pan.cn` (list), `www.123865.com` (link), `<shareId>.mshare.123pan.cn` (save) | `share-kd-njs.yun.139.com` (share), `personal-kd-njs.yun.139.com` (drive) |

## 4.1 Porting hazards checklist

1. **PAN123 `crc32Hex` must not zero-pad.** `Long.toHexString` yields variable length; the source's own comment ("8 位") contradicts the code. Use `(crc >>> 0).toString(16)`.
2. **PAN123 `SharePwd` must be absent, not empty**, when there is no password (400 `"请输入Next"`).
3. **PAN123 `next` is always the literal `"0"`** in the share list; paging is via `Page`.
4. **PAN123 key-case is inconsistent by design**: share download uses `ShareKey`/`FileID`/`S3KeyFlag`/`Size`/`Etag`, response `data.DownloadURL`; cloud download uses `driveId`/`etag`/`fileId`/`s3keyFlag`/`type`/`fileName`/`size`, response `data.DownloadUrl`.
5. **PAN123 signs the plaintext-invariant path** including `/b` (except `/api/file/download_info`), excluding query.
6. **C139 `mcloud-sign` is computed over the plaintext JSON** that is then AES-encrypted — serialize once, use the same string for both.
7. **C139 `pageCursor` must be JSON `null`**, and a returned `"nextPageCursor": null` must be read as null, not the string `"null"`.
8. **C139 must merge `caLst` + `coLst`** or folder-only shares appear empty.
9. **C139 `coType == 2` also means folder.**
10. **Baidu `isdir` is a string `"1"`** in the share list but an int `1` in the cloud list.
11. **Baidu `randsk`/`sekey` is already URL-encoded** — do not encode it again.
12. **Baidu `Referer` for transfer is exactly `https://pan.baidu.com/s/`** (bare, no surl).
13. **Baidu `locatedownload` is a POST with body `"0"`** and `time` in **seconds**.
14. **Baidu deletes the transfer BEFORE downloading**, not after. The CDN URL survives deletion.
15. **123 redirect probing uses `Content-Length <= 8192` as the "this is a JSON hop, not a file" test**; preserve it.

## 4.2 Explicitly UNCERTAIN items

- Baidu: any `sign`/salt/appkey algorithm — **does not exist in this source**; listed only because it was hypothesised. Do not implement one.
- Baidu: AES-CTR parameters for `encrypt=1` URLs — referenced by comment, never implemented.
- Baidu: `urls[i].rank` field — mentioned in comments, never read in code.
- Baidu: `share/transfer` `extra.list[i].value` (path) equality checking — the code trusts `to`.
- PAN123: no reproducible signature test vector (random + time dependent).
- PAN123: `copy/save/get` completion payload shape — the source itself says `响应格式未在抓包完整呈现，容错多种形态`.
- PAN123: `createSession` title heuristic is marked `文档待验证 #4` by the author.
- C139: whether `dlFromOutLinkV3` accepts a blank/fake `account` — never attempted; the source always supplies a real full phone number.
- C139: clock-skew tolerance on the 900 s OBS URLs.
- C139: personal-drive async polling counts live in the ViewModel, not the API layer.
- All: HTTP status codes are largely ignored; success is determined by body fields (`errno`/`code`/`resultCode`/`success`). Network-level retry is only `retryOnConnectionFailure(true)`.
