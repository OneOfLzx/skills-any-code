import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { startMockOpenAIServer } from '../../utils/mock-openai-server';

describe('CLI 多语言解析测试 (UT-CLI-*)', () => {
  let testDir: string;
  let mock: { baseUrl: string; close: () => Promise<void> };
  const repoRoot = path.join(__dirname, '../../../');

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-analyze-test-'));
    mock = await startMockOpenAIServer();
    // 确保 dist/cli.js 存在
    await execAsync('npm run build', { cwd: repoRoot });
  });

  afterEach(async () => {
    await mock.close();
    await fs.remove(testDir);
  });

  /**
   * UT-CLI-011: 多语言项目CLI解析测试（第12章修订：增加每个源文件对应 .md 存在断言）
   */
  test('UT-CLI-011: 多语言项目CLI解析成功，文件计数正确，每个源文件均有对应 .md', async () => {
    // 创建多语言测试项目
    await fs.writeFile(path.join(testDir, 'index.ts'), 'export const add = (a: number, b: number) => a + b;');
    await fs.writeFile(path.join(testDir, 'utils.js'), 'export const multiply = (a, b) => a * b;');
    await fs.writeFile(path.join(testDir, 'hello.py'), 'def hello():\n    print("Hello Python")');
    await fs.writeFile(path.join(testDir, 'Hello.java'), 'public class Hello { public static void main(String[] args) { System.out.println("Hello Java"); } }');
    await fs.writeFile(path.join(testDir, 'main.go'), 'package main\nimport "fmt"\nfunc main() { fmt.Println("Hello Go") }');

    const { stdout, stderr } = await execAsync(
      `node dist/cli.js analyze --path "${testDir}" --mode full --force --log-level info --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot }
    );
    expect(stderr).toBe('');
    expect(stdout).toMatch(/解析完成！共分析 \d+ 个文件/);
    const match = stdout.match(/共分析 (\d+) 个文件/);
    expect(match && parseInt(match[1], 10)).toBeGreaterThanOrEqual(5);

    // 验证结果目录与根 index.md 存在（V2.2 起根目录为 index.md，不再生成 PROJECT_SUMMARY.md）
    const resultDir = path.join(testDir, '.code-analyze-result');
    expect(await fs.pathExists(resultDir)).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'index.md'))).toBe(true);

    // 第12章 12.3.2 UT-CLI-011 修订：每个源文件均有对应 .md（文件名剥离扩展名）
    expect(await fs.pathExists(path.join(resultDir, 'index.md'))).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'utils.md'))).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'hello.md'))).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'Hello.md'))).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'main.md'))).toBe(true);
    // 可选：根 index.md 内容包含功能描述或目录结构（根目录汇总与 index.ts 可能共用 index.md）
    const indexMdContent = await fs.readFile(path.join(resultDir, 'index.md'), 'utf-8');
    expect(indexMdContent).toMatch(/功能描述|目录|summary/i);
  });

  /**
   * ST-V23-INDEX-INTEGRITY-001（第12章 12.3.3）：全量解析后索引条目数与 resultPath 对应文件存在性
   */
  test('ST-V23-INDEX-INTEGRITY-001: 索引 entries 中 file/directory 数量与 resultPath 对应 .md 均存在', async () => {
    await fs.ensureDir(path.join(testDir, 'src'));
    await fs.writeFile(path.join(testDir, 'src/a.ts'), 'export const a = 1;', 'utf-8');
    await fs.writeFile(path.join(testDir, 'src/b.ts'), 'export const b = 2;', 'utf-8');

    await execAsync(
      `node dist/cli.js analyze --path "${testDir}" --mode full --force --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot }
    );

    const resultRoot = path.join(testDir, '.code-analyze-result');
    const indexPath = path.join(resultRoot, 'analysis-index.json');
    expect(await fs.pathExists(indexPath)).toBe(true);

    const indexData = await fs.readJson(indexPath);
    expect(indexData).toHaveProperty('entries');
    const entries = indexData.entries as Record<string, { resultPath: string; type: string }>;
    const entryList = Object.entries(entries);

    const fileCount = entryList.filter(([, e]) => e.type === 'file').length;
    const dirCount = entryList.filter(([, e]) => e.type === 'directory').length;
    expect(fileCount).toBeGreaterThanOrEqual(2);
    expect(dirCount).toBeGreaterThanOrEqual(1);

    for (const [, entry] of entryList) {
      const resultPath = path.isAbsolute(entry.resultPath) ? entry.resultPath : path.join(resultRoot, entry.resultPath);
      expect(await fs.pathExists(resultPath)).toBe(true);
    }
  }, 60000);

  /**
   * UT-CLI-012: 无后缀文件CLI解析测试
   */
  test('UT-CLI-012: 无后缀文件CLI解析成功，不被跳过', async () => {
    // 创建无后缀文件测试项目
    await fs.writeFile(path.join(testDir, 'Dockerfile'), 'FROM node:18-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD ["npm", "start"]');
    await fs.writeFile(path.join(testDir, 'Makefile'), 'build:\n\tnpm run build\ntest:\n\tnpm test');
    await fs.writeFile(path.join(testDir, 'run'), '#!/bin/bash\necho "Running script"\nnpm start');

    const { stdout, stderr } = await execAsync(
      `node dist/cli.js analyze --path ${testDir} --mode full --force --log-level info --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0 --no-confirm`,
      { cwd: repoRoot }
    );
    expect(stderr).toBe('');
    expect(stdout).toMatch(/解析完成！共分析 \d+ 个文件/);
    const match = stdout.match(/共分析 (\d+) 个文件/);
    expect(match && parseInt(match[1], 10)).toBeGreaterThanOrEqual(3);

    // 验证结果文件存在
    const resultDir = path.join(testDir, '.code-analyze-result');
    expect(await fs.pathExists(resultDir)).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'Dockerfile.md'))).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'Makefile.md'))).toBe(true);
    expect(await fs.pathExists(path.join(resultDir, 'run.md'))).toBe(true);
    // V2.3 应生成索引文件
    expect(await fs.pathExists(path.join(resultDir, 'analysis-index.json'))).toBe(true);
  });
});
