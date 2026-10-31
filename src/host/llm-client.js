/**
 * Simple LLM client compatible with ds-bot's llm.stream() interface
 * Supports OpenAI-compatible APIs (OpenAI, DeepSeek, etc.)
 */

export function createLLMClient(config) {
  const {
    provider = 'openai',
    baseURL: rawBaseURL = 'https://api.openai.com/v1',
    apiKey,
    model = 'gpt-3.5-turbo',
    log = () => {},
  } = config;

  const baseURL = normalizeBaseURL(rawBaseURL);

  if (!apiKey) {
    log('LLM client created without API key - calls will fail');
  }

  async function* stream({ messages, maxTokens = 1000, temperature = 0.7 }) {
    if (!apiKey) {
      throw new Error('LLM API key not configured');
    }

    const url = `${baseURL}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error (${response.status}): ${error}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield { type: 'text', text: content };
            }
          } catch (e) {
            log(`Failed to parse SSE chunk: ${e.message}`);
          }
        }
      }
    } catch (error) {
      log(`LLM stream error: ${error.message}`);
      throw error;
    }
  }

  async function testConnection() {
    if (!apiKey) {
      return { ok: false, error: 'API key not configured' };
    }

    try {
      const url = `${baseURL}/chat/completions`;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };

      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi! Reply with just "OK"' }],
        max_tokens: 50,
        stream: false,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });

      const responseText = await response.text();

      if (!response.ok) {
        let errorDetail = responseText;
        try {
          const errorJson = JSON.parse(responseText);
          errorDetail = errorJson.error?.message || errorJson.message || responseText;
        } catch {
          // Keep original text if not JSON
        }
        return { 
          ok: false, 
          error: `HTTP ${response.status}: ${errorDetail}`,
          status: response.status,
          body: responseText.slice(0, 500), // First 500 chars
        };
      }

      const result = JSON.parse(responseText);
      const reply = result.choices?.[0]?.message?.content || '(empty response)';
      
      return { ok: true, response: reply.trim() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return {
    stream,
    testConnection,
  };
}

/**
 * Normalize base URL - ensure it ends with /v1 for OpenAI-compatible APIs
 */
function normalizeBaseURL(url) {
  if (!url) return url;
  url = url.trim().replace(/\/+$/, ''); // Remove trailing slashes
  if (!url.endsWith('/v1')) {
    url = `${url}/v1`;
  }
  return url;
}

export const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  },
  anthropic: {
    name: 'Anthropic (via OpenAI adapter)',
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
    note: 'Requires OpenAI-compatible proxy',
  },
  moonshot: {
    name: 'Moonshot (月之暗面)',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  zhipu: {
    name: 'ZhipuAI (智谱清言)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4', 'glm-4-plus', 'glm-3-turbo'],
  },
  custom: {
    name: '自定义 / Custom',
    baseURL: '',
    models: [],
  },
};
