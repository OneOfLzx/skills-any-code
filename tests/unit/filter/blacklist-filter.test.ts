/**
 * V2.3 黑名单过滤规则重构单元测试
 * 对应测试文档 10.4.5：UT-V23-BL-001 ~ UT-V23-BL-016
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { BlacklistService } from '../../../src/infrastructure/blacklist.service';

describe('黑名单过滤 (V23-BL)', () => {
  let testProjectDir: string;

  beforeEach(async () => {
    testProjectDir = path.join(os.tmpdir(), `blacklist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.ensureDir(testProjectDir);
  });

  afterEach(async () => {
    await fs.remove(testProjectDir).catch(() => {});
  });

  it('UT-V23-BL-001: 全局黑名单过滤生效', async () => {
    const service = new BlacklistService();
    await service.load(['*.md', '*.yml'], testProjectDir);

    expect(service.isIgnored('README.md')).toBe(true);
    expect(service.isIgnored('config.yml')).toBe(true);
    expect(service.isIgnored('src/index.ts')).toBe(false);
  });

  it('UT-V23-BL-002: 项目级 .code-analyze-ignore 过滤生效', async () => {
    await fs.writeFile(path.join(testProjectDir, '.code-analyze-ignore'), 'jest.config.*\n', 'utf-8');
    const service = new BlacklistService();
    await service.load([], testProjectDir);

    expect(service.isIgnored('jest.config.ts')).toBe(true);
    expect(service.isIgnored('src/app.ts')).toBe(false);
  });

  it('UT-V23-BL-003: .gitignore 作为第三层过滤', async () => {
    await fs.writeFile(path.join(testProjectDir, '.gitignore'), 'node_modules/\ndist/\n', 'utf-8');
    const service = new BlacklistService();
    await service.load([], testProjectDir);

    expect(service.isIgnored('node_modules/foo')).toBe(true);
    expect(service.isIgnored('dist/bundle.js')).toBe(true);
    expect(service.isIgnored('src/index.ts')).toBe(false);
  });

  it('UT-V23-BL-004: 项目级否定模式覆盖全局规则', async () => {
    await fs.writeFile(path.join(testProjectDir, '.code-analyze-ignore'), '!tsconfig.json\n', 'utf-8');
    const service = new BlacklistService();
    await service.load(['*.json'], testProjectDir);

    expect(service.isIgnored('package.json')).toBe(true);
    expect(service.isIgnored('tsconfig.json')).toBe(false);
    expect(service.isIgnored('src/data.json')).toBe(true);
  });

  it('UT-V23-BL-007: .code-analyze-ignore 不存在时正常运行', async () => {
    const service = new BlacklistService();
    await service.load(['*.log'], testProjectDir);
    expect(service.isIgnored('app.log')).toBe(true);
  });

  it('UT-V23-BL-008: .gitignore 不存在时正常运行', async () => {
    const service = new BlacklistService();
    await service.load(['*.tmp'], testProjectDir);
    expect(service.isIgnored('file.tmp')).toBe(true);
  });

  it('UT-V23-BL-014: 空黑名单时仅二进制等其它判定生效', async () => {
    const service = new BlacklistService();
    await service.load([], testProjectDir);
    expect(service.isIgnored('src/index.ts')).toBe(false);
    expect(service.isIgnored('README.md')).toBe(false);
  });

  it('UT-V23-BL-015: 注释行和空行被忽略', async () => {
    await fs.writeFile(
      path.join(testProjectDir, '.code-analyze-ignore'),
      '# this is a comment\n\n*.tmp\n',
      'utf-8'
    );
    const service = new BlacklistService();
    await service.load([], testProjectDir);
    expect(service.isIgnored('file.tmp')).toBe(true);
    expect(service.isIgnored('file.ts')).toBe(false);
  });
});
