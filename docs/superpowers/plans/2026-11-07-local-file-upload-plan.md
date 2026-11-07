# Local File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe local-file upload flow to YunX Desktop, with a real Baidu Open Platform adapter and explicit unavailable states for the other five platforms.

**Architecture:** Keep file access and network transfer in the Electron main process. The renderer sends only validated file paths and user choices through narrow IPC methods, while a dedicated upload manager owns serial task execution, bounded chunk reads, cancellation and progress events. Baidu OAuth credentials are stored separately from existing web Cookies and are used by a provider-specific adapter implementing the documented precreate → locateupload → multipart upload → create sequence.

**Tech Stack:** Electron 44, TypeScript 7 / Node16 module resolution, Node built-in `fetch`, `fs/promises`, `crypto`, native DOM JavaScript renderer, existing script-based mock/UI tests.

**Spec:** `docs/superpowers/specs/2026-11-07-local-file-upload-design.md`

## Global Constraints

- Do not modify `D:\软件\YunX-Desktop（网盘聚合）`; work only in `D:\VibeCoding\YunX-Desktop-source`.
- Do not install dependencies or run lifecycle scripts without fresh permission; the previous `npm install` was denied.
- Do not implement undocumented upload endpoints for Quark, 123pan, 139 Cloud, UC or Xunlei.
- Existing web-session Cookie credentials remain separate from Baidu Open Platform OAuth credentials.
- If `safeStorage.isEncryptionAvailable()` is false, Baidu OAuth upload is unavailable and OAuth secrets/tokens must not be saved.
- Baidu upload paths are restricted to `/apps/{appname}` and this first version accepts a root-level filename only; remote collisions use documented `rtype=0` failure behavior and never overwrite or silently rename.
- File bytes must stay in the main process and be read in bounded chunks; no binary buffer crosses renderer IPC.
- Single-file uploads are the first release behavior; multiple selected files are queued serially.

## Review Focus

- A renderer-supplied path points to a directory, missing file, unreadable file, or symlink: main process rejects it before any network request; covered in Task 3 path-validation tests.
- A destination contains traversal, a slash, an empty name, or an overlong/invalid filename: main process rejects it before OAuth/API calls; covered in Task 3 destination tests.
- OAuth token storage runs without Electron encryption: no OAuth secret/token is persisted and capability reports unavailable; covered in Task 1 store tests.
- Baidu precreate returns only some `block_list` indexes: only those parts are uploaded, then create receives the original block list and upload ID; covered in Task 2 protocol tests.
- A locate-upload response contains an HTTP/non-HTTPS or malformed host: adapter rejects it and does not upload bytes; covered in Task 2 host-validation tests.

---

### Task 1: OAuth credential storage and capability state

**Files:**
- Modify: `src/main/store/credentialStore.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/main.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/style.css`
- Test: `scripts/verify-upload-store.cjs`

**Interfaces:**
- Consumes: existing `CredentialStore`, Electron `safeStorage`, existing settings IPC pattern.
- Produces: `BaiduOAuthConfig { appKey, appSecret, appName, redirectUri }`, `BaiduOAuthTokens { accessToken, refreshToken, expiresAt }`, and main-only `CredentialStore.saveBaiduOAuth(...)`, `getBaiduOAuth()`, `clearBaiduOAuth()`, `canUseSecureOAuth()` methods; preload methods `auth.getBaiduOAuthStatus()`, `auth.saveBaiduOAuthConfig(...)`, `auth.startBaiduOAuth()`, `auth.clearBaiduOAuth()`.

- [ ] **Step 1: Write failing store tests** in `scripts/verify-upload-store.cjs` using Electron's real `safeStorage` behavior or a small injected store seam. Assert encrypted storage is required for OAuth data, config/tokens round-trip when available, clear removes all OAuth data, and unavailable encryption reports false without persisting secrets.
- [ ] **Step 2: Run the focused store test** with the repository's existing build/test prerequisites only after dependencies are available. Expected initially: missing methods or failing assertions.
- [ ] **Step 3: Implement OAuth-specific storage** in `CredentialStore` without changing existing Cookie fallback semantics. Store config/tokens under a separate versioned key, require `safeStorage.isEncryptionAvailable()`, expose capability status without returning secrets to renderer, and rotate the refresh token by replacing the complete encrypted entry atomically before persisting.
- [ ] **Step 4: Add narrow OAuth IPC** in `main.ts` and `preload.ts`. Validate string lengths and required fields in main; never expose `appSecret`, refresh token, or access token through a list/status response. Add a main-process OAuth state holder and `BrowserWindow` callback handler used by Task 2's authorization flow.
- [ ] **Step 5: Add capability/settings UI** in `app.js` and `style.css` showing Baidu Open Platform upload as unavailable until secure storage, app configuration, and OAuth authorization are complete; include an explicit “not supported yet” label for the other five providers.
- [ ] **Step 6: Run the focused test** and verify PASS; also confirm the existing credential behavior remains covered by existing login tests.

