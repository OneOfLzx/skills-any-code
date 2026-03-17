import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { AnalysisAppService } from '../../src/application/analysis.app.service';
import { TestProjectFactory } from '../utils/test-project-factory';
import { startMockOpenAIServer } from '../utils/mock-openai-server';
import { createTestConfigInDir } from '../utils/test-config-helper';

describe('System test: V2.1 LLM原生解析（ST-FULL-* / ST-INC-* 关键场景）', () => {
  let tempHome: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeAll(async () => {
    tempHome = path.join(os.tmpdir(), `ca-full-analysis-${Date.now()}`);
    await fs.ensureDir(tempHome);
    const mock = await startMockOpenAIServer();
    await createTestConfigInDir(tempHome, {
      llmBaseUrl: mock.baseUrl,
      llmApiKey: 'test',
      llmModel: 'mock',
      cacheEnabled: false,
      cacheMaxSizeMb: 0,
    });
    await mock.close();
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.remove(tempHome).catch(() => {});
  });

  test('ST-FULL-007/008/009/010: 多语言/无后缀/非标准后缀/罕见语言均可解析', async () => {
    const mock = await startMockOpenAIServer();
    const testProject = await TestProjectFactory.create('empty', false);
    const projectPath = testProject.path;
    try {
      await fs.writeFile(path.join(projectPath, 'index.ts'), 'export const add = (a: number, b: number) => a + b;');
      await fs.writeFile(path.join(projectPath, 'Dockerfile'), 'FROM node:18-alpine\nWORKDIR /app');
      await fs.writeFile(path.join(projectPath, 'code-snippets.txt'), 'def add(a,b): return a+b');
      await fs.writeFile(path.join(projectPath, 'Hello.swift'), 'func hello() -> String { return "Hello" }');

      const app = new AnalysisAppService();
      const res = await app.runAnalysis({
        path: projectPath,
        mode: 'full',
        force: true,
        llmConfig: {
          base_url: mock.baseUrl,
          api_key: 'test',
          model: 'mock',
          temperature: 0.1,
          max_tokens: 1000,
          max_total_tokens: 200_000,
          timeout: 1000,
          max_retries: 0,
          retry_delay: 1,
          context_window_size: 1000,
          cache_enabled: false,
          cache_dir: path.join(projectPath, '.cache'),
          cache_max_size_mb: 0,
        },
      } as any);

      expect(res.success).toBe(true);
      // V2.3 黑名单过滤 *.txt，code-snippets.txt 不解析；index.ts/Dockerfile/Hello.swift 必解析，至少 3 个
      expect(res.data?.analyzedFilesCount).toBeGreaterThanOrEqual(3);
    } finally {
      await mock.close();
      await testProject.cleanup();
    }
  }, 120000);

  test('ST-V23-BL-OUTDIR-001: 输出目录 .code-analyze-result 不参与解析', async () => {
    const mock = await startMockOpenAIServer();
    const testProject = await TestProjectFactory.create('small', false);
    const projectPath = testProject.path;

    try {
      const app = new AnalysisAppService();

      const first = await app.runAnalysis({
        path: projectPath,
        mode: 'full',
        force: true,
        llmConfig: {
          base_url: mock.baseUrl,
          api_key: 'test',
          model: 'mock',
          temperature: 0.1,
          max_tokens: 1000,
          max_total_tokens: 200_000,
          timeout: 1000,
          max_retries: 0,
          retry_delay: 1,
          context_window_size: 1000,
          cache_enabled: false,
          cache_dir: path.join(projectPath, '.cache'),
          cache_max_size_mb: 0,
        },
      } as any);

      expect(first.success).toBe(true);

      const second = await app.runAnalysis({
        path: projectPath,
        mode: 'full',
        force: true,
        llmConfig: {
          base_url: mock.baseUrl,
          api_key: 'test',
          model: 'mock',
          temperature: 0.1,
          max_tokens: 1000,
          timeout: 1000,
          max_retries: 0,
          retry_delay: 1,
          context_window_size: 1000,
          cache_enabled: false,
          cache_dir: path.join(projectPath, '.cache'),
          cache_max_size_mb: 0,
        },
      } as any);

      expect(second.success).toBe(true);
      expect(second.data?.analyzedFilesCount).toBe(first.data?.analyzedFilesCount);

      const indexPath = path.join(projectPath, '.code-analyze-result', 'analysis-index.json');
      const indexData = await fs.readJson(indexPath);

      const entries = indexData.entries ?? {};
      const keys = Object.keys(entries);

      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) {
        expect(k.includes('/.code-analyze-result/')).toBe(false);
        expect(k.endsWith('/.code-analyze-result')).toBe(false);
      }
    } finally {
      await mock.close();
      await testProject.cleanup();
    }
  }, 180000);

  test('ST-INC-004: Git项目存在未提交变更且未force时给出提示', async () => {
    const mock = await startMockOpenAIServer();
    const testProject = await TestProjectFactory.create('small', true);
    try {
      const app = new AnalysisAppService();
      // 修改文件但不提交
      await fs.writeFile(path.join(testProject.path, 'src', 'index.ts'), '// modified');

      const res = await app.runAnalysis({
        path: testProject.path,
        mode: 'auto',
        force: false,
        llmConfig: {
          base_url: mock.baseUrl,
          api_key: 'test',
          model: 'mock',
          temperature: 0.1,
          max_tokens: 1000,
          max_total_tokens: 200_000,
          timeout: 1000,
          max_retries: 0,
          retry_delay: 1,
          context_window_size: 1000,
          cache_enabled: false,
          cache_dir: path.join(testProject.path, '.cache'),
          cache_max_size_mb: 0,
        },
      } as any);

      expect(res.success).toBe(false);
      expect(res.message).toContain('未提交的变更');
    } finally {
      await mock.close();
      await testProject.cleanup();
    }
  }, 120000);
});
