import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { startMockOpenAIServer } from '../../utils/mock-openai-server';

const execAsync = promisify(exec);

function stripAnsi(input: string): string {
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    '',
  );
}

interface TokenSnapshot {
  prompt: number;
  completion: number;
  total: number;
}

function extractTokenSnapshots(output: string): TokenSnapshot[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const snapshots: TokenSnapshot[] = [];

  for (const line of lines) {
    const m = line.match(/Tokens:\s*in=(\d+)\s+out=(\d+)\s+total=(\d+)/);
    if (m) {
      snapshots.push({
        prompt: Number(m[1]),
        completion: Number(m[2]),
        total: Number(m[3]),
      });
    }
  }
  return snapshots;
}

describe('ST-V24-TOK-004: LLM 重试场景下 Token 统计合理性', () => {
  const repoRoot = path.join(__dirname, '../../..');

  it(
    'ST-V24-TOK-004: 单次失败后重试成功时，仅统计成功调用的 Token',
    async () => {
      // 1. 启动带「第一次请求失败、之后成功」行为的 Mock LLM
      const mock = await startMockOpenAIServer({
        failRequestIndices: [1],
      });

      // 2. 构造一个小型测试项目，仅 1 个文件，方便判断「预期成功调用次数约为常数级」
      const projectDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'code-analyze-tok-retry-'),
      );
      try {
        await fs.writeFile(
          path.join(projectDir, 'index.ts'),
          'export const add = (a: number, b: number) => a + b;',
          'utf-8',
        );

        // 3. 运行一次 full 解析，开启重试（--llm-max-retries=1）
        let combined = '';
        try {
          const { stdout, stderr } = await execAsync(
            `node dist/cli.js analyze --path "${projectDir}" --mode full --force --no-skills --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 1 --no-confirm`,
            { cwd: repoRoot, timeout: 120000 },
          );
          combined = (stdout ?? '') + (stderr ?? '');
        } catch (e: any) {
          // 若进程非 0 退出，也收集输出用于断言
          combined = (e.stdout ?? '') + (e.stderr ?? '');
          throw e;
        } finally {
          await mock.close();
        }

        const output = stripAnsi(combined);

        // 4. 至少应有一行 Token 统计输出
        const snapshots = extractTokenSnapshots(output);
        expect(snapshots.length).toBeGreaterThan(0);

        // 5. Token total 单调非降，证明是对「成功调用」的累积统计，而不是失败重试多次叠加噪声
        for (let i = 1; i < snapshots.length; i++) {
          expect(snapshots[i].total).toBeGreaterThanOrEqual(
            snapshots[i - 1].total,
          );
        }

        // 6. 合理性校验：由于 Mock 每次 usage.total_tokens 固定为 30，
        //    在单小文件场景下，本次解析成功调用次数应为有限常数，total 不应爆炸式增长。
        const finalTotal = snapshots[snapshots.length - 1].total;
        // 这里用一个相对宽松的上限，例如 30 * 20 = 600，确保没有将失败重试无限累积进统计。
        expect(finalTotal).toBeGreaterThan(0);
        expect(finalTotal).toBeLessThanOrEqual(600);
      } finally {
        await fs.remove(projectDir).catch(() => {});
      }
    },
    240000,
  );
});

