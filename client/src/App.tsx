import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { SimulatePanel } from './components/SimulatePanel';
import { DecisionList } from './components/DecisionList';
import { DecisionDetailView } from './pages/DecisionDetail';
import { EvalTab } from './pages/EvalTab';

type Tab = 'decisions' | 'eval';

export function App() {
  const [tab, setTab] = useState<Tab>('decisions');
  const [selected, setSelected] = useState<string | null>(null);
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> AI Purchasing Agent
          <span className="sub">makes, executes and validates purchase decisions</span>
        </div>
        <nav className="tabs">
          <button className={tab === 'decisions' ? 'active' : ''} onClick={() => setTab('decisions')}>
            Decisions
          </button>
          <button className={tab === 'eval' ? 'active' : ''} onClick={() => setTab('eval')}>
            Evaluation
          </button>
        </nav>
        <div className="meta">
          {health.data ? (
            <>
              <span>sim now {health.data.simNow.slice(0, 10)}</span>
              <span>model {health.data.model}</span>
              <span>llm cache {health.data.llmCache}</span>
            </>
          ) : (
            <span className="warn">API not reachable</span>
          )}
        </div>
      </header>

      {tab === 'decisions' ? (
        <main className="layout">
          <aside className="sidebar">
            <SimulatePanel onStarted={(id) => setSelected(id)} />
            <DecisionList selected={selected} onSelect={setSelected} />
          </aside>
          <section className="content">
            {selected ? <DecisionDetailView id={selected} /> : <Empty />}
          </section>
        </main>
      ) : (
        <main className="single">
          <EvalTab onOpen={(id) => { setSelected(id); setTab('decisions'); }} />
        </main>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <h2>Pick a scenario and run it</h2>
      <p>
        The agent gathers evidence through tools, the deterministic engine computes the quantity, policy decides
        whether a human must approve, and every action is read back and reconciled if it does not match.
      </p>
    </div>
  );
}
