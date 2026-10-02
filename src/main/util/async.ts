/*
 * YunX Desktop (云析桌面版) —— 异步工具。
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带最大次数的轮询：fn 返回非 null 即结束 */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  attempts: number,
  intervalMs: number,
): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const r = await fn();
    if (r !== null && r !== undefined) return r;
    await sleep(intervalMs);
  }
  return null;
}
