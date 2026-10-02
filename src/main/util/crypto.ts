/*
 * YunX Desktop (云析桌面版) —— 通用工具：哈希 / CRC32 / Base64。
 * Node crypto 提供 md5/aes；CRC32 与无填充 hex 需自行实现以对齐 Kotlin 语义。
 */

import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';

/** MD5 → 小写 hex */
export function md5Hex(input: string | Buffer): string {
  return createHash('md5').update(input).digest('hex');
}

/** MD5 → 大写 hex */
export function md5Upper(input: string | Buffer): string {
  return createHash('md5').update(input).digest('hex').toUpperCase();
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** CRC32（IEEE）→ 无符号 32 位整数 */
export function crc32(input: string | Buffer): number {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * CRC32 → hex。[重要] 对齐 Kotlin 的 Long.toHexString：
 * 小写、**不补零**（高位为 0 时长度不足 8 位）。
 */
export function crc32Hex(input: string | Buffer): string {
  return crc32(input).toString(16);
}

export function base64Encode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64');
}

export function base64Decode(input: string): string {
  return Buffer.from(input, 'base64').toString('utf8');
}

/** 宽松 Base64 解码（URL-safe 归一化），失败返回 null */
export function tryBase64Decode(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const out = Buffer.from(padded, 'base64').toString('utf8');
    return out;
  } catch {
    return null;
  }
}

/**
 * AES-128-CBC 加密，输出 Base64(IV ‖ 密文)。
 * 对齐 C139 的 AES/CBC/PKCS5Padding + Base64.NO_WRAP。
 */
export function aesCbcEncryptBase64(plaintext: string, keyUtf8: string): string {
  const key = Buffer.from(keyUtf8, 'utf8');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
}

/**
 * AES-128-CBC 解密：入参为 Base64(IV ‖ 密文)。
 * 若明文以 gzip magic (1f 8b) 开头则自动 gunzip。
 */
export function aesCbcDecryptFromBase64(payload: string, keyUtf8: string): string {
  const raw = Buffer.from(payload, 'base64');
  const key = Buffer.from(keyUtf8, 'utf8');
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  let out = Buffer.concat([decipher.update(ct), decipher.final()]);
  if (out.length >= 2 && out[0] === 0x1f && out[1] === 0x8b) {
    out = gunzipSync(out);
  }
  return out.toString('utf8');
}

import { gunzipSync } from 'node:zlib';

/** 随机字符串 */
export function randomString(len: number, charset = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  let out = '';
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) out += charset[bytes[i] % charset.length];
  return out;
}

/** 32 位随机 hex（123 的 loginuuid） */
export function randomHex32(): string {
  return randomBytes(16).toString('hex');
}

/** 格式化时间为 "yyyy-MM-dd HH:mm:ss"（本地时区） */
export function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 格式化 UTC+offset 为 "YYYYMMDDHHmm" */
export function formatUtcOffsetMinutes(d: Date, offsetSeconds: number): string {
  const shifted = new Date(d.getTime() + offsetSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}${p(shifted.getUTCMonth() + 1)}${p(shifted.getUTCDate())}` +
    `${p(shifted.getUTCHours())}${p(shifted.getUTCMinutes())}`
  );
}

/**
 * Java URLEncoder.encode 等价实现：
 * 空格 → '+'，并对 ! ' ( ) * 等 Java 不编码的字符保持原样。
 */
export function javaUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (c) => c);
}

/** Java URLEncoder.encode + 空格转回 %20（C139 mcloud-sign 用） */
export function javaUrlEncodeSpaceAsPct20(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => c);
}
