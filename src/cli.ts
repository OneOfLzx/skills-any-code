#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import fs from 'fs-extra';
import path from 'path';
import { version } from '../package.json';
import { AnalysisAppService } from './application/analysis.app.service';
import { configManager } from './common/config';
import { logger } from './common/logger';
import { cliRenderer } from './common/ui';
import type { TokenUsageStats } from './common/types';
import { AppError, ErrorCode } from './common/errors';
import { LocalStorageService } from './infrastructure/storage.service';
import { GitService } from './infrastructure/git.service';
import { generateProjectSlug } from './common/utils';
import { DEFAULT_CONCURRENCY } from './common/constants';

const program = new Command();

// 主命令配置
program
  .name('code-analyze')
  .alias('ca')
  .description('独立的大型项目代码理解与分析工具')
  .version(version, '-v, --version', '显示版本号')
  .helpOption('-h, --help', '显示帮助信息')
  .option('--log-level <level>', '日志级别：debug/info/warn/error')
  .option('--path <path>', '指定解析的项目根路径', process.cwd())
  .option('-m, --mode <mode>', '解析模式：full/incremental/auto', 'auto')
  .option('-d, --depth <number>', '解析深度，默认无限制', '-1')
  .option('-C, --concurrency <number>', '并行解析并发数（未传时使用 CPU*2，但不超过配置 analyze.max_concurrency）')
  .option('--output-dir <path>', '自定义结果输出目录')
  .option('--skills-providers <list>', '逗号分隔的 AI 工具标识列表（opencode/cursor/claude/codex）')
  .option('--no-skills', '跳过 Skill 生成')
  // LLM相关参数
  .option('--llm-base-url <url>', 'LLM API服务地址')
  .option('--llm-api-key <key>', 'LLM API密钥')
  .option('--llm-model <model>', 'LLM模型名称')
  .option('--llm-temperature <number>', 'LLM生成温度（0-2）', parseFloat)
  .option('--llm-max-tokens <number>', 'LLM最大生成Token数', parseInt)
  .option('--llm-timeout <ms>', 'LLM调用超时时间（毫秒）', parseInt)
  .option('--llm-max-retries <number>', 'LLM调用最大重试次数', parseInt)
  .option('--llm-retry-delay <ms>', 'LLM重试间隔时间（毫秒）', parseInt)
  .option('--llm-context-window-size <number>', 'LLM上下文窗口大小', parseInt)
  .option('--no-llm-cache', '禁用LLM解析结果缓存')
  .option('--llm-cache-dir <path>', 'LLM缓存存储目录')
  .option('--clear-cache', '清空现有LLM解析缓存后再执行解析');

// init 子命令：显式初始化配置文件（V2.5）
program
  .command('init')
  .description('初始化或重置配置文件（V2.5）')
  .action(async () => {
    try {
      const resolvedPath = '~/.config/code-analyze/config.yaml';
      const fsPath = resolvedPath.replace('~', process.env.HOME || process.env.USERPROFILE || '');
      const exists = await fs.pathExists(fsPath);

      await configManager.init();
      logger.success(exists ? `配置文件已重置：${fsPath}` : `配置文件已写入：${fsPath}`);
      process.exit(0);
    } catch (error) {
      logger.error('初始化配置失败', error as Error);
      process.exit(1);
    }
  });

