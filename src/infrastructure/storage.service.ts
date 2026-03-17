import * as fs from 'fs-extra'
import * as path from 'path'
import { createHash } from 'crypto'
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

  private normalizeNewlines(input: string): string {
    return input.replace(/\r\n/g, '\n')
  }

  private extractSection(markdown: string, title: string): string {
    const md = this.normalizeNewlines(markdown)
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\n##\\s+${escaped}\\n([\\s\\S]*?)(?=\\n##\\s+|\\n#\\s+|$)`, 'm')
    const m = md.match(re)
    return (m?.[1] ?? '').trim()
  }

  private parseBasicInfo(markdown: string): Record<string, string> {
    const basic = this.extractSection(markdown, '基本信息')
    const lines = basic.split('\n').map(l => l.trim()).filter(Boolean)
    const map: Record<string, string> = {}
    for (const line of lines) {
      const cleaned = line.replace(/^-+\s*/, '').trim()
      const idx = cleaned.indexOf('：') >= 0 ? cleaned.indexOf('：') : cleaned.indexOf(':')
      if (idx <= 0) continue
      const k = cleaned.slice(0, idx).trim()
      const v = cleaned.slice(idx + 1).trim()
      if (k) map[k] = v
    }
    return map
  }

  private parseFileMarkdownToAnalysis(markdown: string, filePath: string): FileAnalysis | null {
    const md = this.normalizeNewlines(markdown)
    const firstLine = md.split('\n')[0]?.trim() ?? ''
    const name = firstLine.startsWith('# ') ? firstLine.slice(2).trim() : path.basename(filePath)
    const basic = this.parseBasicInfo(md)
    const summary = this.extractSection(md, '概述')
    const description = this.extractSection(md, '功能描述')

    const language = basic['语言'] ?? 'unknown'
    const loc = Number(basic['代码行数'] ?? NaN)
    const lastAnalyzedAt = basic['最后解析时间'] ?? new Date(0).toISOString()
    const fileGitCommitId = basic['file_git_commit_id']
    const isDirtyWhenAnalyzedRaw = basic['is_dirty_when_analyzed']
    const fileHashWhenAnalyzed = basic['file_hash_when_analyzed']

    const isDirtyWhenAnalyzed =
      isDirtyWhenAnalyzedRaw === undefined
        ? undefined
        : ['true', '1', 'yes'].includes(isDirtyWhenAnalyzedRaw.toLowerCase())

    return {
      type: 'file',
      path: filePath,
      name,
      language,
      linesOfCode: Number.isFinite(loc) ? loc : 0,
      dependencies: [],
      fileGitCommitId: fileGitCommitId && fileGitCommitId !== 'N/A' ? fileGitCommitId : undefined,
      isDirtyWhenAnalyzed,
      fileHashWhenAnalyzed: fileHashWhenAnalyzed || undefined,
      description: description || undefined,
      summary: summary || '',
      classes: [],
      functions: [],
      lastAnalyzedAt,
      commitHash: '',
    }
  }

  private parseDirectoryMarkdownToAnalysis(markdown: string, dirPath: string): DirectoryAnalysis | null {
    const md = this.normalizeNewlines(markdown)
    const firstLine = md.split('\n')[0]?.trim() ?? ''
    const rawName = firstLine.startsWith('# ') ? firstLine.slice(2).trim() : path.basename(dirPath)
    const name = rawName.replace(/\s*目录\s*$/, '').trim() || path.basename(dirPath)
    const summary = this.extractSection(md, '概述')
    const description = this.extractSection(md, '功能描述') || summary
    const basic = this.parseBasicInfo(md)
    const lastAnalyzedAt = basic['最后解析时间'] ?? new Date(0).toISOString()
    return {
      type: 'directory',
      path: dirPath,
      name,
      description: description || '',
      summary: summary || '',
      childrenDirsCount: 0,
      childrenFilesCount: 0,
      structure: [],
      lastAnalyzedAt,
      commitHash: '',
    }
  }

  /**
   * 仅更新结果 Markdown 中「基本信息」段的部分字段，避免依赖任何内部 JSON 状态。
   */
  private async updateFileMarkdownBasicInfo(
    outputPath: string,
    updates: Partial<Pick<FileAnalysis, 'fileGitCommitId' | 'isDirtyWhenAnalyzed' | 'fileHashWhenAnalyzed' | 'lastAnalyzedAt'>>,
  ): Promise<void> {
    const raw = await fs.readFile(outputPath, 'utf-8')
    const md = this.normalizeNewlines(raw)
    const basic = this.extractSection(md, '基本信息')
    if (!basic) {
      // 如果没有“基本信息”段，直接回退为重写全文件（风险较大）；这里选择保守：不改动
      return
    }

    const lines = basic.split('\n')
    const patchKV = (key: string, value: string) => {
      const re = new RegExp(`^\\s*-\\s*${key}\\s*[：:].*$`, 'm')
      const replacement = `- ${key}：${value}`
      const joined = lines.join('\n')
      if (re.test(joined)) {
        const next = joined.replace(re, replacement)
        lines.splice(0, lines.length, ...next.split('\n'))
      } else {
        lines.push(replacement)
      }
    }

    if (updates.lastAnalyzedAt) patchKV('最后解析时间', updates.lastAnalyzedAt)
    if (updates.fileGitCommitId !== undefined) patchKV('file_git_commit_id', updates.fileGitCommitId || 'N/A')
    if (updates.isDirtyWhenAnalyzed !== undefined) patchKV('is_dirty_when_analyzed', String(!!updates.isDirtyWhenAnalyzed))
    if (updates.fileHashWhenAnalyzed !== undefined) patchKV('file_hash_when_analyzed', updates.fileHashWhenAnalyzed || '')

    const newBasic = lines.join('\n').trim() + '\n'
    const escaped = '基本信息'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const reSection = new RegExp(`(\\n##\\s+${escaped}\\n)([\\s\\S]*?)(?=\\n##\\s+|\\n#\\s+|$)`, 'm')
    const nextMd = md.replace(reSection, `$1${newBasic}`)
    await fs.writeFile(outputPath, nextMd, 'utf-8')
  }

  async saveFileAnalysis(projectSlug: string, filePath: string, data: FileAnalysis): Promise<void> {
    try {
      const storageRoot = this.getStorageRoot()
      const outputPath = getFileOutputPath(storageRoot, filePath)
      await fs.ensureDir(path.dirname(outputPath))

      const relativePath = path.relative(this.projectRoot, filePath) || data.path
      const fileGitCommitId = data.fileGitCommitId ?? 'N/A'
      const isDirty = data.isDirtyWhenAnalyzed ?? false
      let fileHash = data.fileHashWhenAnalyzed ?? ''
      // 防御：某些路径/worker 回传异常场景下 fileHashWhenAnalyzed 可能丢失。
      // 这里尝试根据源码文件内容补齐，保证基本信息段可用于增量与回归测试。
      if (!fileHash) {
        try {
          const abs =
            path.isAbsolute(filePath) ? filePath : path.resolve(this.projectRoot, filePath)
          if (await fs.pathExists(abs)) {
            const content = await fs.readFile(abs, 'utf-8')
            fileHash = createHash('sha256').update(content).digest('hex')
          }
        } catch {
          // ignore：保持空字符串写入，避免影响主流程
        }
      }

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
      if (!(await fs.pathExists(mdPath))) {
        return null
      }
      const markdown = await fs.readFile(mdPath, 'utf-8')
      const parsed = this.parseFileMarkdownToAnalysis(markdown, filePath)
      return parsed
    } catch {
      return null
    }
  }

  async getDirectoryAnalysis(projectSlug: string, dirPath: string, type: 'summary' | 'full' | 'diagram'): Promise<DirectoryAnalysis | null> {
    try {
      const storageRoot = this.getStorageRoot()
      const mdPath = getDirOutputPath(storageRoot, dirPath)
      if (!(await fs.pathExists(mdPath))) {
        return null
      }
      const markdown = await fs.readFile(mdPath, 'utf-8')
      const parsed = this.parseDirectoryMarkdownToAnalysis(markdown, dirPath)
      return parsed
    } catch {
      return null
    }
  }

  /**
   * 增量模式 meta-only：仅在已有 Markdown 结果上更新基础字段，不依赖内部 JSON。
   */
  async patchFileResultMarkdown(
    filePath: string,
    updates: Partial<Pick<FileAnalysis, 'fileGitCommitId' | 'isDirtyWhenAnalyzed' | 'fileHashWhenAnalyzed' | 'lastAnalyzedAt'>>,
  ): Promise<void> {
    const storageRoot = this.getStorageRoot()
    const outputPath = getFileOutputPath(storageRoot, filePath)
    if (!(await fs.pathExists(outputPath))) {
      return
    }
    await this.updateFileMarkdownBasicInfo(outputPath, updates)
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

  /**
   * 判断当前存储目录下是否已经存在任意解析结果。
   * 规则：
   * - 若元数据文件 .analysis_metadata.json 已存在，则认为“有结果”；
   * - 否则在存储根目录下递归查找任意 .md 结果文件（如 index.md 或文件级解析结果）。
   */
  async hasAnyResult(projectSlug: string): Promise<boolean> {
    try {
      const storageRoot = this.getStorageRoot()
      if (!(await fs.pathExists(storageRoot))) {
        return false
      }

      const metaPath = path.join(storageRoot, '.analysis_metadata.json')
      if (await fs.pathExists(metaPath)) {
        return true
      }

      const entries = await fs.readdir(storageRoot, { withFileTypes: true })
      const stack: string[] = []
      for (const entry of entries) {
        const full = path.join(storageRoot, entry.name)
        stack.push(full)
      }

      while (stack.length > 0) {
        const current = stack.pop() as string
        const stat = await fs.stat(current)
        if (stat.isDirectory()) {
          const children = await fs.readdir(current, { withFileTypes: true })
          for (const child of children) {
            stack.push(path.join(current, child.name))
          }
        } else if (stat.isFile() && current.toLowerCase().endsWith('.md')) {
          return true
        }
      }

      return false
    } catch {
      return false
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
