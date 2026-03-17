import * as fs from 'fs-extra'
import * as path from 'path'
import { createHash } from 'crypto'
import { IAnalysisService, IGitService, IStorageService, IBlacklistService } from '../interfaces'
import {
  FullAnalysisParams,
  IncrementalAnalysisParams,
  ResumeAnalysisParams,
  AnalysisResult,
  FileAnalysis,
  DirectoryAnalysis,
  LLMConfig,
  AnalysisObject,
  ObjectResultMeta,
} from '../../common/types'
import { AppError, ErrorCode } from '../../common/errors'
import { logger } from '../../common/logger'
import { getFileOutputPath, getDirOutputPath } from '../../common/utils'
import { OpenAIClient } from '../../infrastructure/llm/openai.client'
import { LLMUsageTracker } from '../../infrastructure/llm/llm.usage.tracker'
import { CodeSplitter } from '../../infrastructure/splitter/code.splitter'
import { FileHashCache } from '../../infrastructure/cache/file.hash.cache'
import { LLMAnalysisService } from '../../application/services/llm.analysis.service'
import os from 'os'

export class AnalysisService implements IAnalysisService {
  private llmAnalysisService: LLMAnalysisService

  private tracker: LLMUsageTracker

  constructor(
    private gitService: IGitService,
    private storageService: IStorageService,
    private blacklistService: IBlacklistService,
    private projectSlug: string,
    private currentCommit: string,
    private llmConfig: LLMConfig
  ) {
    // 初始化LLM相关服务
    this.tracker = new LLMUsageTracker()
    const llmClient = new OpenAIClient(llmConfig, this.tracker);
    const fileSplitter = new CodeSplitter(llmClient);
    const homeDir = os.homedir()
    const resolvedCacheDir = llmConfig.cache_dir.replace(/^~(?=\/|\\|$)/, homeDir)
    const cache = new FileHashCache({
      cacheDir: resolvedCacheDir,
      maxSizeMb: llmConfig.cache_max_size_mb,
    })
    this.llmAnalysisService = new LLMAnalysisService(llmClient, fileSplitter, cache, llmConfig);
  }

  getTokenUsage() {
    return this.tracker.getStats()
  }

  /**
   * 统计将参与解析的对象总数（文件+目录），用于进度条 total。
   * 与 fullAnalysis 使用相同的深度与黑名单规则。
   */
  async countObjects(projectRoot: string, depth: number = -1): Promise<number> {
    const rootStat = await fs.stat(projectRoot)
    if (rootStat.isFile()) return 1
    let count = 0
    const countDir = async (dirPath: string, currentDepth: number): Promise<void> => {
      if (depth >= 1 && currentDepth > depth) return
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const valid = entries.filter(entry => {
        // 解析输出目录一律跳过，避免 .code-analyze-result 被再次解析
        if (entry.isDirectory() && entry.name === '.code-analyze-result') {
          return false
        }
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(projectRoot, fullPath)
        const key = entry.isDirectory() ? `${relativePath}/` : relativePath
        return !this.blacklistService.isIgnored(key)
      })
      for (const entry of valid) {
        if (entry.isFile()) count++
        else await countDir(path.join(dirPath, entry.name), currentDepth + 1)
      }
      count++ // 目录自身计为一个对象
    }
    await countDir(projectRoot, 1)
    return count
  }

