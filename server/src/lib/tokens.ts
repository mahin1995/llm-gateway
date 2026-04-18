import type { ChatMessage } from "../types.js";

export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(`${message.role}: ${message.content}`) + 4, 0);
}

export function truncateMessagesToTokenBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  const maxChars = Math.max(1, maxTokens * 4);
  const kept: ChatMessage[] = [];
  let remainingChars = maxChars;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const overhead = message.role.length + 2;
    const availableForContent = remainingChars - overhead;

    if (availableForContent <= 0) {
      break;
    }

    if (message.content.length <= availableForContent) {
      kept.unshift(message);
      remainingChars -= message.content.length + overhead;
      continue;
    }

    kept.unshift({
      ...message,
      content: message.content.slice(message.content.length - availableForContent)
    });
    break;
  }

  return kept;
}
