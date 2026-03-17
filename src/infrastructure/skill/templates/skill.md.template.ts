/**
 * SKILL.md 内容模板（符合 Agent Skills 开放标准）
 *
 * 该 Skill 名为 code-query，基于本项目已生成的 analysis-index.json，
 * 为 Agent / 开发者提供「给定源码绝对路径 → 查询已存在的 Markdown 分析结果路径」的只读能力。
 */
export function getSkillMdContent(): string {
  return `---
name: code-query
description: 基于本地分析索引，根据源码文件或目录的绝对路径，查询对应的代码分析结果 Markdown 文件路径。适用于在编码或对话过程中，快速定位任意文件/目录的分析报告，而无需重新触发完整解析流程。
compatibility: Requires Node.js runtime
---

# code-query Skill

## 概览

code-query 是对本项目「代码解析 / 分析」能力的只读封装。
它依赖 code-analyze 生成的结果目录与索引文件 analysis-index.json，
在不重新跑分析的前提下，根据源码的绝对路径快速定位到对应的 Markdown 分析报告文件。

## 能力

- 基于 analysis-index.json 的路径查询：
  - 输入：被分析项目中某个文件或目录的绝对路径。
  - 行为：读取 resolve-config.json 中的 indexFilePath，打开 analysis-index.json，在 entries 中查找该路径。
  - 输出：
    - 命中：返回对应 Markdown 报告的绝对路径；
    - 未命中：返回字符串 null。
- 同时覆盖文件与目录：
  - 文件 → 返回类似 C:/project/.code-analyze-result/src/utils/helper.md；
  - 目录 → 返回类似 C:/project/.code-analyze-result/src/components/index.md。
- 只读、无副作用：
  - 不修改任何业务源码文件；
  - 不触发新的 LLM 调用或重新解析，仅在既有索引上做查表操作。

## 使用方法

在被分析的项目根目录中，调用已部署的查询脚本，传入绝对路径：

\`\`\`bash
node scripts/resolve.js <absolute-path>
\`\`\`

- \`<absolute-path>\`：项目中某个文件或目录的绝对路径（如 \`C:/project/src/index.ts\` 或 \`C:/project/src\`）。

脚本内部执行过程如下：

1. 从 Skill 目录读取 resolve-config.json，获取 indexFilePath；
2. 打开 indexFilePath 指向的 analysis-index.json；
3. 对输入路径做归一化（统一路径分隔符等），在 entries 中查找；
4. 若命中：向 stdout 输出 resultPath（Markdown 报告绝对路径，单行）；
5. 若未命中：向 stdout 输出字符串 \`null\`（小写，单行）；
6. 若读取配置或索引失败：向 stderr 输出错误信息，并以退出码 1 结束。

## 输入 / 输出说明

| 项目             | 说明                                                   |
|------------------|--------------------------------------------------------|
| 输入参数         | 文件或目录的绝对路径（必须位于当前项目根目录之下）    |
| 成功（命中）     | stdout 单行输出对应 Markdown 结果文件的绝对路径       |
| 成功（未命中）   | stdout 单行输出字符串 \`null\`                         |
| 读取失败         | stderr 输出错误信息，退出码为 1                        |

## 示例

**查询文件：**
\`\`\`bash
node scripts/resolve.js C:/my-project/src/utils/helper.ts
# 可能输出：C:/my-project/.code-analyze-result/src/utils/helper.md
\`\`\`

**查询目录：**
\`\`\`bash
node scripts/resolve.js C:/my-project/src/components
# 可能输出：C:/my-project/.code-analyze-result/src/components/index.md
\`\`\`

**路径不存在或未参与解析：**
\`\`\`bash
node scripts/resolve.js C:/my-project/unknown/file.ts
# 输出：null
\`\`\`
`
}