  async fullAnalysis(params: FullAnalysisParams): Promise<AnalysisResult> {
    const startTime = Date.now()
    const errors: Array<{ path: string; message: string }> = []
    const completedFiles: string[] = []
    const completedDirs: string[] = []

    // 检查路径是文件还是目录
    const rootStat = await fs.stat(params.projectRoot)
    
     const storageRoot = this.storageService.getStoragePath(this.projectSlug)
    const indexEntries: Array<{ sourcePath: string; resultPath: string; type: 'file' | 'directory' }> = []

    // 如果是单个文件，直接处理
    if (rootStat.isFile()) {
      let parseResult: FileAnalysis | null = null
      try {
        const content = await fs.readFile(params.projectRoot, 'utf-8')
        const fileHash = createHash('sha256').update(content).digest('hex')
        parseResult = await this.llmAnalysisService.analyzeFile(params.projectRoot, content, fileHash)

        const relativePath = path.basename(params.projectRoot)
        const fileResult: FileAnalysis = {
          ...parseResult,
          path: relativePath,
          commitHash: this.currentCommit
        }

        await this.storageService.saveFileAnalysis(this.projectSlug, relativePath, fileResult)
        completedFiles.push(relativePath)
        params.onProgress?.(1, 1, { path: relativePath })

        const sourceAbsPath = path.resolve(params.projectRoot)
        const resultAbsPath = path.resolve(storageRoot, getFileOutputPath(storageRoot, relativePath))
        indexEntries.push({ sourcePath: sourceAbsPath, resultPath: resultAbsPath, type: 'file' })
      } catch (e: unknown) {
        errors.push({ path: params.projectRoot, message: (e as Error).message })
      }

      const duration = Date.now() - startTime
      const summaryPath = path.join(storageRoot, 'index.md')

      return {
        success: errors.length === 0,
        analyzedFilesCount: completedFiles.length,
        analyzedDirsCount: 0,
        duration,
        errors,
        projectSlug: this.projectSlug,
        summaryPath,
        indexEntries,
        removedSourcePaths: []
      }
    }

    // 递归遍历目录
    const traverseDir = async (dirPath: string, currentDepth: number): Promise<DirectoryAnalysis> => {
      // depth: -1 或 undefined 表示不限制深度；仅当 depth >= 1 时才启用限制
      if (params.depth !== undefined && params.depth >= 1 && currentDepth > params.depth) {
        return {
          type: 'directory',
          path: path.relative(params.projectRoot, dirPath),
          name: path.basename(dirPath),
          description: '超出解析深度限制',
          summary: '超出解析深度限制',
          childrenDirsCount: 0,
          childrenFilesCount: 0,
          structure: [],
          lastAnalyzedAt: new Date().toISOString(),
          commitHash: this.currentCommit
        }
      }

      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const childrenResults: Array<FileAnalysis | DirectoryAnalysis> = []

      const validEntries = entries.filter(entry => {
        if (entry.isDirectory() && entry.name === '.code-analyze-result') {
          return false
        }
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(params.projectRoot, fullPath)
        const key = entry.isDirectory() ? `${relativePath}/` : relativePath
        return !this.blacklistService.isIgnored(key)
      })

      // 并行处理文件
      const fileTasks = validEntries
        .filter(entry => entry.isFile())
        .map(async entry => {
          const filePath = path.join(dirPath, entry.name)
          const relativePath = path.relative(params.projectRoot, filePath)
          const fileObj: AnalysisObject = { type: 'file', path: relativePath }
          params.onObjectPlanned?.(fileObj)
          params.onObjectStarted?.(fileObj)

          try {
            const content = await fs.readFile(filePath, 'utf-8')
            const fileHash = createHash('sha256').update(content).digest('hex')

            // 计算文件级 git 元信息（设计文档 10.3.2 / 13.8），在非 git 场景下安全降级
            const hasGitMeta =
              typeof (this.gitService as any).getFileLastCommit === 'function' &&
              typeof (this.gitService as any).isFileDirty === 'function'
            const fileGitCommitId = hasGitMeta
              ? await this.gitService.getFileLastCommit(params.projectRoot, relativePath)
              : null
            const isDirty = hasGitMeta
              ? await this.gitService.isFileDirty(params.projectRoot, relativePath)
              : false

            const parseResult = await this.llmAnalysisService.analyzeFile(filePath, content, fileHash)
            
            const fileResult: FileAnalysis = {
              ...parseResult,
              path: relativePath,
              commitHash: this.currentCommit,
              fileGitCommitId: fileGitCommitId ?? undefined,
              isDirtyWhenAnalyzed: isDirty,
              fileHashWhenAnalyzed: fileHash
            }

            await this.storageService.saveFileAnalysis(this.projectSlug, relativePath, fileResult)
            completedFiles.push(relativePath)
            params.onObjectCompleted?.(fileObj, { status: 'parsed' })
            const sourceAbsPath = path.resolve(params.projectRoot, relativePath)
            const resultAbsPath = path.resolve(storageRoot, getFileOutputPath(storageRoot, relativePath))
            indexEntries.push({ sourcePath: sourceAbsPath, resultPath: resultAbsPath, type: 'file' })
            return fileResult
          } catch (e: unknown) {
            errors.push({ path: relativePath, message: (e as Error).message })
            const meta: ObjectResultMeta = { status: 'failed', reason: (e as Error).message }
            params.onObjectCompleted?.(fileObj, meta)
            return null
          }
        })

      // 串行处理子目录（避免IO冲突）
      const dirTasks = validEntries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const subDirPath = path.join(dirPath, entry.name)
          const relativePath = path.relative(params.projectRoot, subDirPath)
          const dirObj: AnalysisObject = { type: 'directory', path: relativePath }
          params.onObjectPlanned?.(dirObj)
          params.onObjectStarted?.(dirObj)
          const dirResult = await traverseDir(subDirPath, currentDepth + 1)
          childrenResults.push(dirResult)
          params.onObjectCompleted?.(dirObj, { status: 'parsed' })
          return dirResult
        })

