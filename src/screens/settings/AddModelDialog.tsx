/** "Add model" dialog — smart configuration + advanced model settings.
 *
 * Mirrors the Model settings mockup: a Smart configuration toggle that
 * auto-fills known-model metadata, the basic fields (Model ID, context
 * window, max output tokens) and a collapsible Advanced settings section
 * (input types, capabilities, reasoning levels, reasoning parameter mapping).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, X } from 'lucide-react';
import { KNOWN_MODEL_IDS, matchModelSpec, newId, resolveContextWindow } from '../../lib/aiProviders';
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

/** One editable effort row: level name → its payload-parameter JSON. */
interface EffortRow {
  level: string;
  params: string;
}

/** Turns a model's saved levels + mapping JSON into editable rows. */
function mappingToRows(levels: string[], mapping: string | undefined): EffortRow[] {
  const rows = levels.map((level) => ({ level, params: '' }));
  if (mapping) {
    try {
      const obj = JSON.parse(mapping) as Record<string, unknown>;
      for (const [level, fragment] of Object.entries(obj)) {
        const existing = rows.find((r) => r.level === level);
        if (existing) existing.params = JSON.stringify(fragment);
        else rows.push({ level, params: JSON.stringify(fragment) });
      }
    } catch {
      // unparsable legacy mapping — start from bare level names
    }
  }
  return rows;
}

interface Props {
  /** Existing model — the dialog prefills and Save updates it in place. */
  initial?: AiModelEntry | null;
  onCancel: () => void;
  onSave: (model: AiModelEntry) => void;
}