### Task 2: Baidu OAuth callback and documented upload adapter

**Files:**
- Create: `src/main/upload/baiduOAuth.ts`
- Create: `src/main/upload/baiduUpload.ts`
- Modify: `src/main/store/credentialStore.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/net/http.ts`
- Test: `scripts/verify-baidu-upload.cjs`

**Interfaces:**
- Consumes: Task 1's OAuth config/tokens and `ResolveContext`-style HTTP injection.
- Produces: `BaiduUploadAdapter.upload(input: { filePath: string; fileName: string; appName: string; tokens: BaiduOAuthTokens; signal: AbortSignal; onProgress: (bytes: number) => void }): Promise<{ path: string; fsId?: string; size: number }>` and `BaiduUploadAdapter.refreshIfNeeded(...)`.

- [ ] **Step 1: Write the failing mock-protocol tests** in `scripts/verify-baidu-upload.cjs`. Rewrite official HTTPS URLs to a local HTTP server, capture request method/query/form fields, and assert: precreate is POST with `method=precreate`, access token, `/apps/{appName}/{fileName}` path, size, `isdir=0`, MD5 `block_list`, `autoinit=1`, and returned upload ID/missing indexes; locateupload is GET with documented parameters; only HTTPS server hosts are accepted; only returned missing chunk indexes are sent as multipart `superfile2`; create is POST with matching path/size/block list/uploadid and `rtype=0`; progress advances only after successful chunks; API errors and aborts reject cleanly without create.
- [ ] **Step 2: Run the focused adapter test** and verify it fails because the adapter does not exist.
- [ ] **Step 3: Extend `HttpOptions` and request helpers** only as needed for bounded binary/multipart requests in main. Keep ordinary `body?: string` compatibility; build the multipart body for one chunk in a bounded `Buffer` with the Node built-in `FormData`/`Blob` or a standards-compliant multipart encoder already available in the runtime, and set an explicit request timeout. Do not create a generic renderer binary transport.
- [ ] **Step 4: Implement `baiduOAuth.ts`** with official authorization-code constants: authorize URL `https://openapi.baidu.com/oauth/2.0/authorize`, `response_type=code`, configured AppKey as `client_id`, default `redirect_uri=oob`, `scope=basic,netdisk`, random state, and one-time code validation. Open the URL in a dedicated Electron `BrowserWindow`; intercept the documented OOB success URL `http://openapi.baidu.com/oauth/2.0/login_success`, parse its query code, compare returned state, prevent navigation, and close only after a valid code is captured. Exchange at `https://openapi.baidu.com/oauth/2.0/token` using the documented GET query fields `grant_type=authorization_code`, code, client ID/secret and exact redirect URI; refresh with `grant_type=refresh_token`, rotating the returned refresh token. Keep secrets in main only.
- [ ] **Step 5: Implement `baiduUpload.ts`** with bounded standard-user chunks of 4 MiB and maximum 1024 chunks. Compute lowercase MD5 for each chunk, call precreate with the documented file fields plus conflict-fail `rtype=0` only where the endpoint accepts it, validate the returned upload ID and missing-index array, obtain an HTTPS upload host from documented response fields `servers[].server` (fall back only to other returned HTTPS entries), upload only required indexes to `/rest/2.0/pcs/superfile2` as multipart fields `method=upload`, `type=tmpfile`, `path`, `uploadid`, `partseq`, `access_token`, then call create with the original block list and `rtype=0` (collision fails, does not overwrite). Validate `/apps/{appName}` root path, filename, regular-file size and abort signal before every network operation.
- [ ] **Step 6: Run the focused adapter test** and verify PASS, including zero-byte/one-chunk, multi-chunk, partial block list, malformed host, API error and cancellation cases.

### Task 3: Upload task manager and secure file-selection IPC

**Files:**
- Create: `src/main/upload/uploadManager.ts`
- Modify: `src/main/main.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/shared/types.ts`
- Test: `scripts/verify-upload-manager.cjs`

**Interfaces:**
- Consumes: Task 2 `BaiduUploadAdapter`, `CredentialStore`, Electron `dialog`, Node `fs/promises`.
- Produces: `UploadTask`, `UploadStatus`, and `UploadManager` methods `create(files, platform, destination)`, `start(id)`, `cancel(id)`, `remove(id)`, `list()`, `get(id)`; events `progress`, `done`, `error` with `upload:progress`, `upload:done`, `upload:error` IPC forwarding.

