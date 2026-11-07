import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

const PRECREATE_URL = 'https://pan.baidu.com/rest/2.0/xpan/file';
const LOCATE_UPLOAD_URL = 'https://d.pcs.baidu.com/rest/2.0/pcs/file';
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNKS = 1024;

type UploadRequest = (url: string, opts?: RequestInit) => Promise<Response>;

export interface BaiduUploadInput {
  filePath: string;
  fileName: string;
  appName: string;
  tokens: { accessToken: string; refreshToken: string; expiresAt: number };
  signal: AbortSignal;
  onProgress: (bytes: number) => void;
}

function encodeForm(values: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(values).map(([k, v]) => [k, String(v)])).toString();
}

function validatePath(appName: string, fileName: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(appName)) throw new Error('百度应用名无效');
  if (!fileName.trim() || fileName.length > 240 || /[\\/\0]/.test(fileName) || fileName === '.' || fileName === '..' || fileName.includes('..')) {
    throw new Error('文件名只能是应用目录下的单层文件名');
  }
  return `/apps/${appName}/${fileName}`;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('上传已取消');
}

interface ReadableHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

/** 读取恰好 length 字节；文件在 stat 之后被截断或短读时报错，避免零填充上传 */
export async function readExact(handle: ReadableHandle, length: number, position: number): Promise<Buffer> {
  const chunk = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(chunk, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error('读取文件时文件被截断或大小发生变化');
    offset += bytesRead;
  }
  return chunk;
}

async function parseResponse(response: Response, label: string): Promise<any> {
  const body = await response.text();
  let json: any;
  try { json = body ? JSON.parse(body) : {}; } catch { throw new Error(`${label}返回无效响应`); }
  if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）`);
  const code = json.errno ?? json.error_code;
  if (code != null && Number(code) !== 0) throw new Error(`${label}失败（errno=${code}）`);
  return json;
}

function pickHttpsHost(json: any): URL {
  const candidates = [
    ...(Array.isArray(json.servers) ? json.servers.map((x: any) => x.server) : []),
    ...(Array.isArray(json.bak_servers) ? json.bak_servers.map((x: any) => x.server) : []),
    ...(Array.isArray(json.quic_servers) ? json.quic_servers.map((x: any) => x.server) : []),
  ];
  for (const item of candidates) {
    try {
      const host = new URL(String(item));
      if (host.protocol === 'https:' && host.hostname) return host;
    } catch { /* try next returned server */ }
  }
  throw new Error('百度未返回有效的 HTTPS 上传域名');
}

function multipart(fields: Record<string, string>, filename: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----YunX${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  const safeFilename = filename.replace(/["\r\n]/g, '_');
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  chunks.push(bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export class BaiduUploadAdapter {
  private readonly request: UploadRequest;
  constructor(options: { request?: UploadRequest } = {}) { this.request = options.request ?? ((url, opts) => fetch(url, opts)); }

  async upload(input: BaiduUploadInput): Promise<{ path: string; fsId?: string; size: number }> {
    const path = validatePath(input.appName, input.fileName);
    const file = await stat(input.filePath);
    if (!file.isFile()) throw new Error('只能上传普通文件');
    if (file.size > 4 * 1024 ** 3) throw new Error('文件超过普通百度账号 4 GB 上限');
    const count = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    if (count > MAX_CHUNKS) throw new Error('文件分片数超过百度上限');

    const hashes: string[] = [];
    const handle = await open(input.filePath, 'r');
    try {
      for (let index = 0; index < count; index++) {
        checkAbort(input.signal);
        const length = Math.min(CHUNK_SIZE, Math.max(0, file.size - index * CHUNK_SIZE));
        const chunk = await readExact(handle, length, index * CHUNK_SIZE);
        hashes.push(createHash('md5').update(chunk).digest('hex'));
      }
    } finally { await handle.close(); }

    checkAbort(input.signal);
    const token = input.tokens.accessToken;
    const preUrl = `${PRECREATE_URL}?method=precreate&access_token=${encodeURIComponent(token)}`;
    const preBody = encodeForm({ path, size: file.size, isdir: 0, block_list: JSON.stringify(hashes), autoinit: 1 });
    const pre = await parseResponse(await this.request(preUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: preBody, signal: input.signal }), '百度预上传');
    const uploadId = String(pre.uploadid ?? '');
    if (!uploadId) throw new Error('百度预上传未返回 uploadid');
    const missing = Array.isArray(pre.block_list)
      ? pre.block_list.map(Number).filter((x: number) => Number.isInteger(x) && x >= 0 && x < count)
      : Array.from({ length: count }, (_, i) => i);

    checkAbort(input.signal);
    const locateQuery = encodeForm({ method: 'locateupload', appid: '250528', access_token: token, path, uploadid: uploadId, upload_version: '2.0' });
    const locate = await parseResponse(await this.request(`${LOCATE_UPLOAD_URL}?${locateQuery}`, { method: 'GET', signal: input.signal }), '百度获取上传域名');
    const host = pickHttpsHost(locate);

    const missingSet = new Set(missing);
    const alreadyUploadedBytes = Array.from({ length: count }, (_, index) => index)
      .filter((index) => !missingSet.has(index))
      .reduce((sum, index) => sum + Math.min(CHUNK_SIZE, Math.max(0, file.size - index * CHUNK_SIZE)), 0);
    if (alreadyUploadedBytes) input.onProgress(alreadyUploadedBytes);

    const uploadFile = await open(input.filePath, 'r');
    try {
      for (const index of missing) {
        checkAbort(input.signal);
        const length = Math.min(CHUNK_SIZE, Math.max(0, file.size - index * CHUNK_SIZE));
        const chunk = await readExact(uploadFile, length, index * CHUNK_SIZE);
        const payload = multipart({ method: 'upload', type: 'tmpfile', path, uploadid: uploadId, partseq: String(index), access_token: token }, input.fileName, chunk);
        const url = new URL('/rest/2.0/pcs/superfile2', host);
        url.search = `?${new URLSearchParams({ method: 'upload', type: 'tmpfile', access_token: token, path, uploadid: uploadId, partseq: String(index) })}`;
        const uploaded = await parseResponse(await this.request(url.toString(), { method: 'POST', headers: { 'Content-Type': payload.contentType, 'Content-Length': String(payload.body.length) }, body: payload.body, signal: input.signal }), '百度分片上传');
        void uploaded;
        input.onProgress(length);
      }
    } finally { await uploadFile.close(); }

    checkAbort(input.signal);
    const createUrl = `${PRECREATE_URL}?method=create&access_token=${encodeURIComponent(token)}`;
    const createBody = encodeForm({ path, size: file.size, isdir: 0, block_list: JSON.stringify(hashes), uploadid: uploadId, rtype: 0 });
    const created = await parseResponse(await this.request(createUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: createBody, signal: input.signal }), '百度创建文件');
    return { path: String(created.path ?? path), fsId: created.fs_id == null ? undefined : String(created.fs_id), size: file.size };
  }
}
