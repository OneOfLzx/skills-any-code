import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import { startMockOpenAIServer } from '../utils/mock-openai-server';
import { TestProjectFactory } from '../utils/test-project-factory';
import { createTestConfig } from '../utils/test-config-helper';
import { listAllFilesRecursively, assertOnlyAllowedResultFiles } from '../utils/result-dir-whitelist';

const execAsync = promisify(exec);

interface RunCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<RunCliResult> {
  const cmd = `node dist/cli.js ${args.join(' ')}`;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs ?? 180000,
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (e: any) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (e.message || String(e)),
    };
  }
}

describe('CLI: 结果目录文件白名单契约（end-to-end）', () => {
  const repoRoot = path.join(__dirname, '../..');
  let mock: { baseUrl: string; close: () => Promise<void> };
  let configPath: string;
  let configTempDir: string;
  let hasDistCli = false;

  beforeAll(async () => {
    const distCli = path.join(repoRoot, 'dist', 'cli.js');
    hasDistCli = await fs.pathExists(distCli);
  });

  beforeEach(async () => {
    mock = await startMockOpenAIServer();
    const { configPath: cp, tempDir: td } = await createTestConfig({
      llmBaseUrl: mock.baseUrl,
      llmApiKey: 'test',
      llmModel: 'mock',
      cacheEnabled: false,
      cacheMaxSizeMb: 0,
    });
    configPath = cp;
    configTempDir = td;
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
    }
    if (configTempDir) {
      await fs.remove(configTempDir).catch(() => {});
    }
  });

  test(
    'ST-RESULT-WHITELIST-CLI-001: CLI analyze full 结果目录只允许 .md 与集中 JSON（metadata/index），不允许 per-file/per-dir JSON',
    async () => {
      if (!hasDistCli) {
        // eslint-disable-next-line jest/no-jasmine-globals
        pending('dist/cli.js not found, skip CLI result-dir whitelist test');
      }

      const project = await TestProjectFactory.create('small', false);
      const outputDir = '.result-whitelist-cli';

      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TERM: 'dumb',
          FORCE_COLOR: '0',
        };

        const { code, stderr } = await runCli(
          [
            'analyze',
            '--path',
            project.path,
            '--mode',
            'full',
            '--force',
            '--no-skills',
            '--output-dir',
            outputDir,
            '--llm-base-url',
            mock.baseUrl,
            '--llm-api-key',
            'test',
            '--llm-max-retries',
            '0',
            '-c',
            configPath,
            '--no-confirm',
          ],
          { cwd: repoRoot, env, timeoutMs: 240000 },
        );

        expect(code).toBe(0);
        expect(stderr).toBe('');

        const resultRoot = path.join(project.path, outputDir);
        const exists = await fs.pathExists(resultRoot);
        expect(exists).toBe(true);

        const files = await listAllFilesRecursively(resultRoot);
        // 当前实现下预期存在 per-file/per-dir JSON，从而触发断言失败，
        // 将违规 JSON 文件路径暴露在错误信息中，作为后续修复的回归用例。
        assertOnlyAllowedResultFiles(files);
      } finally {
        await project.cleanup();
      }
    },
    300000,
  );
});

