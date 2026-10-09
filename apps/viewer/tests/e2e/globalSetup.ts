/**
 * 起一個**真的**測試後端給前端 e2e 用。
 *
 * 這是 `apps/viewer` 唯一需要 Python 環境的地方 —— 刻意隔離在
 * `tests/e2e/` 底下，因此 `npm test` 仍然是純 Node、離線、確定性的
 * （見 `tests/fixtures/README.md` 的理由）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, URL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`測試後端未在 ${timeoutMs} ms 內就緒：${String(lastError)}`);
}

let child: ChildProcess | null = null;

export async function setup(): Promise<void> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn('uv', ['run', 'rtgaia-testbe', '--port', String(port), '--host', '127.0.0.1', '--test-api'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const log: string[] = [];
  child.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`測試後端結束（code ${code}）：\n${log.join('')}`);
    }
  });

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    console.error(log.join(''));
    throw error;
  }
  process.env.RTGAIA_TESTBE_URL = baseUrl;
  process.env.RTGAIA_TESTBE_WS = `ws://127.0.0.1:${port}`;
}

export async function teardown(): Promise<void> {
  if (child === null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (child.exitCode === null) child.kill('SIGKILL');
  child = null;
}
