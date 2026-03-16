import OpenAI from 'openai';
import { ILLMClient } from '../../domain/interfaces';
import { LLMConfig, LLMCallOptions, LLMResponse } from '../../common/types';
import { AppError, ErrorCode } from '../../common/errors';
import { logger } from '../../common/logger';

export class OpenAIClient implements ILLMClient {
  private client: OpenAI;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.api_key,
      baseURL: config.base_url,
      timeout: config.timeout,
      dangerouslyAllowBrowser: true,
    });
  }

  async call(prompt: string, options?: LLMCallOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    const retries = options?.retries ?? this.config.max_retries;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: options?.model ?? this.config.model,
          temperature: options?.temperature ?? this.config.temperature,
          max_tokens: options?.maxTokens ?? this.config.max_tokens,
          messages: [
            { role: 'system', content: '你是专业的代码分析专家，严格按照要求输出结构化结果。' },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' }
        });

        const content = response.choices[0].message.content || '';
        const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        return {
          content,
          usage: {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          },
          model: response.model,
          responseTime: Date.now() - startTime,
        };
      } catch (error: any) {
        const errorMessage = error?.message || 'Unknown LLM call error';
        logger.debug(`LLM call attempt ${attempt + 1} failed: ${errorMessage}`);

        if (attempt === retries) {
          if (error?.status === 429) {
            throw new AppError(ErrorCode.LLM_RATE_LIMITED, 'LLM service rate limited', error);
          } else if (error?.code === 'ETIMEDOUT') {
            throw new AppError(ErrorCode.LLM_TIMEOUT, 'LLM call timeout', error);
          } else {
            throw new AppError(ErrorCode.LLM_CALL_FAILED, `LLM call failed: ${errorMessage}`, error);
          }
        }

        await this.sleep(this.config.retry_delay * Math.pow(2, attempt));
      }
    }

    throw new AppError(ErrorCode.LLM_CALL_FAILED, 'Max retries exceeded');
  }

  async batchCall(prompts: string[], options?: LLMCallOptions): Promise<LLMResponse[]> {
    const results: LLMResponse[] = [];
    for (const prompt of prompts) {
      results.push(await this.call(prompt, options));
    }
    return results;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
