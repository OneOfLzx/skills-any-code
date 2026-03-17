import path from 'path';
import fs from 'fs-extra';

export type AnalyzedFileRecord = {
  fileHashWhenAnalyzed?: string;
};

function resolveAnalyzedJsonPathInDir(
  projectPath: string,
  baseDirName: string,
  relFilePath: string,
): string {
  const parsed = path.parse(relFilePath);
  const jsonFileName =
    parsed.name === 'index' && parsed.ext ? `index${parsed.ext}.json` : `${parsed.name}.json`;
  return path.join(projectPath, baseDirName, path.dirname(relFilePath), jsonFileName);
}

export async function readAnalyzedFileRecord(
  projectPath: string,
  relFilePath: string,
): Promise<AnalyzedFileRecord> {
  const candidates = [
    resolveAnalyzedJsonPathInDir(projectPath, '.code-analyze-result', relFilePath),
    resolveAnalyzedJsonPathInDir(projectPath, '.code-analyze-internal', relFilePath),
  ];

  for (const p of candidates) {
    if (await fs.pathExists(p)) {
      return (await fs.readJson(p)) as AnalyzedFileRecord;
    }
  }

  throw new Error(
    `Analyzed record JSON not found for ${relFilePath}. Tried: ${candidates.join(', ')}`,
  );
}

export async function readFileHashWhenAnalyzedOrThrow(
  projectPath: string,
  relFilePath: string,
): Promise<string> {
  const rec = await readAnalyzedFileRecord(projectPath, relFilePath);
  const hash = rec.fileHashWhenAnalyzed;
  if (!hash) {
    throw new Error(`Expected fileHashWhenAnalyzed in analyzed record for ${relFilePath}`);
  }
  return hash;
}

