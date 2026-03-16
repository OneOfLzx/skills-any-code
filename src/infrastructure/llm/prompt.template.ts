// ===== 三步协议：单文件（需求 10.5.3 / 10.9.1）=====
/** 第一步：仅提取结构信息，不包含 summary/description */
export const FILE_STRUCTURE_PROMPT = `
请仅提取以下代码文件中的「类定义」和「全局函数」结构，返回严格的JSON，不要包含任何其他文本。不要生成功能描述或概述。

文件路径: {{filePath}}
文件内容:
{{fileContent}}

返回的JSON结构（仅包含以下字段）：
{
  "name": "文件名（不含路径）",
  "language": "代码语言类型",
  "linesOfCode": 代码行数（数字）,
  "dependencies": ["依赖的模块列表"],
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

若无对应内容则返回空数组；不要输出 summary、description、classDiagram、sequenceDiagram。
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
  "name": "文件名（不含路径）",
  "language": "代码语言类型",
  "linesOfCode": 总代码行数（数字）,
  "dependencies": ["所有依赖去重后的列表"],
  "classes": [ 合并去重后的所有类定义 ],
  "functions": [ 合并去重后的所有函数定义 ]
}

classes/functions 的每项格式与分片中的一致。不要输出 summary、description、classDiagram、sequenceDiagram。
`;

export const CODE_ANALYSIS_PROMPT = `
请分析以下代码文件，返回严格的JSON格式结果，不要包含任何其他文本。

文件路径: {{filePath}}
文件内容:
{{fileContent}}

需要返回的JSON结构如下：
{
  "name": "文件名（不含路径）",
  "language": "代码语言类型",
  "linesOfCode": 代码行数（数字）,
  "dependencies": ["依赖的模块列表"],
  "summary": "文件核心功能描述（100字以内）",
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
  ],
  "classDiagram": "Mermaid类图代码（如果有类的话）",
  "sequenceDiagram": "Mermaid时序图代码，展示核心方法调用流程"
}

注意：
1. 严格按照JSON格式返回，不要有任何额外说明
2. 如果没有对应的内容，返回空数组或空字符串
3. Mermaid代码要合法，可直接渲染
4. 所有描述用中文
`;

export const CHUNK_ANALYSIS_PROMPT = `
请分析以下代码文件分片，返回严格的JSON格式结果，不要包含任何其他文本。

文件路径: {{filePath}}
分片ID: {{chunkId}}
分片内容:
{{chunkContent}}
上下文: {{context}}

需要返回的JSON结构如下：
{
  "basicInfo": {
    "language": "代码语言类型（可选）",
    "dependencies": ["依赖的模块列表"],
    "linesOfCode": 本分片代码行数
  },
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
  ],
  "partialDiagrams": {
    "classDiagram": "本分片相关的Mermaid类图代码片段",
    "sequenceDiagram": "本分片相关的Mermaid时序图代码片段"
  },
  "summary": "本分片核心功能描述"
}

注意：
1. 严格按照JSON格式返回，不要有任何额外说明
2. 如果没有对应的内容，返回空数组或空字符串
3. 只分析当前分片的内容，上下文仅作参考
4. 所有描述用中文
`;

export const MERGE_CHUNKS_PROMPT = `
请合并以下多个代码分片的分析结果，生成完整的文件分析结果，返回严格的JSON格式。

文件路径: {{filePath}}
分片分析结果列表:
{{chunkResults}}

需要返回的完整JSON结构如下：
{
  "name": "文件名（不含路径）",
  "language": "代码语言类型",
  "linesOfCode": 总代码行数（数字）,
  "dependencies": ["所有依赖的模块列表，去重"],
  "summary": "文件整体核心功能描述（100字以内）",
  "classes": [
    合并后的所有类定义，去重，合并同一个类的不同部分
  ],
  "functions": [
    合并后的所有函数定义，去重
  ],
  "classDiagram": "合并后的完整Mermaid类图代码",
  "sequenceDiagram": "合并后的完整Mermaid时序图代码，展示核心方法调用流程"
}

注意：
1. 严格按照JSON格式返回，不要有任何额外说明
2. 合并时去重相同的类、方法、函数
3. 确保类图和时序图完整合法，可直接渲染
4. 所有描述用中文
`;
