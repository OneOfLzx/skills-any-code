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

  test('ST-LLM-CONNECT-003: LLM 服务返回鉴权/模型错误等异常状态导致 connect 失败', async () => {
    const testProject = await TestProjectFactory.create('small', false);
    const mock = await startMockOpenAIServer({
      // 首次请求即返回 5xx，模拟「鉴权失败/模型不存在等导致 connect 失败」的统一错误分支
      failRequestIndices: [1],
    });

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    // 配置完整的 LLM 参数，确保失败来自「服务侧错误」而非配置缺失或 base_url 不可达
    let yaml = await fs.readFile(configPath, 'utf-8');
    yaml = yaml
      .replace('base_url: ""', `base_url: "${mock.baseUrl}"`)
      .replace('api_key: ""', 'api_key: "invalid-key"')
      .replace('model: ""', 'model: "invalid-model"');
    await fs.writeFile(configPath, yaml, 'utf-8');

    const result = await runCli([
      'analyze',
      '--path', testProject.path,
      '-c', configPath,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('LLM 连接/配置校验失败');
    // 与 ST-LLM-CONNECT-002 区分：此处 base_url 可达，stderr 中应包含来自 Mock 服务的错误信息
    expect(result.stderr).toContain('mock server error');

    await mock.close();
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

  test('ST-CACHE-LIMIT-002: cache_max_size_mb=0 时禁用磁盘缓存，不产生任何缓存文件', async () => {
    const testProject = await TestProjectFactory.create('small', false);
    const mock = await startMockOpenAIServer();

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    // 将 LLM 配置指向 Mock 服务，并将 cache_max_size_mb 设为 0（禁用缓存）
    let yaml = await fs.readFile(configPath, 'utf-8');
    yaml = yaml
      .replace('base_url: ""', `base_url: "${mock.baseUrl}"`)
      .replace('api_key: ""', 'api_key: "test"')
      .replace('model: ""', 'model: "mock"')
      .replace('cache_max_size_mb: 500', 'cache_max_size_mb: 0');
    await fs.writeFile(configPath, yaml, 'utf-8');

    const cacheDir = path.join(os.homedir(), '.cache', 'code-analyze', 'llm');

    // 确保起始状态下缓存目录不存在
    const existsBefore = await fs.pathExists(cacheDir);
    if (existsBefore) {
      await fs.remove(cacheDir);
    }

    // 多次执行 analyze，验证不会产生任何缓存文件
    for (let i = 0; i < 2; i++) {
      const result = await runCli([
        'analyze',
        '--path', testProject.path,
        '-c', configPath,
      ]);
      expect(result.code).toBe(0);
    }

    const existsAfter = await fs.pathExists(cacheDir);
    if (existsAfter) {
      const files = await fs.readdir(cacheDir);
      expect(files.length).toBe(0);
    }

    await mock.close();
    await testProject.cleanup();
  }, 240000);

  test('ST-BLACKLIST-IMG-001: 默认黑名单过滤图片资源，不生成 Markdown 与索引条目', async () => {
    const testProject = await TestProjectFactory.create('empty', false);
    const projectPath = testProject.path;
    const mock = await startMockOpenAIServer();

    // 在项目中创建多种图片资源以及一个代码文件，代码文件用于验证整体解析仍然成功
    await fs.ensureDir(path.join(projectPath, 'assets'));
    const imageFiles = [
      'logo.png',
      'banner.jpg',
      'icon.jpeg',
      'demo.gif',
      'bg.bmp',
      'diagram.svg',
      'thumb.webp',
      'favicon.ico',
    ];
    for (const name of imageFiles) {
      await fs.writeFile(path.join(projectPath, 'assets', name), 'binary-image-content');
    }
    await fs.ensureDir(path.join(projectPath, 'src'));
    await fs.writeFile(
      path.join(projectPath, 'src', 'index.ts'),
      'export const hello = () => "world";',
    );

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    let yaml = await fs.readFile(configPath, 'utf-8');
    yaml = yaml
      .replace('base_url: ""', `base_url: "${mock.baseUrl}"`)
      .replace('api_key: ""', 'api_key: "test"')
      .replace('model: ""', 'model: "mock"');
    await fs.writeFile(configPath, yaml, 'utf-8');

    const result = await runCli([
      'analyze',
      '--path', projectPath,
      '-c', configPath,
    ]);

    expect(result.code).toBe(0);

    const resultDir = path.join(projectPath, '.code-analyze-result');
    const indexPath = path.join(resultDir, 'analysis-index.json');
    const indexExists = await fs.pathExists(indexPath);
    expect(indexExists).toBe(true);

    const indexData = await fs.readJson(indexPath);
    const entries = indexData.entries ?? {};
    const keys: string[] = Object.keys(entries);

    // 默认黑名单应使所有图片文件不进入索引
    for (const name of imageFiles) {
      const srcPath = path.join(projectPath, 'assets', name).replace(/\\/g, '/');
      expect(keys.some((k) => k.endsWith(`/assets/${name}`) || k === srcPath)).toBe(false);

      const mdPath = path.join(resultDir, 'assets', `${path.parse(name).name}.md`);
      expect(await fs.pathExists(mdPath)).toBe(false);
    }

    await mock.close();
    await testProject.cleanup();
  }, 240000);

  test('ST-BLACKLIST-IMG-002: 通过 .code-analyze-ignore 解封部分图片后可进入索引/生成 Markdown', async () => {
    const testProject = await TestProjectFactory.create('empty', false);
    const projectPath = testProject.path;
    const mock = await startMockOpenAIServer();

    await fs.ensureDir(path.join(projectPath, 'assets'));
    const unblocked = 'logo.png';
    const blocked = 'banner.jpg';

    await fs.writeFile(path.join(projectPath, 'assets', unblocked), 'binary-image-content');
    await fs.writeFile(path.join(projectPath, 'assets', blocked), 'binary-image-content');

    // 通过 .code-analyze-ignore 的否定规则解封指定图片
    await fs.writeFile(
      path.join(projectPath, '.code-analyze-ignore'),
      `!assets/${unblocked}\n`,
      'utf-8',
    );

    await fs.ensureDir(path.join(projectPath, 'src'));
    await fs.writeFile(
      path.join(projectPath, 'src', 'index.ts'),
      'export const hello = () => "world";',
    );

    const configPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const initResult = await runCli(['init', `-c`, configPath]);
    expect(initResult.code).toBe(0);

    let yaml = await fs.readFile(configPath, 'utf-8');
    yaml = yaml
      .replace('base_url: ""', `base_url: "${mock.baseUrl}"`)
      .replace('api_key: ""', 'api_key: "test"')
      .replace('model: ""', 'model: "mock"');
    await fs.writeFile(configPath, yaml, 'utf-8');

    const result = await runCli([
      'analyze',
      '--path', projectPath,
      '-c', configPath,
    ]);

    expect(result.code).toBe(0);

    const resultDir = path.join(projectPath, '.code-analyze-result');
    const indexPath = path.join(resultDir, 'analysis-index.json');
    const indexExists = await fs.pathExists(indexPath);
    expect(indexExists).toBe(true);

    const indexData = await fs.readJson(indexPath);
    const entries = indexData.entries ?? {};
    const keys: string[] = Object.keys(entries);

    const unblockedSrc = path.join(projectPath, 'assets', unblocked).replace(/\\/g, '/');
    const blockedSrc = path.join(projectPath, 'assets', blocked).replace(/\\/g, '/');

    // 被解封的图片应当进入索引并生成 Markdown
    expect(
      keys.some((k) => k.endsWith(`/assets/${unblocked}`) || k === unblockedSrc),
    ).toBe(true);
    const unblockedMd = path.join(resultDir, 'assets', `${path.parse(unblocked).name}.md`);
    expect(await fs.pathExists(unblockedMd)).toBe(true);

    // 未解封的图片仍应被黑名单过滤
    expect(
      keys.some((k) => k.endsWith(`/assets/${blocked}`) || k === blockedSrc),
    ).toBe(false);
    const blockedMd = path.join(resultDir, 'assets', `${path.parse(blocked).name}.md`);
    expect(await fs.pathExists(blockedMd)).toBe(false);

    await mock.close();
    await testProject.cleanup();
  }, 240000);
});

