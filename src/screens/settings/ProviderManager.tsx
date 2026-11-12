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
import { aiChat, claudeUsage, cliDetect, launchApp, zcodePlanSubscription } from '../../lib/tauriClient';
import { detectZcodeGlm, ZCODE_DEFAULT_MODEL } from '../../lib/zcode';
import {
  API_FORMAT_LABEL,
  activeProviderId,
  anthropicEndpoint,
  isCliProvider,
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

/** Auto-scan for installed AI apps — once per app session. */
let scannedAppsOnce = false;

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
  /** Plan-subscription fetch state for the selected z.ai-family provider. */
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
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

  /** z.ai coding-plan family — these expose the plan subscription API. */
  const isZaiFamily = selected?.type === 'zcode' || selected?.type === 'zcode-cli';

  // Auto-fetch once when a z.ai-family provider without plan data is selected.
  const planFetchRef = useRef('');
  useEffect(() => {
    if (
      (isZaiFamily || selected?.type === 'claude-code') &&
      !selected?.planInfo &&
      planFetchRef.current !== selected?.id &&
      (selected?.apiKey || selected?.type === 'zcode-cli' || selected?.type === 'claude-code')
    ) {
      planFetchRef.current = selected.id;
      void fetchPlan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const fetchPlan = async () => {
    if (!selected || planLoading) return;
    setPlanLoading(true);
    setPlanError('');
    try {
      let key = selected.apiKey;
      if (!key && selected.type === 'zcode-cli') {
        // The zcode CLI shares the desktop credential store's key.
        const zc = await detectZcodeGlm();
        key = zc?.apiKey ?? '';
      }
      const body =
        selected.type === 'claude-code' ? await claudeUsage() : await zcodePlanSubscription(key);
      patch(selected.id, { planInfo: { fetchedAt: Date.now(), body } });
      notify(
        selected.type === 'claude-code' ? 'Usage scanned from Claude Code logs' : 'Plan subscription updated',
        'success',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlanError(message);
      notify('Plan fetch failed', 'error');
    } finally {
      setPlanLoading(false);
    }
  };

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

  /** Scans for installed AI apps (ZCode, Claude Code, Codex, Copilot) and
   * adds providers for the ones not configured yet, reading each app's own
   * config for its default model. */
  const scanApps = async (silent = false) => {
    const added: string[] = [];
    try {
      let next = [...loadProviders()];
      let mutated = false;
      const hasType = (type: string) => next.some((p) => p.type === type);
      const addDetected = (
        type: string,
        name: string,
        configModels: string[],
        effort = '',
        baseUrl = '',
        apiKey = '',
        enabled = true,
        usable = true,
        launchKind?: string,
        launchTarget?: string,
      ) => {
        // The app's config is the source of truth: a detected provider's
        // model list mirrors exactly what the app's config declares.
        const model = configModels[0] ?? '';
        const buildModels = () =>
          configModels.map((m) => ({
            id: newId('m'),
            name: m,
            vision: false,
            enabled: true,
            ...(m === model && effort ? { effort } : {}),
          }));
        const existing = next.find((p) => p.type === type);
        if (existing) {
          // Backfill/refresh from the app's config — drop stale entries that
          // earlier (hardcoded-catalog) scans merged in, and attach launch
          // info for providers added before it was detected.
          const needsUsable = existing.usable !== usable;
          const needsLaunch = Boolean(
            launchKind && launchTarget && (!existing.launchKind || !existing.launchTarget),
          );
          if (configModels.length > 0) {
            const same =
              existing.model === model &&
              existing.models.length === configModels.length &&
              existing.models.every((m, i) => m.name === configModels[i]) &&
              !needsUsable &&
              !needsLaunch;
            if (!same) {
              next = next.map((p) =>
                p.id === existing.id
                  ? { ...p, model, models: buildModels(), usable, ...(needsLaunch ? { launchKind, launchTarget } : {}) }
                  : p,
              );
              mutated = true;
            }
          } else if (needsUsable || needsLaunch) {
            next = next.map((p) =>
              p.id === existing.id
                ? { ...p, usable: needsUsable ? usable : p.usable, ...(needsLaunch ? { launchKind, launchTarget } : {}) }
                : p,
            );
            mutated = true;
          }
          return;
        }
        next = [
          ...next,
          {
            id: newId('p'),
            name,
            kind: 'custom',
            detected: true,
            type,
            apiFormat: 'openai',
            baseUrl,
            apiKey,
            model,
            enabled,
            models: buildModels(),
            ...(launchKind && launchTarget ? { launchKind, launchTarget } : {}),
          },
        ];
        added.push(name);
      };
      const detected = await cliDetect();
      // ZCode's model set comes from its OWN plan subscription report — the
      // modelCode entries the plan actually records (real usage).
      let zcodeModel = '';
      let zcodePlanModels: string[] = [];
      try {
        const zcode = await detectZcodeGlm();
        if (zcode) {
          zcodeModel = zcode.model;
          if (!hasType('zcode')) {
            addDetected(
              'zcode',
              zcode.name,
              [zcode.model],
              '',
              zcode.baseUrl,
              zcode.apiKey,
            );
          }
          try {
            const body = await zcodePlanSubscription(zcode.apiKey);
            zcodePlanModels = planModelCodes(body);
          } catch {
            // plan API unreachable — fall back to the credential's model
          }
        }
      } catch {
        // ZCode desktop not installed / unreadable
      }
      // Generic scan — every detected CLI coding agent becomes a provider.
      // zcode's CLI kind is distinct from the HTTP zcode providers;
      // claude's canonical type is claude-code (matches earlier entries).
      for (const app of detected.apps) {
        const type =
          app.binary === 'zcode' ? 'zcode-cli' : app.binary === 'claude' ? 'claude-code' : app.binary;
        const configModels =
          app.binary === 'zcode'
            ? zcodePlanModels.length > 0
              ? zcodePlanModels
              : [zcodeModel || ZCODE_DEFAULT_MODEL]
            : app.model
              ? [app.model]
              : [];
        addDetected(
          type,
          app.name,
          configModels,
          app.effort,
          '',
          '',
          true,
          app.usable !== false,
          app.launchKind || 'cli',
          app.launchTarget || app.binary,
        );
      }
      // Desktop AI apps — listed as detected inventory (they run in their
      // own window with their own login; disabled until the user opts in).
      for (const desktopApp of detected.desktop) {
        addDetected(
          desktopApp.id,
          desktopApp.name,
          [],
          '',
          '',
          '',
          false,
          false,
          desktopApp.launchKind,
          desktopApp.launchTarget,
        );
      }
      if (added.length > 0 || mutated) {
        // Persist new providers AND re-grouping marks for earlier scans.
        commit(next);
        notify('Added AI apps: ' + added.join(', '), 'success');
      } else if (!silent) {
        notify('All installed AI apps are already configured', 'success');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  // Scan once per app session when the settings screen opens.
  useEffect(() => {
    if (scannedAppsOnce) return;
    scannedAppsOnce = true;
    void scanApps(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const apps = providers.filter((p) => p.kind !== 'builtin' && p.detected);
  const customs = providers.filter((p) => p.kind !== 'builtin' && !p.detected);

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
            className="prov-mgr__ghost-btn"
            title="Look for ZCode, Claude Code, Codex and Copilot installed on this machine"
            onClick={() => void scanApps()}
          >
            <Sparkles size={12} strokeWidth={1.5} />
            Detect AI apps
          </button>
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
          {apps.length > 0 && (
            <>
              <span className="prov-mgr__group">Installed AI apps</span>
              {apps.map(renderRow)}
            </>
          )}
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
            {selected.detected && selected.launchKind && selected.launchTarget && (
              <button
                type="button"
                className="prov-mgr__ghost-btn"
                title={`Launch ${selected.name}`}
                onClick={() => {
                  launchApp(selected.launchKind!, selected.launchTarget!)
                    .then((message) => notify(message, 'success'))
                    .catch((error) =>
                      notify(error instanceof Error ? error.message : String(error), 'error'),
                    );
                }}
              >
                <Zap size={12} strokeWidth={1.5} />
                Launch
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

          {(isZaiFamily || selected.type === 'claude-code') && (
            <div className="prov-mgr__plan">
              <div className="prov-mgr__plan-head">
                <span className="prov-mgr__label">
                  {selected.type === 'claude-code' ? 'Usage (from Claude Code logs)' : 'Plan subscription'}
                </span>
                <button
                  type="button"
                  className="prov-mgr__ghost-btn"
                  disabled={planLoading}
                  title="Fetch the coding-plan subscription/quota report"
                  onClick={() => void fetchPlan()}
                >
                  {planLoading ? <Loader2 size={12} className="prov-mgr__spin" /> : <RefreshCw size={12} strokeWidth={1.5} />}
                  {selected.type === 'claude-code' ? 'Scan usage' : 'Refresh'}
                </button>
              </div>
              {planError && <p className="prov-mgr__plan-error">{planError}</p>}
              {selected.planInfo ? (
                selected.type === 'claude-code' ? (
                  <ClaudeUsageView body={selected.planInfo.body} fetchedAt={selected.planInfo.fetchedAt} />
                ) : (
                  <PlanLimitsView body={selected.planInfo.body} fetchedAt={selected.planInfo.fetchedAt} />
                )
              ) : (
                <p className="prov-mgr__footnote">
                  {selected.type === 'claude-code'
                    ? 'No usage scanned yet — hit Scan usage.'
                    : 'No plan data fetched yet — hit Refresh.'}
                </p>
              )}
            </div>
          )}

          {selected.type === 'zcode' && (
            <div className="prov-mgr__hint-row">
              <button type="button" className="prov-mgr__ghost-btn" onClick={() => void detectZcode()}>
                <Sparkles size={12} strokeWidth={1.5} />
                Detect from ZCode desktop
              </button>
            </div>
          )}

          {isCliProvider(selected) && (
            <div className="prov-mgr__hint-row">
              <p className="prov-mgr__footnote">
                Runs through the installed{' '}
                {selected.type === 'claude-code' ? 'claude' : selected.type === 'copilot' ? 'copilot' : selected.type === 'zcode-cli' ? 'zcode' : 'codex'} CLI —
                uses that app's own login and subscription. Base URL and API key are not needed.
              </p>
            </div>
          )}

          {['claude-desktop', 'chatgpt-desktop', 'gemini-desktop'].includes(selected.type) && (
            <div className="prov-mgr__hint-row">
              <p className="prov-mgr__footnote">
                Desktop app detected — pigry lists it once installed. The app runs in its own
                window with its own login; it manages its model there. Disabled by default since
                chat can't be routed into the desktop app directly.
              </p>
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
            {selected.models.length === 0 &&
              (isCliProvider(selected) || selected.detected ? (
                <p className="prov-mgr__models-empty">
                  This app manages its own model inside the app — nothing to configure here.
                </p>
              ) : (
                <p className="prov-mgr__models-empty">No models — add one above.</p>
              ))}
            {selected.models.map((model) => {
              const test = tests[model.id];
              return (
                <div key={model.id} className={`prov-mgr__model${model.enabled ? '' : ' prov-mgr__model--off'}`}>
                  <span className="prov-mgr__model-name">{model.name}</span>
                  {model.context && <span className="prov-mgr__badge">{model.context}</span>}
                  {model.vision && <span className="prov-mgr__badge">Vision</span>}
                  {model.effort && <span className="prov-mgr__badge">Effort: {model.effort}</span>}
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

/** Parsed view of the z.ai coding-plan quota report. */
interface PlanLimit {
  type?: string;
  unit?: number;
  number?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: Array<{ modelCode?: string; usage?: number }>;
}

/** Real model codes recorded by the z.ai coding plan (usage details). */
function planModelCodes(body: string): string[] {
  try {
    const limits = (JSON.parse(body)?.data?.limits ?? []) as Array<{
      usageDetails?: Array<{ modelCode?: string }>;
    }>;
    const codes: string[] = [];
    for (const limit of limits) {
      for (const detail of limit.usageDetails ?? []) {
        if (detail.modelCode && !codes.includes(detail.modelCode)) {
          codes.push(detail.modelCode);
        }
      }
    }
    return codes;
  } catch {
    return [];
  }
}

function parsePlanLimits(body: string): PlanLimit[] {
  try {
    return (JSON.parse(body)?.data?.limits ?? []) as PlanLimit[];
  } catch {
    return [];
  }
}

function planLimitLabel(limit: PlanLimit): string {
  if (limit.type === 'TIME_LIMIT') return '5-hour session quota';
  if (limit.type === 'TOKENS_LIMIT') return 'Monthly token quota';
  return limit.type ?? 'Quota';
}

function PlanLimitsView({ body, fetchedAt }: { body: string; fetchedAt: number }) {
  const limits = parsePlanLimits(body);
  if (limits.length === 0) {
    return <p className="prov-mgr__footnote">No quota limits in the report.</p>;
  }
  return (
    <div className="prov-mgr__plan-rows">
      {limits.map((limit, index) => (
        <div key={index} className="prov-mgr__plan-row">
          <span className="prov-mgr__plan-label">{planLimitLabel(limit)}</span>
          <span className="prov-mgr__plan-value">
            {typeof limit.percentage === 'number' ? `${limit.percentage}% used` : ''}
            {typeof limit.remaining === 'number' ? ` · ${limit.remaining} left` : ''}
          </span>
          {limit.nextResetTime ? (
            <span className="prov-mgr__plan-reset">
              resets {new Date(limit.nextResetTime).toLocaleString()}
            </span>
          ) : null}
          {limit.usageDetails && limit.usageDetails.length > 0 && (
            <span className="prov-mgr__plan-models">
              {limit.usageDetails.map((u) => `${u.modelCode}: ${u.usage}`).join(' · ')}
            </span>
          )}
        </div>
      ))}
      <p className="prov-mgr__footnote">Fetched {new Date(fetchedAt).toLocaleString()}</p>
    </div>
  );
}

/** Parsed view of Claude Code's own session-log usage aggregate. */
interface ClaudeModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
}

function ClaudeUsageView({ body, fetchedAt }: { body: string; fetchedAt: number }) {
  let report: { sessions?: number; models?: ClaudeModelUsage[] } | null = null;
  try {
    report = JSON.parse(body);
  } catch {
    // unparsable aggregate
  }
  const models = report?.models ?? [];
  if (models.length === 0) {
    return <p className="prov-mgr__footnote">No usage records found in Claude Code logs.</p>;
  }
  const tokens = (m: ClaudeModelUsage) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
  return (
    <div className="prov-mgr__plan-rows">
      {models.map((m) => (
        <div key={m.model} className="prov-mgr__plan-row">
          <span className="prov-mgr__plan-label">{m.model}</span>
          <span className="prov-mgr__plan-value">
            {tokens(m).toLocaleString()} tokens · {m.requests} requests
          </span>
          <span className="prov-mgr__plan-models">
            in {m.inputTokens.toLocaleString()} · out {m.outputTokens.toLocaleString()} · cache read{' '}
            {m.cacheReadTokens.toLocaleString()} · cache write {m.cacheCreationTokens.toLocaleString()}
          </span>
        </div>
      ))}
      <p className="prov-mgr__footnote">
        {report?.sessions ?? 0} sessions · scanned {new Date(fetchedAt).toLocaleString()}
      </p>
    </div>
  );
}
