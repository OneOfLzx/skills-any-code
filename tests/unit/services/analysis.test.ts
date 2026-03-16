import fs from 'fs-extra';
import path from 'path';
import { AnalysisService } from '../../../src/domain/services/analysis.service';

jest.mock('../../../src/infrastructure/llm/openai.client', () => {
  return {
    OpenAIClient: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          name: 'mock-file',
          language: 'TypeScript',
          linesOfCode: 1,
          dependencies: [],
          summary: 'mock summary',
          classes: [],
          functions: [],
          classDiagram: '',
          sequenceDiagram: '',
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'm',
        responseTime: 1,
      }),
      batchCall: jest.fn(),
    })),
  };
});

describe('AnalysisService 解析服务测试（V2.1 LLM原生）', () => {
  let analysisService: AnalysisService;
  let gitService: any;
  let storageService: any;
  const testProjectRoot = path.join(__dirname, '../../test-projects/test-analysis');

  beforeEach(async () => {
    gitService = {} as any;
    storageService = {
      saveFileAnalysis: jest.fn().mockResolvedValue(true),
      saveDirectoryAnalysis: jest.fn().mockResolvedValue(true),
      getStoragePath: jest.fn().mockReturnValue(path.join(testProjectRoot, '.code-analyze-result'))
    };
    const blacklistService = {
      load: jest.fn().mockResolvedValue(undefined),
      isIgnored: jest.fn().mockReturnValue(false),
    } as any;

    analysisService = new AnalysisService(
      gitService,
      storageService,
      blacklistService,
      'test-project',
      'test-commit',
      {
        base_url: 'http://127.0.0.1:12345/v1',
        api_key: 'k',
        model: 'm',
        temperature: 0.1,
        max_tokens: 1000,
        timeout: 1000,
        max_retries: 0,
        retry_delay: 1,
        context_window_size: 1000,
        cache_enabled: false,
        cache_dir: path.join(testProjectRoot, '.cache'),
      }
    );

    // 清理测试目录
    await fs.remove(testProjectRoot);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(testProjectRoot);
  });



  /**
   * UT-ANA-005: 多语言文件混合解析
   */
  test('UT-ANA-005: 多语言/无后缀/非标准后缀文本文件都被处理', async () => {
    // 创建多语言测试项目
    await fs.ensureDir(testProjectRoot);
    await fs.writeFile(path.join(testProjectRoot, 'index.ts'), 'export const add = (a: number, b: number) => a + b;');
    await fs.writeFile(path.join(testProjectRoot, 'utils.js'), 'export const multiply = (a, b) => a * b;');
    await fs.writeFile(path.join(testProjectRoot, 'Dockerfile'), 'FROM node:18\nWORKDIR /app');
    await fs.writeFile(path.join(testProjectRoot, 'Makefile'), 'build:\n\tnpm run build');
    await fs.writeFile(path.join(testProjectRoot, 'code.txt'), 'def add(a,b): return a+b');

    const result = await analysisService.fullAnalysis({
      projectRoot: testProjectRoot,
      depth: -1,
      concurrency: 4,
    });

    expect(result.success).toBe(true);
    // 5 个文本文件（index.ts, utils.js, Dockerfile, Makefile, code.txt）均解析；V2.3 黑名单不含 .txt 时仍为 5
    expect(result.analyzedFilesCount).toBeGreaterThanOrEqual(4);
    expect(storageService.saveFileAnalysis).toHaveBeenCalledTimes(5);
  });
});
