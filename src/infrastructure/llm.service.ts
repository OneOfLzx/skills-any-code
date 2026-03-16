import OpenAI from 'openai';
import { configManager } from '../common/config';
import { AppError, ErrorCode } from '../common/errors';
import { logger } from '../common/logger';

export interface LLMService {
  generateCompletion(prompt: string, systemPrompt?: string): Promise<string>;
}

export class OpenAILLMService implements LLMService {
  private client: OpenAI | null = null;

  private async getClient(): Promise<OpenAI> {
    if (!this.client) {
      let config: any;
      try {
        config = configManager.getConfig();
      } catch (e) {
        await configManager.load();
        config = configManager.getConfig();
      }
      
      if (!config.llm.apiKey) {
        throw new AppError(ErrorCode.ANALYSIS_EXCEPTION, 'LLM API key not configured. Please set it in config file or via CODE_ANALYZE_LLM_APIKEY environment variable.');
      }

      this.client = new OpenAI({
        baseURL: config.llm.baseURL,
        apiKey: config.llm.apiKey,
      });
    }
    return this.client;
  }

  async generateCompletion(prompt: string, systemPrompt: string = 'You are a code analysis expert. You help analyze code files, generate summaries, class diagrams, and other analysis results. Be concise and accurate.'): Promise<string> {
    const client = await this.getClient();
    const config = configManager.getConfig();

    try {
      logger.debug(`Calling LLM model ${config.llm.model} with prompt length: ${prompt.length}`);
      
      const response = await client.chat.completions.create({
        model: config.llm.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2048,
      });

      const result = response.choices[0]?.message?.content?.trim() || '';
      
      if (!result) {
        throw new AppError(ErrorCode.ANALYSIS_EXCEPTION, 'LLM returned empty response');
      }

      logger.debug(`LLM response received, length: ${result.length}`);
      return result;
    } catch (error: any) {
      logger.error('LLM call failed:', error);
      throw new AppError(ErrorCode.ANALYSIS_EXCEPTION, `LLM call failed: ${error.message}`);
    }
  }
}

export const llmService = new OpenAILLMService();
