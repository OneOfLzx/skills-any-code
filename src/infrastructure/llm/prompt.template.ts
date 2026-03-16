// ===== 三步协议：单文件（需求 10.5.3 / 10.9.1）=====
/** 第一步：仅提取结构信息（类 / 全局变量 / 全局函数），不包含 summary/description 及基础信息 */
export const FILE_STRUCTURE_PROMPT = `
请仅提取以下代码文件中的「类定义」「全局变量」「全局函数」结构，返回严格的JSON，不要包含任何其他文本。不要生成功能描述、概述或基础信息（语言、行数、依赖等）。

文件路径: {{filePath}}
文件内容:
{{fileContent}}

返回的JSON结构（仅包含以下字段）：
{
  "classes": [
    {
      "name": "类名",
      "extends": "继承的父类名（没有则为null）",
      "implements": ["实现的接口列表（没有则为空数组）"],
      "methods": [
        { "name": "方法名", "signature": "方法签名", "description": "方法功能描述", "visibility": "public/private/protected" }
      ],
      "properties": [
        { "name": "属性名", "type": "属性类型", "description": "属性描述", "visibility": "public/private/protected" }
      ]
    }
  ],
  "functions": [
    { "name": "函数名", "signature": "函数签名", "description": "函数功能描述" }
  ]
}

若无对应内容则返回空数组；不要输出 summary、description、classDiagram、sequenceDiagram，也不要输出 language、linesOfCode、dependencies 等基础信息。
`;

/** 第二步：仅生成功能描述（200字以内） */
export const FILE_DESCRIPTION_PROMPT = `
根据以下已提取的代码结构信息，用一段话描述该文件的整体功能，200字以内。只返回一个JSON对象：{"description": "你的描述"}，不要其他内容。

结构信息：
{{structureJson}}
`;

/** 第三步：仅生成概述（100字以内） */
export const FILE_SUMMARY_PROMPT = `
根据以下代码结构及功能描述，用一句话概括该文件的核心作用，100字以内。只返回一个JSON对象：{"summary": "你的概述"}，不要其他内容。

结构信息：
{{structureJson}}

功能描述：
{{description}}
`;

/** 解析失败时的重试提示（追加到原提示） */
export const PARSE_RETRY_HINT = `

【重要】上一次输出格式不符合要求，请严格只输出上述JSON结构，不要包含任何额外说明、markdown 标记或前后文字。
`;

// ===== 合并阶段三步协议（需求 10.7.1 / 10.9.4）=====
/** 合并阶段第一步：将多分片结果合并为统一结构 */
export const MERGE_STRUCTURE_PROMPT = `
以下是对同一文件的多个分片的分析结果，请合并、去重为一份完整的结构（类与全局函数）。只返回JSON，不要功能描述或概述。

文件路径: {{filePath}}
分片结果列表:
{{chunkResults}}

返回的JSON结构（仅包含以下字段）：
{
  "classes": [
    {
      "name": "类名",
      "extends": "继承的父类名（没有则为null）",
      "implements": ["实现的接口列表（没有则为空数组）"],
      "methods": [
        { "name": "方法名", "signature": "方法签名", "description": "方法功能描述", "visibility": "public/private/protected" }
      ],
      "properties": [
        { "name": "属性名", "type": "属性类型", "description": "属性描述", "visibility": "public/private/protected" }
      ]
    }
  ],
  "functions": [
    { "name": "函数名", "signature": "函数签名", "description": "函数功能描述" }
  ]
}

classes/functions 的每项格式与分片中的一致。不要输出 summary、description、classDiagram、sequenceDiagram。
`;

// ===== 目录两步协议（需求 10.6.3 / 10.9.3）=====
/** 目录第一步：根据子项精简信息生成功能描述（description，200 字以内） */
export const DIRECTORY_DESCRIPTION_PROMPT = `
你是一个代码结构分析助手。下面是某个目录下所有直接子目录和子文件的精简信息，请用一段不超过 200 字的中文自然语言，总结该目录在项目中的功能定位和主要职责。

只返回一个 JSON对象：{"description": "你的功能描述"}，不要输出任何其他内容。

子目录和子文件精简信息（JSON）：
{{childrenJson}}
`;

/** 目录第二步：在同一会话中基于功能描述生成概述（summary，100 字以内） */
export const DIRECTORY_SUMMARY_PROMPT = `
基于下面的目录功能描述和子项精简信息，请用一句不超过 100 字的中文话，总结该目录的核心作用，侧重高层概括，避免细节展开。

只返回一个 JSON 对象：{"summary": "你的概述"}，不要输出任何其他内容。

目录功能描述：
{{description}}

子目录和子文件精简信息（JSON）：
{{childrenJson}}
`;

export const CODE_ANALYSIS_PROMPT = `
（已废弃的旧版一次性解析提示，保留为空以兼容现有引用，不再用于主流程）
`;

export const CHUNK_ANALYSIS_PROMPT = `
请分析以下代码文件分片，提取当前分片中「可确定的类定义、全局变量、全局函数」结构信息，返回严格的JSON格式结果，不要包含任何其他文本。不要生成功能描述、概述或图表。

文件路径: {{filePath}}
分片ID: {{chunkId}}
分片内容:
{{chunkContent}}
上下文: {{context}}

需要返回的JSON结构如下（仅包含以下字段）：
{
  "classes": [
    {
      "name": "类名",
      "extends": "继承的父类名（没有则为null）",
      "implements": ["实现的接口列表（没有则为空数组）"],
      "methods": [
        {
          "name": "方法名",
          "signature": "方法签名",
          "description": "方法功能描述",
          "visibility": "public/private/protected"
        }
      ],
      "properties": [
        {
          "name": "属性名",
          "type": "属性类型",
          "description": "属性描述",
          "visibility": "public/private/protected"
        }
      ]
    }
  ],
  "functions": [
    {
      "name": "函数名",
      "signature": "函数签名",
      "description": "函数功能描述"
    }
  ]
}

注意：
1. 严格按照JSON格式返回，不要有任何额外说明
2. 如果没有对应的内容，返回空数组或空字符串
3. 只分析当前分片的内容，上下文仅作参考
4. 不要输出 basicInfo、partialDiagrams、summary 等字段
5. 所有描述用中文
`;
