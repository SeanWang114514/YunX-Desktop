# Multi-platform local-file upload design

## Intent and why

Add local-file upload to YunX Desktop, an Electron desktop application that currently resolves shared links and downloads files. Users should be able to choose a local file with an upload action and drop files onto the application. The feature should be honest about platform support: a platform is upload-capable only when the app has both a documented upload protocol and a compatible authorization flow.

## Goals

- Add a clear upload entry point and drag-and-drop file selection to the existing UI.
- Upload supported files from the local machine without transferring entire file contents through renderer IPC or holding large files in memory.
- Show destination platform, upload progress, completion, and actionable errors.
- Reuse existing credential storage and platform conventions only where compatible.
- Keep unsupported platforms visible as unavailable rather than guessing private endpoints or treating cloud copy/share transfer as local upload.
- Preserve existing download flows and the user's packaged Release directory.

## Non-goals

- Reverse engineer private endpoints, bypass anti-bot/access controls, or imitate undocumented upload protocols.
- Claim upload support for a platform solely because its existing adapter can create directories, list files, transfer a share, or download.
- Replace the existing top-tab layout with a new application-wide navigation system unless needed for the upload control.
- Silently upload to a cloud-drive root or choose a platform without the user's explicit choice.

## Current project constraints

- Renderer is native DOM JavaScript; main and preload are TypeScript in Electron.
- Current UI has a top titlebar and horizontal tabs, not a left navigation rail.
- Existing platform credentials are web-session Cookies for most providers; Baidu's public upload endpoints require an OAuth access token and application authorization, which the current Baidu Cookie login does not provide.
- Baidu official Open Platform docs describe OAuth authorization and upload flow. Upload is limited to `/apps/{appname}`. Standard/VIP/Super VIP single-file size limits are 4/10/20 GB, maximum 1024 chunks; standard chunk size is 4 MB, VIP 16 MB, Super VIP 32 MB. Flow: OAuth access token, precreate, locate upload host, multipart chunks, create.
- The current Baidu login flow captures only web cookies. OAuth requires application AppKey/secret and a registered callback; OAuth callback/token refresh must be added separately and secrets should not be exposed to renderer.
- For Quark, 123pan, 139 Cloud, UC and Xunlei, this investigation found no verifiable public official upload endpoint documentation. Existing code does contain some cloud folder/list methods, but those do not establish upload support.
- `HttpOptions.body` is currently string-only; a large-file flow should use local file paths/streams in main process rather than widening ordinary API IPC to binary payloads.
- Repository is cloned at `D:\VibeCoding\YunX-Desktop-source`; do not modify `D:\软件\YunX-Desktop（网盘聚合）`.
- Dependency installation was previously denied and must not be retried without fresh authorization.

## Product behavior

- The existing UI remains the base layout. Add a recognizable upload icon/button at the far left of the top navigation area (rather than inventing a complete side rail), matching the existing dark theme, button radius, accent, and spacing.
- Clicking the control opens Electron's native file picker; dropping one or more files anywhere in the app enters the same upload-selection flow.
- Before upload, show a compact confirmation panel with selected file names/sizes and a platform selector. Do not begin a network transfer merely because a file was dropped.
- Platform choices show capability and authorization status. For this first implementation, Baidu may be selectable only after a valid Open Platform OAuth credential exists. Other providers show “not supported yet — no verified public upload protocol.”
- For supported uploads, destination is the authorized app's `/apps/{appname}` root. In the first version, users may change the file name but cannot enter nested directories. Validate the namespace and filename in the main process.
- On remote name collision, fail safely and show the platform error; never overwrite or silently rename. Baidu precreate uses the documented conflict-fail `rtype=0` behavior.
- Upload tasks appear in a dedicated upload view (or a clearly separated section of the existing download view) with percent, bytes transferred, status and error details. Upload and download task identities/events must not collide.

## Security and architecture

