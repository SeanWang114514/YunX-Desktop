/*
 * YunX Desktop (云析桌面版) —— 预加载脚本：暴露受限的 IPC API 给渲染进程。
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: {
    list: () => ipcRenderer.invoke('platform:list'),
  },
  resolve: {
    parse: (text: string, pwd?: string) => ipcRenderer.invoke('resolve:parse', text, pwd),
    listDir: (platform: string, shareId: string, dirFid: string, text?: string) =>
      ipcRenderer.invoke('resolve:listDir', platform, shareId, dirFid, text),
    getLink: (platform: string, shareId: string, file: unknown, text?: string) =>
      ipcRenderer.invoke('resolve:getLink', platform, shareId, file, text),
  },
  download: {
    add: (
      platform: string,
      shareId: string,
      file: unknown,
      link: unknown,
      saveDir?: string,
      text?: string,
    ) => ipcRenderer.invoke('download:add', platform, shareId, file, link, saveDir, text),
    list: () => ipcRenderer.invoke('download:list'),
    pause: (id: string) => ipcRenderer.invoke('download:pause', id),
    resume: (id: string) => ipcRenderer.invoke('download:resume', id),
    remove: (id: string) => ipcRenderer.invoke('download:remove', id),
    openFolder: (id: string) => ipcRenderer.invoke('download:openFolder', id),
    openFile: (id: string) => ipcRenderer.invoke('download:openFile', id),
    onProgress: (cb: (t: unknown) => void) =>
      ipcRenderer.on('download:progress', (_e, t) => cb(t)),
    onDone: (cb: (t: unknown) => void) => ipcRenderer.on('download:done', (_e, t) => cb(t)),
    onError: (cb: (t: unknown) => void) => ipcRenderer.on('download:error', (_e, t) => cb(t)),
  },
  settings: {
    get: (key: string, fallback: unknown) => ipcRenderer.invoke('settings:get', key, fallback),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  },
  auth: {
    list: () => ipcRenderer.invoke('auth:list'),
    setCookie: (platform: string, credential: string) =>
      ipcRenderer.invoke('auth:setCookie', platform, credential),
    clear: (platform: string) => ipcRenderer.invoke('auth:clear', platform),
    verify: (platform: string, credential: string) =>
      ipcRenderer.invoke('auth:verify', platform, credential),
    openLogin: (platform: string, url: string) =>
      ipcRenderer.invoke('auth:openLogin', platform, url),
    /** 保存登录窗口里的 Cookie（由界面「保存登录信息」按钮触发） */
    saveLoginCookies: (platform: string) =>
      ipcRenderer.invoke('auth:saveLoginCookies', platform),
    closeLogin: () => ipcRenderer.invoke('auth:closeLogin'),
    reloadLogin: (url?: string) => ipcRenderer.invoke('auth:reloadLogin', url),
    /** 登录窗口内检测到登录态（仅提示，不自动保存） */
    onLoginDetected: (cb: (platform: string) => void) => {
      const h = (_e: unknown, p: string) => cb(p);
      ipcRenderer.on('auth:loginDetected', h);
      return () => ipcRenderer.removeListener('auth:loginDetected', h);
    },
    onLoginWindowClosed: (cb: (platform: string) => void) => {
      const h = (_e: unknown, p: string) => cb(p);
      ipcRenderer.on('auth:loginWindowClosed', h);
      return () => ipcRenderer.removeListener('auth:loginWindowClosed', h);
    },
    xunleiLogin: (username: string, password: string) =>
      ipcRenderer.invoke('auth:xunleiLogin', username, password),
  },
  sys: {
    readClipboard: () => ipcRenderer.invoke('sys:readClipboard'),
    info: () => ipcRenderer.invoke('sys:info'),
  },
};

contextBridge.exposeInMainWorld('yunx', api);

export type YunXApi = typeof api;
