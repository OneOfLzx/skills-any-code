import * as crypto from 'crypto'
import * as path from 'path'

/**
 * 规范化路径：统一使用正斜杠、移除尾部斜杠
 * 用于索引文件中的路径标准化和 resolve 查询时的路径匹配
 */
export function normalizePath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

export function generateProjectSlug(projectRoot: string, isGit: boolean, gitSlug?: string): string {
  if (isGit && gitSlug) {
    return gitSlug.replace('/', '-')
  }
  const dirName = path.basename(projectRoot)
  const pathHash = crypto.createHash('md5').update(projectRoot).digest('hex').slice(0, 8)
  return `${dirName}-${pathHash}`
}

export function getStoragePath(projectRoot: string, customOutputDir?: string): string {
  const outputDir = customOutputDir || './.code-analyze-result'
  // 如果是相对路径，相对于项目根目录
  if (!path.isAbsolute(outputDir)) {
    return path.resolve(projectRoot, outputDir)
  }
  return outputDir
}

export function getFileOutputPath(storageRoot: string, filePath: string): string {
  const parsed = path.parse(filePath)
  // 特殊处理 index.xxx：为避免与目录级 index.md 冲突，文件结果命名为 index.xxx.md
  if (parsed.name === 'index' && parsed.ext) {
    return path.join(storageRoot, parsed.dir, `index${parsed.ext}.md`)
  }
  return path.join(storageRoot, parsed.dir, `${parsed.name}.md`)
}

export function getDirOutputPath(storageRoot: string, dirPath: string): string {
  return path.join(storageRoot, dirPath, 'index.md')
}

export function getLanguageFromExtension(ext: string): string {
  const map: Record<string, string> = {
    '.js': 'javascript',
    '.ts': 'typescript',
    '.jsx': 'javascript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.cpp': 'cpp',
    '.c': 'c',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.rs': 'rust'
  }
  return map[ext.toLowerCase()] || 'unknown'
}
