import * as workerpool from 'workerpool'
import * as path from 'path'
import { IWorkerPoolService } from '../../domain/interfaces'
import { FileAnalysis, DirectoryAnalysis, ModificationLog } from '../../common/types'
import { AppError, ErrorCode } from '../../common/errors'
import { DEFAULT_CONCURRENCY } from '../../common/constants'

export class WorkerPoolService implements IWorkerPoolService {
  private pool: workerpool.Pool
  private pendingTasks: Promise<any>[] = []
  private currentConcurrency: number

  constructor(concurrency: number = DEFAULT_CONCURRENCY) {
    this.currentConcurrency = concurrency
    this.pool = workerpool.pool(path.join(__dirname, 'parse.worker.js'), {
      maxWorkers: concurrency,
      workerType: 'thread'
    })
  }

  async submitFileAnalysisTask(
    filePath: string,
    fileContent: string,
    fileHash: string,
    language?: string
  ): Promise<FileAnalysis> {
    try {
      const task = this.pool.exec('parseFile', [filePath, fileContent, fileHash, language])
      this.pendingTasks.push(task)
      
      const result = await task
      // 移除已完成的任务
      this.pendingTasks = this.pendingTasks.filter(t => t !== task)
      
      return result
    } catch (e) {
      throw new AppError(ErrorCode.WORKER_SCHEDULE_FAILED, 'File analysis task failed', (e as Error).message)
    }
  }

  async submitDirectoryAggregationTask(dirPath: string, childrenResults: Array<FileAnalysis | DirectoryAnalysis>): Promise<DirectoryAnalysis> {
    try {
      const task = this.pool.exec('aggregateDirectory', [dirPath, childrenResults])
      this.pendingTasks.push(task)
      
      const result = await task
      this.pendingTasks = this.pendingTasks.filter(t => t !== task)
      
      return result
    } catch (e) {
      throw new AppError(ErrorCode.WORKER_SCHEDULE_FAILED, 'Directory aggregation task failed', (e as Error).message)
    }
  }

  async submitValidationTask(parentResult: DirectoryAnalysis, childResult: FileAnalysis | DirectoryAnalysis): Promise<{
    valid: boolean
    corrections?: Partial<FileAnalysis | DirectoryAnalysis>
    log?: ModificationLog
  }> {
    try {
      const task = this.pool.exec('validateResult', [parentResult, childResult])
      this.pendingTasks.push(task)
      
      const result = await task
      this.pendingTasks = this.pendingTasks.filter(t => t !== task)
      
      return result
    } catch (e) {
      throw new AppError(ErrorCode.WORKER_SCHEDULE_FAILED, 'Validation task failed', (e as Error).message)
    }
  }

  setConcurrency(concurrency: number): void {
    this.currentConcurrency = concurrency
    this.pool.terminate()
    this.pool = workerpool.pool(path.join(__dirname, 'parse.worker.js'), {
      maxWorkers: concurrency,
      workerType: 'thread'
    })
  }

  async waitAll(): Promise<void> {
    await Promise.all(this.pendingTasks)
  }

  cancelAll(): void {
    this.pool.terminate()
    this.pendingTasks = []
  }
}