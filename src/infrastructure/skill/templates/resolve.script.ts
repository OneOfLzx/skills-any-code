/**
 * scripts/resolve.js 内容模板（部署到 Skill 目录中的独立脚本，仅使用 Node 内置模块）
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

  if (entry) {
    process.stdout.write(entry.resultPath + '\\n')
  } else {
    process.stdout.write('N/A\\n')
  }
  process.exit(0)
}

main()
`
}
