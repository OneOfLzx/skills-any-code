import { z } from 'zod'

export const AnalyzeProjectCommandSchema = z.object({
  path: z.string().optional().describe('指定解析的项目根路径，默认当前工作目录'),
  mode: z.enum(['full', 'incremental', 'auto']).default('auto').describe('解析模式'),
  depth: z.number().int().min(1).optional().describe('解析深度，默认无限制'),
  concurrency: z.number().int().min(1).optional().describe('并行解析并发数，默认CPU核心数*2'),
  outputDir: z.string().optional().describe('结果输出目录'),
  skillsProviders: z.array(z.string()).optional().describe('Skill 部署的 AI 工具标识列表'),
  noSkills: z.boolean().optional().describe('是否跳过 Skill 生成')
})

export type AnalyzeProjectCommandParams = z.infer<typeof AnalyzeProjectCommandSchema>

export const ProjectCodeQuerySkillSchema = z.object({
  path: z.string().describe('需要查询的文件/目录相对项目根的路径'),
  type: z.enum(['summary', 'full', 'diagram']).default('summary').describe('查询类型'),
  projectSlug: z.string().optional().describe('项目唯一标识，默认当前项目')
})

export type ProjectCodeQuerySkillParams = z.infer<typeof ProjectCodeQuerySkillSchema>
