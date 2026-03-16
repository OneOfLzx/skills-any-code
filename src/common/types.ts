// 元数据结构
export interface AnalysisMetadata {
  projectRoot: string
  lastAnalyzedAt: string
  gitCommits: Array<{
    hash: string
    branch: string
    analyzedAt: string
  }>
  analysisVersion: string
  analyzedFilesCount: number
  schemaVersion: string
}

// 文件分析结果
export interface FileAnalysis {
  type: 'file'
  path: string
  name: string
  language: string
  linesOfCode: number
  dependencies: string[]
  /** 文件功能描述（200字以内），由 LLM 第二步调用生成 */
  description?: string
  summary: string
  classes: Array<{
    name: string
    extends?: string
    implements?: string[]
    methods: Array<{
      name: string
      signature: string
      description: string
      visibility: 'public' | 'private' | 'protected'
    }>
    properties: Array<{
      name: string
      type: string
      description: string
      visibility: 'public' | 'private' | 'protected'
    }>
  }>
  functions: Array<{
    name: string
    signature: string
    description: string
  }>
  classDiagram: string
  sequenceDiagram: string
  lastAnalyzedAt: string
  commitHash: string
}

// 目录分析结果
export interface DirectoryAnalysis {
  type: 'directory'
  path: string
  name: string
  summary: string
  structure: Array<{
    name: string
    type: 'file' | 'directory'
    description: string
  }>
  dependencies: string[]
  moduleDiagram: string
  lastAnalyzedAt: string
  commitHash: string
}

// 项目整体总结
export interface ProjectSummary {
  projectName: string
  slug: string
  description: string
  techStack: string[]
  codeSize: {
    files: number
    lines: number
    languages: Record<string, number>
  }
  architecture: {
    layers: string[]
    modules: Array<{ name: string; description: string }>
    dependencies: Array<{ from: string; to: string }>
  }
  coreFlow: string
  architectureDiagram: string
  flowDiagram: string
  generatedAt: string
  commitHash: string
}

// 修正日志
export interface ModificationLog {
  id: string
  timestamp: string
  path: string
  type: 'inconsistency' | 'omission' | 'error'
  originalContent: string
  correctedContent: string
  reason: string
}

// 解析断点
export interface AnalysisCheckpoint {
  projectRoot: string
  commitHash: string
  mode: 'full' | 'incremental'
  completedFiles: string[]
  completedDirs: string[]
  pendingTasks: Array<{ type: 'file' | 'directory'; path: string }>
  createdAt: string
}

// ===== V2.3 索引相关类型 =====
export interface IndexEntry {
  resultPath: string
  type: 'file' | 'directory'
}

export interface AnalysisIndex {
  version: string
  projectRoot: string
  storageRoot: string
  generatedAt: string
  entries: Record<string, IndexEntry>
}

// ===== V2.3 resolve-config.json =====
export interface ResolveConfig {
  indexFilePath: string
}

// 进度回调：每完成一个对象（文件/目录）时调用
export type ProgressCallback = (done: number, total: number, current?: { path: string }) => void

// 分析服务参数
export interface FullAnalysisParams {
  projectRoot: string
  depth?: number
  concurrency: number
  /** 可选：每完成一个文件/目录时回调，用于进度条等 */
  onProgress?: ProgressCallback
}

export interface IncrementalAnalysisParams {
  projectRoot: string
  baseCommit: string
  targetCommit: string
  changedFiles: string[]
  concurrency: number
}

export interface ResumeAnalysisParams {
  projectRoot: string
  checkpoint: AnalysisCheckpoint
}

// 分析结果
export interface AnalysisResult {
  success: boolean
  analyzedFilesCount: number
  analyzedDirsCount: number
  duration: number
  errors: Array<{ path: string; message: string }>
  projectSlug: string
  summaryPath: string
  /** V2.3：解析过程中收集的索引条目 */
  indexEntries: Array<{ sourcePath: string; resultPath: string; type: 'file' | 'directory' }>
  /** V2.3：增量解析中已删除的源码路径 */
  removedSourcePaths: string[]
}

// 命令参数类型
export interface AnalyzeProjectCommandParams {
  path?: string
  mode?: 'full' | 'incremental' | 'auto'
  depth?: number
  concurrency?: number
  force?: boolean
  llmConfig?: LLMConfig
  /** V2.3：Skill 部署的 Provider 列表 */
  skillsProviders?: string[]
  /** V2.3：是否跳过 Skill 生成 */
  noSkills?: boolean
  /** V2.3：结果输出目录 */
  outputDir?: string
  /** 总对象数已知时回调（用于 CLI 启动进度条） */
  onTotalKnown?: (total: number) => void
  /** 进度更新回调（done, total, current） */
  onProgress?: ProgressCallback
}

// 命令返回结果
export interface AnalyzeProjectCommandResult {
  success: boolean
  code: number
  message: string
  data?: {
    projectName: string
    mode: 'full' | 'incremental'
    analyzedFilesCount: number
    duration: number
    summaryPath: string
  }
  errors?: Array<{
    path: string
    message: string
  }>
}

// LLM调用选项
export interface LLMCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}

// LLM响应结果
export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  responseTime: number;
}

// 文件分片
export interface FileChunk {
  id: number;
  content: string;
  startLine: number;
  endLine: number;
  context?: string;
}

// 分片解析结果
export interface FileChunkAnalysis {
  chunkId: number;
  basicInfo: Partial<{
    name: string;
    language: string;
    linesOfCode: number;
    dependencies: string[];
  }>;
  classes: Array<{
    name: string;
    extends?: string;
    implements?: string[];
    methods: Array<{
      name: string;
      signature: string;
      description: string;
      visibility: 'public' | 'private' | 'protected';
    }>;
    properties: Array<{
      name: string;
      type: string;
      description: string;
      visibility: 'public' | 'private' | 'protected';
    }>;
  }>;
  functions: Array<{
    name: string;
    signature: string;
    description: string;
  }>;
  partialDiagrams: {
    classDiagram?: string;
    sequenceDiagram?: string;
  };
  summary: string;
}

// LLM配置
export interface LLMConfig {
  model: string;
  api_key: string;
  base_url?: string;
  temperature: number;
  max_tokens: number;
  timeout: number;
  proxy?: string;
  max_retries: number;
  retry_delay: number;
  context_window_size: number;
  cache_enabled: boolean;
  cache_dir: string;
}

// 扩展CLI配置（与 Config 对齐，供类型引用）
export interface CliConfig {
  global: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    outputFormat: 'text' | 'json' | 'markdown';
    autoConfirm: boolean;
    outputDir: string;
  };
  llm: LLMConfig;
  commands: {
    analyze: {
      defaultDepth: number;
      defaultConcurrency: number;
    };
    skills: {
      defaultProviders: string[];
    };
  };
}
