import { configManager } from '../../../src/common/config';
import { LLMAnalysisService } from '../../../src/application/services/llm.analysis.service';
import { CodeSplitter } from '../../../src/infrastructure/splitter/code.splitter';
import { FileHashCache } from '../../../src/infrastructure/cache/file.hash.cache';
import { ILLMClient } from '../../../src/domain/interfaces';

describe('LLM安全与统计测试（V2.1）', () => {
  test('UT-LLM-020: 敏感文件默认在忽略列表中（V2.3 使用 analyze.blacklist）', async () => {
    await configManager.load();
    const config = configManager.getConfig();
    const blacklist = config.analyze.blacklist;
    expect(blacklist.some((p: string) => p.includes('.env') || p === '*.env*')).toBe(true);
    expect(blacklist.some((p: string) => p.includes('credentials') || p === 'credentials.*')).toBe(true);
  });

  test('UT-LLM-019: LLMAnalysisService 能统计总调用次数与Token使用量', async () => {
    const usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20 };
    const meta = { usage, model: 'm', responseTime: 1 };
    const llmClient: jest.Mocked<ILLMClient> = {
      call: jest.fn()
        .mockResolvedValueOnce({ content: JSON.stringify({ name: 'a.ts', language: 'TS', linesOfCode: 1, dependencies: [], classes: [], functions: [] }), ...meta })
        .mockResolvedValueOnce({ content: JSON.stringify({ description: 'a' }), ...meta })
        .mockResolvedValueOnce({ content: JSON.stringify({ summary: 'a' }), ...meta })
        .mockResolvedValueOnce({ content: JSON.stringify({ name: 'b.ts', language: 'TS', linesOfCode: 1, dependencies: [], classes: [], functions: [] }), ...meta })
        .mockResolvedValueOnce({ content: JSON.stringify({ description: 'b' }), ...meta })
        .mockResolvedValueOnce({ content: JSON.stringify({ summary: 'b' }), ...meta }),
      batchCall: jest.fn(),
    } as any;

    const splitter = new CodeSplitter(llmClient);
    const cache = new FileHashCache('C:\\\\temp\\\\code-analyze-test-cache');
    await cache.clear();

    const svc = new LLMAnalysisService(
      llmClient,
      splitter,
      cache,
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
        cache_dir: 'C:\\\\temp\\\\code-analyze-test-cache',
      } as any
    );

    const hash = FileHashCache.calculateFileHash('export const a=1');
    await svc.analyzeFile('a.ts', 'export const a=1', hash);
    await svc.analyzeFile('b.ts', 'export const b=1', FileHashCache.calculateFileHash('export const b=1'));

    const stats = svc.getStats();
    expect(stats.totalCalls).toBe(6);
    expect(stats.totalTokensUsed).toBe(120);
  });
});