// 默认解析（不带子命令时直接执行）
program.action(async () => {
    const os = require('os');
    try {
      // 加载配置（V2.5：配置未初始化时直接失败，提示先执行 init）
      let config;
      try {
        config = await configManager.load();
      } catch (e: any) {
        if (e instanceof AppError && e.code === ErrorCode.CONFIG_NOT_INITIALIZED) {
          process.stderr.write(
            `配置文件未初始化，请先执行 "code-analyze init" 创建配置：~/.config/code-analyze/config.yaml\n`,
          );
          process.exit(1);
          return;
        }
        throw e;
      }
      const cliLogLevel = program.opts().logLevel as any;
      if (cliLogLevel) {
        logger.setLevel(cliLogLevel);
      }

      // 合并LLM命令行参数
      const options = program.opts();
      if (options.llmBaseUrl) config.llm.base_url = options.llmBaseUrl;
      if (options.llmApiKey) config.llm.api_key = options.llmApiKey;
      if (options.llmModel) config.llm.model = options.llmModel;
      if (options.llmTemperature !== undefined) config.llm.temperature = options.llmTemperature;
      if (options.llmMaxTokens !== undefined) config.llm.max_tokens = options.llmMaxTokens;
      if (options.llmTimeout !== undefined) config.llm.timeout = options.llmTimeout;
      if (options.llmMaxRetries !== undefined) config.llm.max_retries = options.llmMaxRetries;
      if (options.llmRetryDelay !== undefined) config.llm.retry_delay = options.llmRetryDelay;
      if (options.llmContextWindowSize !== undefined) config.llm.context_window_size = options.llmContextWindowSize;
      if (options.llmCache !== undefined) config.llm.cache_enabled = options.llmCache;
      if (options.llmCacheDir) config.llm.cache_dir = options.llmCacheDir;

      // 处理清空缓存选项
      if (options.clearCache) {
        const { FileHashCache } = await import('./infrastructure/cache/file.hash.cache');
        const homeDir = os.homedir();
        const cache = new FileHashCache({
          cacheDir: config.llm.cache_dir.replace(/^~(?=\/|\\|$)/, homeDir),
          maxSizeMb: config.llm.cache_max_size_mb,
        });
        await cache.clear();
        logger.info('LLM缓存已清空');
      }

      // 默认并发：CPU*2，但不超过配置中的 analyze.max_concurrency
      const cpuBasedConcurrency = DEFAULT_CONCURRENCY;
      const configuredMax = Number(config.analyze.max_concurrency ?? DEFAULT_CONCURRENCY);
      const defaultConcurrency =
        configuredMax > 0 ? Math.min(cpuBasedConcurrency, configuredMax) : cpuBasedConcurrency;

      const analysisParams = {
        path: options.path,
        mode: options.mode as any,
        depth: Number(options.depth),
        concurrency: options.concurrency !== undefined ? Number(options.concurrency) : defaultConcurrency,
        outputDir: options.outputDir || config.global.output_dir,
        llmConfig: config.llm,
        skillsProviders: options.skillsProviders
          ? options.skillsProviders.split(',').map((s: string) => s.trim().toLowerCase())
          : undefined,
        noSkills: options.skills === false,
      };

      // V2.5：解析前执行 LLM 连接可用性校验，失败则立即退出（需求文档 13.4.2 / 测试文档 ST-LLM-CONNECT-001）
      const { OpenAIClient } = await import('./infrastructure/llm/openai.client');
      const llmClient = new OpenAIClient(config.llm);
      logger.info(
        `LLM 客户端初始化完成，开始测试连接与配置 (url=${config.llm.base_url}, model=${config.llm.model})`,
      );
      try {
        await llmClient.testConnection(config.llm);
      } catch (e: any) {
        const detail = e?.message || String(e);
        process.stderr.write(`LLM 连接/配置校验失败: ${detail}\n`);
        process.exit(1);
      }

      const analysisService = new AnalysisAppService();

      // 在 analyze 生命周期内，将所有 logger 输出通过 CLI 渲染器固定到进度块下方，
      // 避免产生额外的进度/对象/Tokens 区域块。
      logger.setSink((line) => {
        cliRenderer.logBelow(line);
      });

      const paramsWithProgress = {
        ...analysisParams,
        onTotalKnown: (total: number) => {
          cliRenderer.setTotal(total);
        },
        onProgress: (done: number, total: number, current?: { path: string }) => {
          cliRenderer.updateProgress(done, total, current?.path, analysisParams.concurrency);
        },
        onTokenUsageSnapshot: (stats: TokenUsageStats) => {
          cliRenderer.updateTokens(stats);
        },
        onScanProgress: (scannedFiles: number) => {
          cliRenderer.updateScanProgress(scannedFiles);
        },
      };

      let result;
      // 执行解析（V2.4+：不再在 CLI 中做交互式错误处理，所有 LLM 错误由应用层统一抛出）
      result = await analysisService.runAnalysis(paramsWithProgress);
      
      if (result.success) {
        const files = result.data?.analyzedFilesCount || 0;
        const dirs = (result as any).data?.analyzedDirsCount || 0;
        const objects = files + dirs;
        logger.success(
          `解析完成！共处理 ${objects} 个对象`,
        );
        const summaryPath = result.data?.summaryPath || '';
        const summaryLabel = summaryPath ? `入口文件：${path.basename(summaryPath)}` : '入口文件：index.md';
        logger.success(`项目分析结果${summaryLabel}`);
        const usage = result.data?.tokenUsage;
        if (usage) {
          logger.info(
            `本次解析共调用 LLM ${usage.totalCalls} 次，输入 Token: ${usage.totalPromptTokens}，` +
            `输出 Token: ${usage.totalCompletionTokens}，总 Token: ${usage.totalTokens}`
          );
        }
      } else {
        logger.error(`解析失败：${result.message}`);
        if (result.errors && result.errors.length > 0) {
          result.errors.forEach(err => logger.error(`- ${err.path}: ${err.message}`));
        }
        process.exit(1);
      }
    } catch (error) {
      const err = error as any;
      // V2.5：LLM 连接/配置校验失败时统一输出明确前缀，满足 ST-LLM-CONNECT-001/002/003
      if (err && err.code && (
          err.code === ErrorCode.LLM_INVALID_CONFIG ||
          err.code === ErrorCode.LLM_CALL_FAILED ||
          err.code === ErrorCode.LLM_TIMEOUT
        )) {
        const detail = err.message || '';
        process.stderr.write(`LLM 连接/配置校验失败: ${detail}\n`);
      } else if (err instanceof AppError) {
        logger.error(`执行失败：${err.message}`, err);
      } else {
        logger.error('执行失败', err as Error);
      }
      process.exit(1);
    }
  });