- [ ] **Step 1: Write failing manager tests** covering serial queue ordering, task states, progress aggregation, cancellation, removal, unsupported platform rejection, missing/dir path rejection, and destination validation before adapter invocation.
- [ ] **Step 2: Run the focused manager test** and verify it fails because the manager/types do not exist.
- [ ] **Step 3: Add shared upload types** with task IDs distinct from download IDs, source path kept main-process-only where possible, destination filename/path, byte totals, completed bytes, status (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`), error and timestamps.
- [ ] **Step 4: Implement main-process file validation and serial `UploadManager`**. Use `lstat/stat` to require regular readable files, reject directories/special files, derive a safe default basename, queue multiple files serially, retain only bounded runtime state, and call the Baidu adapter only when secure OAuth capability and credential state are valid.
- [ ] **Step 5: Register IPC handlers**: `upload:pickFiles` uses native `showOpenDialog({ properties: ['openFile', 'multiSelections'] })`; `upload:add` accepts paths plus platform/destination; `upload:list`, `upload:start`, `upload:cancel`, `upload:remove` manage tasks. Validate all renderer inputs in main and never accept a URL or raw bytes.
- [ ] **Step 6: Add preload wrappers and progress event unsubscribe functions**, then run focused manager tests and verify PASS.

### Task 4: Renderer upload control, confirmation and task view

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/index.html`
- Modify: `scripts/verify-ui.cjs`

**Interfaces:**
- Consumes: Task 1 capability status and Task 3 preload methods/events.
- Produces: keyboard-accessible upload button at the far left of the title/navigation area, drag-over/drop selection flow, confirmation panel, explicit platform capability labels, and upload task rendering.

- [ ] **Step 1: Extend the UI smoke test** to assert upload control placement/label, native picker IPC call, drag-over visual state, dropped-file confirmation without an upload IPC call, unsupported provider copy, and upload task progress/error rendering.
- [ ] **Step 2: Run `verify-ui.cjs`** after the test changes and verify the new assertions fail.
- [ ] **Step 3: Add upload state and render functions** in `app.js`: selected files, destination name, platform capability, confirmation/error state and upload tasks. Keep multi-file confirmation explicit and queue them serially through main.
- [ ] **Step 4: Add the upload button and drop handlers**. Use `preventDefault` on `dragover`/`drop`, show a visible `.drop-active` state, obtain dropped paths through a narrow preload method that calls `webUtils.getPathForFile(file)` on each Electron `File`, and call no upload handler until the user confirms.
- [ ] **Step 5: Add confirmation and task controls** with Baidu selectable only when capability status is ready, all other platforms disabled with explanatory copy, and task cancel/remove buttons. Escape/keyboard behavior must remain usable.
- [ ] **Step 6: Run the UI smoke test** and verify PASS, including existing resolve/download/accounts/settings checks.

### Task 5: Regression, packaging documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs-api-spec.md` only if a cross-reference is needed; do not rewrite unrelated protocol documentation.
- Modify: `scripts/verify-login.cjs` only if OAuth capability needs a regression fixture.
- Test: existing `scripts/verify-adapters.cjs`, `scripts/verify-engine.cjs`, `scripts/verify-taskmanager.cjs`, `scripts/verify-ui.cjs`, `scripts/verify-login.cjs`.

**Interfaces:**
- Consumes: Tasks 1–4 complete upload feature.
- Produces: user-facing setup instructions, documented unsupported platforms and a verified build/test result.

- [ ] **Step 1: Update README** with Baidu Open Platform app setup, OAuth configuration, `/apps/{appname}` root-only destination, collision-fail behavior, secure-storage requirement, and explicit unsupported status for the other providers; do not claim Cookie login enables upload.
- [ ] **Step 2: Run `npm run typecheck` from `D:\VibeCoding\YunX-Desktop-source`** only if dependencies already exist; otherwise report the prerequisite without bypassing permission controls.
- [ ] **Step 3: Run the focused upload scripts and all existing verification scripts** from the repository root. Expected: every assertion passes; if dependencies are unavailable, report the exact blocked command and do not substitute an unverified result.
- [ ] **Step 4: Inspect `git diff --check`, verify only intended source/docs/test files changed, and confirm `D:\软件\YunX-Desktop（网盘聚合）` was not modified.
- [ ] **Step 5: Commit the completed feature only after tests pass**, using a focused message such as `feat: add safe local file upload flow`.
