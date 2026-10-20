import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicClient, http } from 'viem';

export interface AnvilNode {
  url: string;
  process: ChildProcess;
  stop: () => Promise<void>;
}

/** Start a loopback Anvil node and wait until it answers. `args` are extra anvil flags. */
export async function startAnvil(port: number, args: string[] = [], timeoutMs = 120_000): Promise<AnvilNode> {
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout?.on('data', d => { if (log.length < 20_000) log += d; });
  child.stderr?.on('data', d => { if (log.length < 20_000) log += d; });
  const url = `http://127.0.0.1:${port}`;
  const rpc = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 5_000 }) });
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${log.slice(-2000)}`);
    try {
      await rpc.getChainId();
      break;
    } catch {
      if (Date.now() - started > timeoutMs) {
        child.kill('SIGTERM');
        throw new Error(`anvil did not start in time: ${log.slice(-2000)}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return {
    url,
    process: child,
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    }),
  };
}
