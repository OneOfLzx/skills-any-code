import path from 'path';
import fs from 'fs-extra';
import { AnalysisAppService } from '../../src/application/analysis.app.service';
import { TestProjectFactory } from '../utils/test-project-factory';
import { startMockOpenAIServer } from '../utils/mock-openai-server';

describe('System test: V2.1 LLM原生解析（ST-FULL-* / ST-INC-* 关键场景）', () => {
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
          timeout: 1000,
          max_retries: 0,
          retry_delay: 1,
          context_window_size: 1000,
          cache_enabled: false,
          cache_dir: path.join(projectPath, '.cache'),
        },
      } as any);

      expect(res.success).toBe(true);
      // V2.3 黑名单过滤 *.txt，code-snippets.txt 不解析，共 3 个文件
      expect(res.data?.analyzedFilesCount).toBe(3);
    } finally {
      await mock.close();
      await testProject.cleanup();
    }
  }, 120000);

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
          timeout: 1000,
          max_retries: 0,
          retry_delay: 1,
          context_window_size: 1000,
          cache_enabled: false,
          cache_dir: path.join(testProject.path, '.cache'),
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
