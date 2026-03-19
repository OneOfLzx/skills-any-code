# 🛠️ Skill Any Code (sac)

**Redefines codebase indexing by Agent Skills**.

**Skill Any Code** is a high-performance CLI tool designed to transform complex code repositories into "Skill Maps" that Large Language Models (LLMs) and AI Agents can actually navigate. By generating natural language summaries and adhering to the standard **Agent Skills** protocol, it enables LLMs to explore code through **Progressive Disclosure**. No more context-window bloat; no more AI hallucinations caused by overwhelming raw source code.


## ✨ Why Skill Any Code?

* **🗺️ Progressive Understanding, Zero Context Bloat**: Traditional methods "dump" the entire codebase into the LLM, wasting tokens and causing confusion. **sac** generates hierarchical Markdown summaries, allowing the LLM to navigate layer-by-layer—only diving deep when necessary.
* **🤖 Native Agent Skills Support**: Automatically generates `SKILL.md` and routing scripts compatible with the [Agent Skills](https://agentskills.io/) specification. Works out-of-the-box with AI-native editors like Cursor, Claude Code, and GitHub Copilot.
* **🧠 Natural Language Indexing**: Translates dry code files into rich descriptions—including overviews, core purposes, key functions, and class definitions—dramatically increasing the LLM's reasoning accuracy.


## 📦 Quick Start

### 1. Install the CLI:

```Bash
npm i -g skill-any-code

npm init
# Config your LLM API Key in ~/.config/skill-any-code/config.yaml
```

### 2. Generate Summaries:

```Bash
cd <your_project_path>

# Start generating summaries
sac
```


## 🚀 How it Works

1.  **Bottom-Up Recursive Analysis**: The CLI starts from the deepest files in your project. It uses LLM power to extract **classes, functions, and core logic** from raw code. As it moves up, it aggregates these snippets into high-level directory summaries, ensuring every layer of your project has a concise "executive summary."
2.  **Semantic Indexing**: The process results in a structured Markdown knowledge base. This is not just a file list; it’s a **Semantic Index** where top-level folders explain "Why" and "What," while leaf-node files explain "How."
3.  **Skill Injection**: **sac** deploys a `SKILL.md` and a cross-platform routing script (`get_summary.py`) to your root. This grants any AI Agent the "Skill" to navigate your codebase intelligently without reading every line of code.
4.  **Progressive Discovery**: Instead of a "Big Bang" context dump, the AI explores your repo layer-by-layer:
    * **Identify**: Check the root summary to find the relevant module.
    * **Drill-down**: Use the Skill script to fetch sub-directory summaries.
    * **Locate**: Reach the target file summary with surgical precision.

<p align="center">
  <img src="docs/readme_img.png" alt="Skill Any Code Bottom-Up Parsing and Navigation Workflow" width="90%" />
</p>


## TODO
1.  支持没有代码的文件解析，例如mk文件
2.  解析文件中的结构体定义
3.  解析文件的全局变量
