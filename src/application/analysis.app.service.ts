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
  // 当前正在 worker 中执行的对象（严格意义上的 in-flight）
  private activeObjects: Set<string> = new Set()
  private progressEnabled = false
  private onProgress?: AnalyzeProjectCommandParams['onProgress']
  private concurrency = DEFAULT_CONCURRENCY
  private lastRenderedCurrentKey: string | null = null

  private async buildNonGitFileSnapshot(
    projectRoot: string,
    blacklistService: BlacklistService,
  ): Promise<NonNullable<AnalysisMetadata['fileSnapshot']>> {
    const snapshot: NonNullable<AnalysisMetadata['fileSnapshot']> = {}

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
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

  private async findMissingResultObjects(
    projectRoot: string,
    depth: number,
    blacklistService: BlacklistService,
    storageRoot: string,
  ): Promise<{ missingFiles: string[]; missingDirs: string[] }> {
    const missingFiles: string[] = []
    const missingDirs: string[] = []

    const depthEnabled = depth !== undefined && depth >= 1
    const maxDepth = depthEnabled ? depth : Number.POSITIVE_INFINITY
    const { getFileOutputPath } = await import('../common/utils')

    const walk = async (dirAbs: string, dirRel: string, currentDepth: number): Promise<void> => {
      if (currentDepth > maxDepth) return

      // 目录结果文件缺失：<storageRoot>/<dirRel>/index.md（根目录为 storageRoot/index.md）
      // 注意：BlacklistService 对 "./" 会归一化为空路径；空路径表示项目根自身，按“不忽略”处理即可
      if (dirRel === '.' || !blacklistService.isIgnored(`${dirRel}/`)) {
        const dirMd = path.join(storageRoot, dirRel === '.' ? '' : dirRel, 'index.md')
        if (!(await fs.pathExists(dirMd))) {
          missingDirs.push(dirRel === '.' ? '.' : dirRel)
        }
      }

      const entries = await fs.readdir(dirAbs, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirAbs, entry.name)
        const rel = path.relative(projectRoot, fullPath) || entry.name
        const key = entry.isDirectory() ? `${rel}/` : rel
        if (blacklistService.isIgnored(key)) {
          continue
        }
        if (entry.isDirectory()) {
          await walk(fullPath, rel, currentDepth + 1)
        } else if (entry.isFile()) {
          const expected = getFileOutputPath(storageRoot, rel)
          if (!(await fs.pathExists(expected))) {
            missingFiles.push(rel)
          }
        }
      }
    }

    const rootStat = await fs.stat(projectRoot)
    if (rootStat.isFile()) {
      const rel = path.basename(projectRoot)
      const expected = getFileOutputPath(storageRoot, rel)
      if (!(await fs.pathExists(expected))) {
        missingFiles.push(rel)
      }
      return { missingFiles, missingDirs }
    }

    await walk(projectRoot, '.', 1)
    return { missingFiles, missingDirs }
  }

  async runAnalysis(params: AnalyzeProjectCommandParams & { outputDir?: string }): Promise<AnalyzeProjectCommandResult> {
    const projectRoot = params.path || process.cwd()
    logger.info(`解析流程开始，项目根路径：${projectRoot}`)
    // 仅在需要 CLI 进度渲染时才维护 activeObjects 快照，避免在性能/集成测试中产生 O(n log n) 排序开销。
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
    logger.debug(`项目路径：${projectRoot}，是否为Git项目：${isGit}`)
    
    if (isGit) {
      currentCommit = await gitService.getCurrentCommit()
      currentBranch = await gitService.getCurrentBranch()
      const gitSlug = await gitService.getProjectSlug()
      projectSlug = generateProjectSlug(projectRoot, true, gitSlug)
      logger.debug(`Git项目信息：分支=${currentBranch}，commit=${currentCommit}，slug=${gitSlug}`)
    } else {
      projectSlug = generateProjectSlug(projectRoot, false)
    }
    
    // 检测解析模式
    let mode: 'full' | 'incremental' = params.mode === 'full' ? 'full' : 'incremental'
    if (params.mode === 'auto') {
      const existingMeta = await storageService.getMetadata(projectSlug)
      const hasAnyResult = await storageService.hasAnyResult(projectSlug)
      mode = hasAnyResult ? 'incremental' : 'full'
      logger.debug(
        `自动检测解析模式：已有任意结果=${hasAnyResult}，现有元数据=${!!existingMeta}，使用模式=${mode}`,
      )
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
    const storageRoot = getStoragePath(projectRoot, outputDir)

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
        onScanProgress: params.onScanProgress,
      })
    } else {
      // 增量解析
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
            logger.warn(`commit差异比较失败，将仅基于未提交变更与结果缺失进行增量：${(e as Error).message}`)
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

      // 增量模式下，将未提交变更也纳入候选集合，确保「增量 + dirty」仍有解析对象。
      if (isGit) {
        try {
          const uncommitted = await gitService.getUncommittedChanges()
          if (uncommitted.length > 0) {
            logger.debug(`增量模式下检测到未提交变更文件：${uncommitted.length}个，将一并纳入增量集合`)
            const merged = new Set<string>([...changedFiles, ...uncommitted])
            changedFiles = Array.from(merged)
            logger.debug(`合并后的增量候选文件数：${changedFiles.length}个`)
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          logger.warn(`获取未提交变更失败，将仅基于 commit diff 继续：${msg}`)
        }
      }

      // 增量自修复：扫描源码树，补入“结果缺失但源码未变更”的文件/目录。
      // 注意：即便 changedFiles 为空，只要存在缺失结果，也应当执行一次增量解析来补齐。
      const missing = await this.findMissingResultObjects(
        projectRoot,
        params.depth ?? -1,
        blacklistService,
        storageRoot,
      )
      if (missing.missingFiles.length > 0) {
        const merged = new Set<string>([...changedFiles, ...missing.missingFiles])
        changedFiles = Array.from(merged)
      }
      const changedDirs = missing.missingDirs

      // 计算最终会参与增量解析的目录集合：
      // - 一部分来自缺失结果的目录（changedDirs）
      // - 一部分来自变更文件所在的父目录（affectedDirsFromFiles）
      const affectedDirsFromFiles = changedFiles
        .map(file => {
          const parts = file.split(/[/\\]/)
          return parts.slice(0, -1).join('/')
        })
        .filter(Boolean)

      const affectedDirs = Array.from(
        new Set<string>([
          ...affectedDirsFromFiles,
          ...changedDirs,
        ]),
      )

      if (changedFiles.length === 0 && affectedDirs.length === 0) {
        logger.info(`没有检测到需要重新解析的对象，直接返回现有解析结果`)
        analysisResult = {
          success: true,
          analyzedFilesCount: 0,
          analyzedDirsCount: 0,
          duration: Date.now() - startTime,
          errors: [],
          projectSlug,
          summaryPath: path.join(storageRoot, 'index.md'),
          indexEntries: [],
          removedSourcePaths: [],
        }
      } else {
        // 增量模式下，total 由“文件+目录”对象数决定，确保首帧 progress total 反映真实对象总数。
        // 目录对象以 affectedDirs 为准（含变更文件推导出的父目录 + 结果缺失目录）。
        this.totalObjects = changedFiles.length + affectedDirs.length
        params.onTotalKnown?.(this.totalObjects)

        logger.info(
          `开始解析 ${this.totalObjects} 个对象...`,
        )
        analysisResult = await analysisService.incrementalAnalysis({
          projectRoot,
          changedFiles,
          changedDirs: affectedDirs,
          baseCommit: lastCommit ?? '',
          targetCommit: currentCommit,
          concurrency: params.concurrency || DEFAULT_CONCURRENCY,
          onObjectPlanned: obj => this.handleObjectPlanned(obj),
          onObjectStarted: obj => this.handleObjectStarted(obj),
          onObjectCompleted: (obj, meta) => this.handleObjectCompleted(obj, meta, params),
          onScanProgress: params.onScanProgress,
        })
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
    // 严格语义：对象完成即从 in-flight 集合移除；不再包含“刚完成”对象，也不做目录长驻。
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
    // 无任何 worker in-flight 对象时，不展示当前对象块（传空字符串即可）
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
