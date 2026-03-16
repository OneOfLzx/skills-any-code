import fs from 'fs-extra';
import yaml from 'js-yaml';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import { DEFAULT_CONCURRENCY, DEFAULT_OUTPUT_DIR } from './constants';
import { logger } from './logger';

// V2.3：全局黑名单默认值（.gitignore 语法）
const DEFAULT_BLACKLIST = [
  '*.yml', '*.yaml', '*.ini', '*.cfg', '*.json', '*.toml',
  '*.md', '*.txt', '*.rst',
  'README*', 'LICENSE*', 'CHANGELOG*',
  '*.lock', 'package-lock.json', 'yarn.lock',
  '*.env*', 'credentials.*', '*.pem', '*.key',
  'docs/', 'dist/', 'build/', 'coverage/',
  'node_modules/', '.git/', '.code-analyze-result/',
];

const DEFAULT_PROVIDERS = ['opencode', 'cursor', 'claude', 'codex'];

const ConfigSchema = z.object({
  global: z.object({
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    output_format: z.enum(['text', 'json', 'markdown']).default('text'),
    auto_confirm: z.boolean().default(false),
    output_dir: z.string().default(DEFAULT_OUTPUT_DIR),
  }).default({}),
  analyze: z.object({
    default_mode: z.enum(['full', 'incremental', 'auto']).default('auto'),
    default_concurrency: z.number().default(DEFAULT_CONCURRENCY),
    default_depth: z.number().default(-1),
    blacklist: z.array(z.string()).default(DEFAULT_BLACKLIST),
  }).default({}),
  skills: z.object({
    default_providers: z.array(z.string()).default(DEFAULT_PROVIDERS),
  }).default({}),
  llm: z.object({
    base_url: z.string().default('https://ark.cn-beijing.volces.com/api/v3'),
    api_key: z.string().default(''),
    model: z.string().default('doubao-seed-1-6-251015-251015'),
    temperature: z.number().min(0).max(2).default(0.1),
    max_tokens: z.number().int().min(100).default(4000),
    timeout: z.number().int().min(1000).default(60000),
    max_retries: z.number().int().min(0).default(3),
    retry_delay: z.number().int().min(100).default(1000),
    context_window_size: z.number().int().min(1000).default(128000),
    cache_enabled: z.boolean().default(true),
    cache_dir: z.string().default('~/.cache/code-analyze/llm'),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

class ConfigManager {
  private config: Config | null = null;
  private configPath: string = '';

  private getDefaultConfigPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, '.config', 'code-analyze', 'config.yaml');
  }

  private expandTilde(pathStr: string): string {
    if (pathStr.startsWith('~') && (pathStr.length === 1 || pathStr[1] === '/' || pathStr[1] === '\\')) {
      const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
      return path.join(home, pathStr.slice(1));
    }
    return pathStr;
  }

  async load(customPath?: string): Promise<Config> {
    this.configPath = customPath ? this.expandTilde(customPath) : this.getDefaultConfigPath();
    
    // 1. 加载默认配置
    let config = ConfigSchema.parse({});

    // 2. 加载配置文件
    if (await fs.pathExists(this.configPath)) {
      try {
        const fileContent = await fs.readFile(this.configPath, 'utf-8');
        const fileConfig = yaml.load(fileContent) as Record<string, unknown>;
        if (fileConfig && 'query' in fileConfig) {
          logger.warn('配置项 "query" 已在 V2.3 中废弃，请移除该配置段');
        }
        if (fileConfig?.analyze && typeof fileConfig.analyze === 'object' && 'exclude_patterns' in (fileConfig.analyze as object)) {
          logger.warn('配置项 "analyze.exclude_patterns" 已在 V2.3 中废弃，请使用 "analyze.blacklist" 替代');
        }
        config = ConfigSchema.parse(fileConfig);
        logger.debug(`已加载配置文件：${this.configPath}`);
      } catch (error) {
        logger.warn(`配置文件解析失败，使用默认配置：${(error as Error).message}`);
      }
    } else {
      // 配置文件不存在，自动生成默认配置文件
      try {
        await fs.ensureDir(path.dirname(this.configPath));
        await fs.writeFile(this.configPath, yaml.dump(config), 'utf-8');
        logger.debug(`已自动生成默认配置文件：${this.configPath}`);
      } catch (error) {
        logger.warn(`自动生成配置文件失败：${(error as Error).message}`);
      }
    }

    // 3. 加载环境变量
    const envConfig: any = {};
    Object.entries(process.env).forEach(([key, value]) => {
      if (!key.startsWith('CODE_ANALYZE_')) return;
      const configKey = key.replace('CODE_ANALYZE_', '').toLowerCase();
      
      if (!envConfig.global) envConfig.global = {};
      if (configKey === 'log_level' && value) envConfig.global.log_level = value;
      if (configKey === 'output_format' && value) envConfig.global.output_format = value;
      if (configKey === 'auto_confirm' && value) envConfig.global.auto_confirm = value === 'true';
      if (configKey === 'output_dir' && value) envConfig.global.output_dir = value;
      
      if (!envConfig.analyze) envConfig.analyze = {};
      if (configKey === 'analyze_default_mode' && value) envConfig.analyze.default_mode = value;
      if (configKey === 'analyze_default_concurrency' && value) envConfig.analyze.default_concurrency = Number(value);
      if (configKey === 'analyze_default_depth' && value) envConfig.analyze.default_depth = Number(value);

      if (!envConfig.skills) envConfig.skills = {};
      if (configKey === 'skills_default_providers' && value) {
        envConfig.skills.default_providers = value.split(',').map((s: string) => s.trim());
      }

      if (!envConfig.llm) envConfig.llm = {};
      if (configKey === 'llm_base_url' && value) envConfig.llm.base_url = value;
      if (configKey === 'llm_api_key' && value) envConfig.llm.api_key = value;
      if (configKey === 'llm_model' && value) envConfig.llm.model = value;
      if (configKey === 'llm_temperature' && value) envConfig.llm.temperature = Number(value);
      if (configKey === 'llm_max_tokens' && value) envConfig.llm.max_tokens = Number(value);
      if (configKey === 'llm_timeout' && value) envConfig.llm.timeout = Number(value);
      if (configKey === 'llm_max_retries' && value) envConfig.llm.max_retries = Number(value);
      if (configKey === 'llm_retry_delay' && value) envConfig.llm.retry_delay = Number(value);
      if (configKey === 'llm_context_window_size' && value) envConfig.llm.context_window_size = Number(value);
      if (configKey === 'llm_cache_enabled' && value) envConfig.llm.cache_enabled = value === 'true';
      if (configKey === 'llm_cache_dir' && value) envConfig.llm.cache_dir = value;
    });

    config = ConfigSchema.parse({ ...config, ...envConfig });

    this.config = config;
    return config;
  }

  getConfig(): Config {
    if (!this.config) {
      throw new Error('配置未加载，请先调用 load() 方法');
    }
    return this.config;
  }

  async save(config: Partial<Config>): Promise<void> {
    const currentConfig = this.config || await this.load();
    const mergedConfig = { ...currentConfig, ...config };
    const validatedConfig = ConfigSchema.parse(mergedConfig);
    
    await fs.ensureDir(path.dirname(this.configPath));
    await fs.writeFile(this.configPath, yaml.dump(validatedConfig), 'utf-8');
    this.config = validatedConfig;
  }

  async reset(): Promise<void> {
    const defaultConfig = ConfigSchema.parse({});
    await this.save(defaultConfig);
  }
}

export const configManager = new ConfigManager();
