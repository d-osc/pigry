/** Lets an installed coding-agent CLI (Claude Code with the user's subscription, Codex) act as an ordinary chat model for Pigry's agent loop.
 *
 * The loop builds an OpenAI-style request (messages, tools, images). This module turns it into one CLI call with the CLI's own tools
 * switched off, and turns the answer back into an OpenAI-style response — so history, attached context, images, Pigry's tools and
 * guards, parallel agents, token counts and effort all work exactly as with an API provider. Tool calls travel as a small JSON text
 * protocol because a CLI has no function-calling API. */

export const CLI_ENDPOINT_PREFIX = 'cli://';
export const isCliEndpoint = (url: string): boolean => url.startsWith(CLI_ENDPOINT_PREFIX);
export const cliOfEndpoint = (url: string): string => url.slice(CLI_ENDPOINT_PREFIX.length).split(/[?#]/)[0];

interface ToolDef { name: string; description: string; parameters: unknown }
interface ChatMessage { role?: string; content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>; tool_call_id?: string }
export interface OpenAiBody { model?: string; messages?: ChatMessage[]; tools?: Array<{ function?: ToolDef }>; output_config?: { effort?: string }; reasoning_effort?: string; reasoning?: { effort?: string } }

export interface CliRequest { prompt: string; images: Array<{ mediaType: string; data: string }>; model: string; effort: string; toolNames: string[] }

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) + '…' : text);

function toolBlock(tools: ToolDef[]): string {
  if (tools.length === 0) return '';
  const list = tools.map((t) => `- ${t.name}: ${clip((t.description ?? '').replace(/\s+/g, ' '), 1200)}\n  parameters: ${clip(JSON.stringify(t.parameters ?? {}), 1500)}`).join('\n');
  return [
    '[How tools work here]',
    'You are the model behind an agent in the Pigry app. You have NO tools of your own — the app runs tools for you and you must not use any built-in ability to read or change files.',
    'Available tools:',
    list,
    'To call tools, reply with ONLY this JSON — no prose, no code fences: {"tool_calls":[{"name":"<tool name>","arguments":{ ... }}]}',
    'The results come back as "[Tool result: <name>]" messages; you may call more tools. When the work is done, answer in plain text without JSON.',
    'Never say you ran or changed something unless you called the tool for it and saw the result.',
  ].join('\n');
}

/** Splits an OpenAI-style request into the instruction text, the conversation transcript and the images. */
export function buildCliRequest(body: OpenAiBody): CliRequest {
  const tools = (body.tools ?? []).map((t) => t.function).filter((f): f is ToolDef => !!f && !!f.name);
  const system: string[] = [];
  const lines: string[] = [];
  const images: CliRequest['images'] = [];
  const names = new Map<string, string>();
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => {
      const p = part as { type?: string; text?: string; image_url?: { url?: string } };
      if (p.type === 'text') return p.text ?? '';
      if (p.type === 'image_url' && p.image_url?.url) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url);
        if (m) { images.push({ mediaType: m[1], data: m[2] }); return `[image ${images.length} attached]`; }
      }
      return '';
    }).filter(Boolean).join('\n');
  };
  for (const m of body.messages ?? []) {
    if (m.role === 'system') system.push(textOf(m.content));
    else if (m.role === 'user') lines.push(`[User]\n${textOf(m.content)}`);
    else if (m.role === 'assistant') {
      const text = textOf(m.content).trim();
      if (text) lines.push(`[Assistant]\n${text}`);
      const calls = (m.tool_calls ?? []).map((c) => {
        const name = String(c.function?.name ?? '');
        if (c.id) names.set(c.id, name);
        let args: unknown = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* keep {} */ }
        return { name, arguments: args };
      });
      if (calls.length) lines.push(`[Assistant]\n${JSON.stringify({ tool_calls: calls })}`);
    } else if (m.role === 'tool') lines.push(`[Tool result: ${names.get(String(m.tool_call_id ?? '')) || m.tool_call_id || 'tool'}]\n${textOf(m.content)}`);
  }
  const prompt = [
    system.length ? `[Instructions]\n${system.join('\n\n')}` : '',
    toolBlock(tools),
    '[Conversation so far]',
    lines.join('\n\n'),
    '[Your turn]\nWrite the next assistant message now.',
  ].filter(Boolean).join('\n\n');
  const effort = body.output_config?.effort ?? body.reasoning_effort ?? body.reasoning?.effort ?? '';
  return { prompt, images, model: body.model ?? '', effort, toolNames: tools.map((t) => t.name) };
}

