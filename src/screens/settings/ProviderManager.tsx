/** AI provider manager — the Settings → AI Provider section.
 *
 * Left rail: built-in and custom providers with readiness dots. Right pane:
 * connection config (base URL, wire format, key) plus the provider's model
 * list where each model can be tested, renamed, removed or toggled.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Check,
  Eye,
  EyeOff,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { aiChat } from '../../lib/tauriClient';
import { detectZcodeGlm } from '../../lib/zcode';
import {
  API_FORMAT_LABEL,
  activeProviderId,
  anthropicEndpoint,
  loadProviders,
  newId,
  providerStatus,
  resolveEndpoint,
  saveProviders,
  setActiveProvider,
  type AiApiFormat,
  type AiModelEntry,
  type AiProviderEntry,
} from '../../lib/aiProviders';
import { AddModelDialog } from './AddModelDialog';
import './ProviderManager.css';

type ModelTestState = 'running' | 'ok' | 'fail';

export function ProviderManager() {
  const { notify } = useRepository();
  const [store, setStore] = useState<{ list: AiProviderEntry[]; selectedId: string }>(() => {
    const list = loadProviders();
    const active = activeProviderId();
    const preferred =
      list.find((p) => p.id === active)?.id ??
      list.find((p) => p.kind === 'custom')?.id ??
      list[0]?.id ??
      '';
    return { list, selectedId: preferred };
  });
  const providers = store.list;
  const selectedId = store.selectedId;
  const [menuOpen, setMenuOpen] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  /** 'new' = add dialog; an AiModelEntry = edit dialog prefilled with it. */
  const [modelDialog, setModelDialog] = useState<AiModelEntry | 'new' | null>(null);
  const [tests, setTests] = useState<Record<string, ModelTestState>>({});
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const reload = () => {
    const list = loadProviders();
    setStore({ list, selectedId });
    return list;
  };

  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? null,
    [providers, selectedId],
  );

  const commit = (next: AiProviderEntry[]) => {
    setStore({ list: next, selectedId });
    saveProviders(next, activeProviderId() || next[0]?.id);
  };

  const patch = (id: string, changes: Partial<AiProviderEntry>) => {
    commit(providers.map((p) => (p.id === id ? { ...p, ...changes } : p)));
  };

  const patchModel = (providerId: string, modelId: string, changes: Partial<AiModelEntry>) => {
    const next = providers.map((p) => {
      if (p.id !== providerId) return p;
      const models = p.models.map((m) => (m.id === modelId ? { ...m, ...changes } : m));
      return {
        ...p,
        models,
        // Legacy mirror: the first enabled model stays what chat consumers use.
        model: models.find((m) => m.enabled)?.name ?? models[0]?.name ?? '',
      };
    });
    commit(next);
  };

  const addProvider = () => {
    const entry: AiProviderEntry = {
      id: newId('p'),
      name: 'New provider',
      kind: 'custom',
      type: 'custom',
      apiFormat: 'openai',
      baseUrl: '',
      apiKey: '',
      model: '',
      enabled: true,
      models: [],
    };
    commit([...providers, entry]);
    setStore((prev) => ({ ...prev, selectedId: entry.id }));
    setNameEditing(true);
    notify('Provider added', 'success');
  };

  const deleteProvider = (id: string) => {
    const entry = providers.find((p) => p.id === id);
    if (!entry || entry.kind === 'builtin') return;
    const next = providers.filter((p) => p.id !== id);
    commit(next);
    if (activeProviderId() === id) setActiveProvider(next[0]?.id ?? '');
    setStore({ list: next, selectedId: next[0]?.id ?? '' });
    notify(`Provider "${entry.name}" deleted`, 'success');
  };

  /** Dialog Save — appends a new model or replaces the edited one in place. */
  const saveModelDialog = (model: AiModelEntry) => {
    if (!selected) return;
    const exists = selected.models.some((m) => m.id === model.id);
    const models = exists
      ? selected.models.map((m) => (m.id === model.id ? model : m))
      : [...selected.models, model];
    patch(selected.id, { models, model: selected.model || model.name });
    setModelDialog(null);
    notify(`Model "${model.name}" ${exists ? 'updated' : 'added'}`, 'success');
  };

  /** Sends a 1-token ping with this model through the provider's wire format. */
  const testModel = async (model: AiModelEntry) => {
    if (!selected) return;
    setTests((t) => ({ ...t, [model.id]: 'running' }));
    try {
      const isAnthropic = selected.apiFormat === 'anthropic';
      const raw = resolveEndpoint(selected);
      const endpoint = isAnthropic ? anthropicEndpoint(raw) : raw;
      const payload = isAnthropic
        ? { model: model.name, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }
        : { model: model.name, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false };
      const result = await aiChat(
        endpoint,
        selected.apiKey,
        JSON.stringify(payload),
        isAnthropic ? 'anthropic' : 'bearer',
      );
      let ok = result.ok;
      if (ok) {
        try {
          const parsed = JSON.parse(result.body) as Record<string, unknown>;
          // Quota/throttle replies can arrive with HTTP 200 on some gateways.
          ok = !parsed?.error && !parsed?.code;
        } catch {
          ok = false;
        }
      }
      setTests((t) => ({ ...t, [model.id]: ok ? 'ok' : 'fail' }));
    } catch {
      setTests((t) => ({ ...t, [model.id]: 'fail' }));
    }
  };

  const detectZcode = async () => {
    try {
      const found = await detectZcodeGlm();
      if (!found) {
        notify('ZCode desktop not detected', 'error');
        return;
      }
      if (!selected) return;
      patch(selected.id, {
        name: selected.name === 'Z.ai' ? 'Z.ai' : found.name,
        type: 'zcode',
        apiFormat: 'openai',
        baseUrl: found.baseUrl,
        apiKey: found.apiKey,
        model: found.model,
        models:
          found.model && !selected.models.some((m) => m.name === found.model)
            ? [...selected.models, { id: newId('m'), name: found.model, vision: false, enabled: true }]
            : selected.models,
      });
      notify('Z.ai configured from ZCode desktop', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  // Focus the name field as soon as rename mode starts.
  useEffect(() => {
    if (nameEditing) nameInputRef.current?.focus();
  }, [nameEditing]);

  if (!selected) {
    return (
      <div className="prov-mgr">
        <p className="prov-mgr__empty">No providers configured.</p>
      </div>
    );
  }

  const builtins = providers.filter((p) => p.kind === 'builtin');
  const customs = providers.filter((p) => p.kind !== 'builtin');

  const renderRow = (entry: AiProviderEntry) => {
    const status = providerStatus(entry);
    return (
      <button
        key={entry.id}
        type="button"
        className={`prov-mgr__item${entry.id === selectedId ? ' prov-mgr__item--active' : ''}`}
        onClick={() => {
          setStore((prev) => ({ ...prev, selectedId: entry.id }));
          setKeyVisible(false);
          setMenuOpen(false);
        }}
        title={entry.name}
      >
        <span className={`prov-mgr__item-icon${entry.kind === 'builtin' ? ' prov-mgr__item-icon--letter' : ''}`}>
          {entry.kind === 'builtin' ? (
            entry.name.charAt(0).toUpperCase()
          ) : (
            <Box size={13} strokeWidth={1.5} />
          )}
        </span>
        <span className="prov-mgr__item-name">{entry.name}</span>
        <span className={`prov-mgr__dot prov-mgr__dot--${status}`} aria-hidden="true" />
      </button>
    );
  };

  return (
    <div className="prov-mgr">
      <header className="prov-mgr__header">
        <p className="prov-mgr__intro">
          Manage custom model providers. Once configured, they can be selected during chat.
        </p>
        <div className="prov-mgr__header-actions">
          <button
            type="button"
            className="prov-mgr__icon-btn"
            aria-label="Reload providers"
            title="Reload from saved configuration"
            onClick={() => {
              reload();
              notify('Providers reloaded', 'success');
            }}
          >
            <RefreshCw size={13} strokeWidth={1.5} />
          </button>
          <button type="button" className="prov-mgr__add" onClick={addProvider}>
            <Plus size={13} strokeWidth={1.75} />
            Add provider
          </button>
        </div>
      </header>

      <div className="prov-mgr__body">
        <aside className="prov-mgr__rail" aria-label="Provider list">
          <span className="prov-mgr__group">Providers</span>
          {builtins.map(renderRow)}
          <span className="prov-mgr__group">Custom providers</span>
          {customs.map(renderRow)}
        </aside>

        <section className="prov-mgr__detail" aria-label={`${selected.name} settings`}>
          <header className="prov-mgr__detail-head">
            <span className={`prov-mgr__item-icon${selected.kind === 'builtin' ? ' prov-mgr__item-icon--letter' : ' prov-mgr__item-icon--lg'}`}>
              {selected.kind === 'builtin' ? (
                selected.name.charAt(0).toUpperCase()
              ) : (
                <Box size={15} strokeWidth={1.5} />
              )}
            </span>
            {nameEditing ? (
              <input
                ref={nameInputRef}
                className="prov-mgr__name-input"
                value={selected.name}
                onChange={(event) => patch(selected.id, { name: event.target.value })}
                onBlur={() => setNameEditing(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setNameEditing(false);
                }}
                aria-label="Provider name"
                spellCheck={false}
              />
            ) : (
              <button
                type="button"
                className="prov-mgr__name"
                title="Click to rename"
                onClick={() => setNameEditing(true)}
              >
                {selected.name}
              </button>
            )}
            <label className="prov-mgr__switch" title={selected.enabled ? 'Disable this provider' : 'Enable this provider'}>
              <input
                type="checkbox"
                checked={selected.enabled}
                onChange={(event) => patch(selected.id, { enabled: event.target.checked })}
              />
              <span />
            </label>
            {selected.kind === 'custom' && (
              <div className="prov-mgr__menu-wrap">
                <button
                  type="button"
                  className="prov-mgr__icon-btn"
                  aria-label="Provider actions"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <MoreHorizontal size={14} strokeWidth={1.5} />
                </button>
                {menuOpen && (
                  <div className="prov-mgr__menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="prov-mgr__menu-item prov-mgr__menu-item--danger"
                      onClick={() => {
                        setMenuOpen(false);
                        deleteProvider(selected.id);
                      }}
                    >
                      <Trash2 size={12} strokeWidth={1.5} />
                      Delete provider
                    </button>
                  </div>
                )}
              </div>
            )}
          </header>

          <label className="prov-mgr__field">
            <span className="prov-mgr__label">Base URL</span>
            <input
              className="prov-mgr__control"
              value={selected.baseUrl}
              onChange={(event) => patch(selected.id, { baseUrl: event.target.value })}
              placeholder={selected.apiFormat === 'anthropic' ? 'https://host/apps/anthropic' : 'https://api.openai.com/v1'}
              aria-label="Provider base URL"
              spellCheck={false}
            />
          </label>

          <label className="prov-mgr__field">
            <span className="prov-mgr__label">API format</span>
            <select
              className="prov-mgr__control"
              value={selected.apiFormat}
              onChange={(event) => patch(selected.id, { apiFormat: event.target.value as AiApiFormat })}
              aria-label="Provider API format"
            >
              <option value="openai">{API_FORMAT_LABEL.openai}</option>
              <option value="anthropic">{API_FORMAT_LABEL.anthropic}</option>
            </select>
          </label>

          <label className="prov-mgr__field">
            <span className="prov-mgr__label">API key</span>
            <div className="prov-mgr__key">
              <input
                className="prov-mgr__control"
                type={keyVisible ? 'text' : 'password'}
                value={selected.apiKey}
                onChange={(event) => patch(selected.id, { apiKey: event.target.value })}
                placeholder="sk-…"
                aria-label="Provider API key"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="prov-mgr__icon-btn"
                aria-label={keyVisible ? 'Hide API key' : 'Show API key'}
                onClick={() => setKeyVisible((visible) => !visible)}
              >
                {keyVisible ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />}
              </button>
            </div>
          </label>

          {selected.type === 'zcode' && (
            <div className="prov-mgr__hint-row">
              <button type="button" className="prov-mgr__ghost-btn" onClick={() => void detectZcode()}>
                <Sparkles size={12} strokeWidth={1.5} />
                Detect from ZCode desktop
              </button>
            </div>
          )}

          <div className="prov-mgr__models-head">
            <span className="prov-mgr__label">Model list</span>
            <button
              type="button"
              className="prov-mgr__ghost-btn"
              onClick={() => setModelDialog('new')}
            >
              <Plus size={12} strokeWidth={1.75} />
              Add model
            </button>
          </div>

          <div className="prov-mgr__models">
            {selected.models.length === 0 && (
              <p className="prov-mgr__models-empty">No models — add one above.</p>
            )}
            {selected.models.map((model) => {
              const test = tests[model.id];
              return (
                <div key={model.id} className={`prov-mgr__model${model.enabled ? '' : ' prov-mgr__model--off'}`}>
                  <span className="prov-mgr__model-name">{model.name}</span>
                  {model.context && <span className="prov-mgr__badge">{model.context}</span>}
                  {model.vision && <span className="prov-mgr__badge">Vision</span>}
                  <span className="prov-mgr__model-actions">
                    <button
                      type="button"
                      className="prov-mgr__model-btn"
                      title="Send a 1-token test request"
                      aria-label={`Test ${model.name}`}
                      disabled={test === 'running'}
                      onClick={() => void testModel(model)}
                    >
                      {test === 'running' ? (
                        <Loader2 size={12} className="prov-mgr__spin" />
                      ) : test === 'ok' ? (
                        <Check size={12} strokeWidth={2} className="prov-mgr__test-ok" />
                      ) : test === 'fail' ? (
                        <Zap size={12} strokeWidth={1.75} className="prov-mgr__test-fail" />
                      ) : (
                        <Zap size={12} strokeWidth={1.5} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="prov-mgr__model-btn"
                      title="Edit model settings"
                      aria-label={`Edit ${model.name}`}
                      onClick={() => setModelDialog(model)}
                    >
                      <Pencil size={12} strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      className="prov-mgr__model-btn"
                      title="Remove model"
                      aria-label={`Remove ${model.name}`}
                      onClick={() => {
                        const models = selected.models.filter((m) => m.id !== model.id);
                        patch(selected.id, {
                          models,
                          model: models.find((m) => m.enabled)?.name ?? models[0]?.name ?? '',
                        });
                      }}
                    >
                      <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                    <label
                      className="prov-mgr__switch"
                      title={model.enabled ? 'Disable model' : 'Enable model'}
                    >
                      <input
                        type="checkbox"
                        checked={model.enabled}
                        onChange={(event) => patchModel(selected.id, model.id, { enabled: event.target.checked })}
                      />
                      <span />
                    </label>
                  </span>
                </div>
              );
            })}
          </div>

          <p className="prov-mgr__footnote">
            Keys stay on this machine (browser storage). The active provider for chat is selected in
            the AI agent panel; disabling a provider hides it from chat.
          </p>
        </section>
      </div>

      {modelDialog && (
        <AddModelDialog
          initial={modelDialog === 'new' ? null : modelDialog}
          onCancel={() => setModelDialog(null)}
          onSave={saveModelDialog}
        />
      )}
    </div>
  );
}
