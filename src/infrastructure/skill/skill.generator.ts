import * as fs from 'fs-extra'
import * as path from 'path'
import { ISkillGenerator, SkillGenerateOptions, SkillProvider } from '../../domain/interfaces'
import { getSkillMdContent } from './templates/skill.md.template'
import { getResolveScriptContent } from './templates/resolve.script'
import { normalizePath } from '../../common/utils'
import { logger } from '../../common/logger'

const PROVIDER_DIRECTORY_MAP: Record<SkillProvider, string> = {
  opencode: '.agents/skills/code-query',
  cursor: '.agents/skills/code-query',
  codex: '.agents/skills/code-query',
  claude: '.claude/skills/code-query',
}

export class SkillGenerator implements ISkillGenerator {
  async generate(options: SkillGenerateOptions): Promise<string[]> {
    const { projectRoot, storageRoot, providers } = options
    const deployedPaths: string[] = []

    const uniqueDirs = new Set<string>()
    for (const p of providers) {
      const lowerProvider = p.toLowerCase() as SkillProvider
      const dir = PROVIDER_DIRECTORY_MAP[lowerProvider]
      if (dir) {
        uniqueDirs.add(dir)
      } else {
        logger.warn(`不可识别的 provider：${p}，已跳过`)
      }
    }

    const indexFilePath = normalizePath(path.resolve(storageRoot, 'analysis-index.json'))
    const resolveConfig = JSON.stringify({ indexFilePath }, null, 2)
    const skillMd = getSkillMdContent()
    const resolveScript = getResolveScriptContent()

    for (const relativeDir of uniqueDirs) {
      const targetDir = path.join(projectRoot, relativeDir)
      try {
        await fs.ensureDir(targetDir)
        await fs.ensureDir(path.join(targetDir, 'scripts'))

        await fs.writeFile(path.join(targetDir, 'SKILL.md'), skillMd, 'utf-8')
        await fs.writeFile(path.join(targetDir, 'resolve-config.json'), resolveConfig, 'utf-8')
        await fs.writeFile(path.join(targetDir, 'scripts', 'resolve.js'), resolveScript, 'utf-8')

        deployedPaths.push(targetDir)
        logger.debug(`Skill 已部署到：${targetDir}`)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`Skill 部署失败（${targetDir}）：${msg}`)
      }
    }

    return deployedPaths
  }
}
