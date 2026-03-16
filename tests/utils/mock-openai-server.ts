import http from 'http';
import { AddressInfo } from 'net';

type MockOpenAIOptions = {
  /**
   * If provided, always return this JSON object as the model content (stringified).
   * Otherwise, a generic FileAnalysis-like JSON will be returned.
   */
  fixedContent?: Record<string, any>;
  /**
   * 1-based request indices that should return 5xx (e.g. [2] = second LLM request returns 500).
   * Used for ST-LLM-PARTIAL-FAIL-001.
   */
  failRequestIndices?: number[];
  /**
   * 若提供，则请求 body 内容（字符串）包含任一子串时返回 500。用于按路径确定性失败（如 two.ts）。
   */
  failRequestBodyIncludes?: string[];
};

export async function startMockOpenAIServer(options: MockOpenAIOptions = {}) {
  let requestCount = 0;
  const failRequestIndices = new Set(options.failRequestIndices ?? []);
  const failRequestBodyIncludes = options.failRequestBodyIncludes ?? [];

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || req.method !== 'POST') {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      // OpenAI SDK with baseURL ".../v1" will call "/chat/completions"
      if (!req.url.endsWith('/chat/completions')) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve());
      });
      const bodyStr = Buffer.concat(chunks).toString('utf-8');

      requestCount += 1;
      if (failRequestIndices.has(requestCount)) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'mock server error (injected)' }));
        return;
      }
      if (failRequestBodyIncludes.some((s) => bodyStr.includes(s))) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'mock server error (path-injected)' }));
        return;
      }

      const contentObj =
        options.fixedContent ??
        ({
          name: 'mock-file',
          language: 'TypeScript',
          linesOfCode: 1,
          dependencies: [],
          summary: 'mock summary',
          classes: [],
          functions: [],
          classDiagram: '',
          sequenceDiagram: '',
        } satisfies Record<string, any>);

      const responseBody = {
        id: 'mock-chatcmpl-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify(contentObj),
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      };

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responseBody));
    } catch (e: any) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e?.message || 'mock server error' }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

