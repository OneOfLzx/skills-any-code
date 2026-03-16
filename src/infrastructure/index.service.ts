import * as fs from 'fs-extra'
import * as path from 'path'
import { IIndexService } from '../domain/interfaces'
import { AnalysisIndex, IndexEntry } from '../common/types'
import { normalizePath } from '../common/utils'

export class IndexService implements IIndexService {
  private getIndexFilePath(storageRoot: string): string {
    return path.join(storageRoot, 'analysis-index.json')
  }

  async buildIndex(
    projectRoot: string,
    storageRoot: string,
    fileEntries: Array<{ sourcePath: string; resultPath: string }>,
    dirEntries: Array<{ sourcePath: string; resultPath: string }>
  ): Promise<void> {
    const entries: Record<string, IndexEntry> = {}

    for (const entry of fileEntries) {
      entries[normalizePath(entry.sourcePath)] = {
        resultPath: normalizePath(entry.resultPath),
        type: 'file',
      }
    }

    for (const entry of dirEntries) {
      entries[normalizePath(entry.sourcePath)] = {
        resultPath: normalizePath(entry.resultPath),
        type: 'directory',
      }
    }

    const indexData: AnalysisIndex = {
      version: '1.0',
      projectRoot: normalizePath(projectRoot),
      storageRoot: normalizePath(storageRoot),
      generatedAt: new Date().toISOString(),
      entries,
    }

    const indexPath = this.getIndexFilePath(storageRoot)
    await fs.ensureDir(path.dirname(indexPath))
    await fs.writeJson(indexPath, indexData, { spaces: 2 })
  }

  async updateIndex(
    storageRoot: string,
    updatedEntries: Array<{ sourcePath: string; resultPath: string; type: 'file' | 'directory' }>,
    removedPaths: string[]
  ): Promise<void> {
    const existing = await this.readIndex(storageRoot)
    if (!existing) {
      throw new Error('索引文件不存在，无法执行增量更新')
    }

    for (const removedPath of removedPaths) {
      delete existing.entries[normalizePath(removedPath)]
    }

    for (const entry of updatedEntries) {
      existing.entries[normalizePath(entry.sourcePath)] = {
        resultPath: normalizePath(entry.resultPath),
        type: entry.type,
      }
    }

    existing.generatedAt = new Date().toISOString()

    const indexPath = this.getIndexFilePath(storageRoot)
    await fs.writeJson(indexPath, existing, { spaces: 2 })
  }

  async readIndex(storageRoot: string): Promise<AnalysisIndex | null> {
    const indexPath = this.getIndexFilePath(storageRoot)
    if (await fs.pathExists(indexPath)) {
      return await fs.readJson(indexPath)
    }
    return null
  }

  async resolve(storageRoot: string, absolutePath: string): Promise<string | null> {
    const indexData = await this.readIndex(storageRoot)
    if (!indexData) return null

    const normalized = normalizePath(absolutePath)
    const entry = indexData.entries[normalized]
    return entry ? entry.resultPath : null
  }
}
