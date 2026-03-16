import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { promisify } from 'util';
import { exec } from 'child_process';
import { startMockOpenAIServer } from '../utils/mock-openai-server';
import { TestProjectFactory } from '../utils/test-project-factory';

const execAsync = promisify(exec);

interface RunCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<RunCliResult> {
  const repoRoot = path.join(__dirname, '../..');
  const cmd = `node dist/cli.js ${args.join(' ')}`;
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: repoRoot,
      env: { ...process.env, ...(opts?.env || {}) },
      timeout: 120000,
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

describe('V2.5 配置初始化与 LLM 连接 (ST-CONFIG-INIT-*/ST-LLM-CONNECT-*/ST-CACHE-LIMIT-*/ST-BLACKLIST-IMG-*)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = path.join(os.tmpdir(), `ca-v25-home-${Date.now()}`);
    await fs.remove(tempHome);
    await fs.ensureDir(tempHome);
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.remove(tempHome).catch(() => {});
  });

  test('ST-CONFIG-INIT-001: 未初始化配置时 analyze 立即失败并提示先执行 init', async () => {
    const testProject = await TestProjectFactory.create('small', false);

    const result = await runCli([
      'analyze',
      `--path`, testProject.path,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置文件未初始化，请先执行 "code-analyze init"');

    const defaultConfigPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const exists = await fs.pathExists(defaultConfigPath);
    expect(exists).toBe(false);

    await testProject.cleanup();
  });

  test('ST-CONFIG-INIT-002: 先 init 再 analyze 流程完整通过', async () => {
    const testProject = await TestProjectFactory.create('small', false);
    const mock = await startMockOpenAIServer();

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    let yaml = await fs.readFile(configPath, 'utf-8');
    yaml = yaml.replace('base_url: ""', `base_url: "${mock.baseUrl}"`)
      .replace('api_key: ""', 'api_key: "test"')
      .replace('model: ""', 'model: "mock"');
    await fs.writeFile(configPath, yaml, 'utf-8');

    const result = await runCli([
      'analyze',
      '--path', testProject.path,
      '-c', configPath,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain('解析完成');

    await mock.close();
    await testProject.cleanup();
  }, 120000);

  test('ST-LLM-CONNECT-001: LLM 配置缺失导致 connect 阶段失败，不进入解析流程', async () => {
    const testProject = await TestProjectFactory.create('small', false);

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    const result = await runCli([
      'analyze',
      '--path', testProject.path,
      '-c', configPath,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('LLM 连接/配置校验失败');

    await testProject.cleanup();
  }, 120000);

  test('ST-LLM-CONNECT-002: base_url 指向不可达地址时 connect 阶段失败', async () => {
    const testProject = await TestProjectFactory.create('small', false);

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    // 将 LLM 配置改为不可达地址，但保持 api_key/model 非空
    let yaml = await fs.readFile(configPath, 'utf-8');
    yaml = yaml.replace('base_url: ""', 'base_url: "http://127.0.0.1:0"')
      .replace('api_key: ""', 'api_key: "test"')
      .replace('model: ""', 'model: "mock"');
    await fs.writeFile(configPath, yaml, 'utf-8');

    const result = await runCli([
      'analyze',
      '--path', testProject.path,
      '-c', configPath,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('LLM 连接/配置校验失败');

    await testProject.cleanup();
  }, 120000);

  test('ST-CACHE-LIMIT-001: 小上限下多次解析触发缓存清理但解析仍可成功', async () => {
    const testProject = await TestProjectFactory.create('small', false);
    const mock = await startMockOpenAIServer();

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    let yaml = await fs.readFile(configPath, 'utf-8');
    yaml = yaml.replace('base_url: ""', `base_url: "${mock.baseUrl}"`)
      .replace('api_key: ""', 'api_key: "test"')
      .replace('model: ""', 'model: "mock"')
      .replace('cache_max_size_mb: 500', 'cache_max_size_mb: 1');
    await fs.writeFile(configPath, yaml, 'utf-8');

    const cacheDir = path.join(os.homedir(), '.cache', 'code-analyze', 'llm');

    // 多次执行 analyze，驱动缓存写入与清理
    for (let i = 0; i < 3; i++) {
      const result = await runCli([
        'analyze',
        '--path', testProject.path,
        '-c', configPath,
      ]);
      expect(result.code).toBe(0);
    }

    const exists = await fs.pathExists(cacheDir);
    if (exists) {
      const files = await fs.readdir(cacheDir);
      let total = 0;
      for (const f of files) {
        const stat = await fs.stat(path.join(cacheDir, f));
        if (stat.isFile()) total += stat.size;
      }
      // 总大小不应明显超过 1MB（允许少量浮动，取 2MB 上界）
      expect(total).toBeLessThanOrEqual(2 * 1024 * 1024);
    }

    await mock.close();
    await testProject.cleanup();
  }, 240000);
});

