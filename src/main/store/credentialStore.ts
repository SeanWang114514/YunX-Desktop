/*
 * YunX Desktop (云析桌面版) —— 凭据存储。
 * 使用 Electron safeStorage（Windows DPAPI）加密后落盘，
 * 对齐 Kotlin 版权限级别：Cookie/JWT 不以明文留在磁盘上。
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AuthState,
  BaiduOAuthConfig,
  BaiduOAuthTokens,
  SharePlatform,
} from '../../shared/types';

interface EncryptedEntry {
  data: string;
  encrypted: boolean;
}

interface StoreShape {
  version: number;
  /** platform -> { encrypted: base64(密文) } */
  credentials: Record<string, EncryptedEntry>;
  settings: Record<string, unknown>;
  baiduOAuth?: EncryptedEntry;
}

export class CredentialStore {
  private file: string;
  private cache: StoreShape;
  /** OAuth 记录代际：任何保存/清除都会递增，用于丢弃过期的异步刷新结果 */
  private baiduOAuthRevision = 0;
  constructor() {
    const dir = app.getPath('userData');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'yunx-store.json');
    this.cache = this.load();
  }

  private load(): StoreShape {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object') {
          return {
            version: raw.version ?? 1,
            credentials: raw.credentials ?? {},
            settings: raw.settings ?? {},
            baiduOAuth: raw.baiduOAuth && typeof raw.baiduOAuth.data === 'string' ? raw.baiduOAuth : undefined,
          };
        }
      }
    } catch {
      /* 损坏则重建 */
    }
    return { version: 1, credentials: {}, settings: {} };
  }

  private persist(): void {
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.cache, null, 2), 'utf8');
      renameSync(temporary, this.file);
    } catch (e) {
      try { unlinkSync(temporary); } catch { /* preserve original failure */ }
      console.error('[store] 写入失败', e);
      throw e;
    }
  }

  private encrypt(plain: string): { data: string; encrypted: boolean } {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return { data: safeStorage.encryptString(plain).toString('base64'), encrypted: true };
      }
    } catch {
      /* 回退明文 */
    }
    return { data: Buffer.from(plain, 'utf8').toString('base64'), encrypted: false };
  }

  private decrypt(entry: { data: string; encrypted: boolean }): string {
    try {
      if (entry.encrypted && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
      }
      return Buffer.from(entry.data, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }

  /** 保存平台凭据 */
  saveCredential(platform: SharePlatform, credential: string, nickname?: string): void {
    this.cache.credentials[platform] = this.encrypt(credential);
    if (nickname !== undefined) {
      this.cache.settings[`nickname_${platform}`] = nickname;
    }
    this.persist();
  }

  /** 读取平台凭据 */
  getCredential(platform: SharePlatform): string {
    const entry = this.cache.credentials[platform];
    if (!entry) return '';
    return this.decrypt(entry);
  }

  /** 所有已保存的登录态 */
  listAuth(): AuthState[] {
    const out: AuthState[] = [];
    for (const [platform, entry] of Object.entries(this.cache.credentials)) {
      const credential = this.decrypt(entry);
      if (!credential) continue;
      out.push({
        platform: platform as SharePlatform,
        credential,
        nickname: (this.cache.settings[`nickname_${platform}`] as string) || undefined,
        updatedAt: Date.now(),
      });
    }
    return out;
  }

  /** 清除平台登录态 */
  clearCredential(platform: SharePlatform): void {
    delete this.cache.credentials[platform];
    delete this.cache.settings[`nickname_${platform}`];
    this.persist();
  }

  private encryptOAuth(value: string): EncryptedEntry {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法安全保存百度开放平台凭据');
    }
    return { data: safeStorage.encryptString(value).toString('base64'), encrypted: true };
  }

  saveBaiduOAuth(config: BaiduOAuthConfig, tokens?: BaiduOAuthTokens): void {
    const previous = this.cache.baiduOAuth;
    try {
      this.cache.baiduOAuth = this.encryptOAuth(JSON.stringify({ config, tokens: tokens ?? null }));
      this.persist();
    } catch (error) {
      this.cache.baiduOAuth = previous;
      throw error;
    }
    this.baiduOAuthRevision++;
  }

  /** 当前 OAuth 记录代际；异步刷新完成前记录，完成时比对以免覆盖清除/重新配置 */
  getBaiduOAuthRevision(): number { return this.baiduOAuthRevision; }

  /** 仅当代际未变化时保存刷新结果；返回是否真正写入 */
  saveBaiduOAuthIfCurrent(config: BaiduOAuthConfig, tokens: BaiduOAuthTokens, expectedRevision: number): boolean {
    if (this.baiduOAuthRevision !== expectedRevision) return false;
    this.saveBaiduOAuth(config, tokens);
    return true;
  }

  getBaiduOAuth(): { config: BaiduOAuthConfig; tokens: BaiduOAuthTokens | null } | null {
    const entry = this.cache.baiduOAuth;
    if (!entry?.encrypted || !safeStorage.isEncryptionAvailable()) return null;
    try {
      const stored = JSON.parse(safeStorage.decryptString(Buffer.from(entry.data, 'base64')));
      if (!stored?.config?.appKey || !stored?.config?.appSecret || !stored?.config?.appName) return null;
      return { config: stored.config, tokens: stored.tokens ?? null };
    } catch {
      return null;
    }
  }

  clearBaiduOAuth(): void {
    delete this.cache.baiduOAuth;
    this.persist();
    this.baiduOAuthRevision++;
  }

  canUseSecureOAuth(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  getSetting<T>(key: string, fallback: T): T {
    const v = this.cache.settings[key];
    return v === undefined ? fallback : (v as T);
  }

  setSetting(key: string, value: unknown): void {
    this.cache.settings[key] = value;
    this.persist();
  }
}
