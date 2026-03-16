import { configManager } from '../../src/common/config';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('ConfigManager 配置路径测试 (UT-CFG-*)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = path.join(os.tmpdir(), 'code-analyze-test-config');
  
  beforeEach(async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    
    await fs.remove(tempHome);
    await fs.ensureDir(tempHome);
    
    (configManager as any).config = null;
    (configManager as any).configPath = '';
  });
  
  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    
    await fs.remove(tempHome);
  });
  
  test('UT-CFG-001: 配置路径波浪号展开测试，验证~路径正确解析为用户home目录', async () => {
    const customPath = '~/.test-config.yaml';
    await configManager.load(customPath);
    
    const expectedPath = path.join(tempHome, '.test-config.yaml');
    expect((configManager as any).configPath).toBe(expectedPath);
    
    const exists = await fs.pathExists(expectedPath);
    expect(exists).toBe(true);
  });
  
  test('UT-CFG-002: 配置路径优先级测试，验证CLI参数优先级高于内部默认路径', async () => {
    const customPath = path.join(tempHome, 'custom-config.yaml');
    await configManager.load(customPath);
    
    expect((configManager as any).configPath).toBe(customPath);
    
    const defaultPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const defaultExists = await fs.pathExists(defaultPath);
    expect(defaultExists).toBe(false);
    
    const customExists = await fs.pathExists(customPath);
    expect(customExists).toBe(true);
  });
  
  test('UT-CFG-003: 不传入自定义路径时使用默认配置路径', async () => {
    await configManager.load();
    
    const expectedPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    expect((configManager as any).configPath).toBe(expectedPath);
    
    const exists = await fs.pathExists(expectedPath);
    expect(exists).toBe(true);
  });
  
  test('UT-CFG-004: Windows环境下USERPROFILE环境变量优先级测试', async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = tempHome;
    
    await configManager.load();
    
    const expectedPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    expect((configManager as any).configPath).toBe(expectedPath);
  });

  // ===== V2.3 新增配置项测试 (UT-CLI-007 / UT-V23-CFG-*) =====
  test('UT-V23-CFG-001: skills.default_providers 默认值应包含 opencode,cursor,claude,codex', async () => {
    await configManager.load();
    const config = configManager.getConfig();
    expect(config.skills.default_providers).toBeDefined();
    expect(config.skills.default_providers).toContain('opencode');
    expect(config.skills.default_providers).toContain('cursor');
    expect(config.skills.default_providers).toContain('claude');
    expect(config.skills.default_providers).toContain('codex');
  });

  test('UT-V23-CFG-002: analyze.blacklist 默认值应为数组且包含常用模式', async () => {
    await configManager.load();
    const config = configManager.getConfig();
    expect(Array.isArray(config.analyze.blacklist)).toBe(true);
    expect(config.analyze.blacklist.some((p: string) => p.includes('*.md') || p === '*.md')).toBe(true);
    expect(config.analyze.blacklist.some((p: string) => p.includes('node_modules'))).toBe(true);
  });

  test('UT-V23-CFG-006: 完整配置应包含 global、analyze、skills、llm 且 analyze 含 blacklist', async () => {
    await configManager.load();
    const config = configManager.getConfig();
    expect(config).toHaveProperty('global');
    expect(config).toHaveProperty('analyze');
    expect(config).toHaveProperty('skills');
    expect(config).toHaveProperty('llm');
    expect(config.analyze).toHaveProperty('blacklist');
  });
});
