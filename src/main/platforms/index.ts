/*
 * YunX Desktop (云析桌面版) —— 平台注册表：汇总所有网盘适配器。
 */

import type { SharePlatform } from '../../shared/types';
import type { PlatformAdapter } from './types';
import { quarkAdapter } from './quark/api';
import { baiduAdapter } from './baidu/api';
import { pan123Adapter } from './pan123/api';
import { c139Adapter } from './c139/api';
import { ucAdapter } from './uc/api';
import { xunleiAdapter } from './xunlei/api';

export const ADAPTERS: Record<SharePlatform, PlatformAdapter> = {
  QUARK: quarkAdapter,
  BAIDU: baiduAdapter,
  PAN123: pan123Adapter,
  C139: c139Adapter,
  UC: ucAdapter,
  XUNLEI: xunleiAdapter,
};

export function getAdapter(platform: SharePlatform): PlatformAdapter {
  const a = ADAPTERS[platform];
  if (!a) throw new Error(`不支持的平台：${platform}`);
  return a;
}

export const ALL_ADAPTERS: PlatformAdapter[] = Object.values(ADAPTERS);
