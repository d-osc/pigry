import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  Pencil,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { aiChat, cliAgentRun, cliDetect, readWorktreeFile } from '../../lib/tauriClient';
import { detectZcodeGlm } from '../../lib/zcode';
import { renderMarkdown } from '../../lib/markdown';
import {
  activeProviderId,
  anthropicEndpoint,
  isCliProvider,
  loadProviders as loadProviderStore,
  resolveEndpoint,
  saveProviders,
  type AiProviderEntry,
} from '../../lib/aiProviders';
import './AiAgentPanel.css';

interface ChatImage {
  name: string;
  dataUrl: string;
}

interface AttachedFile {
  path: string;
  content: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  /** Clean, editable message text (context is kept separately). */
  text: string;
  /** Baked context (selection + attachments) sent with the payload. */
  context?: string;
  /** Editor selection attached at send time — shown as a code card. */
  selection?: { path: string; startLine: number; endLine: number; text: string } | null;
  images?: string[];
  error?: boolean;
}

/** Full store entry for a detected CLI agent (no HTTP config). */
function cliEntry(id: string, name: string, type: 'claude-code' | 'codex', model: string): AiProviderEntry {
  return {
    id,
    name,
    kind: 'custom',
    type,
    apiFormat: 'openai',
    baseUrl: '',
    apiKey: '',
    model,
    enabled: true,
    models: [],
  };
}

interface AiAgentPanelProps {
  /** Active worktree file path (auto-attached as context). */
  fileName: string;
  width: number;
  onCollapse: () => void;
  /** Current editor text selection (VS Code-style "add selection to chat"). */
  selection?: { path: string; text: string; startLine: number; endLine: number } | null;
}

/** One-click prompts shown on the empty state. */
const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'Explain this file', prompt: 'Explain what this file does and walk through its key parts.' },
  { label: 'Review for bugs', prompt: 'Review this file for bugs and edge cases. Be specific.' },
  { label: 'Improve naming', prompt: 'Suggest clearer names for the identifiers in this file.' },
  { label: 'Write tests', prompt: 'Suggest focused tests for this file.' },
];

