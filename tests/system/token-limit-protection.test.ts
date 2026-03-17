import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as os from 'os'
import { startMockOpenAIServer } from '../utils/mock-openai-server'
import { TestProjectFactory } from '../utils/test-project-factory'
import { createTestConfig } from '../utils/test-config-helper'

const execAsync = promisify(exec)

function stripAnsi(input: string): string {
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    '',
  )
}

describe('资源保护：累计 Token 上限防止大型项目解析 OOM (问题6)', () => {
  const repoRoot = path.join(__dirname, '../..')

  beforeAll(async () => {
    // 确保 dist/cli.js 已构建
    await execAsync('npm run build', { cwd: repoRoot })
  })

  it(
    '当累计 Token 超过上限时应优雅中止且退出码为 1',
    async () => {
      const mock = await startMockOpenAIServer()
      const project = await TestProjectFactory.create('large', false)

      let configTempDir: string | undefined
      try {
        const { configPath, tempDir } = await createTestConfig({
          llmBaseUrl: mock.baseUrl,
          llmApiKey: 'test',
          llmModel: 'mock',
          cacheEnabled: false,
          cacheMaxSizeMb: 0,
        })
        configTempDir = tempDir

        // 通过环境变量设置较低的累计 Token 上限，模拟「超大项目 + token 过多」场景
        const env = {
          ...process.env,
          CODE_ANALYZE_LLM_MAX_TOTAL_TOKENS: '50',
        }

        let code = 0
        let combined = ''
        try {
          const { stdout, stderr } = await execAsync(
            // commander 的全局选项需要放在子命令之前（否则 program.opts().config 取不到）
            `node dist/cli.js -c "${configPath}" analyze --path "${project.path}" --mode full --force --no-skills --llm-max-retries 0 --no-confirm`,
            { cwd: repoRoot, env, timeout: 300000 },
          )
          combined = (stdout ?? '') + (stderr ?? '')
        } catch (e: any) {
          code = typeof e.code === 'number' ? e.code : 1
          combined = String(e.stdout ?? '') + String(e.stderr ?? '')
        }

        const output = stripAnsi(combined)

        // 1) 不应进程级崩溃（如信号 9），而是以受控退出码结束
        expect(code).toBe(1)

        // 2) 输出中包含清晰的资源保护提示，而不是裸栈或 V8 OOM 信息
        expect(output).toContain('累计 Token 使用量超过上限')
        expect(output).toContain('为防止进程 OOM 已安全中止')

        // 3) 给出减小范围/黑名单/分模块等操作建议
        expect(output).toContain('降低解析深度')
        expect(output).toContain('缩小解析路径范围')
        expect(output).toContain('增加黑名单')
      } finally {
        await mock.close()
        await project.cleanup()
        if (configTempDir) {
          await fs.remove(configTempDir).catch(() => {})
        }
      }
    },
    480000,
  )
})

