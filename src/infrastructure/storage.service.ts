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
      // 生成Markdown内容（对应测试文档第 13 章 文件级结构约定）
      let content = `# ${data.name}\n\n`
      content += `## 基本信息\n- 语言：${data.language}\n- 代码行数：${data.linesOfCode}\n- 最后解析时间：${data.lastAnalyzedAt}\n- Commit：${data.commitHash}\n\n`
      if (data.description != null && data.description !== '') {
        content += `## 概述\n${data.summary}\n\n`
        content += `## 功能描述\n${data.description}\n\n`
      } else {
        content += `## 功能描述\n${data.summary}\n\n`
      }

      if (data.dependencies.length > 0) {
        content += `## 依赖\n${data.dependencies.map(d => `- ${d}`).join('\n')}\n\n`
      }

      if (data.classes.length > 0) {
        content += `## 类定义\n`
        for (const cls of data.classes) {
          content += `### ${cls.name}\n`
          if (cls.extends) content += `- 继承：${cls.extends}\n`
          if (cls.implements && cls.implements.length > 0) content += `- 实现：${cls.implements.join(', ')}\n`

          content += `#### 属性\n`
          for (const prop of cls.properties) {
            content += `- ${prop.visibility} ${prop.name}: ${prop.type} - ${prop.description}\n`
          }

          content += `#### 方法\n`
          for (const method of cls.methods) {
            content += `- ${method.visibility} ${method.signature} - ${method.description}\n`
          }
          content += '\n'
        }
      }

      if (data.functions.length > 0) {
        content += `## 函数\n`
        for (const func of data.functions) {
          content += `- ${func.signature} - ${func.description}\n`
        }
        content += '\n'
      }

      if (data.classDiagram) {
        content += `## 类图\n\`\`\`mermaid\n${data.classDiagram}\n\`\`\`\n\n`
      }

      if (data.sequenceDiagram) {
        content += `## 时序图\n\`\`\`mermaid\n${data.sequenceDiagram}\n\`\`\`\n`
      }

      await fs.writeFile(outputPath, content, 'utf-8')
    } catch (e) {
      throw new AppError(ErrorCode.STORAGE_WRITE_FAILED, '保存文件分析结果失败', e)
    }
  }

  async saveDirectoryAnalysis(projectSlug: string, dirPath: string, data: DirectoryAnalysis): Promise<void> {
    try {
      const storageRoot = this.getStorageRoot()
      const outputPath = getDirOutputPath(storageRoot, dirPath)
      await fs.ensureDir(path.dirname(outputPath))
      
       let content = `# ${data.name} 目录\n\n`
       content += `## 功能描述\n${data.summary}\n\n`
       content += `## 目录结构\n`
       for (const item of data.structure) {
         content += `- ${item.type === 'directory' ? '📁' : '📄'} ${item.name} - ${item.description}\n`
       }
       content += '\n'
       
       if (data.dependencies.length > 0) {
         content += `## 外部依赖\n${data.dependencies.map(d => `- ${d}`).join('\n')}\n\n`
       }
       
       if (data.moduleDiagram) {
         content += `## 模块关系图\n\`\`\`mermaid\n${data.moduleDiagram}\n\`\`\`\n`
       }
      content += '\n'
      
      if (data.dependencies.length > 0) {
        content += `## 外部依赖\n${data.dependencies.map(d => `- ${d}`).join('\n')}\n\n`
      }
      
      if (data.moduleDiagram) {
        content += `## 模块关系图\n\`\`\`mermaid\n${data.moduleDiagram}\n\`\`\`\n`
      }
      
      await fs.writeFile(outputPath, content, 'utf-8')
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
    // TODO: 实现查询逻辑
    return null
  }

  async getDirectoryAnalysis(projectSlug: string, dirPath: string, type: 'summary' | 'full' | 'diagram'): Promise<DirectoryAnalysis | null> {
    // TODO: 实现查询逻辑
    return null
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
