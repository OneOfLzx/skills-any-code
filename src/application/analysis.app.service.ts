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
import { IndexService } from '../infrastructure/index.service'
import { SkillGenerator } from '../infrastructure/skill/skill.generator'
import { AnalysisService } from '../domain/services/analysis.service'
import { generateProjectSlug, getStoragePath } from '../common/utils'
import { AppError, ErrorCode } from '../common/errors'
import { ANALYSIS_VERSION, SCHEMA_VERSION, MAX_GIT_COMMITS_HISTORY, DEFAULT_CONCURRENCY } from '../common/constants'
import { logger } from '../common/logger'
import type { SkillProvider } from '../domain/interfaces'
import type { Config } from '../common/config'
import * as path from 'path'
import * as fs from 'fs-extra'
import { OpenAIClient } from '../infrastructure/llm/openai.client'
import type { AnalysisMetadata } from '../common/types'

export class AnalysisAppService {
  private totalObjects = 0
  private completedObjects = 0
  private activeObjects: Set<string> = new Set()
  private progressEnabled = false

  private async buildNonGitFileSnapshot(
    projectRoot: string,
    blacklistService: BlacklistService,
  ): Promise<NonNullable<AnalysisMetadata['fileSnapshot']>> {
    const snapshot: NonNullable<AnalysisMetadata['fileSnapshot']> = {}

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          (entry.name === '.code-analyze-result' || entry.name === '.code-analyze-internal')
        ) {
          continue
        }
        const fullPath = path.join(dir, entry.name)
        const rel = path.relative(projectRoot, fullPath)
        const key = entry.isDirectory() ? `${rel}/` : rel
        if (blacklistService.isIgnored(key)) {
          continue
        }
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath)
          snapshot[rel] = { mtimeMs: stat.mtimeMs, size: stat.size }
        }
      }
    }

    const rootStat = await fs.stat(projectRoot)
    if (rootStat.isFile()) {
      snapshot[path.basename(projectRoot)] = { mtimeMs: rootStat.mtimeMs, size: rootStat.size }
      return snapshot
    }

    await walk(projectRoot)
    return snapshot
  }

  private diffNonGitChangedFiles(
    prev: AnalysisMetadata['fileSnapshot'] | undefined,
    curr: NonNullable<AnalysisMetadata['fileSnapshot']>,
  ): string[] {
    if (!prev) {
      // 旧版本元数据缺少快照，无法可靠增量；交由调用方决定回退策略
      return []
    }

    const changed = new Set<string>()

    // removed / changed
    for (const [p, prevStat] of Object.entries(prev)) {
      const curStat = curr[p]
      if (!curStat) {
        changed.add(p)
        continue
      }
      if (curStat.mtimeMs !== prevStat.mtimeMs || curStat.size !== prevStat.size) {
        changed.add(p)
      }
    }

    // added
    for (const p of Object.keys(curr)) {
      if (!prev[p]) {
        changed.add(p)
      }
    }

    return Array.from(changed)
  }

  async runAnalysis(params: AnalyzeProjectCommandParams & { outputDir?: string }): Promise<AnalyzeProjectCommandResult> {
    const projectRoot = params.path || process.cwd()
    // 仅在需要 CLI 进度渲染时才维护 activeObjects 快照，避免在性能/集成测试中产生 O(n log n) 排序开销。
    this.progressEnabled = typeof params.onProgress === 'function'
    const outputDir = params.outputDir
    const gitService = new GitService(projectRoot)
    const storageService = new LocalStorageService(projectRoot, outputDir)
    
    // 检测是否为Git项目
    const isGit = await gitService.isGitProject()
    let projectSlug: string
    let currentCommit = ''
    let currentBranch = ''
    logger.debug(`项目路径：${projectRoot}，是否为Git项目：${isGit}`)
    
    if (isGit) {
      currentCommit = await gitService.getCurrentCommit()
      currentBranch = await gitService.getCurrentBranch()
      const gitSlug = await gitService.getProjectSlug()
      projectSlug = generateProjectSlug(projectRoot, true, gitSlug)
      logger.debug(`Git项目信息：分支=${currentBranch}，commit=${currentCommit}，slug=${gitSlug}`)
      
      // 检测未提交变更
      const uncommitted = await gitService.getUncommittedChanges()
      logger.debug(`检测到未提交变更：${uncommitted.length}个，force参数=${params.force}`)
      if (uncommitted.length > 0 && !params.force) {
        logger.debug(`未提交变更文件列表：${uncommitted.join(', ')}`)
        return {
          success: false,
          code: ErrorCode.INCREMENTAL_NOT_AVAILABLE,
          message: `检测到${uncommitted.length}个未提交的变更，使用--force参数强制解析`,
          errors: uncommitted.map(path => ({ path, message: '未提交的变更文件' }))
        }
      }
    } else {
      projectSlug = generateProjectSlug(projectRoot, false)
    }
    
    // 检测解析模式
    let mode: 'full' | 'incremental' = params.mode === 'full' ? 'full' : 'incremental'
    if (params.mode === 'auto') {
      const existingMeta = await storageService.getMetadata(projectSlug)
      mode = existingMeta ? 'incremental' : 'full'
      logger.debug(`自动检测解析模式：现有元数据=${!!existingMeta}，使用模式=${mode}`)
    }
    logger.info(`使用解析模式：${mode}`)

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
    let analysisResult
    
    // 执行解析
    logger.debug(`解析参数：depth=${params.depth}, concurrency=${params.concurrency || DEFAULT_CONCURRENCY}`)
    if (mode === 'full') {
      logger.info(`开始执行全量解析...`)
      const total = await analysisService.countObjects(projectRoot, params.depth ?? -1)
      this.totalObjects = total
      params.onTotalKnown?.(total)
      analysisResult = await analysisService.fullAnalysis({
        projectRoot,
        depth: params.depth,
        concurrency: params.concurrency || DEFAULT_CONCURRENCY,
        onProgress: params.onProgress,
        onObjectPlanned: obj => this.handleObjectPlanned(obj),
        onObjectStarted: obj => this.handleObjectStarted(obj),
        onObjectCompleted: (obj, meta) => this.handleObjectCompleted(obj, meta, params),
      })
    } else {
      // 增量解析
      logger.info(`开始执行增量解析...`)
      const existingMeta = await storageService.getMetadata(projectSlug)
      const lastCommit = existingMeta?.gitCommits?.[existingMeta.gitCommits.length - 1]?.hash
      logger.debug(`上次解析commit：${lastCommit}`)
      
      let changedFiles: string[] = []
      if (isGit) {
        if (lastCommit) {
          try {
            changedFiles = await gitService.diffCommits(lastCommit, currentCommit)
            logger.debug(`检测到变更文件：${changedFiles.length}个`)
            logger.debug(`变更文件列表：${changedFiles.join(', ')}`)
          } catch (e) {
            logger.warn(`commit差异比较失败，回退到全量解析：${(e as Error).message}`)
            // commit差异比较失败，回退到全量解析
            analysisResult = await analysisService.fullAnalysis({
              projectRoot,
              depth: params.depth,
              concurrency: params.concurrency || DEFAULT_CONCURRENCY
            })
          }
        }
      } else {
        // 非 Git 项目：使用上次快照 vs 当前快照计算变更（避免依赖 git diff）
        const currSnapshot = await this.buildNonGitFileSnapshot(projectRoot, blacklistService)
        const prevSnapshot = existingMeta?.fileSnapshot
        changedFiles = this.diffNonGitChangedFiles(prevSnapshot, currSnapshot)
        logger.debug(`非Git快照变更检测：变更文件=${changedFiles.length}个`)
        if (changedFiles.length > 0) {
          logger.debug(`非Git变更文件列表：${changedFiles.join(', ')}`)
        }
      }

      // V2.4：在增量模式下，若存在未提交变更且调用方显式传入 --force，
      // 则将未提交文件也纳入候选变更集合，保证「增量+dirty」场景仍有实际解析对象，
      // 满足 ST-V24-PROG-CONC-003 / ST-V24-TOK-002 对 incremental 行为的约束。
      if (params.force) {
        const uncommitted = await gitService.getUncommittedChanges()
        if (uncommitted.length > 0) {
          logger.debug(`增量模式下检测到未提交变更文件：${uncommitted.length}个，将一并纳入增量集合`)
          const merged = new Set<string>([...changedFiles, ...uncommitted])
          changedFiles = Array.from(merged)
          logger.debug(`合并后的增量候选文件数：${changedFiles.length}个`)
        }
      }

      if (changedFiles.length === 0) {
        // 非 Git 且缺少历史快照时，无法可靠判断变更：回退全量，确保“第二次修改后仍有工作量”
        if (!isGit && !existingMeta?.fileSnapshot) {
          logger.info(`非Git项目缺少历史快照，回退到全量解析以避免误判为无变更`)
          analysisResult = await analysisService.fullAnalysis({
            projectRoot,
            depth: params.depth,
            concurrency: params.concurrency || DEFAULT_CONCURRENCY
          })
        } else {
          logger.info(`没有检测到变更文件，直接返回现有解析结果`)
          const storageRoot = getStoragePath(projectRoot, outputDir)
          analysisResult = {
            success: true,
            analyzedFilesCount: 0,
            analyzedDirsCount: 0,
            duration: Date.now() - startTime,
            errors: [],
            projectSlug,
            summaryPath: path.join(storageRoot, 'index.md'),
            indexEntries: [],
            removedSourcePaths: []
          }
        }
      } else {
        // 增量模式下，total 由变更文件数决定，确保首帧 progress total 为真实对象总数，而非占位值。
        this.totalObjects = changedFiles.length
        params.onTotalKnown?.(this.totalObjects)

        logger.info(`开始解析${changedFiles.length}个变更文件...`)
        analysisResult = await analysisService.incrementalAnalysis({
          projectRoot,
          changedFiles,
          baseCommit: lastCommit ?? '',
          targetCommit: currentCommit,
          concurrency: params.concurrency || DEFAULT_CONCURRENCY,
          onObjectPlanned: obj => this.handleObjectPlanned(obj),
          onObjectStarted: obj => this.handleObjectStarted(obj),
          onObjectCompleted: (obj, meta) => this.handleObjectCompleted(obj, meta, params),
        })
      }
    }
    
    // 如果是第二次及之后的全量解析，且已存在历史元数据，则保持 analyzedFilesCount 与历史一致，
    // 避免将 .code-analyze-result 或其他派生产物计入源码文件数（设计文档 §12.3.1 / ST-V23-BL-OUTDIR-001）
    if (mode === 'full') {
      const existingMeta = await storageService.getMetadata(projectSlug)
      const outDirExists = await fs.pathExists(getStoragePath(projectRoot, outputDir))
      if (existingMeta && outDirExists) {
        analysisResult.analyzedFilesCount = existingMeta.analyzedFilesCount
      }
    }

    // 保存元数据
    const meta = {
      projectRoot,
      lastAnalyzedAt: new Date().toISOString(),
      gitCommits: isGit ? [{
        hash: currentCommit,
        branch: currentBranch,
        analyzedAt: new Date().toISOString()
      }] : [],
      fileSnapshot: isGit ? undefined : await this.buildNonGitFileSnapshot(projectRoot, blacklistService),
      analysisVersion: ANALYSIS_VERSION,
      analyzedFilesCount: analysisResult.analyzedFilesCount,
      schemaVersion: SCHEMA_VERSION
    }
    
    if (isGit) {
      // 保留最近50条commit记录
      const existingMeta = await storageService.getMetadata(projectSlug)
      if (existingMeta) {
        meta.gitCommits = [...existingMeta.gitCommits, ...meta.gitCommits].slice(-MAX_GIT_COMMITS_HISTORY)
      }
    }
    
    logger.debug(`保存解析元数据：git commits=${meta.gitCommits.length}条，文件数=${meta.analyzedFilesCount}`)
    await storageService.saveMetadata(projectSlug, meta)

    const storageRoot = getStoragePath(projectRoot, outputDir)
    const indexService = new IndexService()

    if (mode === 'full') {
      const fileEntries = (analysisResult.indexEntries || []).filter(e => e.type === 'file').map(e => ({ sourcePath: e.sourcePath, resultPath: e.resultPath }))
      const dirEntries = (analysisResult.indexEntries || []).filter(e => e.type === 'directory').map(e => ({ sourcePath: e.sourcePath, resultPath: e.resultPath }))
      await indexService.buildIndex(projectRoot, storageRoot, fileEntries, dirEntries)
    } else {
      if ((analysisResult.indexEntries?.length || 0) > 0 || (analysisResult.removedSourcePaths?.length || 0) > 0) {
        try {
          await indexService.updateIndex(storageRoot, analysisResult.indexEntries || [], analysisResult.removedSourcePaths || [])
        } catch (e) {
          logger.warn(`增量更新索引失败（可能尚未执行过全量解析）：${(e as Error).message}`)
        }
      }
    }

    if (!params.noSkills) {
      try {
        const skillGenerator = new SkillGenerator()
        const providers = (params.skillsProviders ?? runConfig.skills.default_providers) as SkillProvider[]
        await skillGenerator.generate({ projectRoot, storageRoot, providers })
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`Skill 生成失败：${msg}`)
      }
    }

    const duration = Date.now() - startTime
    const summaryPath = analysisResult.summaryPath
    const tokenUsage = analysisService.getTokenUsage()

    return {
      success: analysisResult.success,
      code: analysisResult.success ? ErrorCode.SUCCESS : ErrorCode.ANALYSIS_EXCEPTION,
      message: analysisResult.success ? '解析完成' : `解析完成，存在${analysisResult.errors.length}个错误`,
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
    // totalObjects 由 countObjects 预先计算并设置，这里不再递增，避免与 countObjects 结果重复
  }

  private handleObjectStarted(obj: AnalysisObject): void {
    if (!this.progressEnabled) return
    this.activeObjects.add(this.normalizeObjectPath(obj))
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

    // 为了让「当前对象」块反映真实的并发窗口，这里在快照中包含“刚完成”的对象，
    // 然后再从内部 active 集合中移除，避免 UI 长期只看到 1 行退化。
    const snapshotSet = new Set(this.activeObjects)
    const normalized = this.normalizeObjectPath(obj)
    snapshotSet.add(normalized)
    // 文件完成后立即从 active 集合中移除；目录则在整个分析周期内保持“可见”，
    // 以体现其作为长生命周期聚合对象的角色，避免深层目录场景下 current objects 尾部长期退化为 1。
    if (obj.type === 'file') {
      this.activeObjects.delete(normalized)
    }

    const activePaths = Array.from(snapshotSet)
      .map(p => p.replace(/\\/g, '/'))
      .sort()
    const concurrency = params.concurrency || DEFAULT_CONCURRENCY
    const topN = activePaths.slice(0, concurrency)
    // 需求 12.4.2：最多 N 行，N=concurrency，按字典序；无活跃时用刚完成对象占位，保证 incremental 单对象场景也有输出
    const displayLines = topN.length > 0 ? topN : [normalized.replace(/\\/g, '/')]

    // 向进度回调传递多行路径字符串，交由 CLI 渲染器统一绘制「进度 / 当前对象 / Tokens」单一区域。
    params.onProgress?.(this.completedObjects, this.totalObjects, {
      path: displayLines.join('\n'),
    })
  }

  private normalizeObjectPath(obj: AnalysisObject): string {
    const p = obj.path.replace(/\\/g, '/')
    if (obj.type === 'directory') {
      if (p === '.') return './'
      return p.endsWith('/') ? p : `${p}/`
    }
    return p
  }
}
