import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { FileHashCache } from '../../../src/infrastructure/cache/file.hash.cache';

describe('FileHashCache with max size (UT-CACHE-001~003)', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = path.join(os.tmpdir(), `file-hash-cache-${Date.now()}`);
    await fs.remove(cacheDir);
  });

  afterEach(async () => {
    await fs.remove(cacheDir).catch(() => {});
  });

  test('UT-CACHE-001: maxSizeMb = 0 时不读不写磁盘缓存', async () => {
    const cache = new FileHashCache({ cacheDir, maxSizeMb: 0 });

    await cache.set('foo', { type: 'file', path: 'a', name: 'a', language: 'ts', linesOfCode: 1, dependencies: [], summary: '', classes: [], functions: [], lastAnalyzedAt: '', commitHash: '' });
    const exists = await fs.pathExists(cacheDir);
    expect(exists).toBe(false);

    const result = await cache.get('foo');
    expect(result).toBeNull();
  });

  test('UT-CACHE-002: 超过上限时按 mtime 从旧到新删除', async () => {
    const cache = new FileHashCache({ cacheDir, maxSizeMb: 1 });
    await fs.ensureDir(cacheDir);

    const fileA = path.join(cacheDir, 'a.json');
    const fileB = path.join(cacheDir, 'b.json');

    await fs.writeJSON(fileA, { a: 1 });
    await new Promise(r => setTimeout(r, 10));
    await fs.writeJSON(fileB, { b: 1 });

    const statA = await fs.stat(fileA);
    const statB = await fs.stat(fileB);
    expect(statA.mtimeMs).toBeLessThanOrEqual(statB.mtimeMs);

    await cache.set('c', { type: 'file', path: 'c', name: 'c', language: 'ts', linesOfCode: 1, dependencies: [], summary: '', classes: [], functions: [], lastAnalyzedAt: '', commitHash: '' });

    const aExists = await fs.pathExists(fileA);
    const bExists = await fs.pathExists(fileB);
    expect(aExists).toBe(false);
    expect(bExists).toBe(true);
  });

  test('UT-CACHE-003: 删除缓存文件失败时记录 warning 但不抛异常', async () => {
    const cache = new FileHashCache({ cacheDir, maxSizeMb: 1 });
    await fs.ensureDir(cacheDir);
    const fileA = path.join(cacheDir, 'a.json');
    await fs.writeJSON(fileA, { a: 1 });

    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(fs, 'remove').mockImplementationOnce(() => {
      throw new Error('mock unlink error');
    });

    await expect(
      (cache as any).enforceLimit(),
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });
});

