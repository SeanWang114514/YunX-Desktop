/*
 * YunX Desktop (云析桌面版) —— 轻量日志收集器。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class LogCollector {
  private file: string;
  private buffer: string[] = [];

  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.file = join(dir, `yunx-${day}.log`);
  }

  private write(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    this.buffer.push(line);
    if (this.buffer.length > 500) this.buffer.shift();
    try {
      appendFileSync(this.file, line, 'utf8');
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  info(msg: string): void {
    this.write('INFO', msg);
  }
  warn(msg: string): void {
    this.write('WARN', msg);
  }
  error(msg: string): void {
    this.write('ERROR', msg);
  }
  recent(): string[] {
    return [...this.buffer];
  }
}
