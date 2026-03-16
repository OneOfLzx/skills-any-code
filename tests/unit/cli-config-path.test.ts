import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { configManager } from '../../src/common/config';

describe('CLI默认配置路径测试 (UT-CLI-CFG-*)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = path.join(os.tmpdir(), 'code-analyze-test-cli-config');
  const originalCwd = process.cwd();

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
    process.chdir(originalCwd);
    await fs.remove(tempHome);
  });

  test('UT-CLI-CFG-002: CLI默认配置路径展开正确', async () => {
    // 触发配置加载（会自动生成默认配置文件）
    await configManager.load();
    
    // 检查配置文件生成在正确路径
    const expectedConfigPath = path.join(tempHome, '.config', 'code-analyze', 'config.yaml');
    const configExists = await fs.pathExists(expectedConfigPath);
    expect(configExists).toBe(true);
    
    // 检查旧路径没有生成配置文件
    const oldConfigPath = path.join(tempHome, '.code-analyze', 'config.yaml');
    const oldConfigExists = await fs.pathExists(oldConfigPath);
    expect(oldConfigExists).toBe(false);
  });
});