      // 等待所有文件任务完成
      const fileResults = await Promise.all(fileTasks)
      childrenResults.push(...fileResults.filter(Boolean) as FileAnalysis[])

      // 等待所有目录任务完成
      await Promise.all(dirTasks)

      // 生成目录分析结果（目录功能描述与概述通过 LLM 两步协议生成）
      const dirRelativePath = path.relative(params.projectRoot, dirPath)
      const dirName = path.basename(dirPath)

      const fileChildren = childrenResults.filter(child => child.type === 'file') as FileAnalysis[]
      const dirChildren = childrenResults.filter(child => child.type === 'directory') as DirectoryAnalysis[]

      // 构造目录 LLM 所需的子项精简信息
      const childrenDirsPayload = dirChildren.map(d => ({
        name: d.name,
        summary: d.summary,
        description: d.description
      }))
      const childrenFilesPayload = fileChildren.map(f => ({
        name: f.name,
        summary: f.summary,
        description: f.description ?? f.summary
      }))

      let description = ''
      let summary = ''
      try {
        const dirResultFromLLM = await this.llmAnalysisService.analyzeDirectory(childrenDirsPayload, childrenFilesPayload)
        description = dirResultFromLLM.description
        summary = dirResultFromLLM.summary
      } catch (e) {
        // LLM 失败时回退到简易的程序生成描述，避免目录结果缺失
        const segments = dirRelativePath.split(/[/\\]/).filter(Boolean)
        const semanticPath = segments.length > 0 ? segments.join(' / ') : dirName
        const fileCount = fileChildren.length
        const dirCount = dirChildren.length
        const fallback = `该目录「${dirName}」位于路径「${semanticPath}」，包含 ${fileCount} 个文件和 ${dirCount} 个子目录，用于组织与当前模块相关的源代码与子模块。`
        description = fallback
        summary = fallback
      }

      const dirResult: DirectoryAnalysis = {
        type: 'directory',
        path: dirRelativePath,
        name: dirName,
        description,
        summary,
        childrenDirsCount: dirChildren.length,
        childrenFilesCount: fileChildren.length,
        structure: childrenResults.map(child => ({
          name: child.name,
          type: child.type,
          description: child.summary
        })),
        lastAnalyzedAt: new Date().toISOString(),
        commitHash: this.currentCommit
      }

