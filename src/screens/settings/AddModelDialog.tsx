/** "Add model" dialog — smart configuration + advanced model settings.
 *
 * Mirrors the Model settings mockup: a Smart configuration toggle that
 * auto-fills known-model metadata, the basic fields (Model ID, context
 * window, max output tokens) and a collapsible Advanced settings section
 * (input types, capabilities, reasoning levels, reasoning parameter mapping).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, X } from 'lucide-react';
import { matchModelSpec, newId } from '../../lib/aiProviders';
import type { AiModelEntry } from '../../types/repository';

const INPUT_TYPE_OPTIONS: Array<[id: string, label: string]> = [
  ['image', 'Image'],
  ['video', 'Video'],
  ['pdf', 'PDF'],
];

const CAPABILITY_OPTIONS: Array<[id: string, label: string]> = [
  ['structured-output', 'Structured output'],
  ['native-web-search', 'Native web search'],
  ['mid-conversation-system', 'Mid-conversation system messages'],
];

/** "1000000" → "1M", "200000" → "200K" — the display badge. */
function contextBadge(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

interface Props {
  onCancel: () => void;
  onSave: (model: AiModelEntry) => void;
}

export function AddModelDialog({ onCancel, onSave }: Props) {
  const [smart, setSmart] = useState(true);
  const [modelId, setModelId] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [inputTypes, setInputTypes] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [levelDraft, setLevelDraft] = useState<string | null>(null);
  const [mapping, setMapping] = useState('');
  const [error, setError] = useState('');
  const idInputRef = useRef<HTMLInputElement | null>(null);
  const levelInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    idInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (levelDraft !== null) levelInputRef.current?.focus();
  }, [levelDraft]);

  const specHint = useMemo(() => {
    if (!smart || !modelId.trim()) return '';
    return matchModelSpec(modelId)
      ? `Recognized "${modelId.trim()}" — defaults filled automatically.`
      : 'Unknown model — fields stay as entered.';
  }, [smart, modelId]);

  // Smart configuration: re-apply known-model metadata on every id change.
  const applySmart = (id: string) => {
    const spec = matchModelSpec(id);
    if (!spec) return;
    if (spec.contextWindow) setContextWindow(String(spec.contextWindow));
    if (spec.maxOutputTokens) setMaxOutputTokens(String(spec.maxOutputTokens));
    setInputTypes(spec.inputTypes ? spec.inputTypes.filter((t) => t !== 'text') : []);
    setCapabilities(spec.capabilities ?? []);
    setLevels(spec.reasoningLevels ?? []);
  };

  const changeModelId = (value: string) => {
    setModelId(value);
    setError('');
    if (smart) applySmart(value.trim());
  };

  const toggleListValue = (list: string[], setList: (next: string[]) => void, id: string) => {
    setList(list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
  };

  const resetForm = () => {
    setModelId('');
    setContextWindow('');
    setMaxOutputTokens('');
    setInputTypes([]);
    setCapabilities([]);
    setLevels([]);
    setLevelDraft(null);
    setMapping('');
    setError('');
    idInputRef.current?.focus();
  };

  const save = () => {
    const name = modelId.trim();
    if (!name) {
      setError('Model ID is required.');
      idInputRef.current?.focus();
      return;
    }
    const ctx = Number(contextWindow.replace(/[,\s_]/g, ''));
    const maxOut = Number(maxOutputTokens.replace(/[,\s_]/g, ''));
    const types = ['text', ...inputTypes];
    const model: AiModelEntry = {
      id: newId('m'),
      name,
      vision: types.includes('image'),
      enabled: true,
    };
    if (ctx > 0) {
      model.contextWindow = ctx;
      model.context = contextBadge(ctx);
    }
    if (maxOut > 0) model.maxOutputTokens = maxOut;
    if (inputTypes.length > 0) model.inputTypes = types;
    if (capabilities.length > 0) model.capabilities = capabilities;
    if (levels.length > 0) model.reasoningLevels = levels;
    if (mapping.trim()) model.reasoningMapping = mapping.trim();
    if (smart && matchModelSpec(name)) model.smartConfig = true;
    onSave(model);
  };

  const commitLevel = () => {
    const value = (levelDraft ?? '').trim().toLowerCase();
    if (value && !levels.includes(value)) setLevels((prev) => [...prev, value]);
    setLevelDraft(null);
  };

  return (
    <div className="amdlg__overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="amdlg" role="dialog" aria-label="Add model">
        <header className="amdlg__head">
          <span className="amdlg__title">Add model</span>
          <button type="button" className="amdlg__close" aria-label="Close" onClick={onCancel}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div className="amdlg__body">
          <div className="amdlg__smart">
            <span className="amdlg__label">
              Smart configuration
              <span className="amdlg__help" title="Auto-fills context window, max output tokens, input types and capabilities for known models.">
                ?
              </span>
            </span>
            <label className="prov-mgr__switch" title={smart ? 'Smart configuration on' : 'Smart configuration off'}>
              <input type="checkbox" checked={smart} onChange={(event) => {
                setSmart(event.target.checked);
                if (event.target.checked) applySmart(modelId.trim());
              }} />
              <span />
            </label>
          </div>
          {specHint && <p className="amdlg__hint">{specHint}</p>}

          <label className="amdlg__field">
            <span className="amdlg__label">Model ID</span>
            <input
              ref={idInputRef}
              className="prov-mgr__control"
              value={modelId}
              onChange={(event) => changeModelId(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && save()}
              placeholder="Model ID"
              aria-label="Model ID"
              spellCheck={false}
            />
          </label>

          <label className="amdlg__field">
            <span className="amdlg__label">
              Context window
              <span className="amdlg__help" title="Total tokens (input + output) the model can process, e.g. 200000.">
                ?
              </span>
            </span>
            <input
              className="prov-mgr__control"
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
              inputMode="numeric"
              placeholder="e.g. 200000"
              aria-label="Context window"
              spellCheck={false}
            />
          </label>

          <label className="amdlg__field">
            <span className="amdlg__label">
              Max output tokens
              <span className="amdlg__help" title="Upper bound on reply length — sent as the request's max_tokens.">
                ?
              </span>
            </span>
            <input
              className="prov-mgr__control"
              value={maxOutputTokens}
              onChange={(event) => setMaxOutputTokens(event.target.value)}
              inputMode="numeric"
              placeholder="e.g. 8192"
              aria-label="Max output tokens"
              spellCheck={false}
            />
          </label>

          <button
            type="button"
            className="amdlg__advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            {advancedOpen ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
            Advanced settings
          </button>

          {advancedOpen && (
            <div className="amdlg__advanced">
              <div className="amdlg__group">
                <span className="amdlg__label">
                  Input types
                  <span className="amdlg__help" title="Input kinds the model accepts. Text is always enabled.">
                    ?
                  </span>
                </span>
                <div className="amdlg__chips">
                  <span className="amdlg__chip amdlg__chip--locked" title="Text is always accepted">
                    <span className="amdlg__chip-check">✓</span>
                    Text
                    <Lock size={11} strokeWidth={1.75} />
                  </span>
                  {INPUT_TYPE_OPTIONS.map(([id, label]) => (
                    <label key={id} className={`amdlg__chip${inputTypes.includes(id) ? ' amdlg__chip--on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={inputTypes.includes(id)}
                        onChange={() => toggleListValue(inputTypes, setInputTypes, id)}
                      />
                      <span className="amdlg__chip-check">{inputTypes.includes(id) ? '✓' : ''}</span>
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="amdlg__group">
                <span className="amdlg__label">
                  Model capabilities
                  <span className="amdlg__help" title="Extra abilities the provider exposes for this model.">
                    ?
                  </span>
                </span>
                <div className="amdlg__chips">
                  {CAPABILITY_OPTIONS.map(([id, label]) => (
                    <label key={id} className={`amdlg__chip${capabilities.includes(id) ? ' amdlg__chip--on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={capabilities.includes(id)}
                        onChange={() => toggleListValue(capabilities, setCapabilities, id)}
                      />
                      <span className="amdlg__chip-check">{capabilities.includes(id) ? '✓' : ''}</span>
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="amdlg__group">
                <span className="amdlg__label">
                  Reasoning levels (low to high)
                  <span className="amdlg__help" title="Ordered reasoning effort levels the model supports.">
                    ?
                  </span>
                </span>
                <div className="amdlg__chips">
                  {levels.map((level) => (
                    <span key={level} className="amdlg__chip amdlg__chip--on">
                      {level}
                      <button
                        type="button"
                        className="amdlg__chip-x"
                        aria-label={`Remove ${level}`}
                        onClick={() => setLevels((prev) => prev.filter((v) => v !== level))}
                      >
                        <X size={10} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                  {levelDraft !== null ? (
                    <input
                      ref={levelInputRef}
                      className="amdlg__level-input"
                      value={levelDraft}
                      onChange={(event) => setLevelDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitLevel();
                        if (event.key === 'Escape') setLevelDraft(null);
                      }}
                      onBlur={commitLevel}
                      placeholder="level name"
                      aria-label="Reasoning level name"
                      spellCheck={false}
                    />
                  ) : (
                    <button
                      type="button"
                      className="amdlg__chip amdlg__chip-add"
                      aria-label="Add reasoning level"
                      title="Add a reasoning level"
                      onClick={() => setLevelDraft('')}
                    >
                      <Plus size={12} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>

              <div className="amdlg__group">
                <span className="amdlg__label">
                  Reasoning parameter mapping
                  <span className="amdlg__help" title="Optional JSON: level name → request parameters, merged into payloads when that level is selected.">
                    ?
                  </span>
                </span>
                <textarea
                  className="prov-mgr__control amdlg__mapping"
                  value={mapping}
                  onChange={(event) => setMapping(event.target.value)}
                  placeholder={'{"high": {"thinking": {"type": "enabled"}}}'}
                  aria-label="Reasoning parameter mapping"
                  spellCheck={false}
                />
              </div>
            </div>
          )}
        </div>

        {error && <p className="amdlg__error">{error}</p>}

        <footer className="amdlg__foot">
          <button type="button" className="amdlg__reset" onClick={resetForm}>
            Reset form
          </button>
          <span className="amdlg__foot-gap" />
          <button type="button" className="prov-mgr__ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="prov-mgr__add" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
