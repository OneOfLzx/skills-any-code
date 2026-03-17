/**
 * V2.3 CLI resolve 子命令集成测试：完整流程 解析 → 索引 → resolve 查询
 * 对应测试文档 10.4.2、10.4.7 ST-V23-FLOW-001
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { startMockOpenAIServer } from '../../utils/mock-openai-server';
import { createTestProject, mkdtemp } from '../../utils/create-test-project';
import { createTestConfigInDir } from '../../utils/test-config-helper';

const execAsync = promisify(exec);

describe('CLI resolve 集成测试 (V23)', () => {
  let testDir: string;
  let tempHome: string;
  let mock: { baseUrl: string; close: () => Promise<void> };
  const repoRoot = path.join(__dirname, '../../../');

  beforeAll(async () => {
    await execAsync('npm run build', { cwd: repoRoot });
  });

  beforeEach(async () => {
    testDir = mkdtemp('code-analyze-resolve-int');
    tempHome = mkdtemp('code-analyze-resolve-config');
    mock = await startMockOpenAIServer();
    await createTestConfigInDir(tempHome, {
      llmBaseUrl: mock.baseUrl,
      llmApiKey: 'test',
      llmModel: 'mock',
    });
    await createTestProject(testDir, {
      files: ['src/index.ts', 'src/utils/helper.ts'],
      directories: ['src', 'src/utils'],
    });
  });

  afterEach(async () => {
    await mock.close();
    await fs.remove(testDir).catch(() => {});
    await fs.remove(tempHome).catch(() => {});
  });

  const configPath = () => path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
  const execEnv = () => ({ HOME: tempHome, USERPROFILE: tempHome });

  it('UT-V23-RESOLVE-001: 解析后 resolve 应返回对应 Markdown 路径', async () => {
    await execAsync(
      `node dist/cli.js analyze --path "${testDir}" --mode full --force --no-skills -c "${configPath()}" --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot, env: { ...process.env, ...execEnv() } }
    );

    const indexPath = path.join(testDir, '.code-analyze-result', 'analysis-index.json');
    expect(await fs.pathExists(indexPath)).toBe(true);

    const absPath = path.resolve(testDir, 'src/index.ts').replace(/\\/g, '/');
    const { stdout, stderr } = await execAsync(
      `node dist/cli.js resolve "${absPath}" --project "${testDir}" -c "${configPath()}"`,
      { cwd: repoRoot, env: { ...process.env, ...execEnv() } }
    );

    expect(stderr).toBe('');
    const result = stdout.trim();
    expect(result).not.toBe('N/A');
    expect(result).toMatch(/\.md$/);
    expect(await fs.pathExists(result.replace(/\//g, path.sep))).toBe(true);
  }, 60000);

  it('UT-V23-RESOLVE-003: 不存在的路径应输出 N/A', async () => {
    await execAsync(
      `node dist/cli.js analyze --path "${testDir}" --mode full --force --no-skills -c "${configPath()}" --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot, env: { ...process.env, ...execEnv() } }
    );

    const absPath = path.resolve(testDir, 'src/nonexistent.ts').replace(/\\/g, '/');
    const { stdout } = await execAsync(
      `node dist/cli.js resolve "${absPath}" --project "${testDir}" -c "${configPath()}"`,
      { cwd: repoRoot, env: { ...process.env, ...execEnv() } }
    );
    expect(stdout.trim()).toBe('N/A');
  }, 60000);

  it('UT-V23-RESOLVE-004: 索引不存在时 resolve 返回 N/A（当前实现为 exit 0 + N/A）', async () => {
    const absPath = path.resolve(testDir, 'src/index.ts').replace(/\\/g, '/');
    const { stdout } = await execAsync(
      `node dist/cli.js resolve "${absPath}" --project "${testDir}" -c "${configPath()}"`,
      { cwd: repoRoot, env: { ...process.env, ...execEnv() } }
    );
    expect(stdout.trim()).toBe('N/A');
  });
});
