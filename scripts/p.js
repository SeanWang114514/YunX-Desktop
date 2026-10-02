// 测试用 preload：把任意 IPC 调用暴露成 window.__invoke
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__invoke', (channel, args) => ipcRenderer.invoke(channel, ...(args || [])));
