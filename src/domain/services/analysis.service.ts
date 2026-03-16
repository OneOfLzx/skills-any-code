import * as fs from 'fs-extra'
import * as path from 'path'
import { createHash } from 'crypto'
import { IAnalysisService, IGitService, IStorageService, IBlacklistService } from '../interfaces'
import { FullAnalysisParams, IncrementalAnalysisParams, ResumeAnalysisParams, AnalysisResult, FileAnalysis, DirectoryAnalysis, LLMConfig } from '../../common/types'
import { AppError, ErrorCode } from '../../common/errors'
import { logger } from '../../common/logger'
import { getFileOutputPath, getDirOutputPath } from '../../common/utils'
import { OpenAIClient } from '../../infrastructure/llm/openai.client'
import { CodeSplitter } from '../../infrastructure/splitter/code.splitter'
import { FileHashCache } from '../../infrastructure/cache/file.hash.cache'
import { LLMAnalysisService } from '../../application/services/llm.analysis.service'

export class AnalysisService implements IAnalysisService {
  private llmAnalysisService: LLMAnalysisService

  constructor(
    private gitService: IGitService,
    private storageService: IStorageService,
    private blacklistService: IBlacklistService,
    private projectSlug: string,
    private currentCommit: string,
    private llmConfig: LLMConfig
  ) {
    // 初始化LLM相关服务
    const llmClient = new OpenAIClient(llmConfig);
    const fileSplitter = new CodeSplitter(llmClient);
    const cache = new FileHashCache(llmConfig.cache_dir.replace('~', process.env.HOME || process.env.USERPROFILE || ''));
    this.llmAnalysisService = new LLMAnalysisService(llmClient, fileSplitter, cache, llmConfig);
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
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(projectRoot, fullPath)
        return !this.blacklistService.isIgnored(relativePath)
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

    // 先统计总对象数，供进度回调使用
    const total = await this.countObjects(params.projectRoot, params.depth ?? -1)

    // 递归遍历目录
    const traverseDir = async (dirPath: string, currentDepth: number): Promise<DirectoryAnalysis> => {
      // depth: -1 或 undefined 表示不限制深度；仅当 depth >= 1 时才启用限制
      if (params.depth !== undefined && params.depth >= 1 && currentDepth > params.depth) {
        return {
          type: 'directory',
          path: dirPath,
          name: path.basename(dirPath),
          summary: '超出解析深度限制',
          structure: [],
          dependencies: [],
          moduleDiagram: '',
          lastAnalyzedAt: new Date().toISOString(),
          commitHash: this.currentCommit
        }
      }

      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const childrenResults: Array<FileAnalysis | DirectoryAnalysis> = []

      const validEntries = entries.filter(entry => {
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(params.projectRoot, fullPath)
        return !this.blacklistService.isIgnored(relativePath)
      })

      // 并行处理文件
      const fileTasks = validEntries
        .filter(entry => entry.isFile())
        .map(async entry => {
          const filePath = path.join(dirPath, entry.name)
          const relativePath = path.relative(params.projectRoot, filePath)

          try {
            const content = await fs.readFile(filePath, 'utf-8')
            const fileHash = createHash('sha256').update(content).digest('hex')
            const parseResult = await this.llmAnalysisService.analyzeFile(filePath, content, fileHash)
            
            const fileResult: FileAnalysis = {
              ...parseResult,
              path: relativePath,
              commitHash: this.currentCommit
            }

            await this.storageService.saveFileAnalysis(this.projectSlug, relativePath, fileResult)
            completedFiles.push(relativePath)
            params.onProgress?.(completedFiles.length + completedDirs.length, total, { path: relativePath })
            const sourceAbsPath = path.resolve(params.projectRoot, relativePath)
            const resultAbsPath = path.resolve(storageRoot, getFileOutputPath(storageRoot, relativePath))
            indexEntries.push({ sourcePath: sourceAbsPath, resultPath: resultAbsPath, type: 'file' })
            return fileResult
          } catch (e: unknown) {
            errors.push({ path: relativePath, message: (e as Error).message })
            return null
          }
        })

      // 串行处理子目录（避免IO冲突）
      const dirTasks = validEntries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const subDirPath = path.join(dirPath, entry.name)
          const relativePath = path.relative(params.projectRoot, subDirPath)
          const dirResult = await traverseDir(subDirPath, currentDepth + 1)
          childrenResults.push(dirResult)
          return dirResult
        })

      // 等待所有文件任务完成
      const fileResults = await Promise.all(fileTasks)
      childrenResults.push(...fileResults.filter(Boolean) as FileAnalysis[])

      // 等待所有目录任务完成
      await Promise.all(dirTasks)

      // 生成目录分析结果
      const dirRelativePath = path.relative(params.projectRoot, dirPath)
      const dirName = path.basename(dirPath)
      
      const dirResult: DirectoryAnalysis = {
        type: 'directory',
        path: dirRelativePath,
        name: dirName,
        summary: `${dirName} 目录，包含 ${fileResults.filter(Boolean).length} 个文件，${dirTasks.length} 个子目录`,
        structure: childrenResults.map(child => ({
          name: child.name,
          type: child.type,
          description: child.summary
        })),
        dependencies: Array.from(new Set(childrenResults.flatMap(r => r.dependencies))),
        moduleDiagram: '',
        lastAnalyzedAt: new Date().toISOString(),
        commitHash: this.currentCommit
      }

      await this.storageService.saveDirectoryAnalysis(this.projectSlug, dirRelativePath, dirResult)
      completedDirs.push(dirRelativePath)
      params.onProgress?.(completedFiles.length + completedDirs.length, total, { path: dirRelativePath })
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
      if (this.blacklistService.isIgnored(filePath)) continue

      const fileExists = await fs.pathExists(fullPath)
      if (!fileExists) {
        removedSourcePaths.push(path.resolve(params.projectRoot, filePath))
        continue
      }

      try {
        const content = await fs.readFile(fullPath, 'utf-8')
        const fileHash = createHash('sha256').update(content).digest('hex')
        const parseResult = await this.llmAnalysisService.analyzeFile(fullPath, content, fileHash)

        const fileResult: FileAnalysis = {
          ...parseResult,
          type: 'file',
          path: filePath,
          commitHash: params.targetCommit
        }

        await this.storageService.saveFileAnalysis(this.projectSlug, filePath, fileResult)
        completedFiles.push(filePath)

        const sourceAbsPath = path.resolve(params.projectRoot, filePath)
        const resultAbsPath = path.resolve(storageRoot, getFileOutputPath(storageRoot, filePath))
        indexEntries.push({ sourcePath: sourceAbsPath, resultPath: resultAbsPath, type: 'file' })
      } catch (e: unknown) {
        errors.push({ path: filePath, message: (e as Error).message })
      }
    }

    const affectedDirs = [...new Set(params.changedFiles.map(file => {
      const parts = file.split(/[/\\]/)
      return parts.slice(0, -1).join('/')
    }).filter(Boolean))]

    for (const dirPath of affectedDirs) {
      if (this.blacklistService.isIgnored(dirPath)) continue

      const dirResult: DirectoryAnalysis = {
        type: 'directory',
        path: dirPath,
        name: path.basename(dirPath),
        summary: `目录包含 ${completedFiles.length} 个变更文件`,
        structure: completedFiles.map(file => ({
          name: path.basename(file),
          type: 'file',
          description: '变更文件'
        })),
        dependencies: [],
        moduleDiagram: '',
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
}
