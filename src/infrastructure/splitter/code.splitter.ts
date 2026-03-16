import { IFileSplitter } from '../../domain/interfaces';
import { FileChunk, FileChunkAnalysis, FileAnalysis } from '../../common/types';
import { AppError, ErrorCode } from '../../common/errors';
import { ILLMClient } from '../../domain/interfaces';
import {
  MERGE_STRUCTURE_PROMPT,
  FILE_DESCRIPTION_PROMPT,
  FILE_SUMMARY_PROMPT,
  PARSE_RETRY_HINT
} from '../llm/prompt.template';
import Mustache from 'mustache';
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

export class CodeSplitter implements IFileSplitter {
  private llmClient: ILLMClient;

  constructor(llmClient: ILLMClient) {
    this.llmClient = llmClient;
  }

  async split(fileContent: string, maxChunkSize: number): Promise<FileChunk[]> {
    try {
      const lines = fileContent.split('\n');
      const chunks: FileChunk[] = [];
      let currentChunkLines: string[] = [];
      let currentChunkLength = 0;
      let startLine = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLength = line.length + 1; // +1 for newline

        // 检查是否是语义边界：类/函数定义、空行、注释块结束等
        const isSemanticBoundary = /^(class|function|interface|type|enum|export\s+(class|function|interface)|\/\/\s*|\/\*\*|\*\/|\s*$)/.test(line.trim());

        if (currentChunkLength + lineLength > maxChunkSize && isSemanticBoundary && currentChunkLines.length > 0) {
          // 保存当前分片
          chunks.push({
            id: chunks.length,
            content: currentChunkLines.join('\n'),
            startLine,
            endLine: i - 1,
            context: this.extractContext(currentChunkLines)
          });

          // 开始新分片
          currentChunkLines = [];
          currentChunkLength = 0;
          startLine = i;
        }

        currentChunkLines.push(line);
        currentChunkLength += lineLength;
      }

      // 添加最后一个分片
      if (currentChunkLines.length > 0) {
        chunks.push({
          id: chunks.length,
          content: currentChunkLines.join('\n'),
          startLine,
          endLine: lines.length - 1,
          context: this.extractContext(currentChunkLines)
        });
      }

      return chunks;
    } catch (error: any) {
      throw new AppError(ErrorCode.FILE_SPLIT_FAILED, `Failed to split file: ${error.message}`, error);
    }
  }

  /**
   * 合并阶段按需求 10.7.1 / 10.9.4：三步 LLM 调用（结构 → 功能描述 → 概述），与单文件非分片协议一致；
   * 每次解析失败仅重试当次。
   */
  async merge(chunks: FileChunkAnalysis[], filePath: string): Promise<FileAnalysis> {
    const opts = { temperature: 0.1 };

    // 第一步：合并分片结果为统一结构
    const structure = await this.callWithParseRetry(
      Mustache.render(MERGE_STRUCTURE_PROMPT, {
        filePath,
        chunkResults: JSON.stringify(chunks, null, 2)
      }),
      opts,
      (content) => {
        const o = JSON.parse(content);
        return {
          name: o.name ?? path.basename(filePath),
          classes: Array.isArray(o.classes) ? o.classes : [],
          functions: Array.isArray(o.functions) ? o.functions : []
        };
      }
    );

    const structureJson = JSON.stringify(structure, null, 2);

    // 第二步：生成功能描述
    const description = await this.callWithParseRetry(
      Mustache.render(FILE_DESCRIPTION_PROMPT, { structureJson }),
      opts,
      (content) => parseSingleField(content, 'description')
    );

    // 第三步：生成概述
    const summary = await this.callWithParseRetry(
      Mustache.render(FILE_SUMMARY_PROMPT, { structureJson, description }),
      opts,
      (content) => parseSingleField(content, 'summary')
    );

    // 基础信息由程序侧负责，此处仅返回语义部分，路径等由调用方补充
    const name = path.basename(filePath);

    return {
      type: 'file',
      path: filePath,
      name,
      language: '',
      linesOfCode: 0,
      dependencies: [],
      description,
      summary,
      classes: structure.classes,
      functions: structure.functions,
      lastAnalyzedAt: new Date().toISOString(),
      commitHash: ''
    };
  }

  /** 单次调用：解析失败则仅重试该次一次（需求 10.9.2）。 */
  private async callWithParseRetry<T>(
    prompt: string,
    options: { temperature?: number },
    parseFn: (content: string) => T
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.llmClient.call(attempt === 1 ? prompt + PARSE_RETRY_HINT : prompt, {
          ...options,
          retries: 0
        });
        return parseFn(response.content);
      } catch (e) {
        lastError = e;
      }
    }
    throw new AppError(
      ErrorCode.CHUNK_MERGE_FAILED,
      `Failed to parse merge response after retry: ${(lastError as Error)?.message}`,
      lastError
    );
  }

  private extractContext(lines: string[]): string {
    // 提取分片的上下文信息：导入语句、类/函数定义开头
    const contextLines = lines.filter(line => 
      /^(import|export|class|function|interface|type|enum)/.test(line.trim())
    ).slice(0, 10); // 最多取前10行上下文
    return contextLines.join('\n');
  }
}