// resolve 子命令（V2.3：根据绝对路径查询分析结果 Markdown 路径）
program
  .command('resolve')
  .description('查询文件/目录对应的分析结果 Markdown 路径')
  .argument('<absolute-path>', '需要查询的文件/目录的绝对路径')
  .option('-p, --project <path>', '项目根路径', process.cwd())
  .option('--output-dir <path>', '结果输出目录')
  .action(async (absolutePath: string, options: { project?: string; outputDir?: string }) => {
    try {
      let config;
      try {
        config = await configManager.load();
      } catch (e: any) {
        if (e instanceof AppError && e.code === ErrorCode.CONFIG_NOT_INITIALIZED) {
          process.stderr.write(
            `配置文件未初始化，请先执行 "code-analyze init" 创建配置：~/.config/code-analyze/config.yaml\n`,
          );
          process.exit(1);
          return;
        }
        throw e;
      }
      logger.setLevel(program.opts().logLevel as any);
      const projectRoot = options.project || process.cwd();
      const outputDir = options.outputDir || config.global.output_dir;
      const { getStoragePath } = await import('./common/utils');
      const storageRoot = getStoragePath(projectRoot, outputDir);
      const { IndexService } = await import('./infrastructure/index.service');
      const indexService = new IndexService();
      const result = await indexService.resolve(storageRoot, absolutePath);
      if (result !== null) {
        process.stdout.write(result + '\n');
      } else {
        process.stdout.write('N/A\n');
      }
      process.exit(0);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`查询失败：${msg}\n`);
      process.exit(1);
    }
  });

// 全局错误处理
program.showSuggestionAfterError();
program.configureHelp({
  sortSubcommands: true,
  sortOptions: true,
});

// 解析命令行参数
program.parseAsync(process.argv).catch((error) => {
  console.error(pc.red(`\n执行失败：${error.message}`));
  process.exit(1);
});
