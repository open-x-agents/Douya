/**
 * Simple LLM client compatible with ds-bot's llm.stream() interface
 * Supports OpenAI-compatible APIs (OpenAI, DeepSeek, etc.)
 */

export function createLLMClient(config) {
  const {
    provider = 'openai',
    baseURL = 'https://api.openai.com/v1',
    apiKey,
    model = 'gpt-3.5-turbo',
    log = () => {},
  } = config;

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
      const messages = [{ role: 'user', content: 'Hi! Reply with just "OK"' }];
      let response = '';
      
      for await (const chunk of stream({ messages, maxTokens: 50 })) {
        if (chunk.type === 'text') {
          response += chunk.text;
        }
      }

      return { ok: true, response: response.trim() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return {
    stream,
    testConnection,
  };
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
    models: ['deepseek-chat', 'deepseek-coder'],
  },
  custom: {
    name: 'Custom',
    baseURL: '',
    models: [],
  },
};
