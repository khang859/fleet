import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { DEFAULT_CHAT_SETTINGS } from '../../shared/chat-types';

describe('AI settings defaults', () => {
  it('DEFAULT_SETTINGS carries the chat defaults', () => {
    expect(DEFAULT_SETTINGS.ai.chat).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(DEFAULT_SETTINGS.ai.chat.provider).toBe('openrouter');
    expect(DEFAULT_SETTINGS.ai.chat.defaultModel).toBe('deepseek/deepseek-v4-flash');
  });
});