- Renderer sends only a user-selected file path obtained from native file dialog, or a path from an Electron drop event; main process validates it is a regular readable file and owns all file reads/network requests.
- Never accept arbitrary renderer-supplied destination URLs or upload hosts. Platform logic builds URLs from documented constants and server responses constrained to HTTPS hosts returned by the official locate-upload API.
- Keep Baidu AppKey/secret and access/refresh tokens in `CredentialStore`/main process only. Use an OAuth state value and one-time authorization code; validate state before exchanging code, and rotate refresh tokens atomically. If Electron `safeStorage.isEncryptionAvailable()` is false, do not save or use the Baidu OAuth secret/tokens and report upload as unavailable; leave current non-OAuth credential behavior unchanged.
- Use streaming or bounded chunk reads and compute MD5 per protocol chunk; never serialize file bytes through IPC.
- Cancellation should abort outstanding work and leave any partial remote upload state documented as such; do not claim remote rollback unless the official API provides it.
- Separate generic task orchestration from provider-specific methods; initially register only a Baidu adapter behind an explicit OAuth capability check.

## Baidu protocol implementation scope

- OAuth app settings/configuration and callback handling consistent with Baidu's documented authorization-code flow. Do not ship embedded personal AppKey/secret. Use the official `redirect_uri=oob` flow in the Electron login window and capture the one-time code from the success page, or use a registered callback only if the user provides one.
- Save access/refresh tokens separately from the current Baidu Cookie credential so existing resolve/download behavior remains unchanged.
- Implement precreate, locateupload, multipart chunk upload, and create using documented endpoints and fields.
- Enforce namespace `/apps/{appname}` and root-only filename paths; use documented conflict-fail behavior (`rtype=0`) so an existing remote file is never overwritten or silently renamed. Enforce account/app authorization constraints; use documented file-size/chunk limits when membership capability is known, otherwise default conservatively to standard-user limits.
- Report progress from each successfully uploaded chunk. Handle `block_list`/already-uploaded chunk responses as returned by precreate.
- Do not add a local folder-upload feature in this first version; single-file uploads only. (Builder may make bounded, safe choices on whether multi-selection schedules independent single-file tasks.)

## Acceptance criteria

1. Upload control is visible and accessible by keyboard; clicking it opens a native file picker.
2. Dragging files over the window is visibly acknowledged and dropping them opens the same confirmation flow.
3. No upload starts before the user confirms platform and destination.
4. A dropped unsupported file or unsupported platform produces a clear message and no network request.
5. Main process rejects unreadable/non-file paths and any destination outside the allowed Baidu app namespace.
6. Large file bytes never pass through renderer IPC as a serialized buffer; the transfer uses bounded chunks and reports progress.
7. For valid Baidu OAuth credentials and a mock protocol server, unit/integration tests cover precreate, upload-host selection, chunk request ordering, create, cancellation, and API errors.
8. Existing UI smoke tests, adapter checks and download task tests remain passing.
9. Release files at the separate user path remain unchanged.

## Decisions left to the builder

- Exact placement/presentation of the confirmation surface and whether upload tasks get their own tab or share the task page, while retaining existing visual language.
- Whether first release handles multiple files as parallel tasks or serial tasks; default to serial scheduling to limit network/memory pressure unless tests or existing patterns favor otherwise.
- OAuth callback strategy suitable for the packaged Electron app and registered Baidu app constraints; select an official-compatible loopback/custom callback approach, with local-state validation.
- Whether to allow a user-provided Baidu AppKey/secret via settings UI or environment/configuration, keeping secrets out of logs and renderer. Do not invent built-in credentials.
- Exact capability labels and explanatory copy in Simplified Chinese.

## Official evidence reviewed

- Baidu Open Platform upload docs: capability, precreate, locate upload host, multipart upload and create-file pages, under `https://pan.baidu.com/union/doc/`.
- Baidu OAuth docs: application creation, authorization-code mode, callback URL and token exchange pages, under `https://pan.baidu.com/union/doc/`.
- Official 123pan developer entry point did not expose upload endpoints during this review. Product pages for Quark/139 also did not provide endpoint docs. No undocumented endpoints are assumed.
