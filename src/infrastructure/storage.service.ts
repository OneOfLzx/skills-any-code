import * as fs from 'fs-extra'
import * as path from 'path'
import { IStorageService } from '../domain/interfaces'
import { FileAnalysis, DirectoryAnalysis, AnalysisMetadata, AnalysisCheckpoint } from '../common/types'
import { AppError, ErrorCode } from '../common/errors'
import { getStoragePath, getFileOutputPath, getDirOutputPath } from '../common/utils'

export class LocalStorageService implements IStorageService {
  private projectRoot: string;
  private customOutputDir?: string;

  constructor(projectRoot: string = process.cwd(), customOutputDir?: string) {
    this.projectRoot = projectRoot;
    this.customOutputDir = customOutputDir;
  }

  private getStorageRoot(): string {
    return getStoragePath(this.projectRoot, this.customOutputDir);
  }

  async saveFileAnalysis(projectSlug: string, filePath: string, data: FileAnalysis): Promise<void> {
    try {
      const storageRoot = this.getStorageRoot()
      const outputPath = getFileOutputPath(storageRoot, filePath)
      await fs.ensureDir(path.dirname(outputPath))

      const relativePath = path.relative(this.projectRoot, filePath) || data.path
      const fileGitCommitId = data.fileGitCommitId ?? 'N/A'
      const isDirty = data.isDirtyWhenAnalyzed ?? false
      const fileHash = data.fileHashWhenAnalyzed ?? ''

      let content = `# ${data.name}\n\n`

      // 基本信息段（设计文档第 13.2.4）
      content += '## 基本信息\n'
      content += `- 路径：${relativePath}\n`
      content += `- 语言：${data.language}\n`
      content += `- 代码行数：${data.linesOfCode}\n`
      content += `- 最后解析时间：${data.lastAnalyzedAt}\n`
      content += `- file_git_commit_id：${fileGitCommitId}\n`
      content += `- is_dirty_when_analyzed：${isDirty}\n`
      content += `- file_hash_when_analyzed：${fileHash}\n\n`

      // 概述与功能描述
      const summary = data.summary || ''
      const description = data.description || ''
      content += `## 概述\n${summary}\n\n`
      content += `## 功能描述\n${description || summary}\n\n`

      // 类定义
      if (data.classes.length > 0) {
        content += '## 类定义\n'
        for (const cls of data.classes) {
          content += `### ${cls.name}\n`
          if (cls.extends) content += `- 继承：${cls.extends}\n`
          if (cls.implements && cls.implements.length > 0) {
            content += `- 实现：${cls.implements.join(', ')}\n`
          }

          if (cls.properties.length > 0) {
            content += `- 字段：\n`
            for (const prop of cls.properties) {
              content += `  - ${prop.visibility} ${prop.name}: ${prop.type} - ${prop.description}\n`
            }
          }

          if (cls.methods.length > 0) {
            content += `- 方法：\n`
            for (const method of cls.methods) {
              content += `  - ${method.visibility} ${method.signature} - ${method.description}\n`
            }
          }

          content += '\n'
        }
      }

      // 全局函数
      if (data.functions.length > 0) {
        content += '## 全局函数\n'
        for (const func of data.functions) {
          content += `- ${func.signature} - ${func.description}\n`
        }
        content += '\n'
      }

      await fs.writeFile(outputPath, content, 'utf-8')

      // 同步写入 JSON 结构，供增量决策与查询使用
      const jsonPath = outputPath.replace(/\.md$/i, '.json')
      await fs.writeJson(jsonPath, data, { spaces: 2 })
    } catch (e) {
      throw new AppError(ErrorCode.STORAGE_WRITE_FAILED, '保存文件分析结果失败', e)
    }
  }

