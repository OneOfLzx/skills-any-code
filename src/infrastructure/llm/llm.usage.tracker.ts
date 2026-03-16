import type { TokenUsageStats } from '../../common/types'

export class LLMUsageTracker {
  private stats: TokenUsageStats = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCalls: 0,
  }

  addUsage(usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): void {
    this.stats.totalPromptTokens += usage.promptTokens ?? 0
    this.stats.totalCompletionTokens += usage.completionTokens ?? 0
    this.stats.totalTokens += usage.totalTokens ?? 0
    this.stats.totalCalls += 1
  }

  getStats(): TokenUsageStats {
    return { ...this.stats }
  }

  reset(): void {
    this.stats = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCalls: 0,
    }
  }
}

