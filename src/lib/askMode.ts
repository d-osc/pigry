/** "Ask" chat mode: the agent answers questions and may look things up, but changes nothing. Only read-only tools stay available;
 * the shell tool stays too, but refuses any command that is not certainly read-only. */
import type { ToolSpec } from './agentTools.ts';
import { isReadOnlyCall, isReadOnlyCommand } from './toolBatch.ts';

/** Read-only by name: the built-in read tools, memory recall, and the `*_list / *_read / *_preview / *_analyze …` tools of the menus. */
export function isAskTool(name: string): boolean {
  if (name === 'run_command') return true; // wrapped below
  if (name === 'memory_recall') return true;
  if (/_(list|read|preview|analyze|check|get|lookup|search|insights)$/.test(name)) return true;
  return isReadOnlyCall(name, {});
}

export const ASK_REFUSAL = 'error: Ask mode is read-only — this command could change files or git state. Tell the user what you would run and let them switch the chat mode to Normal or Goal.';

export const ASK_NOTE =
  '\n\n[Ask mode]\nThe user is asking a question. Answer it from the code and the context, using only read-only tools to look things up. Do NOT create, edit, delete or move files, change git state, or run commands that modify anything. If a change is needed, explain exactly what you would change and let the user switch to Normal or Goal mode.';

export function askTools(tools: ToolSpec[]): ToolSpec[] {
  return tools
    .filter((tool) => isAskTool(tool.name))
    .map((tool) => (tool.name === 'run_command'
      ? { ...tool, run: (input: Record<string, unknown>) => (isReadOnlyCommand(String(input.command ?? '')) ? tool.run(input) : Promise.resolve(ASK_REFUSAL)) }
      : tool));
}