      await this.storageService.saveDirectoryAnalysis(this.projectSlug, dirRelativePath, dirResult)
      completedDirs.push(dirRelativePath)
      const dirSourceAbsPath = path.resolve(params.projectRoot, dirRelativePath)
      const dirResultAbsPath = path.resolve(storageRoot, getDirOutputPath(storageRoot, dirRelativePath))
      indexEntries.push({ sourcePath: dirSourceAbsPath, resultPath: dirResultAbsPath, type: 'directory' })
      return dirResult
    }

    await traverseDir(params.projectRoot, 1)

    const duration = Date.now() - startTime
    const summaryPath = path.join(storageRoot, 'index.md')

    return {
      success: errors.length === 0,
      analyzedFilesCount: completedFiles.length,
      analyzedDirsCount: completedDirs.length,
      duration,
      errors,
      projectSlug: this.projectSlug,
      summaryPath,
      indexEntries,
      removedSourcePaths: []
    }
  }

  async incrementalAnalysis(params: IncrementalAnalysisParams): Promise<AnalysisResult> {
    const startTime = Date.now()
    const errors: Array<{ path: string; message: string }> = []
    const completedFiles: string[] = []
    const completedDirs: string[] = []
    const indexEntries: Array<{ sourcePath: string; resultPath: string; type: 'file' | 'directory' }> = []
    const removedSourcePaths: string[] = []
    const storageRoot = this.storageService.getStoragePath(this.projectSlug)

    for (const filePath of params.changedFiles) {
      const fullPath = path.join(params.projectRoot, filePath)
      const fileObj: AnalysisObject = { type: 'file', path: filePath }
      if (this.blacklistService.isIgnored(filePath)) {
        const meta: ObjectResultMeta = { status: 'filtered' }
        params.onObjectPlanned?.(fileObj)
        params.onObjectCompleted?.(fileObj, meta)
        continue
      }

      params.onObjectPlanned?.(fileObj)
      params.onObjectStarted?.(fileObj)

      const fileExists = await fs.pathExists(fullPath)
      if (!fileExists) {
        removedSourcePaths.push(path.resolve(params.projectRoot, filePath))
        const meta: ObjectResultMeta = { status: 'skipped', reason: 'file removed' }
        params.onObjectCompleted?.(fileObj, meta)
        continue
      }

      try {
        const content = await fs.readFile(fullPath, 'utf-8')
        const fileHash = createHash('sha256').update(content).digest('hex')
        const hasGitMeta =
          typeof (this.gitService as any).getFileLastCommit === 'function' &&
          typeof (this.gitService as any).isFileDirty === 'function'
        const fileGitCommitId = hasGitMeta
          ? await this.gitService.getFileLastCommit(params.projectRoot, filePath)
          : null
        const isDirty = hasGitMeta
          ? await this.gitService.isFileDirty(params.projectRoot, filePath)
          : false

        const old = await this.storageService.getFileAnalysis(this.projectSlug, filePath, 'full')
        let fileResult: FileAnalysis

        if (old) {
          const action = await this.decideFileAction(old, fileGitCommitId, isDirty, fileHash)
          if (action === 'reuse') {
            fileResult = old
          } else if (action === 'meta-only') {
            fileResult = {
              ...old,
              fileGitCommitId: fileGitCommitId ?? undefined,
              isDirtyWhenAnalyzed: false,
              fileHashWhenAnalyzed: fileHash,
              commitHash: params.targetCommit
            }
            await this.storageService.saveFileAnalysis(this.projectSlug, filePath, fileResult)
          } else {
            const parseResult = await this.llmAnalysisService.analyzeFile(fullPath, content, fileHash)
            fileResult = {
              ...parseResult,
              type: 'file',
              path: filePath,
              commitHash: params.targetCommit,
              fileGitCommitId: fileGitCommitId ?? undefined,
              isDirtyWhenAnalyzed: isDirty,
              fileHashWhenAnalyzed: fileHash
            }
            await this.storageService.saveFileAnalysis(this.projectSlug, filePath, fileResult)
          }
        } else {
          const parseResult = await this.llmAnalysisService.analyzeFile(fullPath, content, fileHash)
          fileResult = {
            ...parseResult,
            type: 'file',
            path: filePath,
            commitHash: params.targetCommit,
            fileGitCommitId: fileGitCommitId ?? undefined,
            isDirtyWhenAnalyzed: isDirty,
            fileHashWhenAnalyzed: fileHash
          }
          await this.storageService.saveFileAnalysis(this.projectSlug, filePath, fileResult)
        }

        completedFiles.push(filePath)

        const sourceAbsPath = path.resolve(params.projectRoot, filePath)
        const resultAbsPath = path.resolve(storageRoot, getFileOutputPath(storageRoot, filePath))
        indexEntries.push({ sourcePath: sourceAbsPath, resultPath: resultAbsPath, type: 'file' })
        const meta: ObjectResultMeta = old
          ? { status: 'cached' }
          : { status: 'parsed' }
        params.onObjectCompleted?.(fileObj, meta)
      } catch (e: unknown) {
        errors.push({ path: filePath, message: (e as Error).message })
        const meta: ObjectResultMeta = { status: 'failed', reason: (e as Error).message }
        params.onObjectCompleted?.(fileObj, meta)
      }
    }

    const affectedDirs = [...new Set(params.changedFiles.map(file => {
      const parts = file.split(/[/\\]/)
      return parts.slice(0, -1).join('/')
    }).filter(Boolean))]

    for (const dirPath of affectedDirs) {
      const key = `${dirPath}/`
      if (this.blacklistService.isIgnored(key)) continue

      // 读取该目录下当前已存在的文件/目录分析结果，作为精简输入
      const absoluteDirPath = path.join(params.projectRoot, dirPath)
      const entries = await fs.readdir(absoluteDirPath, { withFileTypes: true })
      const childrenResults: Array<FileAnalysis | DirectoryAnalysis> = []

      for (const entry of entries) {
        const fullPath = path.join(absoluteDirPath, entry.name)
        const rel = path.relative(params.projectRoot, fullPath)
        if (entry.isFile()) {
          const fa = await this.storageService.getFileAnalysis(this.projectSlug, rel, 'summary')
          if (fa) childrenResults.push(fa)
        } else if (entry.isDirectory()) {
          const da = await this.storageService.getDirectoryAnalysis(this.projectSlug, rel, 'summary')
          if (da) childrenResults.push(da)
        }
      }

      const fileChildren = childrenResults.filter(c => c.type === 'file') as FileAnalysis[]
      const dirChildren = childrenResults.filter(c => c.type === 'directory') as DirectoryAnalysis[]

      const childrenDirsPayload = dirChildren.map(d => ({
        name: d.name,
        summary: d.summary,
        description: d.description
      }))
      const childrenFilesPayload = fileChildren.map(f => ({
        name: f.name,
        summary: f.summary,
        description: f.description ?? f.summary
      }))

      let description = ''
      let summary = ''
      try {
        const dirResultFromLLM = await this.llmAnalysisService.analyzeDirectory(childrenDirsPayload, childrenFilesPayload)
        description = dirResultFromLLM.description
        summary = dirResultFromLLM.summary
      } catch {
        const fileCount = fileChildren.length
        const dirCount = dirChildren.length
        const fallback = `该目录包含 ${fileCount} 个文件和 ${dirCount} 个子目录，用于承载本次增量变更相关的代码。`
        description = fallback
        summary = fallback
      }

      const dirResult: DirectoryAnalysis = {
        type: 'directory',
        path: dirPath,
        name: path.basename(dirPath),
        description,
        summary,
        childrenDirsCount: dirChildren.length,
        childrenFilesCount: fileChildren.length,
        structure: childrenResults.map(child => ({
          name: child.name,
          type: child.type,
          description: child.summary
        })),
        lastAnalyzedAt: new Date().toISOString(),
        commitHash: params.targetCommit
      }

      await this.storageService.saveDirectoryAnalysis(this.projectSlug, dirPath, dirResult)
      completedDirs.push(dirPath)

      const dirSourceAbsPath = path.resolve(params.projectRoot, dirPath)
      const dirResultAbsPath = path.resolve(storageRoot, getDirOutputPath(storageRoot, dirPath))
      indexEntries.push({ sourcePath: dirSourceAbsPath, resultPath: dirResultAbsPath, type: 'directory' })
    }

    const duration = Date.now() - startTime
    const summaryPath = path.join(storageRoot, 'index.md')

    return {
      success: errors.length === 0,
      analyzedFilesCount: completedFiles.length,
      analyzedDirsCount: completedDirs.length,
      duration,
      errors,
      projectSlug: this.projectSlug,
      summaryPath,
      indexEntries,
      removedSourcePaths
    }
  }

  async resumeAnalysis(params: ResumeAnalysisParams): Promise<AnalysisResult> {
    // TODO: 实现断点续传逻辑
    throw new AppError(ErrorCode.ANALYSIS_EXCEPTION, '断点续传功能开发中')
  }

  /**
   * 根据历史解析结果 + 当前 git 状态 + 文件哈希，决定是否复用/仅更新元信息/重新解析。
   * 对应需求文档 10.3.4 与设计文档 13.8.2。
   */
  private async decideFileAction(
    old: FileAnalysis,
    currentFileGitCommitId: string | null,
    isDirty: boolean,
    currentHash: string
  ): Promise<'reuse' | 'meta-only' | 'reanalyze'> {
    const oldCommitId = old.fileGitCommitId
    const oldDirty = !!old.isDirtyWhenAnalyzed
    const oldHash = old.fileHashWhenAnalyzed

    // 场景 1：当前 clean，且 commit 与历史一致 && 历史也是 clean → reuse
    if (!isDirty && currentFileGitCommitId && oldCommitId === currentFileGitCommitId && oldDirty === false) {
      return 'reuse'
    }

    // 场景 2：当前 dirty，历史 dirty 且 hash 相同 → reuse
    if (isDirty && oldDirty && oldHash && oldHash === currentHash) {
      return 'reuse'
    }

    // 场景 3：历史 dirty，当前 clean 且 hash 相同 → 只更新元信息
    if (!isDirty && oldDirty && oldHash && oldHash === currentHash && currentFileGitCommitId) {
      return 'meta-only'
    }

    // 其他场景重新解析
    return 'reanalyze'
  }
}
