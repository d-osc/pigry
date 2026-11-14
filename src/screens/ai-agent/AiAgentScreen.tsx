import { useState } from 'react';
import { Clock, Plus, ShieldCheck } from 'lucide-react';
import { AiAgentPanel } from '../explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import './AiAgentScreen.css';

export function AiAgentScreen() {
  const { repository } = useRepository();
  // The panel fills the page — the inline width is overridden by CSS so the
  // flex layout decides (see .agent-screen__body .explorer-ai below).
  const [aiWidth] = useState(720);
  return (
    <div className="screen agent-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Copilot</h1>
        <span className="agent-screen__scope">Repository agent</span>
        <span className="screen-header__meta">
          Understand your code. Review every change. Stay in control.
        </span>
        <button type="button" className="outline-button">
          <ShieldCheck size={12} strokeWidth={1.25} />
          Approval required
        </button>
        <button type="button" className="outline-button">
          <Clock size={12} strokeWidth={1.25} />
          Sessions
        </button>
        <button type="button" className="primary-button">
          <Plus size={12} strokeWidth={1.25} />
          New session
        </button>
      </header>
      <div className="screen-body agent-screen__body">
        <AiAgentPanel
          width={aiWidth}
          fileName={repository?.name ?? 'pigry'}
          defaultTeam={teamForScreen('ai-agent')}
          onCollapse={() => {}}
        />
      </div>
    </div>
  );
}