export function AiAgentPanel({ fileName, width, onCollapse, selection }: AiAgentPanelProps) {
  const [providers, setProviders] = useState<AiProviderEntry[]>([]);
  const [activeId, setActiveId] = useState<string>(() => activeProviderId());
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  // Message being edited (index) + its draft (Copilot-style edit & resubmit).
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Dismissed selection key — reset whenever a different selection arrives.
  const selectionKey = selection ? `${selection.path}:${selection.startLine}:${selection.endLine}` : '';
  const [dismissedKey, setDismissedKey] = useState('');
  useEffect(() => {
    setDismissedKey('');
  }, [selectionKey]);
  const activeSelection =
    selection && selectionKey !== dismissedKey ? selection : null;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<ChatImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachError, setAttachError] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ZCode Cloud (GLM) — detected automatically when ZCode desktop is installed.
  const [zcodeProvider, setZcodeProvider] = useState<AiProviderEntry | null>(null);
  // CLI coding agents — detected via --version on mount.
  const [cliProviders, setCliProviders] = useState<AiProviderEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    detectZcodeGlm()
      .then((provider) => {
        if (!cancelled && provider) {
          setZcodeProvider({
            ...cliEntry('zcode-cloud', provider.name, 'claude-code', provider.model),
            type: 'zcode',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          });
        }
      })
      .catch(() => {});
    cliDetect()
      .then((result) => {
        if (cancelled) return;
        const found: AiProviderEntry[] = [];
        if (result.claude) {
          found.push(
            cliEntry(
              'cli-claude',
              'Claude Code' + (result.claudeVersion ? ' · ' + result.claudeVersion : ''),
              'claude-code',
              'claude CLI (own subscription)',
            ),
          );
        }
        if (result.codex) {
          found.push(
            cliEntry(
              'cli-codex',
              'Codex' + (result.codexVersion ? ' · ' + result.codexVersion : ''),
              'codex',
              'codex CLI (own subscription)',
            ),
          );
        }
        setCliProviders(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const allProviders = useMemo(
    () => [...cliProviders, ...(zcodeProvider ? [zcodeProvider] : []), ...providers],
    [cliProviders, zcodeProvider, providers],
  );
  const active =
    allProviders.find((provider) => provider.id === activeId) ?? allProviders[0] ?? null;

  // Mirror the Settings → AI Provider manager (localStorage-driven).
  useEffect(() => {
    const sync = () => {
      setProviders(loadProviderStore());
      const id = activeProviderId();
      if (id) setActiveId(id);
    };
    sync();
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  // Persist the conversation (drop image data URLs to respect storage limits).
  useEffect(() => {
    try {
      const slim = messages.slice(-30).map((message) => ({ ...message, images: undefined }));
      localStorage.setItem('orbit:ai-conversation', JSON.stringify(slim));
    } catch {
      // storage full — drop silently
    }
  }, [messages]);

  // Restore conversation once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('orbit:ai-conversation');
      if (raw) setMessages(JSON.parse(raw) as ChatMessage[]);
    } catch {
      // ignore
    }
  }, []);

  // Auto-scroll to the newest message.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, sending]);

  const attachImages = (files: FileList | null) => {
    if (!files?.length) return;
    setAttachError('');
    Array.from(files)
      .slice(0, 4)
      .forEach((file) => {
        if (!file.type.startsWith('image/')) {
          setAttachError(`${file.name} is not an image`);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          setImages((current) => [...current, { name: file.name, dataUrl: String(reader.result) }]);
        };
        reader.readAsDataURL(file);
      });
  };

  const attachActiveFile = async () => {
    if (!fileName) return;
    setAttachError('');
    try {
      const file = await readWorktreeFile(fileName);
      if (file.binary || file.tooLarge) {
        setAttachError('Active file is binary or too large to attach');
        return;
      }
      setAttachedFiles((current) =>
        current.some((f) => f.path === fileName)
          ? current
          : [...current, { path: fileName, content: file.content }],
      );
    } catch {
      setAttachError('Could not read the active file');
    }
  };

  const removeAttached = (path: string) => {
    setAttachedFiles((current) => current.filter((file) => file.path !== path));
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!active) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: 'No AI provider configured — add one in Settings → AI Provider.',
          error: true,
        },
      ]);
      return;
    }

    let context = '';
    if (activeSelection) {
      context += `\n\n[Selected code — ${activeSelection.path}:${activeSelection.startLine}-${activeSelection.endLine}]\n${activeSelection.text.slice(0, 8000)}`;
    }
    for (const attached of attachedFiles) {
      context += `\n\n[Attached file: ${attached.path}]\n${attached.content.slice(0, 12000)}`;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      text,
      context,
      selection: activeSelection
        ? {
            path: activeSelection.path,
            startLine: activeSelection.startLine,
            endLine: activeSelection.endLine,
            text: activeSelection.text.slice(0, 8000),
          }
        : null,
      images: images.map((image) => image.dataUrl),
    };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput('');
    setImages([]);
    await doSend(history);
  };

  /** Edits a sent user message and re-runs the conversation from there
   * (VS Code Copilot style): everything after the edited message is
   * discarded and a fresh reply is generated. */
  const resendEdited = async (index: number, newText: string) => {
    if (sending || !newText.trim()) return;
    const edited: ChatMessage = { ...messages[index], text: newText.trim() };
    const history = [...messages.slice(0, index), edited];
    setMessages(history);
    setEditingIndex(null);
    await doSend(history);
  };

  /** Runs the provider for `history` (whose last entry is the user turn). */
  const doSend = async (history: ChatMessage[]) => {
    const last = history[history.length - 1];
    setSending(true);

    if (isCliProvider(active)) {
      const cli = active.type === 'claude-code' ? 'claude' : 'codex';
      try {
        const output = await cliAgentRun(cli, last.text);
        setMessages((m) => [...m, { role: 'assistant', text: output || '(no output)' }]);
      } catch (error) {
        setMessages((m) => [
          ...m,
          { role: 'assistant', text: error instanceof Error ? error.message : String(error), error: true },
        ]);
      } finally {
        setSending(false);
      }
      return;
    }

    const isAnthropic = active.apiFormat === 'anthropic';
    const rawEndpoint = resolveEndpoint(active);
    const endpoint = isAnthropic ? anthropicEndpoint(rawEndpoint) : rawEndpoint;
    // Anthropic image blocks carry base64 without the data: URL prefix.
    const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);
    const mediaTypeOf = (dataUrl: string) =>
      dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
    const fullText = last.text + (last.context ?? '');
    const turnImages = (last.images ?? []).map((dataUrl) => ({ dataUrl }));
    const content = isAnthropic
      ? turnImages.length > 0
        ? [
            { type: 'text', text: fullText },
            ...turnImages.map((image) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaTypeOf(image.dataUrl),
                data: base64Of(image.dataUrl),
              },
            })),
          ]
        : fullText
      : turnImages.length > 0
        ? [
            { type: 'text', text: fullText },
            ...turnImages.map((image) => ({
              type: 'image_url',
              image_url: { url: image.dataUrl },
            })),
          ]
        : fullText;
    const payload = isAnthropic
      ? {
          model: active.model || 'claude-sonnet',
          max_tokens: 4096,
          messages: [{ role: 'user', content }],
        }
      : {
          model: active.model || 'glm-4.6',
          messages: [{ role: 'user', content }],
          stream: false,
        };

    try {
      const result = await aiChat(
        endpoint,
        active.apiKey,
        JSON.stringify(payload),
        isAnthropic ? 'anthropic' : 'bearer',
      );
      const parsed = (() => {
        try {
          return JSON.parse(result.body) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      let assistantText = '';
      if (isAnthropic) {
        const blocks = parsed?.content as Array<{ type?: string; text?: string }> | undefined;
        assistantText =
          blocks
            ?.filter((block) => block?.type === 'text')
            .map((block) => block.text ?? '')
            .join('') ?? '';
      } else {
        assistantText =
          (parsed as { choices?: Array<{ message?: { content?: string } }> })
            ?.choices?.[0]?.message?.content ?? '';
      }
      if (!result.ok || !assistantText) {
        // Anthropic gateways surface errors as {code, message}, the official
        // API as {error:{message}} — try both before falling back.
        const err = parsed as
          | { error?: { message?: string }; message?: string; code?: string }
          | null;
        const message =
          err?.error?.message ?? err?.message ?? err?.code ?? result.error ?? `HTTP ${result.status}`;
        setMessages((m) => [...m, { role: 'assistant', text: String(message), error: true }]);
      } else {
        setMessages((m) => [...m, { role: 'assistant', text: assistantText }]);
      }
    } catch (error) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: error instanceof Error ? error.message : String(error),
          error: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const clearConversation = () => {
    setMessages([]);
    try {
      localStorage.removeItem('orbit:ai-conversation');
    } catch {
      // ignore
    }
  };

  const providerLabel = active ? `${active.name || active.type}${active.model ? ' · ' + active.model : ''}` : 'No provider';

  return (
    <aside className="explorer-ai" style={{ width }}>
      <header className="explorer-ai__header">
        <div className="explorer-ai__title">
          <span className="explorer-ai__badge">
            <i />
            AI
          </span>
          <strong>AI Agent</strong>
        </div>
        <div className="explorer-ai__header-actions">
          <span className="explorer-ai__ctx-chip" title={fileName}>
            {fileName}
          </span>
          <button
            type="button"
            className="explorer-ai__collapse"
            aria-label="Collapse AI panel"
            title="Hide AI Agent panel"
            onClick={onCollapse}
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="explorer-ai__body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="ai-hero">
            <div className="ai-hero__icon">
              <Sparkles size={20} strokeWidth={1.5} />
            </div>
            <h3 className="ai-hero__title">
              Ask AI about <code>{fileName}</code>
            </h3>
            <p className="ai-hero__sub">Attach files or images for deeper context.</p>
            <div className="ai-hero__chips">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  className="ai-hero__chip"
                  onClick={() => {
                    setInput(suggestion.prompt);
                    textareaRef.current?.focus();
                  }}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <section className="explorer-ai__section">
            <div className="explorer-ai__card">
              {messages.map((message, index) => {
                const isUser = message.role === 'user';
                const editing = editingIndex === index;
                return (
                  <div
                    key={index}
                    className={`explorer-ai__msg ${isUser ? 'explorer-ai__msg--user' : ''}${message.error ? ' explorer-ai__msg--error' : ''}`}
                  >
                    <div className="explorer-ai__msg-meta">
                      <span className="explorer-ai__avatar">{isUser ? 'You' : 'AI'}</span>
                      <span className="explorer-ai__msg-name">{isUser ? 'You' : 'AI Agent'}</span>
                      {isUser && !editing && (
                        <button
                          type="button"
                          className="explorer-ai__msg-edit-btn"
                          title="Edit message and resend"
                          aria-label="Edit message"
                          disabled={sending}
                          onClick={() => {
                            setEditingIndex(index);
                            setEditDraft(message.text);
                          }}
                        >
                          <Pencil size={11} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                    {editing ? (
                      <div className="explorer-ai__msg-editor">
                        <textarea
                          className="explorer-ai__msg-editor-input"
                          value={editDraft}
                          rows={Math.min(10, Math.max(2, editDraft.split('\n').length))}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditingIndex(null);
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                              event.preventDefault();
                              void resendEdited(index, editDraft);
                            }
                          }}
                          autoFocus
                        />
                        <div className="explorer-ai__msg-editor-actions">
                          <button
                            type="button"
                            className="explorer-ai__msg-editor-btn"
                            onClick={() => setEditingIndex(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="explorer-ai__msg-editor-btn explorer-ai__msg-editor-btn--primary"
                            disabled={!editDraft.trim() || sending}
                            onClick={() => void resendEdited(index, editDraft)}
                          >
                            <Check size={11} strokeWidth={2} />
                            Save &amp; resubmit
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {isUser && message.selection && (
                          <div className="explorer-ai__msg-selection" title={message.selection.path}>
                            <div className="explorer-ai__msg-selection-head">
                              <FileText size={10} strokeWidth={1.5} />
                              <span>{message.selection.path.split('/').pop()}</span>
                              <span className="explorer-ai__msg-selection-range">
                                {message.selection.startLine}–{message.selection.endLine}
                              </span>
                            </div>
                            <pre className="explorer-ai__msg-selection-code">
                              {message.selection.text}
                            </pre>
                          </div>
                        )}
                        <div className="explorer-ai__msg-text">
                          {isUser ? message.text : renderMarkdown(message.text)}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              {sending && (
                <div className="explorer-ai__msg">
                  <div className="explorer-ai__msg-meta">
                    <span className="explorer-ai__avatar">AI</span>
                    <span className="explorer-ai__msg-name">AI Agent</span>
                  </div>
                  <span className="ai-typing" aria-label="AI is thinking">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      <footer className="explorer-ai__footer">
        <div className="ai-composer">
          {(activeSelection || attachedFiles.length > 0 || images.length > 0) && (
            <div className="ai-composer__attachments">
              {activeSelection && (
                <span
                  className="ai-composer__sel-chip"
                  title={`Selected lines ${activeSelection.startLine}–${activeSelection.endLine} of ${activeSelection.path} — included with your next message`}
                >
                  <FileText size={10} strokeWidth={1.5} />
                  {activeSelection.path.split('/').pop()}
                  <span className="ai-composer__sel-range">
                    {activeSelection.startLine}–{activeSelection.endLine}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove selection from chat"
                    onClick={() => setDismissedKey(selectionKey)}
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              )}
              {attachedFiles.map((file) => (
                <span key={file.path} className="explorer-ai__chip" title={file.path}>
                  <FileText size={10} strokeWidth={1.5} />
                  {file.path.split('/').pop()}
                  <button type="button" aria-label={`Remove ${file.path}`} onClick={() => removeAttached(file.path)}>
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              ))}
              {images.map((image, index) => (
                <span key={index} className="explorer-ai__thumb">
                  <img src={image.dataUrl} alt={image.name} />
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="ai-composer__input"
            placeholder={`Ask AI to improve this file… (Enter to send)`}
            aria-label="Ask AI"
            value={input}
            rows={2}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {attachError && <p className="ai-composer__error">{attachError}</p>}
          <div className="ai-composer__bar">
            <div className="ai-composer__tools">
              <button
                type="button"
                className="ai-composer__tool"
                title="Attach image (PNG/JPG)"
                onClick={() => imageInputRef.current?.click()}
              >
                <ImageIcon size={12} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                className="ai-composer__tool"
                title={`Attach active file (${fileName})`}
                onClick={() => void attachActiveFile()}
              >
                <Paperclip size={12} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                className="ai-composer__tool"
                title="Clear conversation"
                onClick={clearConversation}
              >
                <Trash2 size={12} strokeWidth={1.5} />
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  attachImages(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="ai-composer__right">
              <button
                type="button"
                className="explorer-ai__model-pill"
                title="Change provider or model"
                onClick={() => setModelDialogOpen(true)}
              >
                <span className={`explorer-ai__model-dot explorer-ai__model-dot--${active && active.apiKey && active.baseUrl ? 'ok' : 'warn'}`} />
                <span className="explorer-ai__model-pill-name">{providerLabel}</span>
                <ChevronDown size={11} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="ai-composer__send"
                aria-label="Send"
                disabled={sending || !input.trim()}
                onClick={() => void send()}
              >
                {sending ? (
                  <Loader2 size={14} strokeWidth={1.75} className="explorer-ai__send-spin" />
                ) : (
                  <ArrowRight size={14} strokeWidth={1.75} />
                )}
              </button>
            </div>
          </div>
        </div>
        <div className="ai-composer__hint">
          Context: {fileName}
          {activeSelection ? ` · lines ${activeSelection.startLine}–${activeSelection.endLine} selected` : ''}
          {attachedFiles.length > 0 ? ` +${attachedFiles.length} attached` : ''}
        </div>
      </footer>

      {modelDialogOpen && (
        <ModelPickerDialog
          providers={providers}
          activeId={active?.id ?? ''}
          onClose={() => setModelDialogOpen(false)}
          onPick={(providerId, modelName) => {
            // Persist the chosen model as the provider's active one, then
            // switch — the panel and legacy consumers both read the mirror.
            const list = providers.map((p) =>
              p.id === providerId
                ? { ...p, model: modelName, models: p.models.map((m) => ({ ...m, enabled: m.name === modelName ? true : m.enabled })) }
                : p,
            );
            saveProviders(list, providerId);
            setProviders(list);
            setActiveId(providerId);
            setModelDialogOpen(false);
          }}
        />
      )}
    </aside>
  );
}

/** Full-screen dialog: pick a provider on the left, a model on the right. */
function ModelPickerDialog({
  providers,
  activeId,
  onClose,
  onPick,
}: {
  providers: AiProviderEntry[];
  activeId: string;
  onClose: () => void;
  onPick: (providerId: string, modelName: string) => void;
}) {
  const activeProvider = providers.find((p) => p.id === activeId) ?? null;
  const [viewId, setViewId] = useState(activeProvider?.id ?? providers[0]?.id ?? '');
  const viewed = providers.find((p) => p.id === viewId) ?? providers[0] ?? null;

  return (
    <div
      className="model-dlg-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="model-dlg" role="dialog" aria-modal="true" aria-label="Select model">
        <header className="model-dlg__head">
          <strong className="model-dlg__title">Select model</strong>
          <button type="button" className="model-dlg__close" onClick={onClose} aria-label="Close model picker">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>
        <div className="model-dlg__body">
          <aside className="model-dlg__providers" aria-label="Providers">
            <span className="model-dlg__group">Providers</span>
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={`model-dlg__provider${provider.id === viewId ? ' model-dlg__provider--active' : ''}`}
                onClick={() => setViewId(provider.id)}
              >
                <span className={`model-dlg__dot model-dlg__dot--${provider.apiKey && provider.baseUrl ? 'ok' : 'warn'}`} />
                <span className="model-dlg__provider-name">{provider.name}</span>
                <span className="model-dlg__provider-count">{provider.models.length}</span>
              </button>
            ))}
          </aside>
          <section className="model-dlg__models" aria-label={`Models of ${viewed?.name ?? ''}`}>
            {viewed && viewed.models.length === 0 && (
              <p className="model-dlg__empty">No models — add some in Settings → AI Provider.</p>
            )}
            {viewed?.models.map((model) => {
              const isChosen = viewed.id === activeId && model.name === viewed.model;
              return (
                <button
                  key={model.id}
                  type="button"
                  className={`model-dlg__model${isChosen ? ' model-dlg__model--chosen' : ''}${model.enabled ? '' : ' model-dlg__model--off'}`}
                  onClick={() => onPick(viewed.id, model.name)}
                  disabled={!model.enabled}
                >
                  {isChosen ? (
                    <Check size={13} strokeWidth={2} className="model-dlg__check" />
                  ) : (
                    <span className="model-dlg__check-spacer" />
                  )}
                  <span className="model-dlg__model-name">{model.name}</span>
                  {model.context && <span className="model-dlg__badge">{model.context}</span>}
                  {model.vision && <span className="model-dlg__badge">Vision</span>}
                </button>
              );
            })}
          </section>
        </div>
        <footer className="model-dlg__foot">
          <span className="model-dlg__hint">Manage providers in Settings → AI Provider.</span>
        </footer>
      </div>
    </div>
  );
}
