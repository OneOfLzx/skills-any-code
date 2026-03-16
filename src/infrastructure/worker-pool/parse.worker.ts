import * as workerpool from 'workerpool'
import * as path from 'path'
import { FileAnalysis, DirectoryAnalysis, ModificationLog, LLMConfig } from '../../common/types'
import { OpenAIClient } from '../llm/openai.client'
import { CodeSplitter } from '../splitter/code.splitter'
import { FileHashCache } from '../cache/file.hash.cache'
import { LLMAnalysisService } from '../../application/services/llm.analysis.service'
import * as crypto from 'crypto'

async function parseFile(
  filePath: string,
  fileContent: string,
  fileHash: string,
  language?: string,
  llmConfig?: LLMConfig
): Promise<FileAnalysis> {
  if (!llmConfig) {
    throw new Error('LLM config is required for file parsing')
  }

  // 初始化LLM相关服务
  const llmClient = new OpenAIClient(llmConfig)
  const fileSplitter = new CodeSplitter(llmClient)
  const cache = new FileHashCache({
    cacheDir: llmConfig.cache_dir,
    maxSizeMb: llmConfig.cache_max_size_mb,
  })
  const llmAnalysisService = new LLMAnalysisService(llmClient, fileSplitter, cache, llmConfig)

  const result = await llmAnalysisService.analyzeFile(filePath, fileContent, fileHash)
  return result
}

async function aggregateDirectory(dirPath: string, childrenResults: Array<FileAnalysis | DirectoryAnalysis>): Promise<DirectoryAnalysis> {
  const name = path.basename(dirPath)
  const fileChildren = childrenResults.filter(c => c.type === 'file') as FileAnalysis[]
  const dirChildren = childrenResults.filter(c => c.type === 'directory') as DirectoryAnalysis[]

  const description = `该目录包含 ${fileChildren.length} 个文件和 ${dirChildren.length} 个子目录，用于组织相关源码与子模块。`
  const summary = `包含 ${childrenResults.length} 个子项的目录`

  const structure = childrenResults.map(child => ({
    name: child.name,
    type: child.type,
    description: child.summary.substring(0, 100)
  }))

  return {
    type: 'directory',
    path: dirPath,
    name,
    description,
    summary,
    childrenDirsCount: dirChildren.length,
    childrenFilesCount: fileChildren.length,
    structure,
    lastAnalyzedAt: new Date().toISOString(),
    commitHash: ''
  }
}

async function validateResult(parentResult: DirectoryAnalysis, childResult: FileAnalysis | DirectoryAnalysis): Promise<{
  valid: boolean
  corrections?: Partial<FileAnalysis | DirectoryAnalysis>
  log?: ModificationLog
}> {
  // 简单的校验逻辑：检查子项是否在父项的结构中存在
  const existsInStructure = parentResult.structure.some(item => item.name === childResult.name)
  const corrections: Partial<FileAnalysis | DirectoryAnalysis> = {}
  let log: ModificationLog | undefined

  if (!existsInStructure) {
    // 修正：将子项添加到父项的结构中
    (corrections as Partial<DirectoryAnalysis>).structure = [
      ...parentResult.structure,
      {
        name: childResult.name,
        type: childResult.type,
        description: childResult.summary.substring(0, 100)
      }
    ]

    log = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      path: parentResult.path,
      type: 'omission',
      originalContent: JSON.stringify(parentResult.structure),
      correctedContent: JSON.stringify((corrections as Partial<DirectoryAnalysis>).structure),
      reason: `Child item ${childResult.name} missing from directory structure`
    }

    return {
      valid: false,
      corrections,
      log
    }
  }

  return { valid: true }
}

// 注册Worker方法
workerpool.worker({
  parseFile,
  aggregateDirectory,
  validateResult
})