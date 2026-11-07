/**
 * 测试专用 Electron 桩：由 scripts/resolve-ts-loader.mjs 在测试进程中解析 `electron` 导入时使用。
 * 实际值由测试脚本在 import 前写入 globalThis.__yunxElectronStub。
 */
const stub = globalThis.__yunxElectronStub;
if (!stub) throw new Error('测试未注入 globalThis.__yunxElectronStub');

export const app = stub.app;
export const safeStorage = stub.safeStorage;
export default stub;
