/** Reads the text out of a one-shot chat reply, whatever shape the provider used, and says why when there is none.
 * Pure: the node tests load it directly. */

export interface ChatReply {
  text: string;
  /** finish_reason / stop_reason, when the provider gave one. */
  finishReason: string;
  /** True when the model sent reasoning but no answer. */
  reasoningOnly: boolean;
}

type Part = { type?: string; text?: string };

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Part[])
      .filter((part) => part && typeof part.text === 'string' && part.type !== 'reasoning' && part.type !== 'thinking')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

interface Parsed {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: string; reasoning?: string };
    delta?: { content?: unknown; reasoning_content?: string };
    text?: string;
    finish_reason?: string;
  }>;
  content?: Part[];
  stop_reason?: string;
  output_text?: string;
  output?: Array<{ type?: string; content?: Part[] }>;
  status?: string;
  incomplete_details?: { reason?: string };
}

/** A body sent as server-sent events although `stream: false` was asked for: the deltas joined. */
function fromEventStream(body: string, anthropic: boolean): ChatReply | null {
  const events = body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (events.length === 0) return null;
  let text = '';
  let reasoning = '';
  let finishReason = '';
  for (const data of events) {
    if (!data || data === '[DONE]') continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    if (anthropic) {
      const delta = event.delta as { type?: string; text?: string; thinking?: string; stop_reason?: string } | undefined;
      if (delta?.type === 'text_delta') text += delta.text ?? '';
      if (delta?.type === 'thinking_delta') reasoning += delta.thinking ?? '';
      if (delta?.stop_reason) finishReason = delta.stop_reason;
    } else {
      const choice = (event as Parsed).choices?.[0];
      text += partsText(choice?.delta?.content);
      reasoning += choice?.delta?.reasoning_content ?? '';
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { text, finishReason, reasoningOnly: !text.trim() && !!reasoning.trim() };
}

/** The answer text of an Anthropic Messages, OpenAI Chat Completions or OpenAI Responses reply. */
export function readChatReply(body: string, anthropic: boolean): ChatReply {
  let parsed: Parsed | null = null;
  try { parsed = JSON.parse(body) as Parsed; } catch { parsed = null; }
  if (!parsed) return fromEventStream(body, anthropic) ?? { text: '', finishReason: '', reasoningOnly: false };

  if (anthropic || Array.isArray(parsed.content)) {
    const blocks = parsed.content ?? [];
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('');
    return { text, finishReason: parsed.stop_reason ?? '', reasoningOnly: !text.trim() && blocks.some((block) => block?.type === 'thinking') };
  }
  const choice = parsed.choices?.[0];
  if (choice) {
    const text = partsText(choice.message?.content) || choice.text || '';
    const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning ?? '';
    return { text, finishReason: choice.finish_reason ?? '', reasoningOnly: !text.trim() && !!reasoning.trim() };
  }
  // Responses API.
  const output = parsed.output ?? [];
  const text = parsed.output_text
    ?? output.filter((item) => item?.type === 'message').map((item) => partsText(item.content)).join('');
  return {
    text,
    finishReason: parsed.incomplete_details?.reason ?? (parsed.status && parsed.status !== 'completed' ? parsed.status : ''),
    reasoningOnly: !text.trim() && output.some((item) => item?.type === 'reasoning'),
  };
}

/** Why a reply has no text, in words the user can act on. */
export function emptyReplyMessage(used: string, reply: ChatReply, body: string): string {
  const reason = reply.finishReason;
  if (/length|max_tokens|max_output_tokens/i.test(reason)) {
    return `${used} ran out of output tokens before it answered (${reason}). Try a lower effort, or raise the model’s max output tokens in Settings → AI Provider.`;
  }
  if (reply.reasoningOnly) {
    return `${used} only sent its reasoning and no answer${reason ? ` (${reason})` : ''}. Try again, or try a lower effort.`;
  }
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${used} returned an empty reply${reason ? ` (${reason})` : ''}.${snippet ? ` The provider sent: ${snippet}` : ''}`;
}
