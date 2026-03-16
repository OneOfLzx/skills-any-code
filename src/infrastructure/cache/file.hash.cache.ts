import { IAnalysisCache } from '../../domain/interfaces';
import { FileAnalysis } from '../../common/types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';

export class FileHashCache implements IAnalysisCache {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    fs.ensureDirSync(cacheDir);
  }

  async get(fileHash: string): Promise<FileAnalysis | null> {
    const cachePath = path.join(this.cacheDir, `${fileHash}.json`);
    try {
      if (await fs.pathExists(cachePath)) {
        const data = await fs.readJSON(cachePath);
        return data as FileAnalysis;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  async set(fileHash: string, result: FileAnalysis): Promise<void> {
    const cachePath = path.join(this.cacheDir, `${fileHash}.json`);
    try {
      await fs.writeJSON(cachePath, result, { spaces: 2 });
    } catch (error) {
      // 缓存写入失败不影响主流程
      console.warn('Failed to write cache:', error);
    }
  }

  async clear(fileHash?: string): Promise<void> {
    if (fileHash) {
      const cachePath = path.join(this.cacheDir, `${fileHash}.json`);
      await fs.remove(cachePath);
    } else {
      await fs.emptyDir(this.cacheDir);
    }
  }

  static calculateFileHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
