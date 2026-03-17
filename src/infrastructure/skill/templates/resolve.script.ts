/**
 * scripts/resolve.js 内容模板（部署到 Skill 目录中的独立脚本，仅使用 Node 内置模块）
 *
 * 约定：
 * - 输入：命令行参数 argv[2]，应为项目内文件或目录的绝对路径
 * - 行为：读取 resolve-config.json 中的 indexFilePath，打开 analysis-index.json 并在 entries 中查找
 * - 输出：
 *   - 命中：stdout 输出对应 Markdown 结果文件的绝对路径（单行）
 *   - 未命中：stdout 输出字符串 "N/A"（单行）
 *   - 读取配置或索引失败：stderr 输出错误信息并以 exit code 1 退出
 */
export function getResolveScriptContent(): string {
  return `const fs = require('fs')
const path = require('path')

function normalizePath(inputPath) {
  let normalized = inputPath.replace(/\\\\/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    process.stderr.write('Usage: node resolve.js <absolute-path>\\n')
    process.exit(1)
  }

  const configPath = path.join(__dirname, '..', 'resolve-config.json')
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (e) {
    process.stderr.write('Failed to read resolve-config.json\\n')
    process.exit(1)
  }

  let indexData
  try {
    indexData = JSON.parse(fs.readFileSync(config.indexFilePath, 'utf-8'))
  } catch (e) {
    process.stderr.write('Failed to read analysis-index.json\\n')
    process.exit(1)
  }

  const normalized = normalizePath(inputPath)
  const entry = indexData.entries[normalized]

  if (entry && entry.resultPath) {
    process.stdout.write(entry.resultPath + '\\n')
  } else {
    process.stdout.write('N/A\\n')
  }
  process.exit(0)
}

main()
`
}
