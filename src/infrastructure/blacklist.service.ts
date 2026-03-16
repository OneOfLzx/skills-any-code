import ignore, { Ignore } from 'ignore'
import * as fs from 'fs-extra'
import * as path from 'path'
import { IBlacklistService } from '../domain/interfaces'

export class BlacklistService implements IBlacklistService {
  private ig: Ignore = ignore()

  async load(globalBlacklist: string[], projectRoot: string): Promise<void> {
    this.ig = ignore()

    this.ig.add(globalBlacklist)

    const projectIgnorePath = path.join(projectRoot, '.code-analyze-ignore')
    if (await fs.pathExists(projectIgnorePath)) {
      const content = await fs.readFile(projectIgnorePath, 'utf-8')
      this.ig.add(content)
    }

    const gitignorePath = path.join(projectRoot, '.gitignore')
    if (await fs.pathExists(gitignorePath)) {
      const content = await fs.readFile(gitignorePath, 'utf-8')
      this.ig.add(content)
    }
  }

  isIgnored(relativePath: string): boolean {
    return this.ig.ignores(relativePath)
  }
}
