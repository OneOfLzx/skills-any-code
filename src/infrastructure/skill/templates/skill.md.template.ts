/**
 * SKILL.md 内容模板（符合 Agent Skills 开放标准）
 */
export function getSkillMdContent(): string {
  return `---
name: code-query
description: 根据源码文件或目录的绝对路径，查询对应的代码分析结果 Markdown 文件路径。适用于在编码过程中快速获取任意文件/目录的解析结果，无需重新解析。
compatibility: Requires Node.js runtime
---

# code-query Skill

## 使用场景

- 需要查看某个源码文件或目录的已解析结果时；
- AI 编程助手需要根据用户当前编辑的文件定位到对应的分析报告时；
- 希望在不重新执行 \`code-analyze analyze\` 的前提下读取历史解析内容时。

## 使用方法

调用项目内部署的查询脚本，传入**绝对路径**：

\`\`\`bash
node scripts/resolve.js <absolute-path>
\`\`\`

- \`<absolute-path>\`：被解析项目中某个文件或目录的绝对路径（如 \`C:/project/src/index.ts\` 或 \`C:/project/src\`）。

## 使用流程

1. 运行上述命令，脚本会读取 \`resolve-config.json\` 中的索引文件路径，并在索引中查找输入路径；
2. 若找到：脚本向 stdout 输出对应的 Markdown 结果文件绝对路径（单行）；
3. 若未找到：脚本向 stdout 输出 \`N/A\`（单行）；
4. 当返回值不是 \`N/A\` 时，读取该 Markdown 文件即可获得目标文件/目录的完整结构化解析信息。

## 输入输出说明

| 项目 | 说明 |
|------|------|
| 输入 | 文件或目录的绝对路径 |
| 成功（找到） | Markdown 结果文件的绝对路径（单行，stdout） |
| 成功（未找到） | \`N/A\`（单行，stdout） |
| 失败 | 错误信息输出到 stderr，退出码 1 |

## 示例

**查询文件：**
\`\`\`bash
node scripts/resolve.js C:/my-project/src/utils/helper.ts
# 输出：C:/my-project/.code-analyze-result/src/utils/helper.md
\`\`\`

**查询目录：**
\`\`\`bash
node scripts/resolve.js C:/my-project/src/components
# 输出：C:/my-project/.code-analyze-result/src/components/index.md
\`\`\`

**路径不存在或未参与解析：**
\`\`\`bash
node scripts/resolve.js C:/my-project/unknown/file.ts
# 输出：N/A
\`\`\`
`
}
