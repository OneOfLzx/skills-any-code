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
  TokenUsageStats,
} from '../../common/types'
import { AppError, ErrorCode } from '../../common/errors'
import { logger } from '../../common/logger'
import { getFileOutputPath, getDirOutputPath } from '../../common/utils'
import { OpenAIClient } from '../../infrastructure/llm/openai.client'
import { LLMUsageTracker } from '../../infrastructure/llm/llm.usage.tracker'
import { CodeSplitter } from '../../infrastructure/splitter/code.splitter'
import { FileHashCache } from '../../infrastructure/cache/file.hash.cache'
import { LLMAnalysisService } from '../../application/services/llm.analysis.service'
import { WorkerPoolService } from '../../infrastructure/worker-pool/worker-pool.service'
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
    private llmConfig: LLMConfig,
    private readonly onTokenUsageSnapshot?: (stats: TokenUsageStats) => void,
  ) {
    // 初始化LLM相关服务（附带 Token 用量限制，防止单次解析占用过多资源）
    this.tracker = new LLMUsageTracker(this.onTokenUsageSnapshot, llmConfig.max_total_tokens)
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
        // 解析输出目录与内部状态目录一律跳过，避免 .code-analyze-result/.code-analyze-internal 被再次解析
        if (
          entry.isDirectory() &&
          (entry.name === '.code-analyze-result' || entry.name === '.code-analyze-internal')
        ) {
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

    type DirNode = {
      absPath: string
      relPath: string
      depth: number
      childDirs: string[]
      childFiles: string[]
    }

    const depthEnabled = params.depth !== undefined && params.depth >= 1
    const maxDepth = depthEnabled ? (params.depth as number) : Number.POSITIVE_INFINITY

    // 第一步：扫描工程，生成全量任务图（文件解析任务 + 目录聚合任务）
    const dirNodes = new Map<string, DirNode>()
    const fileAbsByRel = new Map<string, string>()

    const rootRel = '.'
    dirNodes.set(rootRel, {
      absPath: params.projectRoot,
      relPath: rootRel,
      depth: 1,
      childDirs: [],
      childFiles: [],
    })

    const queue: Array<{ rel: string; abs: string; depth: number }> = [{ rel: rootRel, abs: params.projectRoot, depth: 1 }]

    while (queue.length > 0) {
      const current = queue.shift()!
      const node = dirNodes.get(current.rel)!

      // depth 限制：到达上限时不再下探，但目录自身仍会作为聚合对象（children 为空）
      if (current.depth > maxDepth) {
        continue
      }

      const entries = await fs.readdir(current.abs, { withFileTypes: true })
      const validEntries = entries
        .filter(entry => {
          if (
            entry.isDirectory() &&
            (entry.name === '.code-analyze-result' || entry.name === '.code-analyze-internal')
          ) {
            return false
          }
          const fullPath = path.join(current.abs, entry.name)
          const relativePath = path.relative(params.projectRoot, fullPath)
          const key = entry.isDirectory() ? `${relativePath}/` : relativePath
          return !this.blacklistService.isIgnored(key)
        })
        .sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of validEntries) {
        const fullPath = path.join(current.abs, entry.name)
        const relPath = path.relative(params.projectRoot, fullPath) || entry.name

        if (entry.isFile()) {
          node.childFiles.push(relPath)
          fileAbsByRel.set(relPath, fullPath)
        } else if (entry.isDirectory()) {
          node.childDirs.push(relPath)
          const childDepth = current.depth + 1
          dirNodes.set(relPath, {
            absPath: fullPath,
            relPath: relPath,
            depth: childDepth,
            childDirs: [],
            childFiles: [],
          })
          // 仍按扫描阶段的先后顺序入队，保证任务队列“最开始就确定”且可复现
          queue.push({ rel: relPath, abs: fullPath, depth: childDepth })
        }
      }
    }

    // 第二步：预排序任务队列（拓扑序 / 叶子优先）
    const plannedFiles = Array.from(fileAbsByRel.keys()).sort((a, b) => a.localeCompare(b))
    const plannedDirs = Array.from(dirNodes.values())
      .sort((a, b) => {
        // 深度更深的目录先聚合（叶子优先）；同深度按路径稳定排序
        if (b.depth !== a.depth) return b.depth - a.depth
        return a.relPath.localeCompare(b.relPath)
      })
      .map(d => d.relPath)

    // “一开始就排好所有对象任务”的生命周期回调（用于 UI / 统计）
    for (const f of plannedFiles) {
      params.onObjectPlanned?.({ type: 'file', path: f })
    }
    for (const d of plannedDirs) {
      params.onObjectPlanned?.({ type: 'directory', path: d })
    }

    // 第三步：线程池消费队列（worker 永远只执行“可执行任务”，避免等待占 worker）
    const workerPool = new WorkerPoolService(this.llmConfig, params.concurrency)

    const fileResults = new Map<string, FileAnalysis>()
    const dirResults = new Map<string, DirectoryAnalysis>()
    const startedDirs = new Set<string>()

    const ensureDirAndAncestorsStarted = (relPath: string) => {
      // 针对文件或目录路径，确保其所有祖先目录（含自身目录节点）在首次参与解析时即进入 active 集合，
      // 以便目录对象的 active 生命周期覆盖其子对象解析全过程（满足深层目录并发退化相关需求）。
      let current = path.dirname(relPath) || '.'
      // path.dirname('.') === '.'，确保根目录也会被处理一次
      while (current && current !== '.' && !dirNodes.has(current)) {
        const parent = path.dirname(current)
        if (!parent || parent === current) break
        current = parent
      }

      while (current) {
        if (dirNodes.has(current) && !startedDirs.has(current)) {
          const dirObj: AnalysisObject = { type: 'directory', path: current }
          params.onObjectStarted?.(dirObj)
          startedDirs.add(current)
        }
        if (current === '.') break
        const parent = path.dirname(current)
        if (!parent || parent === current) break
        current = parent
      }
    }

    try {
      // 目录对象作为长生命周期聚合对象：在文件解析开始前先进入 active 集合，
      // 其 completed 将在对应聚合任务完成后触发。
      for (const dirRel of plannedDirs) {
        if (!startedDirs.has(dirRel)) {
          const dirObj: AnalysisObject = { type: 'directory', path: dirRel }
          params.onObjectStarted?.(dirObj)
          startedDirs.add(dirRel)
        }
      }

      const filePromises = plannedFiles.map(async relPath => {
        const fileObj: AnalysisObject = { type: 'file', path: relPath }
        // 确保所属目录链在首次处理子文件前就进入 active 集合，
        // 使目录对象的 active 时长覆盖子对象解析阶段。
        ensureDirAndAncestorsStarted(relPath)
        params.onObjectStarted?.(fileObj)
        try {
          const absPath = fileAbsByRel.get(relPath)!
          const content = await fs.readFile(absPath, 'utf-8')
          const fileHash = createHash('sha256').update(content).digest('hex')

          const hasGitMeta =
            typeof (this.gitService as any).getFileLastCommit === 'function' &&
            typeof (this.gitService as any).isFileDirty === 'function'
          const fileGitCommitId = hasGitMeta ? await this.gitService.getFileLastCommit(params.projectRoot, relPath) : null
          const isDirty = hasGitMeta ? await this.gitService.isFileDirty(params.projectRoot, relPath) : false

          const workerRes: any = await workerPool.submitFileAnalysisTask(absPath, content, fileHash)
          const parseResult: FileAnalysis = workerRes?.analysis ?? workerRes
          const usage = workerRes?.usage
          // 汇总 worker 返回的 token 用量到主线程 tracker，用于全局上限保护与 UI 展示
          if (usage) {
            this.tracker.addTotals(usage)
          }

          const fileResult: FileAnalysis = {
            ...parseResult,
            path: relPath,
            commitHash: this.currentCommit,
            fileGitCommitId: fileGitCommitId ?? undefined,
            isDirtyWhenAnalyzed: isDirty,
            fileHashWhenAnalyzed: fileHash,
          }

          await this.storageService.saveFileAnalysis(this.projectSlug, relPath, fileResult)
          completedFiles.push(relPath)
          fileResults.set(relPath, fileResult)
          params.onObjectCompleted?.(fileObj, { status: 'parsed' })
          const sourceAbsPath = path.resolve(params.projectRoot, relPath)
          const resultAbsPath = path.resolve(storageRoot, getFileOutputPath(storageRoot, relPath))
          indexEntries.push({ sourcePath: sourceAbsPath, resultPath: resultAbsPath, type: 'file' })
        } catch (e: any) {
          if (e instanceof AppError && e.code === ErrorCode.LLM_TOKEN_LIMIT_EXCEEDED) {
            throw e
          }
          errors.push({ path: relPath, message: (e as Error).message })
          params.onObjectCompleted?.(fileObj, { status: 'failed', reason: (e as Error).message })
        }
      })

      await Promise.all(filePromises)

      // 目录聚合任务：按“叶子优先”深度分组，同一深度内并发执行；
      // 每个目录仅在依赖结果已可用时运行，且其 active 生命周期覆盖子对象解析阶段。
      const dirsByDepth = new Map<number, string[]>()
      for (const dirRel of plannedDirs) {
        const node = dirNodes.get(dirRel)
        if (!node) continue
        const arr = dirsByDepth.get(node.depth) ?? []
        arr.push(dirRel)
        dirsByDepth.set(node.depth, arr)
      }

      const sortedDepths = Array.from(dirsByDepth.keys()).sort((a, b) => b - a)

      for (const depth of sortedDepths) {
        const batch = dirsByDepth.get(depth)!
        await Promise.all(
          batch.map(async dirRel => {
            const dirObj: AnalysisObject = { type: 'directory', path: dirRel }

            const node = dirNodes.get(dirRel)
            if (!node) {
              params.onObjectCompleted?.(dirObj, { status: 'skipped', reason: 'dir node not found' })
              return
            }

            // 若此前因无子文件/子目录从未被启动，则在聚合阶段补充一次 started 回调。
            if (!startedDirs.has(dirRel)) {
              params.onObjectStarted?.(dirObj)
              startedDirs.add(dirRel)
            }

            // depth 超限：输出占位目录结果（与旧逻辑一致）
            if (node.depth > maxDepth) {
              const placeholder: DirectoryAnalysis = {
                type: 'directory',
                path: dirRel,
                name: path.basename(dirRel),
                description: '超出解析深度限制',
                summary: '超出解析深度限制',
                childrenDirsCount: 0,
                childrenFilesCount: 0,
                structure: [],
                lastAnalyzedAt: new Date().toISOString(),
                commitHash: this.currentCommit,
              }
              await this.storageService.saveDirectoryAnalysis(this.projectSlug, dirRel, placeholder)
              dirResults.set(dirRel, placeholder)
              completedDirs.push(dirRel)
              params.onObjectCompleted?.(dirObj, { status: 'parsed' })
              const dirSourceAbsPath = path.resolve(params.projectRoot, dirRel)
              const dirResultAbsPath = path.resolve(storageRoot, getDirOutputPath(storageRoot, dirRel))
              indexEntries.push({ sourcePath: dirSourceAbsPath, resultPath: dirResultAbsPath, type: 'directory' })
              return
            }

            const childResults: Array<FileAnalysis | DirectoryAnalysis> = []
            for (const f of node.childFiles) {
              const fr = fileResults.get(f)
              if (fr) childResults.push(fr)
            }
            for (const d of node.childDirs) {
              const dr = dirResults.get(d)
              if (dr) childResults.push(dr)
            }

            const fileChildren = childResults.filter(c => c.type === 'file') as FileAnalysis[]
            const dirChildren = childResults.filter(c => c.type === 'directory') as DirectoryAnalysis[]

            const childrenDirsPayload = dirChildren.map(d => ({
              name: d.name,
              summary: d.summary,
              description: d.description,
            }))
            const childrenFilesPayload = fileChildren.map(f => ({
              name: f.name,
              summary: f.summary,
              description: f.description ?? f.summary,
            }))

            let description = ''
            let summary = ''
            try {
              const llmRes: any = await workerPool.submitDirectoryAggregationTask(node.absPath, {
                childrenDirs: childrenDirsPayload,
                childrenFiles: childrenFilesPayload,
              })
              // 聚合 worker 返回的 token 用量到主线程 tracker，用于全局上限保护与 UI 展示
              if (llmRes?.usage) {
                this.tracker.addTotals(llmRes.usage)
              }
              description = llmRes.description
              summary = llmRes.summary
            } catch (e: any) {
              if (e instanceof AppError && e.code === ErrorCode.LLM_TOKEN_LIMIT_EXCEEDED) {
                throw e
              }
              const dirName = path.basename(dirRel)
              const fileCount = fileChildren.length
              const dirCount = dirChildren.length
              const fallback = `该目录「${dirName}」包含 ${fileCount} 个文件和 ${dirCount} 个子目录，用于组织与当前模块相关的源代码与子模块。`
              description = fallback
              summary = fallback
            }

            const dirName = path.basename(dirRel)
            const dirResult: DirectoryAnalysis = {
              type: 'directory',
              path: dirRel,
              name: dirName,
              description,
              summary,
              childrenDirsCount: dirChildren.length,
              childrenFilesCount: fileChildren.length,
              structure: childResults.map(child => ({
                name: child.name,
                type: child.type,
                description: child.summary,
              })),
              lastAnalyzedAt: new Date().toISOString(),
              commitHash: this.currentCommit,
            }

            await this.storageService.saveDirectoryAnalysis(this.projectSlug, dirRel, dirResult)
            dirResults.set(dirRel, dirResult)
            completedDirs.push(dirRel)
            params.onObjectCompleted?.(dirObj, { status: 'parsed' })
            const dirSourceAbsPath = path.resolve(params.projectRoot, dirRel)
            const dirResultAbsPath = path.resolve(storageRoot, getDirOutputPath(storageRoot, dirRel))
            indexEntries.push({ sourcePath: dirSourceAbsPath, resultPath: dirResultAbsPath, type: 'directory' })
          }),
        )
      }
    } catch (e: any) {
      // 资源保护：一旦触发 token 上限，立刻取消所有 worker 并将错误上抛给应用层/CLI 做受控退出
      if (typeof (workerPool as any).terminate === 'function') {
        await (workerPool as any).terminate(true).catch(() => {})
      } else {
        workerPool.cancelAll()
      }
      if (e instanceof AppError && e.code === ErrorCode.LLM_TOKEN_LIMIT_EXCEEDED) {
        throw e
      }
      throw e
    } finally {
      // 防御：确保线程池释放
      if (typeof (workerPool as any).terminate === 'function') {
        await (workerPool as any).terminate(true).catch(() => {})
      } else {
        workerPool.cancelAll()
      }
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
