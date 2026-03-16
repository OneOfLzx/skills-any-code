import { ILLMClient, IFileSplitter, IAnalysisCache } from '../../domain/interfaces';
import { FileAnalysis, LLMConfig } from '../../common/types';
import {
  FILE_STRUCTURE_PROMPT,
  FILE_DESCRIPTION_PROMPT,
  FILE_SUMMARY_PROMPT,
  PARSE_RETRY_HINT,
  CHUNK_ANALYSIS_PROMPT
} from '../../infrastructure/llm/prompt.template';
import Mustache from 'mustache';
import { AppError, ErrorCode } from '../../common/errors';
import { FileHashCache } from '../../infrastructure/cache/file.hash.cache';
import path from 'path';

/** 从 LLM 返回中解析单字段：支持 {"key": "value"} 或纯字符串 */
function parseSingleField(content: string, field: 'description' | 'summary'): string {
  const trimmed = content.trim();
  try {
    const o = JSON.parse(trimmed);
    if (o && typeof o[field] === 'string') return o[field];
  } catch {
    // 非 JSON 则整体视为该字段内容
  }
  return trimmed || '';
}

export class LLMAnalysisService {
  private llmClient: ILLMClient;
  private fileSplitter: IFileSplitter;
  private cache: IAnalysisCache;
  private config: LLMConfig;
  public totalTokensUsed = 0;
  public totalCalls = 0;

  constructor(
    llmClient: ILLMClient,
    fileSplitter: IFileSplitter,
    cache: IAnalysisCache,
    config: LLMConfig
  ) {
    this.llmClient = llmClient;
    this.fileSplitter = fileSplitter;
    this.cache = cache;
    this.config = config;
  }

  async analyzeFile(filePath: string, fileContent: string, fileHash: string): Promise<FileAnalysis> {
    // 先查缓存
    if (this.config.cache_enabled) {
      const cachedResult = await this.cache.get(fileHash);
      if (cachedResult) {
        cachedResult.path = filePath;
        cachedResult.lastAnalyzedAt = new Date().toISOString();
        return cachedResult;
      }
    }

    let result: FileAnalysis;

    // 检查文件大小是否超过上下文窗口
    if (fileContent.length > this.config.context_window_size * 0.8) {
      // 大文件分片解析
      result = await this.analyzeLargeFile(filePath, fileContent);
    } else {
      // 小文件直接解析
      result = await this.analyzeSmallFile(filePath, fileContent);
    }

    // 保存缓存
    if (this.config.cache_enabled) {
      await this.cache.set(fileHash, result);
    }

    result.path = filePath;
    result.lastAnalyzedAt = new Date().toISOString();
    return result;
  }

  /** 三步协议（需求 10.5.3 / 10.9.1）：结构 → 功能描述 → 概述，程序组装为完整 FileAnalysis；某次解析失败仅重试当次（10.9.2）。 */
  private async analyzeSmallFile(filePath: string, fileContent: string): Promise<FileAnalysis> {
    const opts = { temperature: 0.1 };

    // 第一步：仅提取结构
    const structure = await this.callWithParseRetry(
      Mustache.render(FILE_STRUCTURE_PROMPT, { filePath, fileContent }),
      opts,
      (content) => {
        const o = JSON.parse(content);
        return {
          name: o.name ?? path.basename(filePath),
          language: o.language ?? '',
          linesOfCode: typeof o.linesOfCode === 'number' ? o.linesOfCode : 0,
          dependencies: Array.isArray(o.dependencies) ? o.dependencies : [],
          classes: Array.isArray(o.classes) ? o.classes : [],
          functions: Array.isArray(o.functions) ? o.functions : []
        };
      }
    );

    const structureJson = JSON.stringify(structure, null, 2);

    // 第二步：仅生成功能描述
    const description = await this.callWithParseRetry(
      Mustache.render(FILE_DESCRIPTION_PROMPT, { structureJson }),
      opts,
      (content) => parseSingleField(content, 'description')
    );

    // 第三步：仅生成概述
    const summary = await this.callWithParseRetry(
      Mustache.render(FILE_SUMMARY_PROMPT, { structureJson, description }),
      opts,
      (content) => parseSingleField(content, 'summary')
    );

    return {
      type: 'file',
      path: filePath,
      name: structure.name,
      language: structure.language,
      linesOfCode: structure.linesOfCode,
      dependencies: structure.dependencies,
      description,
      summary,
      classes: structure.classes,
      functions: structure.functions,
      classDiagram: '',
      sequenceDiagram: '',
      lastAnalyzedAt: new Date().toISOString(),
      commitHash: ''
    };
  }

  /** 单次调用：解析失败则仅重试该次一次，不重做已成功步骤（需求 10.9.2）。 */
  private async callWithParseRetry<T>(
    prompt: string,
    options: { temperature?: number },
    parseFn: (content: string) => T
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.llmClient.call(
          attempt === 1 ? prompt + PARSE_RETRY_HINT : prompt,
          { ...options, retries: 0 }
        );
        this.updateStats(response.usage.totalTokens);
        return parseFn(response.content);
      } catch (e) {
        lastError = e;
      }
    }
    throw new AppError(
      ErrorCode.LLM_RESPONSE_PARSE_FAILED,
      `Failed to parse LLM response after retry: ${(lastError as Error)?.message}`,
      lastError
    );
  }

  private async analyzeLargeFile(filePath: string, fileContent: string): Promise<FileAnalysis> {
    // 分片
    const chunks = await this.fileSplitter.split(fileContent, this.config.context_window_size * 0.7);
    
    // 并行解析所有分片
    const chunkAnalysisPromises = chunks.map(async (chunk) => {
      const prompt = Mustache.render(CHUNK_ANALYSIS_PROMPT, {
        filePath,
        chunkId: chunk.id,
        chunkContent: chunk.content,
        context: chunk.context || ''
      });

      const response = await this.llmClient.call(prompt, { temperature: 0.1 });
      this.updateStats(response.usage.totalTokens);

      return {
        ...JSON.parse(response.content),
        chunkId: chunk.id
      };
    });

    const chunkResults = await Promise.all(chunkAnalysisPromises);
    
    // 合并分片结果
    return this.fileSplitter.merge(chunkResults, filePath);
  }

  private updateStats(tokens: number): void {
    this.totalCalls++;
    this.totalTokensUsed += tokens;
  }

  getStats(): { totalCalls: number; totalTokensUsed: number } {
    return {
      totalCalls: this.totalCalls,
      totalTokensUsed: this.totalTokensUsed
    };
  }
}
