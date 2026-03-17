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
    // 初始化 LLM 相关服务（仅做统计与快照推送，不做 Token 上限拦截）
    this.tracker = new LLMUsageTracker(this.onTokenUsageSnapshot)
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

    /**
     * 返回该目录在“黑名单过滤 + 深度限制”之后是否仍包含可解析内容（文件或非空子目录）。
     * 规则：空目录不计为解析对象（也不应生成任何目录解析结果文件）。
     */
    const walk = async (dirPath: string, currentDepth: number): Promise<boolean> => {
      // depth 限制：到达上限时不再下探；但“空目录不解析”的规则仍成立，
      // 因此这里直接视为“无可解析内容”，从而不计入 count。
      if (depth >= 1 && currentDepth > depth) {
        return false
      }

      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const valid = entries.filter(entry => {
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(projectRoot, fullPath)
        const key = entry.isDirectory() ? `${relativePath}/` : relativePath
        return !this.blacklistService.isIgnored(key)
      })

      let hasContent = false
      for (const entry of valid) {
        if (entry.isFile()) {
          count++
          hasContent = true
          continue
        }
        if (entry.isDirectory()) {
          const childHas = await walk(path.join(dirPath, entry.name), currentDepth + 1)
          if (childHas) {
            hasContent = true
          }
        }
      }

      if (hasContent) {
        // 仅在目录包含可解析内容时，才将目录自身计为一个对象
        count++
      }
      return hasContent
    }

    await walk(projectRoot, 1)
    return count
  }

  async fullAnalysis(params: FullAnalysisParams): Promise<AnalysisResult> {
    const startTime = Date.now()
    const errors: Array<{ path: string; message: string }> = []
    const completedFiles: string[] = []
    const completedDirs: string[] = []
    let plannedParseableFileCount = 0
    let plannedParseableDirCount = 0

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

    const queue: Array<{ rel: string; abs: string; depth: number }> = [
      { rel: rootRel, abs: params.projectRoot, depth: 1 },
    ]

    const scanConcurrency = Math.max(1, Math.min(8, os.cpus()?.length || 4))

    const processDir = async (current: { rel: string; abs: string; depth: number }) => {
      const node = dirNodes.get(current.rel)
      if (!node) return

      // depth 限制：到达上限时不再下探，但目录自身仍会作为聚合对象（children 为空）
      if (current.depth > maxDepth) {
        return
      }

      const entries = await fs.readdir(current.abs, { withFileTypes: true })
      const validEntries = entries
        .filter(entry => {
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
          plannedParseableFileCount++
          const totalPlannedObjects = plannedParseableFileCount + plannedParseableDirCount
          if (totalPlannedObjects % 10 === 0) {
            params.onScanProgress?.(totalPlannedObjects)
          }
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

    const runScanQueue = async () => {
      const workers = Array.from({ length: scanConcurrency }, async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const current = queue.shift()
          if (!current) return
          await processDir(current)
        }
      })
      await Promise.all(workers)
    }

    await runScanQueue()

    // 目录剪枝：空目录（在过滤与深度限制后无任何可解析子项）不进入解析队列，也不生成目录解析文件。
    // 这一步会自底向上移除空目录，并同步修正父目录的 childDirs 列表。
    const allScannedDirs = Array.from(dirNodes.values())
    const scannedDirsByDepthDesc = allScannedDirs
      .slice()
      .sort((a, b) => {
        if (b.depth !== a.depth) return b.depth - a.depth
        return a.relPath.localeCompare(b.relPath)
      })

    const keptDirs = new Set<string>()
    for (const d of scannedDirsByDepthDesc) {
      // depth 超限的目录：旧逻辑会生成占位目录结果；按“空目录不解析”新规则，这里也不生成任何目录结果。
      // 由于扫描阶段 current.depth > maxDepth 已 continue，超限目录的 child 列表会为空，从而自然被剪枝掉。
      const node = dirNodes.get(d.relPath)
      if (!node) continue
      node.childDirs = node.childDirs.filter(child => keptDirs.has(child))
      const hasContent = node.childFiles.length > 0 || node.childDirs.length > 0
      if (hasContent) {
        keptDirs.add(d.relPath)
        plannedParseableDirCount++
        const totalPlannedObjects = plannedParseableFileCount + plannedParseableDirCount
        if (totalPlannedObjects % 10 === 0) {
          params.onScanProgress?.(totalPlannedObjects)
        }
      }
    }

    // 同步清理被剪枝目录对应的旧结果文件（避免历史残留导致“看起来像生成过”）
    const prunedDirs = allScannedDirs
      .map(d => d.relPath)
      .filter(rel => !keptDirs.has(rel))

    for (const rel of prunedDirs) {
      // 根目录 '.' 不存在单独的目录结果文件，无需清理
      if (rel === '.') continue
      const out = getDirOutputPath(storageRoot, rel)
      if (await fs.pathExists(out)) {
        await fs.remove(out)
      }
    }

    // 第二步：预排序任务队列（拓扑序 / 叶子优先）
    const plannedFiles = Array.from(fileAbsByRel.keys()).sort((a, b) => a.localeCompare(b))
    const plannedDirs = Array.from(dirNodes.values())
      .filter(d => keptDirs.has(d.relPath))
      .sort((a, b) => {
        // 深度更深的目录先聚合（叶子优先）；同深度按路径稳定排序
        if (b.depth !== a.depth) return b.depth - a.depth
        return a.relPath.localeCompare(b.relPath)
      })
      .map(d => d.relPath)

    const finalTotalPlannedObjects = plannedParseableFileCount + plannedParseableDirCount
    if (finalTotalPlannedObjects > 0 && finalTotalPlannedObjects % 10 !== 0) {
      params.onScanProgress?.(finalTotalPlannedObjects)
    }

    // “一开始就排好所有对象任务”的生命周期回调（用于 UI / 统计）
    for (const f of plannedFiles) {
      params.onObjectPlanned?.({ type: 'file', path: f })
    }
    for (const d of plannedDirs) {
      params.onObjectPlanned?.({ type: 'directory', path: d })
    }

    // 第三步：线程池消费队列
    // 重要：这里显式做并发闸门，避免把大量任务提前堆进 workerpool 队列，
    // 从而使「当前对象」严格等价于“正在 worker 中执行”的 in-flight 集合（不包含排队任务）。
    const workerPool = new WorkerPoolService(this.llmConfig, params.concurrency)

    const fileResults = new Map<string, FileAnalysis>()
    const dirResults = new Map<string, DirectoryAnalysis>()

    async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
      const concurrency = Math.max(1, Number(limit) || 1)
      let nextIndex = 0
      const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
          const idx = nextIndex++
          if (idx >= items.length) return
          await fn(items[idx])
        }
      })
      await Promise.all(runners)
    }

    try {
      await mapLimit(plannedFiles, params.concurrency, async (relPath) => {
        const fileObj: AnalysisObject = { type: 'file', path: relPath }
        try {
          const absPath = fileAbsByRel.get(relPath)!
          const content = await fs.readFile(absPath, 'utf-8')
          const fileHash = createHash('sha256').update(content).digest('hex')

          const hasGitMeta =
            typeof (this.gitService as any).getFileLastCommit === 'function' &&
            typeof (this.gitService as any).isFileDirty === 'function'
          const fileGitCommitId = hasGitMeta ? await this.gitService.getFileLastCommit(params.projectRoot, relPath) : null
          const isDirty = hasGitMeta ? await this.gitService.isFileDirty(params.projectRoot, relPath) : false

          // 仅在真正提交到 worker 前标记 started，使「当前对象」严格反映 worker in-flight。
          params.onObjectStarted?.(fileObj)
          const workerRes: any = await workerPool.submitFileAnalysisTask(absPath, content, fileHash)
          const parseResult: FileAnalysis = workerRes?.analysis ?? workerRes
          const usage = workerRes?.usage
          // 汇总 worker 返回的 token 用量到主线程 tracker，用于 UI 展示
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
          errors.push({ path: relPath, message: (e as Error).message })
          params.onObjectCompleted?.(fileObj, { status: 'failed', reason: (e as Error).message })
        }
      })

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
        await mapLimit(batch, params.concurrency, async (dirRel) => {
            const dirObj: AnalysisObject = { type: 'directory', path: dirRel }

            const node = dirNodes.get(dirRel)
            if (!node) {
              params.onObjectCompleted?.(dirObj, { status: 'skipped', reason: 'dir node not found' })
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

            // 空目录（过滤/深度限制后无任何可解析内容）不生成目录解析文件。
            if (fileChildren.length === 0 && dirChildren.length === 0) {
              // 若历史上曾生成过该目录的结果文件，则清理掉
              const out = getDirOutputPath(storageRoot, dirRel)
              if (await fs.pathExists(out)) {
                await fs.remove(out)
              }
              params.onObjectCompleted?.(dirObj, { status: 'skipped', reason: 'empty directory' })
              return
            }

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

            // 仅在真正提交到 worker 前标记 started，使「当前对象」严格反映 worker in-flight。
            params.onObjectStarted?.(dirObj)

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

            try {
              await this.storageService.saveDirectoryAnalysis(this.projectSlug, dirRel, dirResult)
              dirResults.set(dirRel, dirResult)
              const dirSourceAbsPath = path.resolve(params.projectRoot, dirRel)
              const dirResultAbsPath = path.resolve(storageRoot, getDirOutputPath(storageRoot, dirRel))
              indexEntries.push({ sourcePath: dirSourceAbsPath, resultPath: dirResultAbsPath, type: 'directory' })
              completedDirs.push(dirRel)
              params.onObjectCompleted?.(dirObj, { status: 'parsed' })
            } catch (e: any) {
              const msg = (e as Error)?.message ?? String(e)
              errors.push({ path: dirRel, message: msg })
              params.onObjectCompleted?.(dirObj, { status: 'failed', reason: msg })
              return
            }

            // 内存回收：目录聚合完成后，其直接子项结果对更上层目录已不再必要。
            // 上层目录只依赖该目录自身的 summary/description，因此可以安全释放子文件/子目录结果，
            // 避免 fullAnalysis 在大项目下因结果常驻 Map 而导致内存线性增长。
            for (const f of node.childFiles) {
              fileResults.delete(f)
            }
            for (const d of node.childDirs) {
              dirResults.delete(d)
            }
          })
      }
    } catch (e: any) {
      // 防御：出现异常时尽快取消 worker，避免遗留线程占用资源
      if (typeof (workerPool as any).terminate === 'function') {
        await (workerPool as any).terminate(true).catch(() => {})
      } else {
        workerPool.cancelAll()
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

    let scannedObjects = 0

    async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
      const concurrency = Math.max(1, Number(limit) || 1)
      let nextIndex = 0
      const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
          const idx = nextIndex++
          if (idx >= items.length) return
          await fn(items[idx])
        }
      })
      await Promise.all(runners)
    }

    // 并发处理文件级增量对象
    await mapLimit(params.changedFiles, params.concurrency, async (filePath) => {
      const fullPath = path.join(params.projectRoot, filePath)
      const fileObj: AnalysisObject = { type: 'file', path: filePath }

      scannedObjects++
      if (scannedObjects % 10 === 0) {
        params.onScanProgress?.(scannedObjects)
      }

      if (this.blacklistService.isIgnored(filePath)) {
        const meta: ObjectResultMeta = { status: 'filtered' }
        params.onObjectPlanned?.(fileObj)
        params.onObjectCompleted?.(fileObj, meta)
        return
      }

      params.onObjectPlanned?.(fileObj)
      params.onObjectStarted?.(fileObj)

      const fileExists = await fs.pathExists(fullPath)
      if (!fileExists) {
        removedSourcePaths.push(path.resolve(params.projectRoot, filePath))
        const meta: ObjectResultMeta = { status: 'skipped', reason: 'file removed' }
        params.onObjectCompleted?.(fileObj, meta)
        return
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
              commitHash: params.targetCommit,
              lastAnalyzedAt: new Date().toISOString(),
            }
            if (typeof (this.storageService as any).patchFileResultMarkdown === 'function') {
              await (this.storageService as any).patchFileResultMarkdown(filePath, {
                fileGitCommitId: fileGitCommitId ?? undefined,
                isDirtyWhenAnalyzed: false,
                fileHashWhenAnalyzed: fileHash,
                lastAnalyzedAt: fileResult.lastAnalyzedAt,
              })
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
              fileHashWhenAnalyzed: fileHash,
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
            fileHashWhenAnalyzed: fileHash,
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
    })

    const affectedDirsFromFiles = params.changedFiles
      .map(file => {
        const parts = file.split(/[/\\]/)
        return parts.slice(0, -1).join('/')
      })
      .filter(Boolean)

    const affectedDirs = [
      ...new Set<string>([
        ...affectedDirsFromFiles,
        ...(params.changedDirs ?? []),
      ]),
    ]

    // 并发处理目录聚合任务
    await mapLimit(affectedDirs, params.concurrency, async (dirPath) => {
      const dirObj: AnalysisObject = { type: 'directory', path: dirPath }

      scannedObjects++
      if (scannedObjects % 10 === 0) {
        params.onScanProgress?.(scannedObjects)
      }

      const key = `${dirPath}/`
      if (this.blacklistService.isIgnored(key)) {
        const meta: ObjectResultMeta = { status: 'filtered' }
        params.onObjectPlanned?.(dirObj)
        params.onObjectCompleted?.(dirObj, meta)
        return
      }

      params.onObjectPlanned?.(dirObj)

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

      // 空目录（在当前过滤规则下没有任何可解析子项结果）不生成目录解析文件；
      // 若历史上已有目录结果，则同时清理并从索引中移除。
      if (fileChildren.length === 0 && dirChildren.length === 0) {
        const sourceAbsPath = path.resolve(params.projectRoot, dirPath)
        removedSourcePaths.push(sourceAbsPath)
        const out = getDirOutputPath(storageRoot, dirPath)
        if (await fs.pathExists(out)) {
          await fs.remove(out)
        }
        const meta: ObjectResultMeta = { status: 'skipped', reason: 'empty directory' }
        params.onObjectCompleted?.(dirObj, meta)
        return
      }

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

      params.onObjectStarted?.(dirObj)

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

      try {
        completedDirs.push(dirPath)
        await this.storageService.saveDirectoryAnalysis(this.projectSlug, dirPath, dirResult)
        const dirSourceAbsPath = path.resolve(params.projectRoot, dirPath)
        const dirResultAbsPath = path.resolve(storageRoot, getDirOutputPath(storageRoot, dirPath))
        indexEntries.push({ sourcePath: dirSourceAbsPath, resultPath: dirResultAbsPath, type: 'directory' })
        const meta: ObjectResultMeta = { status: 'parsed' }
        params.onObjectCompleted?.(dirObj, meta)
      } catch (e: any) {
        errors.push({ path: dirPath, message: (e as Error)?.message ?? String(e) })
        const meta: ObjectResultMeta = { status: 'failed', reason: (e as Error)?.message ?? String(e) }
        params.onObjectCompleted?.(dirObj, meta)
      }
    })

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
