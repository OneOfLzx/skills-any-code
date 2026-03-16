import { AnalysisAppService } from './analysis.app.service'
import { GitService } from '../infrastructure/git.service'
import { LocalStorageService } from '../infrastructure/storage.service'
import { WorkerPoolService } from '../infrastructure/worker-pool/worker-pool.service'
import { AnalysisService } from '../domain/services/analysis.service'
import { IncrementalService } from '../domain/services/incremental.service'

export interface AppServices {
  analysisAppService: AnalysisAppService
  analysisService: AnalysisService
  incrementalService: IncrementalService
  gitService: GitService
  storageService: LocalStorageService
  workerPoolService: WorkerPoolService
}

export function createAppServices(projectRoot?: string): AppServices {
  const gitService = new GitService(projectRoot || process.cwd())
  const storageService = new LocalStorageService(projectRoot || process.cwd())
  const workerPoolService = new WorkerPoolService()
  const incrementalService = new IncrementalService(gitService, storageService)
  
  const analysisAppService = new AnalysisAppService()
  
  return {
    analysisAppService,
    analysisService: {} as AnalysisService,
    incrementalService,
    gitService,
    storageService,
    workerPoolService
  }
}
