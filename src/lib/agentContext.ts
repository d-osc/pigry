export function shortenContext(text: string, limit: number, hint: string): string {
  if (text.length <= limit) return text;
  const marker = `\n[… ${hint} …]\n`;
  if (marker.length + 4 >= limit) return text.slice(0, limit);
  const remaining = limit - marker.length;
  const tail = Math.floor(remaining / 4);
  return text.slice(0, remaining - tail) + marker + text.slice(-tail);
}

type Message = Record<string, unknown>;

export function recentChatContext(messages: { role: 'user' | 'assistant'; text: string }[]): Message[] {
  return messages.slice(-20).filter((message) => message.text.trim()).map((message) => ({
    role: message.role,
    content: message.text,
  }));
}
