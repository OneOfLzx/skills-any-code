import { AnalyzeProjectCommandParams, AnalyzeProjectCommandResult, LLMConfig } from '../common/types'
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

export class AnalysisAppService {
  async runAnalysis(params: AnalyzeProjectCommandParams & { outputDir?: string }): Promise<AnalyzeProjectCommandResult> {
    const projectRoot = params.path || process.cwd()
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

    const analysisService = new AnalysisService(
      gitService,
      storageService,
      blacklistService,
      projectSlug,
      currentCommit,
      params.llmConfig as LLMConfig
    )
    
    const startTime = Date.now()
    let analysisResult
    
    // 执行解析
    logger.debug(`解析参数：depth=${params.depth}, concurrency=${params.concurrency || DEFAULT_CONCURRENCY}`)
    if (mode === 'full') {
      logger.info(`开始执行全量解析...`)
      const total = await analysisService.countObjects(projectRoot, params.depth ?? -1)
      params.onTotalKnown?.(total)
      analysisResult = await analysisService.fullAnalysis({
        projectRoot,
        depth: params.depth,
        concurrency: params.concurrency || DEFAULT_CONCURRENCY,
        onProgress: params.onProgress
      })
    } else {
      // 增量解析
      logger.info(`开始执行增量解析...`)
      const existingMeta = await storageService.getMetadata(projectSlug)
      const lastCommit = existingMeta?.gitCommits?.[existingMeta.gitCommits.length - 1]?.hash
      logger.debug(`上次解析commit：${lastCommit}`)
      
      let changedFiles: string[] = []
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
      
      if (changedFiles.length === 0) {
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
      } else {
        logger.info(`开始解析${changedFiles.length}个变更文件...`)
        analysisResult = await analysisService.incrementalAnalysis({
          projectRoot,
          changedFiles,
          baseCommit: lastCommit!,
          targetCommit: currentCommit,
          concurrency: params.concurrency || DEFAULT_CONCURRENCY
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

    return {
      success: analysisResult.success,
      code: analysisResult.success ? ErrorCode.SUCCESS : ErrorCode.ANALYSIS_EXCEPTION,
      message: analysisResult.success ? '解析完成' : `解析完成，存在${analysisResult.errors.length}个错误`,
      data: {
        projectName: projectSlug,
        mode,
        analyzedFilesCount: analysisResult.analyzedFilesCount,
        duration,
        summaryPath
      },
      errors: analysisResult.errors.length > 0 ? analysisResult.errors : undefined
    }
  }
}
