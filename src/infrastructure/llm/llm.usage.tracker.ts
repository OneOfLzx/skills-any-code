import type { TokenUsageStats } from '../../common/types'
import { AppError, ErrorCode } from '../../common/errors'

/**
 * 单次解析周期内的 LLM Token 使用统计器。
 *
 * - 对所有调用做累计统计；
 * - 支持 maxTotalTokens 上限保护；
 * - 通过 onSnapshot 回调向上层（如 CLI 渲染器）推送最新快照；
 * - 不直接向 stdout 打印 Token 行，由 CLI 统一渲染「Tokens: ...」。
 */
export class LLMUsageTracker {
  private stats: TokenUsageStats = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCalls: 0,
  }

  /**
   * 单次解析允许的累计 Token 上限（totalTokens）。
   * - 0 表示不限制；
   * - 大于 0 时，当累计值超过该上限会立刻抛出 AppError，终止后续解析流程。
   */
  private readonly maxTotalTokens: number

  constructor(
    private readonly onSnapshot?: (stats: TokenUsageStats) => void,
    maxTotalTokens: number = 0,
  ) {
    this.maxTotalTokens = maxTotalTokens
  }

  addUsage(usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): void {
    this.stats.totalPromptTokens += usage.promptTokens ?? 0
    this.stats.totalCompletionTokens += usage.completionTokens ?? 0
    this.stats.totalTokens += usage.totalTokens ?? 0
    this.stats.totalCalls += 1

    const snapshot = this.getStats()

    // 资源保护：累计 Token 超过上限时立即中止，避免进程级 OOM。
    if (this.maxTotalTokens > 0 && snapshot.totalTokens > this.maxTotalTokens) {
      throw new AppError(
        ErrorCode.LLM_TOKEN_LIMIT_EXCEEDED,
        `本次解析累计 Token 已超过上限 ${this.maxTotalTokens}，为避免内存/费用风险已安全中止。` +
          '请尝试降低解析深度（如 --depth）、缩小解析路径范围、增加黑名单，或分模块分别运行 analyze。',
        {
          totalTokens: snapshot.totalTokens,
          maxTotalTokens: this.maxTotalTokens,
        },
      )
    }

    if (this.onSnapshot) {
      this.onSnapshot(snapshot)
    }
  }

  /**
   * 将外部汇总（例如 worker 线程返回的本任务 usage delta）累加到总量中。
   * 注意：这里的 totalCalls 表示调用次数增量，而不是“任务数”。
   */
  addTotals(delta: Partial<TokenUsageStats>): void {
    this.stats.totalPromptTokens += delta.totalPromptTokens ?? 0
    this.stats.totalCompletionTokens += delta.totalCompletionTokens ?? 0
    this.stats.totalTokens += delta.totalTokens ?? 0
    this.stats.totalCalls += delta.totalCalls ?? 0

    const snapshot = this.getStats()

    if (this.maxTotalTokens > 0 && snapshot.totalTokens > this.maxTotalTokens) {
      throw new AppError(
        ErrorCode.LLM_TOKEN_LIMIT_EXCEEDED,
        `本次解析累计 Token 已超过上限 ${this.maxTotalTokens}，为避免内存/费用风险已安全中止。` +
          '请尝试降低解析深度（如 --depth）、缩小解析路径范围、增加黑名单，或分模块分别运行 analyze。',
        {
          totalTokens: snapshot.totalTokens,
          maxTotalTokens: this.maxTotalTokens,
        },
      )
    }

    if (this.onSnapshot) {
      this.onSnapshot(snapshot)
    }
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

