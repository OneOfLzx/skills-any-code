// ===== Three-step protocol: single file =====
/** Step 1: Extract structure only (classes / globals / functions). No summary/description/basic info. */
export const FILE_STRUCTURE_PROMPT = `
Extract ONLY the following structure from the code file. Return STRICT JSON and nothing else.
Do NOT generate summary/description or any basic info (language, LOC, dependencies, etc.).

File path: {{filePath}}
File content:
{{fileContent}}

Return JSON with ONLY these fields:
{
  "classes": [
    {
      "name": "ClassName",
      "extends": "ParentClassName or null",
      "implements": ["InterfaceName", "..."],
      "methods": [
        { "name": "methodName", "signature": "methodSignature", "description": "what it does", "visibility": "public|private|protected" }
      ],
      "properties": [
        { "name": "propertyName", "type": "propertyType", "description": "what it represents", "visibility": "public|private|protected" }
      ]
    }
  ],
  "functions": [
    { "name": "functionName", "signature": "functionSignature", "description": "what it does" }
  ]
}

If nothing is found, return empty arrays. Do NOT output any other fields.
`;

/** Step 2: Generate description only (<= 200 words) */
export const FILE_DESCRIPTION_PROMPT = `
Based on the extracted structure JSON below, describe the overall purpose of this file in <= 200 words.
Return ONLY one JSON object: {"description": "..."}. No other text.

Structure JSON:
{{structureJson}}
`;

/** Step 3: Generate summary only (<= 100 words) */
export const FILE_SUMMARY_PROMPT = `
Based on the structure and description below, write a one-sentence high-level summary in <= 100 words.
Return ONLY one JSON object: {"summary": "..."}. No other text.

Structure JSON:
{{structureJson}}

Description:
{{description}}
`;

/** Retry hint when parsing fails (append to original prompt) */
export const PARSE_RETRY_HINT = `

[IMPORTANT] Your previous output did NOT match the required format.
Return STRICTLY the JSON specified above and NOTHING ELSE (no markdown, no explanations, no extra text).
`;

// ===== Merge stage =====
/** Merge step: merge and deduplicate multiple chunk results into one structure */
export const MERGE_STRUCTURE_PROMPT = `
Below are analysis results for multiple chunks of the same file. Merge and deduplicate them into ONE complete structure (classes and global functions).
Return ONLY JSON. Do NOT generate description or summary.

File path: {{filePath}}
Chunk results:
{{chunkResults}}

Return JSON with ONLY these fields:
{
  "classes": [
    {
      "name": "ClassName",
      "extends": "ParentClassName or null",
      "implements": ["InterfaceName", "..."],
      "methods": [
        { "name": "methodName", "signature": "methodSignature", "description": "what it does", "visibility": "public|private|protected" }
      ],
      "properties": [
        { "name": "propertyName", "type": "propertyType", "description": "what it represents", "visibility": "public|private|protected" }
      ]
    }
  ],
  "functions": [
    { "name": "functionName", "signature": "functionSignature", "description": "what it does" }
  ]
}

Keep item formats consistent with the chunk results. Do NOT output any other fields.
`;

// ===== Directory two-step protocol =====
/** Directory step 1: generate description (<= 200 words) */
export const DIRECTORY_DESCRIPTION_PROMPT = `
You are a codebase structure analysis assistant. Below is a JSON list of all direct child directories and files (with brief summaries).
Write an English paragraph (<= 200 words) describing the directory's role and responsibilities in the project.

Return ONLY one JSON object: {"description": "..."}. No other text.

Children (JSON):
{{childrenJson}}
`;

/** Directory step 2: generate summary (<= 100 words) */
export const DIRECTORY_SUMMARY_PROMPT = `
Based on the directory description and children JSON below, write a one-sentence high-level summary in English (<= 100 words).
Focus on the big picture and avoid details.

Return ONLY one JSON object: {"summary": "..."}. No other text.

Directory description:
{{description}}

Children (JSON):
{{childrenJson}}
`;

export const CODE_ANALYSIS_PROMPT = `
(Deprecated legacy prompt. Kept empty for backward compatibility; not used in the main pipeline.)
`;

export const CHUNK_ANALYSIS_PROMPT = `
Analyze the following code chunk. Extract ONLY the structure that is confidently present in THIS chunk (classes, global variables, global functions).
Return STRICT JSON and nothing else. Do NOT generate description, summary, or diagrams.

File path: {{filePath}}
Chunk ID: {{chunkId}}
Chunk content:
{{chunkContent}}
Context (reference only): {{context}}

Return JSON with ONLY these fields:
{
  "classes": [
    {
      "name": "ClassName",
      "extends": "ParentClassName or null",
      "implements": ["InterfaceName", "..."],
      "methods": [
        {
          "name": "methodName",
          "signature": "methodSignature",
          "description": "what it does",
          "visibility": "public|private|protected"
        }
      ],
      "properties": [
        {
          "name": "propertyName",
          "type": "propertyType",
          "description": "what it represents",
          "visibility": "public|private|protected"
        }
      ]
    }
  ],
  "functions": [
    {
      "name": "functionName",
      "signature": "functionSignature",
      "description": "what it does"
    }
  ]
}

Rules:
1) Output STRICT JSON only (no extra text)
2) If nothing is found, return empty arrays
3) Analyze ONLY this chunk; context is reference only
4) Do NOT output fields like basicInfo, partialDiagrams, summary, description, etc.
5) Write all descriptions in English
`;