/** The first balanced {...} object that contains the "tool_calls" key, or null. */
function extractCallObject(text: string): { json: string; start: number; end: number } | null {
  const key = text.indexOf('"tool_calls"');
  if (key < 0) return null;
  for (let start = text.lastIndexOf('{', key); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const json = text.slice(start, i + 1);
        try { if (Array.isArray((JSON.parse(json) as { tool_calls?: unknown }).tool_calls)) return { json, start, end: i + 1 }; } catch { /* try an outer brace */ }
        break;
      }
    }
    if (start === 0) break;
  }
  return null;
}

export interface CliReply { content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
/** Reads the model's answer: plain text, or the tool-call JSON (possibly wrapped in prose or a code fence). */
export function parseCliReply(text: string, toolNames: string[], idPrefix = 'cli_call'): CliReply {
  const found = toolNames.length ? extractCallObject(text) : null;
  if (!found) return { content: text.trim() };
  const parsed = JSON.parse(found.json) as { tool_calls: Array<{ name?: unknown; arguments?: unknown }> };
  const calls = parsed.tool_calls.filter((c) => typeof c.name === 'string' && toolNames.includes(c.name as string));
  if (calls.length === 0) return { content: text.trim() };
  const prose = (text.slice(0, found.start) + text.slice(found.end)).replace(/```(?:json)?/g, '').trim();
  return {
    content: prose,
    tool_calls: calls.map((c, i) => ({
      id: `${idPrefix}_${Date.now().toString(36)}_${i}`,
      type: 'function' as const,
      function: { name: c.name as string, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
    })),
  };
}

/** The request for Codex: the prompt and the images (the backend writes them to temp files and passes them with `-i`). */
export function codexMessageLine(req: CliRequest): string {
  return JSON.stringify({ prompt: req.prompt, images: req.images });
}

/** The user message for `agy --input-format stream-json`: text only (Antigravity accepts no image blocks). */
export function agyMessageLine(req: CliRequest): string {
  const note = req.images.length ? `\n\n[${req.images.length} image(s) were attached but this CLI cannot receive images — say so if they matter.]` : '';
  return JSON.stringify({ event: 'user', message: { content: req.prompt + note } });
}

/** The user message for `claude -p --input-format stream-json` (text plus any images). */
export function claudeMessageLine(req: CliRequest): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: req.prompt }, ...req.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))],
    },
  });
}

export interface CliChatResult { ok: boolean; status: number; body: string; error: string }

/** Same contract as aiChat(): returns an OpenAI-style chat completion in `body`. */
export async function cliChat(url: string, bodyJson: string): Promise<CliChatResult> {
  const fail = (error: string): CliChatResult => ({ ok: false, status: 500, body: JSON.stringify({ error: { message: error } }), error });
  try {
    const cli = cliOfEndpoint(url);
    const req = buildCliRequest(JSON.parse(bodyJson) as OpenAiBody);
    const tauri = await import('./tauriClient.ts');
    let text = '', promptTokens = 0, completionTokens = 0;
    if (cli === 'claude' || cli === 'agy' || cli === 'codex') {
      const line = cli === 'claude' ? claudeMessageLine(req) : cli === 'codex' ? codexMessageLine(req) : agyMessageLine(req);
      const out = JSON.parse(await tauri.cliChatRun(cli, line, req.model || undefined, req.effort || undefined)) as { text: string; isError: boolean; inputTokens: number; outputTokens: number };
      if (out.isError) return fail(out.text || `${cli} reported an error`);
      text = out.text; promptTokens = out.inputTokens; completionTokens = out.outputTokens;
    } else {
      // Any other CLI: text only (no images, no token counts)
      text = await tauri.cliAgentRun(cli, req.prompt, req.model || undefined);
      promptTokens = Math.ceil(req.prompt.length / 4); completionTokens = Math.ceil(text.length / 4);
    }
    const reply = parseCliReply(text, req.toolNames);
    return {
      ok: true, status: 200, error: '',
      body: JSON.stringify({
        model: req.model,
        choices: [{ index: 0, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: reply.content, ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }),
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
