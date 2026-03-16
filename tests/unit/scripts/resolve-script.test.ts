/**
 * V2.3 独立查询脚本（scripts/resolve.js）单元测试
 * 对应测试文档 10.4.3：UT-V23-SCRIPT-001 ~ UT-V23-SCRIPT-008
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { getResolveScriptContent } from '../../../src/infrastructure/skill/templates/resolve.script';

describe('独立查询脚本内容 (V23-SCRIPT)', () => {
  it('UT-V23-SCRIPT-004: 脚本仅使用 Node 内置模块', () => {
    const content = getResolveScriptContent();
    const requireMatches = content.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
    const builtins = ['fs', 'path', 'os', 'url', 'util'];
    for (const req of requireMatches) {
      const mod = req.replace(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/, '$1');
      expect(builtins).toContain(mod);
    }
  });

  it('脚本应包含 normalizePath、resolve-config、entries、resultPath、N/A 逻辑', () => {
    const content = getResolveScriptContent();
    expect(content).toContain('resolve-config.json');
    expect(content).toContain('entries');
    expect(content).toContain('resultPath');
    expect(content).toContain('N/A');
    expect(content).toMatch(/replace.*\\\\/g);
  });
});
