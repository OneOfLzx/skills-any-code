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
  const cache = new FileHashCache(llmConfig.cache_dir)
  const llmAnalysisService = new LLMAnalysisService(llmClient, fileSplitter, cache, llmConfig)

  const result = await llmAnalysisService.analyzeFile(filePath, fileContent, fileHash)
  return result
}

async function aggregateDirectory(dirPath: string, childrenResults: Array<FileAnalysis | DirectoryAnalysis>): Promise<DirectoryAnalysis> {
  const name = path.basename(dirPath)
  
  // 计算目录依赖
  const allDependencies = new Set<string>()
  childrenResults.forEach(child => {
    child.dependencies.forEach(dep => allDependencies.add(dep))
  })

  // 生成目录结构
  const structure = childrenResults.map(child => ({
    name: child.name,
    type: child.type,
    description: child.summary.substring(0, 100)
  }))

  // 生成模块图
  let moduleDiagram = '```mermaid\nflowchart LR\n'
  childrenResults.forEach((child, index) => {
    moduleDiagram += `  node${index}[${child.name}]:::${child.type}\n`
  })
  moduleDiagram += '  classDef file fill:#f9f,stroke:#333,stroke-width:2px\n'
  moduleDiagram += '  classDef directory fill:#9f9,stroke:#333,stroke-width:2px\n'
  moduleDiagram += '```'

  return {
    type: 'directory',
    path: dirPath,
    name,
    summary: `Directory containing ${childrenResults.length} items`,
    structure,
    dependencies: Array.from(allDependencies),
    moduleDiagram,
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

  // 检查依赖一致性
  const childDependencies = new Set(childResult.dependencies)
  const parentDependencies = new Set(parentResult.dependencies)
  const missingDependencies = Array.from(childDependencies).filter(dep => !parentDependencies.has(dep))

  if (missingDependencies.length > 0) {
    // 修正：将缺失的依赖添加到父项
    corrections.dependencies = [
      ...parentResult.dependencies,
      ...missingDependencies
    ]

    log = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      path: parentResult.path,
      type: 'inconsistency',
      originalContent: JSON.stringify(parentResult.dependencies),
      correctedContent: JSON.stringify(corrections.dependencies),
      reason: `Missing dependencies in parent directory: ${missingDependencies.join(', ')}`
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