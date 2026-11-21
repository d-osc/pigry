/** Tool calls that only read: they never change files, the index or history, so several can run at once — within one
 * agent's reply and across agents. Anything not listed here is treated as a change and runs on its own. */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_files', 'search_code', 'read_diff', 'git_status', 'read_history', 'read_commit', 'read_image',
  'read_pdf', 'read_word', 'read_excel', 'compare_branches', 'preview_sync_commits', 'preview_merge', 'preview_stash',
  'check_duplicate_commit', 'repo_insights', 'web_search', 'agent_lookup', 'agent_contacts',
]);

const READ_ONLY_COMMANDS = new Set([
  'cd', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'diff', 'stat', 'file', 'du', 'df', 'tree',
  'which', 'echo', 'basename', 'dirname', 'cut', 'tr', 'sort',
]);
/** Read-only git subcommands. `branch`, `tag`, `remote`, `stash` and `config` only qualify in the listing forms below. */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog',
  'grep', 'cat-file', 'merge-base', 'show-ref',
]);
const GIT_LISTING: Record<string, (args: string[]) => boolean> = {
  branch: (args) => args.every((a) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes'].includes(a)),
  tag: (args) => args.length === 0 || args.every((a) => ['-l', '--list', '-n'].includes(a)),
  remote: (args) => args.length === 0 || (args.length === 1 && ['-v', '--verbose'].includes(args[0])),
  stash: (args) => args[0] === 'list',
  config: (args) => args[0] === '--get' || args[0] === '--list' || args[0] === '-l',
};
/** Flags that make an otherwise read-only command write somewhere. */
const WRITING_FLAGS = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls', '--output'];
/** Commands where -o names an output file (grep -o just prints matches, so it stays allowed). */
const OUTPUT_FILE_COMMANDS = new Set(['sort', 'tree']);

function segmentIsReadOnly(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  const [command, ...args] = words;
  if (!command) return false;
  if (args.some((arg) => WRITING_FLAGS.some((flag) => arg === flag || arg.startsWith(flag + '=')))) return false;
  if (OUTPUT_FILE_COMMANDS.has(command) && args.some((arg) => arg === '-o' || arg.startsWith('-o'))) return false;
  if (command === 'git') {
    const [sub, ...rest] = args;
    if (!sub || sub.startsWith('-')) return false; // global options (-C, -c …) can change what runs
    return READ_ONLY_GIT.has(sub) || (sub in GIT_LISTING && GIT_LISTING[sub](rest));
  }
  return READ_ONLY_COMMANDS.has(command);
}

/** True only when a shell command line is certain to leave files, the index and history alone. When in doubt (quotes,
 * redirects, substitutions, unknown programs) it says no, so the command just runs on its own as before. */
export function isReadOnlyCommand(commandLine: string): boolean {
  const line = commandLine.trim();
  if (!line || /[>`\n\r&]{1}/.test(line.replace(/&&/g, '')) || line.includes('$(') || line.includes('${')) return false;
  return line.split(/&&|\|\||;|\|/).every(segmentIsReadOnly);
}

export function isReadOnlyCall(name: string, input: Record<string, unknown>): boolean {
  return name === 'run_command' ? isReadOnlyCommand(String(input.command ?? '')) : READ_ONLY_TOOLS.has(name);
}

/** Runs `exec` for every item and returns the outputs in the original order. Consecutive read-only items run at the
 * same time; any other item runs alone, after everything before it and before everything after it. */
export async function runInBatches<T>(items: T[], isReadOnly: (item: T) => boolean, exec: (item: T) => Promise<string>): Promise<string[]> {
  const outputs: string[] = new Array(items.length);
  let index = 0;
  while (index < items.length) {
    if (!isReadOnly(items[index])) {
      outputs[index] = await exec(items[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < items.length && isReadOnly(items[end])) end += 1;
    const settled = await Promise.allSettled(items.slice(index, end).map(exec));
    settled.forEach((result, offset) => {
      if (result.status === 'fulfilled') outputs[index + offset] = result.value;
    });
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    index = end;
  }
  return outputs;
}
