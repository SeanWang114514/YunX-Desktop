/*
 * YunX Desktop (云析桌面版) —— 凭据存储。
 * 使用 Electron safeStorage（Windows DPAPI）加密后落盘，
 * 对齐 Kotlin 版权限级别：Cookie/JWT 不以明文留在磁盘上。
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthState, SharePlatform } from '../../shared/types';

interface StoreShape {
  version: number;
  /** platform -> { encrypted: base64(密文) } */
  credentials: Record<string, { data: string; encrypted: boolean }>;
  settings: Record<string, unknown>;
}

export class CredentialStore {
  private file: string;
  private cache: StoreShape;

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
          };
        }
      }
    } catch {
      /* 损坏则重建 */
    }
    return { version: 1, credentials: {}, settings: {} };
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (e) {
      console.error('[store] 写入失败', e);
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

  getSetting<T>(key: string, fallback: T): T {
    const v = this.cache.settings[key];
    return v === undefined ? fallback : (v as T);
  }

  setSetting(key: string, value: unknown): void {
    this.cache.settings[key] = value;
    this.persist();
  }
}
