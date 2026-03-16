import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { startMockOpenAIServer } from '../utils/mock-openai-server';

const execAsync = promisify(exec);

describe('CLI路径测试 (UT-CLI-PATH-*)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = path.join(os.tmpdir(), 'code-analyze-test-cli');
  let testProjectPath: string;
  let mock: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    await fs.remove(tempHome);
    await fs.ensureDir(tempHome);
    testProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'code-analyze-test-project-'));
    mock = await startMockOpenAIServer();

    // 创建测试项目文件
    await fs.writeFile(path.join(testProjectPath, 'index.ts'), 'export const test = 123;');
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;

    await fs.remove(tempHome);
    await mock.close();
    await fs.remove(testProjectPath);
  });

  test('UT-CLI-PATH-001: CLI默认配置路径正确，生成在~/.config/code-analyze/config.yaml', async () => {
    // 先编译CLI
    await execAsync('npm run build', { cwd: path.join(__dirname, '../../') });

    // 执行CLI命令触发配置生成（config命令会加载配置）
    await execAsync('node dist/cli.js config --list', {
      cwd: path.join(__dirname, '../../'),
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome }
    });

    // 检查新路径配置文件存在
    const newConfigPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const newConfigExists = await fs.pathExists(newConfigPath);
    expect(newConfigExists).toBe(true);

    // 检查旧路径配置文件不存在
    const oldConfigPath = path.join(tempHome, '.code-analyze', 'config.yaml');
    const oldConfigExists = await fs.pathExists(oldConfigPath);
    expect(oldConfigExists).toBe(false);
  });

  test('UT-CLI-PATH-002: 默认结果路径正确，没有两级.code-analyze-result目录', async () => {
    // 先编译CLI
    await execAsync('npm run build', { cwd: path.join(__dirname, '../../') });

    // 执行分析命令
    await execAsync(`node dist/cli.js analyze --path ${testProjectPath} --mode full --force --no-confirm --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0`, {
      cwd: path.join(__dirname, '../../'),
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome }
    });

    // 检查结果目录存在
    const resultDir = path.join(testProjectPath, '.code-analyze-result');
    const resultDirExists = await fs.pathExists(resultDir);
    expect(resultDirExists).toBe(true);

    // 检查结果文件存在（V2.2 起根目录为 index.md，不再生成 PROJECT_SUMMARY.md）
    // 注：若实现使用 projectSlug 子目录，则可能存在 resultDir 下再一层目录，此处仅验证根级 index.md
    const summaryFile = path.join(resultDir, 'index.md');
    const summaryExists = await fs.pathExists(summaryFile);
    expect(summaryExists).toBe(true);

    const metadataFile = path.join(resultDir, '.analysis_metadata.json');
    const metadataExists = await fs.pathExists(metadataFile);
    expect(metadataExists).toBe(true);
  });

  test('UT-CLI-PATH-003: 自定义output_dir参数生效', async () => {
    // 先编译CLI
    await execAsync('npm run build', { cwd: path.join(__dirname, '../../') });
    const customOutputDir = path.join(testProjectPath, 'my-custom-result');

    // 执行分析命令，指定自定义输出目录
    await execAsync(`node dist/cli.js analyze --path ${testProjectPath} --mode full --force --output-dir ${customOutputDir} --no-confirm --llm-base-url ${mock.baseUrl} --llm-api-key test --llm-max-retries 0`, {
      cwd: path.join(__dirname, '../../'),
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome }
    });

    // 检查自定义目录存在
    const customDirExists = await fs.pathExists(customOutputDir);
    expect(customDirExists).toBe(true);

    // 检查默认目录不存在
    const defaultDirExists = await fs.pathExists(path.join(testProjectPath, '.code-analyze-result'));
    expect(defaultDirExists).toBe(false);

    // 检查结果文件存在于自定义目录（V2.2 起为 index.md）
    const summaryFile = path.join(customOutputDir, 'index.md');
    const summaryExists = await fs.pathExists(summaryFile);
    expect(summaryExists).toBe(true);
  });
});
