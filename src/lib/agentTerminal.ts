interface AgentCommandEntry {
  id: number;
  command: string;
  output: string;
  status: string;
}

function createTranscript() {
  let entries: AgentCommandEntry[] = [];
  let nextId = 0;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());

  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin(command: string) {
      const id = ++nextId;
      entries = [...entries.slice(-39), { id, command, output: '', status: 'Running' }];
      publish();
      const update = (transform: (entry: AgentCommandEntry) => AgentCommandEntry) => {
        entries = entries.map(entry => entry.id === id ? transform(entry) : entry);
        publish();
      };
      return {
        append(output: string) {
          update(entry => ({ ...entry, output: (entry.output + output).slice(-24_000) }));
        },
        finish(status: string) {
          update(entry => ({ ...entry, status }));
        },
      };
    },
  };
}

const transcripts = new Map<string, ReturnType<typeof createTranscript>>();

export function agentTerminalFor(workspace: string) {
  let transcript = transcripts.get(workspace);
  if (!transcript) {
    transcript = createTranscript();
    transcripts.set(workspace, transcript);
  }
  return transcript;
}
