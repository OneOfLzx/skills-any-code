import { IIncrementalService, IGitService, IStorageService } from '../interfaces'
import { AnalysisMetadata } from '../../common/types'

export class IncrementalService implements IIncrementalService {
  constructor(
    private gitService: IGitService,
    private storageService: IStorageService
  ) {}

  async canDoIncremental(projectRoot: string): Promise<{ available: boolean; baseCommit?: string; reason?: string }> {
    const isGit = await this.gitService.isGitProject(projectRoot)
    if (!isGit) {
      return { available: false, reason: 'Not a git project' }
    }

    const projectSlug = await this.gitService.getProjectSlug(projectRoot)
    const metadata = await this.storageService.getMetadata(projectSlug)
    if (!metadata) {
      return { available: false, reason: 'No historical analysis records' }
    }

    const currentCommit = await this.gitService.getCurrentCommit(projectRoot)
    
    const matchedCommit = metadata.gitCommits.find(c => c.hash === currentCommit)
    if (matchedCommit) {
      return { available: true, baseCommit: currentCommit }
    }

    const historicalCommits = metadata.gitCommits.map(c => c.hash)
    const commonAncestor = await this.findNearestCommonAncestor(projectRoot, [currentCommit, ...historicalCommits])
    
    if (commonAncestor) {
      return { available: true, baseCommit: commonAncestor }
    }

    return { available: false, reason: 'No related historical commits found' }
  }

  async getChangedFiles(projectRoot: string, baseCommit: string, targetCommit: string): Promise<string[]> {
    return this.gitService.diffCommits(projectRoot, baseCommit, targetCommit)
  }

  async findNearestCommonAncestor(projectRoot: string, commits: string[]): Promise<string | null> {
    try {
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(projectRoot)
      const commonAncestor = await git.raw(['merge-base', '--octopus', ...commits])
      return commonAncestor.trim() || null
    } catch (e) {
      return null
    }
  }

  getAffectedDirectories(changedFiles: string[]): string[] {
    const directories = new Set<string>()
    
    changedFiles.forEach(file => {
      const parts = file.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (dir) {
          directories.add(dir)
        }
      }
    })

    directories.add('')

    return Array.from(directories)
  }
}
