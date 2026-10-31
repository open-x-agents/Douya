/**
 * Server-side configuration storage for sensitive data like API keys
 * Stores in a local JSON file, never sends full keys to client
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ConfigStore {
  constructor(path) {
    this.path = path;
    this.config = null;
  }

  async load() {
    try {
      const data = await readFile(this.path, 'utf-8');
      this.config = JSON.parse(data);
    } catch {
      this.config = {
        composioApiKey: null,
        composioEntityId: 'default',
        digestSchedule: '08:00',
        digestSources: [],
        digestRecipients: [],
      };
    }
    return this.config;
  }

  get() {
    return this.config || {};
  }

  async save(updates) {
    this.config = {
      ...this.config,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.config, null, 2), 'utf-8');
    
    return this.config;
  }

  /**
   * Get masked version of API key (safe to send to client)
   */
  getMaskedKey() {
    const key = this.config?.composioApiKey;
    if (!key || typeof key !== 'string') return null;
    if (key.length < 8) return '***';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }

  getMaskedLLMKey() {
    const key = this.config?.llm?.apiKey;
    if (!key || typeof key !== 'string') return null;
    if (key.length < 8) return '***';
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
  }

  /**
   * Check if Composio is configured
   */
  isConfigured() {
    return !!(this.config?.composioApiKey);
  }

  isLLMConfigured() {
    return !!(this.config?.llm?.apiKey && this.config?.llm?.provider);
  }
}

export function createConfigStore(path) {
  return new ConfigStore(path);
}
