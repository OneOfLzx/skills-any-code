import {
  AnalyzeProjectCommandParams,
  AnalyzeProjectCommandResult,
  LLMConfig,
  AnalysisObject,
  ObjectResultMeta,
} from '../common/types'
import { GitService } from '../infrastructure/git.service'
import { LocalStorageService } from '../infrastructure/storage.service'
import { BlacklistService } from '../infrastructure/blacklist.service'
import { SkillGenerator } from '../infrastructure/skill/skill.generator'
import { AnalysisService } from '../domain/services/analysis.service'
import { generateProjectSlug, getStoragePath, getFileOutputPath } from '../common/utils'
import { AppError, ErrorCode } from '../common/errors'
import { DEFAULT_CONCURRENCY } from '../common/constants'
import { logger } from '../common/logger'
import type { SkillProvider } from '../domain/interfaces'
import type { Config } from '../common/config'
import * as path from 'path'
import * as fs from 'fs-extra'
import { createHash } from 'crypto'
import { OpenAIClient } from '../infrastructure/llm/openai.client'

export class AnalysisAppService {
  private totalObjects = 0
  private completedObjects = 0
  private activeObjects: Set<string> = new Set()
  private progressEnabled = false
  private onProgress?: AnalyzeProjectCommandParams['onProgress']
  private concurrency = DEFAULT_CONCURRENCY
  private lastRenderedCurrentKey: string | null = null

  async runAnalysis(params: AnalyzeProjectCommandParams & { outputDir?: string }): Promise<AnalyzeProjectCommandResult> {
    const projectRoot = params.path || process.cwd()
    logger.info(`Analysis started. Project root: ${projectRoot}`)
    this.progressEnabled = typeof params.onProgress === 'function'
    this.onProgress = params.onProgress
    this.concurrency = params.concurrency || DEFAULT_CONCURRENCY
    this.totalObjects = 0
    this.completedObjects = 0
    this.activeObjects = new Set()
    this.lastRenderedCurrentKey = null
    const outputDir = params.outputDir
    const gitService = new GitService(projectRoot)
    const storageService = new LocalStorageService(projectRoot, outputDir)

    // 检测是否为Git项目
    const isGit = await gitService.isGitProject()
    let projectSlug: string
    let currentCommit = ''
    let currentBranch = ''
    logger.debug(`Project path: ${projectRoot}, isGit: ${isGit}`)

    if (isGit) {
      currentCommit = await gitService.getCurrentCommit()
      currentBranch = await gitService.getCurrentBranch()
      const gitSlug = await gitService.getProjectSlug()
      projectSlug = generateProjectSlug(projectRoot, true, gitSlug)
      logger.debug(`Git info: branch=${currentBranch}, commit=${currentCommit}, slug=${gitSlug}`)
    } else {
      projectSlug = generateProjectSlug(projectRoot, false)
    }

    // 检测解析模式
    let mode: 'full' | 'incremental' = params.mode === 'full' ? 'full' : 'incremental'
    if (params.mode === 'auto') {
      const hasAnyResult = await storageService.hasAnyResult(projectSlug)
      mode = hasAnyResult ? 'incremental' : 'full'
      logger.debug(
        `Auto mode detection: hasAnyResult=${hasAnyResult}, selected=${mode}`,
      )
    }
    logger.info(`Analysis mode: ${mode}`)

    let runConfig: Config
    try {
      const { configManager } = await import('../common/config')
      runConfig = configManager.getConfig()
    } catch {
      const { configManager } = await import('../common/config')
      runConfig = await configManager.load()
    }
    const blacklistService = new BlacklistService()
    await blacklistService.load(runConfig.analyze.blacklist, projectRoot)
    const llmConfig = params.llmConfig as LLMConfig
    const storageRoot = getStoragePath(projectRoot, outputDir)

    if (!params.noSkills) {
      try {
        const skillGenerator = new SkillGenerator()
        const providers = (params.skillsProviders ?? runConfig.skills.default_providers) as SkillProvider[]
        await skillGenerator.generate({ projectRoot, storageRoot, providers })
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`Skill generation failed: ${msg}`)
      }
    }

    const analysisService = new AnalysisService(
      gitService,
      storageService,
      blacklistService,
      projectSlug,
      currentCommit,
      llmConfig,
      params.onTokenUsageSnapshot,
    )

    const startTime = Date.now()

    // ===================================================================
    // 构建文件过滤器（全量 vs 增量唯一的差异点）
    // ===================================================================
    let fileFilter: (relPath: string, absPath: string) => Promise<boolean>
    let commitHash: string = currentCommit