export function AddModelDialog({ initial, onCancel, onSave }: Props) {
  const initialSpec = initial ? matchModelSpec(initial.name) : null;
  const initialContext = initial ? resolveContextWindow(initial.name, initial) : null;
  const initialMaxOutput = initial?.maxOutputTokens ?? initialSpec?.maxOutputTokens;
  const [smart, setSmart] = useState(true);
  const [modelId, setModelId] = useState(initial?.name ?? '');
  const [contextWindow, setContextWindow] = useState(String(initialContext ?? ''));
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(initialMaxOutput ?? ''));
  const [defaultEffort, setDefaultEffort] = useState(initial?.defaultEffort ?? '');
  const [outputLanguage, setOutputLanguage] = useState(initial?.textOutputLanguage ?? '');
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(initial && (initial.inputTypes?.length || initial.capabilities?.length || initial.reasoningLevels?.length || initial.reasoningMapping)),
  );
  const [inputTypes, setInputTypes] = useState<string[]>(() => {
    if (initial?.inputTypes) return initial.inputTypes.filter((t) => t !== 'text');
    // Legacy entries only had the vision flag.
    return initial?.vision ? ['image'] : [];
  });
  const [capabilities, setCapabilities] = useState<string[]>(initial?.capabilities ?? []);
  /** Editable effort types — each vendor's known models come prefilled. */
  const [effortRows, setEffortRows] = useState<EffortRow[]>(() =>
    mappingToRows(initial?.reasoningLevels ?? initialSpec?.reasoningLevels ?? [], initial?.reasoningMapping ?? initialSpec?.reasoningMapping),
  );
  const [error, setError] = useState('');
  const idInputRef = useRef<HTMLInputElement | null>(null);
  const catalogId = useId();
  const languageListId = useId();
  const spec = matchModelSpec(modelId);
  const levels = [...new Set(effortRows.map(({ level }) => level.trim()).filter(Boolean))];
  const defaultEffortLabel = spec?.providerDefaultEffort
    ? `Provider default (${spec.providerDefaultEffort})`
    : 'Provider default';

  useEffect(() => {
    idInputRef.current?.focus();
  }, []);

  // Smart configuration: re-apply known-model metadata on every id change.
  const applySmart = (id: string, clearMissing = false) => {
    const spec = matchModelSpec(id);
    if (!spec && !clearMissing) return;
    setContextWindow(String(spec?.contextWindow ?? ''));
    setMaxOutputTokens(String(spec?.maxOutputTokens ?? ''));
    setInputTypes(spec?.inputTypes?.filter((t) => t !== 'text') ?? []);
    setCapabilities(spec?.capabilities ?? []);
    setEffortRows(mappingToRows(spec?.reasoningLevels ?? [], spec?.reasoningMapping));
    setDefaultEffort((value) => spec?.reasoningLevels?.includes(value) ? value : '');
  };

  const changeModelId = (value: string) => {
    setModelId(value);
    setError('');
    if (smart && matchModelSpec(value) !== spec) applySmart(value, Boolean(spec));
  };

  const toggleListValue = (list: string[], setList: (next: string[]) => void, id: string) => {
    setList(list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
  };

  const resetForm = () => {
    // Editing: reset back to the model's saved values; adding: clear everything.
    setModelId(initial?.name ?? '');
    setContextWindow(String(initialContext ?? ''));
    setMaxOutputTokens(String(initialMaxOutput ?? ''));
    setDefaultEffort(initial?.defaultEffort ?? '');
    setOutputLanguage(initial?.textOutputLanguage ?? '');
    setInputTypes(
      initial?.inputTypes ? initial.inputTypes.filter((t) => t !== 'text') : initial?.vision ? ['image'] : [],
    );
    setCapabilities(initial?.capabilities ?? []);
    setEffortRows(mappingToRows(initial?.reasoningLevels ?? initialSpec?.reasoningLevels ?? [], initial?.reasoningMapping ?? initialSpec?.reasoningMapping));
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
    const ctx = contextWindow.replace(/[,\s_]/g, '');
    const maxOut = maxOutputTokens.replace(/[,\s_]/g, '');
    for (const [label, value] of [['Context window', ctx], ['Max output tokens', maxOut]]) {
      if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
        setError(`${label} must be a positive whole number or left blank.`);
        return;
      }
    }
    const types = ['text', ...inputTypes];
    // Build effort levels + the level→parameters mapping from the rows.
    const rows = effortRows.filter((r) => r.level.trim());
    let mapping: string | undefined;
    if (rows.length > 0) {
      const obj: Record<string, unknown> = Object.create(null);
      for (const row of rows) {
        const raw = row.params.trim();
        if (!raw) continue;
        try {
          const params: unknown = JSON.parse(raw);
          if (!params || typeof params !== 'object' || Array.isArray(params)) {
            setError(`Effort parameters for "${row.level.trim()}" must be a JSON object.`);
            return;
          }
          obj[row.level.trim()] = params;
        } catch {
          setError(`Effort parameters for "${row.level.trim()}" are not valid JSON.`);
          return;
        }
      }
      if (Object.keys(obj).length > 0) mapping = JSON.stringify(obj);
    }
    const model: AiModelEntry = {
      id: initial?.id ?? newId('m'),
      name,
      vision: types.includes('image'),
      enabled: initial?.enabled ?? true,
    };
    if (ctx) {
      model.contextWindow = Number(ctx);
      model.context = contextBadge(model.contextWindow);
    }
    if (maxOut) model.maxOutputTokens = Number(maxOut);
    if (outputLanguage.trim()) model.textOutputLanguage = outputLanguage.trim();
    if (inputTypes.length > 0) model.inputTypes = types;
    if (capabilities.length > 0) model.capabilities = capabilities;
    model.reasoningLevels = levels;
    if (mapping) model.reasoningMapping = mapping;
    if (levels.includes(defaultEffort)) model.defaultEffort = defaultEffort;
    if (name === initial?.name && initial.effort && levels.includes(initial.effort)) model.effort = initial.effort;
    if (smart && spec) model.smartConfig = true;
    onSave(model);
  };

  return (
    <div className="amdlg__overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="amdlg" role="dialog" aria-label={initial ? 'Edit model' : 'Add model'}>
        <header className="amdlg__head">
          <span className="amdlg__title">{initial ? 'Edit model' : 'Add model'}</span>
          <button type="button" className="amdlg__close" aria-label="Close" onClick={onCancel}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div className="amdlg__body">
          <div className="amdlg__smart">
            <span className="amdlg__label">
              Smart configuration
              <span className="amdlg__help" title="Fills published limits and effort options for known models.">
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
          {smart && modelId.trim() && !spec && (
            <p className="amdlg__hint">No built-in limits for this ID. Enter the values from your provider.</p>
          )}

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
              list={catalogId}
              spellCheck={false}
            />
            <datalist id={catalogId}>
              {KNOWN_MODEL_IDS.map((id) => <option key={id} value={id} />)}
            </datalist>
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
              <span className="amdlg__help" title="Upper bound on tokens generated per request.">
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

          <label className="amdlg__field">
            <span className="amdlg__label">Default effort</span>
            <select
              className="prov-mgr__control"
              value={levels.includes(defaultEffort) ? defaultEffort : ''}
              onChange={(event) => setDefaultEffort(event.target.value)}
              disabled={levels.length === 0}
            >
              <option value="">{defaultEffortLabel}</option>
              {levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>

          <label className="amdlg__field">
            <span className="amdlg__label">Text output language</span>
            <input
              className="prov-mgr__control"
              value={outputLanguage}
              onChange={(event) => setOutputLanguage(event.target.value)}
              placeholder="Automatic"
              list={languageListId}
              maxLength={80}
            />
            <datalist id={languageListId}>
              {['Thai', 'English', 'Chinese', 'Japanese', 'Korean', 'Vietnamese', 'French', 'German', 'Spanish'].map((language) =>
                <option key={language} value={language} />,
              )}
            </datalist>
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
                  Effort types (level → parameters)
                  <span className="amdlg__help" title="Custom effort levels the chat picker offers. Known models come with their vendor's defaults prefilled — edit rows freely. Each level's JSON is merged into chat requests when that level is selected.">
                    ?
                  </span>
                </span>
                {effortRows.length > 0 && (
                  <div className="amdlg__effort-rows">
                    {effortRows.map((row, index) => (
                      <div key={index} className="amdlg__effort-row">
                        <input
                          className="amdlg__effort-name"
                          value={row.level}
                          onChange={(event) =>
                            setEffortRows((prev) =>
                              prev.map((r, i) => (i === index ? { ...r, level: event.target.value } : r)),
                            )
                          }
                          placeholder="level"
                          aria-label={`Effort level ${index + 1} name`}
                          spellCheck={false}
                        />
                        <span className="amdlg__effort-arrow">→</span>
                        <input
                          className="amdlg__effort-params"
                          value={row.params}
                          onChange={(event) =>
                            setEffortRows((prev) =>
                              prev.map((r, i) => (i === index ? { ...r, params: event.target.value } : r)),
                            )
                          }
                          placeholder='{"thinking": {"type": "enabled"}}'
                          aria-label={`Effort level ${index + 1} parameters`}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="amdlg__chip-x"
                          aria-label={`Remove effort level ${row.level || index + 1}`}
                          onClick={() => setEffortRows((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <X size={11} strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="amdlg__effort-add"
                  onClick={() => setEffortRows((prev) => [...prev, { level: '', params: '' }])}
                >
                  <Plus size={11} strokeWidth={2} />
                  Add effort level
                </button>
                <p className="amdlg__hint">
                  Leave parameters empty for a level without vendor parameters.
                </p>
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
