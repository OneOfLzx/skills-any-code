import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs-extra'
import path from 'path'

import { startMockOpenAIServer } from '../utils/mock-openai-server'
import { createTestConfig } from '../utils/test-config-helper'
import { createLargeFixtureProject, mkdtempLargeProjectDir } from '../utils/large-project'

const execFileAsync = promisify(execFile)

function stripAnsi(input: string): string {
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    '',
  )
}

interface RunCliResult {
  code: number
  stdout: string
  stderr: string
}

async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<RunCliResult> {
  const repoRoot = path.join(__dirname, '../..')
  const cliAbs = path.join(repoRoot, 'dist', 'cli.js')

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliAbs, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs ?? 300000,
    })
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (e: any) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (e.message || String(e)),
    }
  }
}

describe('CLI e2e: 大项目解析不应 OOM/crash（问题6）', () => {
  const repoRoot = path.join(__dirname, '../..')
  const distCli = path.join(repoRoot, 'dist', 'cli.js')

  beforeAll(() => {
    const distOk = fs.pathExistsSync(distCli)
    if (!distOk) {
      if (process.env.ALLOW_SKIP_DIST_E2E === '1') {
        // eslint-disable-next-line no-console
        console.warn('[E2E-LARGE-PROJECT-NO-OOM] dist/cli.js missing, skipping due to ALLOW_SKIP_DIST_E2E=1')
        return
      }
      throw new Error('dist/cli.js missing; run build before e2e tests (or set ALLOW_SKIP_DIST_E2E=1)')
    }
  })

  const itWithDist = fs.pathExistsSync(distCli) ? it : it.skip

  itWithDist(
    'E2E-LARGE-PROJECT-NO-OOM-001: analyze full --concurrency 4 不应出现 heap OOM，且应以 exitCode=0 正常结束',
    async () => {
      const projectRoot = mkdtempLargeProjectDir('ca-large-cli')
      let configTempDir = ''
      const mock = await startMockOpenAIServer()

      try {
        await createLargeFixtureProject(projectRoot, {
          modules: 10,
          depth: 4,
          branching: 1,
          filesPerDir: 5,
          totalFilesTarget: 220,
          ext: '.ts',
        })

        const { configPath, tempDir } = await createTestConfig({
          llmBaseUrl: mock.baseUrl,
          llmApiKey: 'test',
          llmModel: 'mock',
          cacheEnabled: false,
          cacheMaxSizeMb: 0,
        })
        configTempDir = tempDir

        const { code, stdout, stderr } = await runCli(
          [
            'analyze',
            '--path',
            projectRoot,
            '--mode',
            'full',
            '--concurrency',
            '4',
            '--force',
            '--no-skills',
            '--llm-base-url',
            mock.baseUrl,
            '--llm-api-key',
            'test',
            '--llm-max-retries',
            '0',
            '--no-confirm',
            '-c',
            configPath,
          ],
          { timeoutMs: 360000 },
        )

        const combined = stripAnsi((stdout ?? '') + (stderr ?? ''))
        expect(code).toBe(0)
        expect(combined.toLowerCase()).not.toContain('heap out of memory')

        // CLI 结束信号（当前实现会输出“解析完成！共分析 X 个文件...”）
        expect(combined).toContain('解析完成')
        expect(combined).toContain('共分析')
      } finally {
        await mock.close()
        if (configTempDir) await fs.remove(configTempDir).catch(() => {})
        await fs.remove(projectRoot).catch(() => {})
      }
    },
    480000,
  )
})

