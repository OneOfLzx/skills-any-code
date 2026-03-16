/**
 * V2.2 根目录与整体行为测试（测试文档第 9.8 节）
 * ST-V22-ROOT-001: 根目录与普通目录行为一致，不生成 PROJECT_SUMMARY.md
 * ST-V22-ROOT-002: 不生成 ANALYSIS_MODIFICATION_LOG.md
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { startMockOpenAIServer } from '../utils/mock-openai-server';
import { createTestProject, mkdtemp } from '../utils/create-test-project';

const execAsync = promisify(exec);

describe('V2.2 根目录与整体行为 (ST-V22-ROOT)', () => {
  let testDir: string;
  let mock: { baseUrl: string; close: () => Promise<void> };
  const repoRoot = path.join(__dirname, '../..');

  beforeAll(async () => {
    await execAsync('npm run build', { cwd: repoRoot });
  });

  beforeEach(async () => {
    testDir = mkdtemp('code-analyze-v22-root');
    mock = await startMockOpenAIServer();
    await createTestProject(testDir, {
      files: ['src/index.ts'],
      directories: ['src'],
    });
  });

  afterEach(async () => {
    if (mock) await mock.close();
    await fs.remove(testDir).catch(() => {});
  });

  it('ST-V22-ROOT-001: 全量解析后不生成 PROJECT_SUMMARY.md，根目录以 index.md 表示', async () => {
    await execAsync(
      `node dist/cli.js analyze --path "${testDir}" --mode full --force --no-skills --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot }
    );

    const resultDir = path.join(testDir, '.code-analyze-result');
    const projectSummaryPath = path.join(resultDir, 'PROJECT_SUMMARY.md');
    const rootIndexPath = path.join(resultDir, 'index.md');

    expect(await fs.pathExists(projectSummaryPath)).toBe(false);
    expect(await fs.pathExists(rootIndexPath)).toBe(true);
  }, 60000);

  it('ST-V22-ROOT-002: 不生成 ANALYSIS_MODIFICATION_LOG.md', async () => {
    await execAsync(
      `node dist/cli.js analyze --path "${testDir}" --mode full --force --no-skills --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot }
    );

    const resultDir = path.join(testDir, '.code-analyze-result');
    const modLogPath = path.join(resultDir, 'ANALYSIS_MODIFICATION_LOG.md');
    expect(await fs.pathExists(modLogPath)).toBe(false);
  }, 60000);

  it('UT-V23-INDEX-001: 全量解析后应生成 analysis-index.json', async () => {
    await execAsync(
      `node dist/cli.js analyze --path "${testDir}" --mode full --force --no-skills --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot }
    );

    const indexPath = path.join(testDir, '.code-analyze-result', 'analysis-index.json');
    expect(await fs.pathExists(indexPath)).toBe(true);
    const indexData = await fs.readJson(indexPath);
    expect(indexData).toHaveProperty('version');
    expect(indexData).toHaveProperty('projectRoot');
    expect(indexData).toHaveProperty('storageRoot');
    expect(indexData).toHaveProperty('generatedAt');
    expect(indexData).toHaveProperty('entries');
  }, 60000);
});
