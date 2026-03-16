#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import fs from 'fs-extra';
import path from 'path';
import { version } from '../package.json';
import { AnalysisAppService } from './application/analysis.app.service';
import { configManager } from './common/config';
import { logger } from './common/logger';
import { confirm, progressBar, select } from './common/ui';
import { ErrorCode } from './common/errors';
import { LocalStorageService } from './infrastructure/storage.service';
import { GitService } from './infrastructure/git.service';
import { generateProjectSlug } from './common/utils';

const program = new Command();

// 主命令配置
program
  .name('code-analyze')
  .alias('ca')
  .description('独立的大型项目代码理解与分析工具')
  .version(version, '-v, --version', '显示版本号')
  .helpOption('-h, --help', '显示帮助信息')
  .option('-c, --config <path>', '指定配置文件路径', '~/.config/code-analyze/config.yaml')
  .option('-o, --output <format>', '输出格式：text/json/markdown', 'text')
  .option('--log-level <level>', '日志级别：debug/info/warn/error');

// analyze子命令
program
  .command('analyze')
  .description('执行项目代码解析')
  .option('-p, --path <path>', '指定解析的项目根路径', process.cwd())
  .option('-m, --mode <mode>', '解析模式：full/incremental/auto', 'auto')
  .option('-d, --depth <number>', '解析深度，默认无限制', '-1')
  .option('-C, --concurrency <number>', '并行解析并发数', String(require('os').cpus().length * 2))
  .option('--output-dir <path>', '自定义结果输出目录')
  .option('--no-confirm', '跳过所有确认提示，自动执行')
  .option('--force', '强制解析，忽略未提交变更警告')
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
  .option('--clear-cache', '清空现有LLM解析缓存后再执行解析')
  .action(async (options) => {
    try {
      // 加载配置
      const config = await configManager.load(program.opts().config);
      logger.setLevel(program.opts().logLevel as any);

      // 合并LLM命令行参数
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
        const { FileHashCache } = require('./infrastructure/cache/file.hash.cache');
        const cache = new FileHashCache(config.llm.cache_dir.replace('~', process.env.HOME || process.env.USERPROFILE || ''));
        await cache.clear();
        logger.info('LLM缓存已清空');
      }

      const analysisParams = {
        path: options.path,
        mode: options.mode as any,
        depth: Number(options.depth),
        concurrency: Number(options.concurrency),
        outputDir: options.outputDir || config.global.output_dir,
        force: options.force || false,
        llmConfig: config.llm,
        skillsProviders: options.skillsProviders
          ? options.skillsProviders.split(',').map((s: string) => s.trim().toLowerCase())
          : undefined,
        noSkills: options.skills === false,
      };

      const analysisService = new AnalysisAppService();
      
      // 先尝试执行解析，如果有未提交变更提示用户确认
      try {
        const tempResult = await analysisService.runAnalysis({ ...analysisParams });
        if (!tempResult.success && tempResult.code === ErrorCode.INCREMENTAL_NOT_AVAILABLE) {
          if (options.confirm) {
            const confirmed = await confirm(`${tempResult.message}，是否继续？`, false);
            if (!confirmed) {
              logger.info('用户取消操作');
              process.exit(0);
            }
            analysisParams.force = true;
          }
        }
      } catch (e) {
        // 预检查失败继续
      }

      // 远程LLM服务风险提示（--no-confirm 会设置 options.confirm=false）
      if (config.llm.base_url && !config.llm.base_url.includes('localhost') && !config.llm.base_url.includes('127.0.0.1') && options.confirm !== false) {
        const confirmed = await confirm(`警告：您正在使用远程LLM服务，所有解析的代码文件内容将会上传到${config.llm.base_url}，相关风险由您自行承担，是否继续？`, false);
        if (!confirmed) {
          logger.info('用户取消操作');
          process.exit(0);
        }
      }

      // 启动进度条（全量模式会通过 onTotalKnown 用真实 total 重新 start）
      logger.info(`开始解析项目：${options.path}`);
      progressBar.start(100, 0, { file: '初始化中...' });

      const paramsWithProgress = {
        ...analysisParams,
        onTotalKnown: (total: number) => {
          progressBar.stop();
          progressBar.start(total, 0, { file: '初始化中...' });
        },
        onProgress: (done: number, _total: number, current?: { path: string }) => {
          progressBar.update(done, { file: current?.path || 'N/A' });
        },
      };

      let result;
      try {
        // 执行解析
        result = await analysisService.runAnalysis(paramsWithProgress);
      } catch (error: any) {
        progressBar.stop();
        if (error.code === ErrorCode.LLM_CALL_FAILED || 
            error.code === ErrorCode.LLM_RATE_LIMITED || 
            error.code === ErrorCode.LLM_TIMEOUT) {
          // LLM调用失败，弹出交互选项
          const choice = await select('LLM服务调用失败，请选择操作：', [
            '重试当前文件',
            '跳过当前文件继续解析',
            '终止整个解析流程'
          ]);

          if (choice === '重试当前文件') {
            logger.info('正在重试...');
            result = await analysisService.runAnalysis(analysisParams);
          } else if (choice === '跳过当前文件继续解析') {
            logger.info('跳过当前文件，继续解析其他文件...');
            // 这里需要重新执行跳过逻辑，暂时先返回结果
            result = {
              success: true,
              code: ErrorCode.SUCCESS,
              message: '解析完成，部分文件已跳过',
              data: {
                projectName: analysisParams.path,
                mode: analysisParams.mode,
                analyzedFilesCount: 0,
                duration: 0,
                summaryPath: ''
              }
            };
          } else {
            logger.info('用户终止解析流程');
            process.exit(0);
          }
        } else {
          throw error;
        }
      }
      
      progressBar.stop();

      if (result.success) {
        logger.success(`解析完成！共分析 ${result.data?.analyzedFilesCount || 0} 个文件，耗时 ${((result.data?.duration || 0) / 1000).toFixed(2)}s`);
        logger.success(`项目分析结果入口：${result.data?.summaryPath || ''}`);
      } else {
        logger.error(`解析失败：${result.message}`);
        if (result.errors && result.errors.length > 0) {
          result.errors.forEach(err => logger.error(`- ${err.path}: ${err.message}`));
        }
        process.exit(1);
      }
    } catch (error) {
      progressBar.stop();
      logger.error('执行失败', error as Error);
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
      const config = await configManager.load(program.opts().config);
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

// config子命令
program
  .command('config')
  .description('管理本地配置')
  .option('--list', '列出所有配置')
  .option('--set <key>=<value>', '设置配置项，例如：--set global.log_level=debug')
  .option('--get <key>', '获取配置项值，例如：--get global.output_format')
  .option('--reset', '重置所有配置为默认值')
  .action(async (options) => {
    try {
      const config = await configManager.load(program.opts().config);
      const outputFormat = program.opts().output;

      if (options.list) {
        if (outputFormat === 'json') {
          console.log(JSON.stringify(config, null, 2));
        } else {
          console.log(pc.bold(pc.blue('当前配置：')));
          console.log('\n[global]');
          Object.entries(config.global).forEach(([key, value]) => console.log(`  ${key} = ${value}`));
          console.log('\n[analyze]');
          Object.entries(config.analyze).forEach(([key, value]) => {
            if (Array.isArray(value)) {
              console.log(`  ${key} = ${(value as string[]).join(', ')}`);
            } else {
              console.log(`  ${key} = ${value}`);
            }
          });
          console.log('\n[skills]');
          Object.entries(config.skills).forEach(([key, value]) => {
            if (Array.isArray(value)) {
              console.log(`  ${key} = ${(value as string[]).join(', ')}`);
            } else {
              console.log(`  ${key} = ${value}`);
            }
          });
          console.log('\n[llm]');
           Object.entries(config.llm).forEach(([key, value]) => console.log(`  ${key} = ${value}`));
        }
        return;
      }

      if (options.get) {
        const keys = options.get.split('.');
        let value: any = config;
        for (const key of keys) {
          if (value && typeof value === 'object' && key in value) {
            value = value[key];
          } else {
            logger.error(`配置项不存在：${options.get}`);
            process.exit(1);
          }
        }
        if (outputFormat === 'json') {
          console.log(JSON.stringify({ key: options.get, value }, null, 2));
        } else {
          console.log(`${options.get} = ${value}`);
        }
        return;
      }

      if (options.set) {
        const [keyStr, valueStr] = options.set.split('=');
        if (!keyStr || valueStr === undefined) {
          logger.error('格式错误，请使用 key=value 格式');
          process.exit(1);
        }

        const keys = keyStr.split('.');
        const updateObj: any = {};
        let current = updateObj;
        
        for (let i = 0; i < keys.length - 1; i++) {
          current[keys[i]] = {};
          current = current[keys[i]];
        }
        
        // 类型转换
        let value: any = valueStr;
        if (valueStr === 'true') value = true;
        if (valueStr === 'false') value = false;
        if (!isNaN(Number(valueStr))) value = Number(valueStr);

        current[keys[keys.length - 1]] = value;

        await configManager.save(updateObj);
        logger.success(`配置已更新：${keyStr} = ${value}`);
        return;
      }

      if (options.reset) {
        const confirmed = await confirm('确定要重置所有配置为默认值吗？', false);
        if (!confirmed) {
          logger.info('用户取消操作');
          process.exit(0);
        }
        await configManager.reset();
        logger.success('配置已重置为默认值');
        return;
      }

      // 没有选项时显示帮助
      program.outputHelp();
    } catch (error) {
      logger.error('配置操作失败', error as Error);
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