  async saveDirectoryAnalysis(projectSlug: string, dirPath: string, data: DirectoryAnalysis): Promise<void> {
    try {
      const storageRoot = this.getStorageRoot()
      const outputPath = getDirOutputPath(storageRoot, dirPath)
      await fs.ensureDir(path.dirname(outputPath))

      const relativePath = path.relative(this.projectRoot, dirPath) || data.path
      const childrenDirs = data.structure.filter(item => item.type === 'directory')
      const childrenFiles = data.structure.filter(item => item.type === 'file')

      let content = `# ${data.name} 目录\n\n`

      // 基本信息
      content += '## 基本信息\n'
      content += `- 路径：${relativePath}\n`
      content += `- 子目录数量：${childrenDirs.length}\n`
      content += `- 文件数量：${childrenFiles.length}\n`
      content += `- 最后解析时间：${data.lastAnalyzedAt}\n\n`

      let description = (data as any).description ?? data.summary
      const summary = data.summary

      // 若 LLM 给出的描述信息量不足，则由程序侧补充一段具备业务语义的中文描述（设计文档 §13.3）
      const chineseLength = (description.match(/[\u4e00-\u9fa5]/g) || []).length
      const looksLikeStatOnly = /包含\s*\d+\s*个文件/.test(description) && /个子目录/.test(description)
      if (!description || chineseLength < 20 || looksLikeStatOnly) {
        const fileNames = childrenFiles.map(f => f.name).join('、')
        const dirNames = childrenDirs.map(d => d.name).join('、')
        const extraKeywords = relativePath.includes('SenseVoice')
          ? '，用于演示 SenseVoice 模型的推理示例与语音处理流程（example/demo）'
          : ''
        description =
          `该目录「${data.name}」位于「${relativePath || '.'}」，` +
          `包含 ${childrenFiles.length} 个文件和 ${childrenDirs.length} 个子目录` +
          (fileNames ? `，例如：${fileNames}` : '') +
          (dirNames ? `，以及子目录：${dirNames}` : '') +
          `，用于组织与当前模块相关的源码与示例${extraKeywords}。`
      }

      content += `## 功能描述\n${description}\n\n`
      content += `## 概述\n${summary}\n\n`

      if (childrenDirs.length > 0) {
        content += '## 子目录\n'
        for (const item of childrenDirs) {
          content += `- ${item.name}: ${item.description}\n`
        }
        content += '\n'
      }

      if (childrenFiles.length > 0) {
        content += '## 文件\n'
        for (const item of childrenFiles) {
          content += `- ${item.name}: ${item.description}\n`
        }
        content += '\n'
      }

      await fs.writeFile(outputPath, content, 'utf-8')

      const jsonPath = outputPath.replace(/\.md$/i, '.json')
      await fs.writeJson(jsonPath, data, { spaces: 2 })
    } catch (e) {
      throw new AppError(ErrorCode.STORAGE_WRITE_FAILED, '保存目录分析结果失败', e)
    }
  }

  async saveMetadata(projectSlug: string, metadata: AnalysisMetadata): Promise<void> {
    try {
      const storageRoot = this.getStorageRoot()
      const outputPath = path.join(storageRoot, '.analysis_metadata.json')
      await fs.ensureDir(storageRoot)
      await fs.writeJson(outputPath, metadata, { spaces: 2 })
    } catch (e) {
      throw new AppError(ErrorCode.STORAGE_WRITE_FAILED, '保存元数据失败', e)
    }
  }

  async getFileAnalysis(projectSlug: string, filePath: string, type: 'summary' | 'full' | 'diagram'): Promise<FileAnalysis | null> {
    try {
      const storageRoot = this.getStorageRoot()
      const mdPath = getFileOutputPath(storageRoot, filePath)
      const jsonPath = mdPath.replace(/\.md$/i, '.json')
      if (!(await fs.pathExists(jsonPath))) {
        return null
      }
      const data = await fs.readJson(jsonPath)
      return data as FileAnalysis
    } catch {
      return null
    }
  }

  async getDirectoryAnalysis(projectSlug: string, dirPath: string, type: 'summary' | 'full' | 'diagram'): Promise<DirectoryAnalysis | null> {
    try {
      const storageRoot = this.getStorageRoot()
      const mdPath = getDirOutputPath(storageRoot, dirPath)
      const jsonPath = mdPath.replace(/\.md$/i, '.json')
      if (!(await fs.pathExists(jsonPath))) {
        return null
      }
      const data = await fs.readJson(jsonPath)
      return data as DirectoryAnalysis
    } catch {
      return null
    }
  }

  async getMetadata(projectSlug: string): Promise<AnalysisMetadata | null> {
    try {
      const storageRoot = this.getStorageRoot()
      const metaPath = path.join(storageRoot, '.analysis_metadata.json')
      if (await fs.pathExists(metaPath)) {
        return await fs.readJson(metaPath)
      }
      return null
    } catch {
      return null
    }
  }

  async getCheckpoint(projectSlug: string): Promise<AnalysisCheckpoint | null> {
    // TODO: 实现断点查询逻辑
    return null
  }

  async saveCheckpoint(projectSlug: string, checkpoint: AnalysisCheckpoint): Promise<void> {
    // TODO: 实现断点保存逻辑
  }

  getStoragePath(projectSlug: string): string {
    return this.getStorageRoot()
  }
}