    if (mode === 'full') {
      // 全量：所有文件均需解析
      fileFilter = async () => true
    } else {
      // 增量：优先对比 commitId，不可用时 fallback 到内容 hash
      const lastCommit = null
      logger.debug(`Last analyzed commit: ${lastCommit || 'N/A'}`)

      // Git 项目：使用 git diff 批量获取变更文件集合（等价于逐文件 commitId 对比的批量优化）
      let gitChangedFiles: Set<string> | null = null
      if (isGit && lastCommit) {
        try {
          const diffFiles = await gitService.diffCommits(lastCommit, currentCommit)
          logger.debug(`git diff detected changed files: ${diffFiles.length}`)
          gitChangedFiles = new Set(diffFiles)

          // 将未提交变更也纳入候选集合
          const uncommitted = await gitService.getUncommittedChanges()
          if (uncommitted.length > 0) {
            logger.debug(`Incremental mode detected uncommitted changes: ${uncommitted.length}`)
            for (const f of uncommitted) gitChangedFiles.add(f)
          }
          logger.debug(`Merged changed files count: ${gitChangedFiles.size}`)
        } catch (e) {
          logger.warn(`Commit diff failed; falling back to hash comparison: ${(e as Error).message}`)
        }
      }

      // 非 Git 项目：需要逐文件 hash 对比，预先无法批量确定变更集
      // 直接在 filter 内逐文件处理

      fileFilter = async (relPath: string, absPath: string): Promise<boolean> => {
        // 检查已有结果是否存在
        const existing = await storageService.getFileAnalysis(projectSlug, relPath, 'summary')
        if (!existing) return true // 结果缺失 → 需要解析

        if (isGit) {
          if (gitChangedFiles !== null) {
            // 批量优化：git diff 隐式对比了 commitId
            return gitChangedFiles.has(relPath)
          }
          // git diff 不可用，回退到逐文件 commitId 对比
          const currentFileCommitId = await gitService.getFileLastCommit(projectRoot, relPath)
          if (currentFileCommitId && existing.fileGitCommitId) {
            return currentFileCommitId !== existing.fileGitCommitId
          }
        }

        // 非 Git 或 commitId 不可用：回退到内容 hash 对比
        if (existing.fileHashWhenAnalyzed) {
          const content = await fs.readFile(absPath, 'utf-8')
          const currentHash = createHash('sha256').update(content).digest('hex')
          return existing.fileHashWhenAnalyzed !== currentHash
        }

        return true // 无法判断 → 安全起见重新解析
      }
    }

    // ===================================================================
    // 调用统一解析管线
    // ===================================================================
    logger.debug(`Analysis params: depth=${params.depth}, concurrency=${params.concurrency || DEFAULT_CONCURRENCY}`)
    const analysisResult = await analysisService.analyze({
      projectRoot,
      depth: params.depth,
      concurrency: params.concurrency || DEFAULT_CONCURRENCY,
      mode,
      commitHash,
      fileFilter,
      onTotalKnown: (total) => {
        this.totalObjects = total
        params.onTotalKnown?.(total)
      },
      onObjectPlanned: obj => this.handleObjectPlanned(obj),
      onObjectStarted: obj => this.handleObjectStarted(obj),
      onObjectCompleted: (obj, meta) => this.handleObjectCompleted(obj, meta, params),
      onScanProgress: params.onScanProgress,
    })

    const duration = Date.now() - startTime
    const summaryPath = analysisResult.summaryPath
    const tokenUsage = analysisService.getTokenUsage()

    return {
      success: analysisResult.success,
      code: analysisResult.success ? ErrorCode.SUCCESS : ErrorCode.ANALYSIS_EXCEPTION,
      message: analysisResult.success ? 'Analysis completed' : `Analysis completed with ${analysisResult.errors.length} error(s)`,
      data: {
        projectName: projectSlug,
        mode,
        analyzedFilesCount: analysisResult.analyzedFilesCount,
        duration,
        summaryPath,
        tokenUsage,
      },
      errors: analysisResult.errors.length > 0 ? analysisResult.errors : undefined
    }
  }

  private handleObjectPlanned(_obj: AnalysisObject): void {
    // totalObjects 由 analyze 内部的 onTotalKnown 回调设置
  }

  private handleObjectStarted(obj: AnalysisObject): void {
    if (!this.progressEnabled) return
    const normalized = this.normalizeObjectPath(obj)
    this.activeObjects.add(normalized)
    this.emitProgressSnapshot(new Set(this.activeObjects), normalized)
  }

  private handleObjectCompleted(
    obj: AnalysisObject,
    _meta: ObjectResultMeta,
    params: AnalyzeProjectCommandParams,
  ): void {
    this.completedObjects++
    if (!this.progressEnabled) {
      return
    }

    const normalized = this.normalizeObjectPath(obj)
    this.activeObjects.delete(normalized)
    this.concurrency = params.concurrency || DEFAULT_CONCURRENCY
    this.emitProgressSnapshot(new Set(this.activeObjects), normalized)
  }

  private normalizeObjectPath(obj: AnalysisObject): string {
    const p = obj.path.replace(/\\/g, '/')
    if (obj.type === 'directory') {
      if (p === '.') return './'
      return p.endsWith('/') ? p : `${p}/`
    }
    return p
  }

  private emitProgressSnapshot(snapshot: Set<string>, fallbackNormalized: string): void {
    if (!this.onProgress) return

    const activePaths = Array.from(snapshot)
      .map(p => p.replace(/\\/g, '/'))
      .sort()

    const topN = activePaths.slice(0, this.concurrency)
    const displayLines = topN
    const key = displayLines.join('\n')
    if (key === this.lastRenderedCurrentKey) {
      return
    }
    this.lastRenderedCurrentKey = key

    this.onProgress(this.completedObjects, this.totalObjects, {
      path: key,
    })
  }
}
