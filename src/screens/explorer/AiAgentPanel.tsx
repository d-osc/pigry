import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { aiChat, cliAgentRun, cliDetect, readWorktreeFile } from '../../lib/tauriClient';
import { detectZcodeGlm } from '../../lib/zcode';
import {
  activeProviderId,
  anthropicEndpoint,
  isCliProvider,
  loadProviders as loadProviderStore,
  resolveEndpoint,
  setActiveProvider,
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
  text: string;
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
}

export function AiAgentPanel({ fileName, width, onCollapse }: AiAgentPanelProps) {
  const [providers, setProviders] = useState<AiProviderEntry[]>([]);
  const [activeId, setActiveId] = useState<string>(() => activeProviderId());
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<ChatImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachError, setAttachError] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

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

  // Outside click closes the provider picker.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [pickerOpen]);

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
    for (const attached of attachedFiles) {
      context += `\n\n[Attached file: ${attached.path}]\n${attached.content.slice(0, 12000)}`;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      text: text + (context ? `\n\n---\n${context}` : ''),
      images: images.map((image) => image.dataUrl),
    };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput('');
    setImages([]);
    setSending(true);

    if (isCliProvider(active)) {
      const cli = active.type === 'claude-code' ? 'claude' : 'codex';
      try {
        const output = await cliAgentRun(cli, userMessage.text);
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
    const content = isAnthropic
      ? images.length > 0
        ? [
            { type: 'text', text: userMessage.text },
            ...images.map((image) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaTypeOf(image.dataUrl),
                data: base64Of(image.dataUrl),
              },
            })),
          ]
        : userMessage.text
      : images.length > 0
        ? [
            { type: 'text', text: userMessage.text },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: { url: image.dataUrl },
            })),
          ]
        : userMessage.text;
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
        <section className="explorer-ai__section">
          <p className="explorer-ai__label">Provider</p>
          <div className="explorer-ai__card explorer-ai__provider-row">
            <Sparkles size={12} strokeWidth={1.5} className="explorer-ai__provider-icon" />
            <span className="explorer-ai__provider-name" title={providerLabel}>
              {providerLabel}
            </span>
            <button
              type="button"
              className="explorer-ai__provider-btn"
              aria-label="Change provider or model"
              title="Change provider / model (Settings → AI Provider)"
              onClick={() => setPickerOpen((open) => !open)}
            >
              <Settings2 size={12} strokeWidth={1.5} />
            </button>
            {pickerOpen && (
              <div className="explorer-ai__picker" ref={pickerRef}>
                {zcodeProvider && (
                  <button
                    type="button"
                    className={`explorer-ai__picker-item${active?.id === zcodeProvider.id ? ' is-active' : ''}`}
                    onClick={() => {
                      setActiveId(zcodeProvider.id);
                      setActiveProvider(zcodeProvider.id);
                      setPickerOpen(false);
                    }}
                  >
                    <Sparkles size={11} strokeWidth={1.5} />
                    {zcodeProvider.name} — detected
                  </button>
                )}
                {providers.length === 0 && !zcodeProvider && (
                  <p className="explorer-ai__picker-empty">No providers — add one in Settings → AI Provider.</p>
                )}
                {providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`explorer-ai__picker-item${provider.id === active?.id ? ' is-active' : ''}`}
                    onClick={() => {
                      setActiveId(provider.id);
                      setActiveProvider(provider.id);
                      setPickerOpen(false);
                    }}
                  >
                    <Sparkles size={11} strokeWidth={1.5} />
                    {provider.name}
                  </button>
                ))}
                <button
                  type="button"
                  className="explorer-ai__picker-settings"
                  onClick={() => setPickerOpen(false)}
                >
                  <Settings2 size={11} strokeWidth={1.5} />
                  Manage in Settings
                </button>
              </div>
            )}
          </div>
        </section>

        {messages.length === 0 ? (
          <section className="explorer-ai__section">
            <div className="explorer-ai__card explorer-ai__empty">
              <Sparkles size={18} strokeWidth={1.25} />
              <p>Ask anything about <code>{fileName}</code> — attach files or images for deeper context.</p>
            </div>
          </section>
        ) : (
          <section className="explorer-ai__section">
            <p className="explorer-ai__label">Conversation</p>
            <div className="explorer-ai__card">
              {messages.map((message, index) => (
                <div key={index} className={`explorer-ai__msg ${message.role === 'user' ? 'explorer-ai__msg--user' : ''}${message.error ? ' explorer-ai__msg--error' : ''}`}>
                  <div className="explorer-ai__msg-meta">
                    <span className="explorer-ai__avatar">{message.role === 'user' ? 'You' : 'AI'}</span>
                    <span className="explorer-ai__msg-name">{message.role === 'user' ? 'You' : 'AI Agent'}</span>
                  </div>
                  <p className="explorer-ai__msg-text">{message.text}</p>
                </div>
              ))}
              {sending && (
                <div className="explorer-ai__msg">
                  <div className="explorer-ai__msg-meta">
                    <Loader2 size={12} className="explorer-ai__spinner" />
                    <span className="explorer-ai__msg-name">AI Agent</span>
                  </div>
                  <p className="explorer-ai__msg-text">Thinking…</p>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="explorer-ai__section">
          {attachedFiles.length > 0 && (
            <div className="explorer-ai__attached">
              {attachedFiles.map((file) => (
                <span key={file.path} className="explorer-ai__chip" title={file.path}>
                  <FileText size={10} strokeWidth={1.5} />
                  {file.path.split('/').pop()}
                  <button type="button" aria-label={`Remove ${file.path}`} onClick={() => removeAttached(file.path)}>
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="explorer-ai__thumbs">
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
          {attachError && <p className="explorer-ai__attach-error">{attachError}</p>}
        </section>
      </div>

      <footer className="explorer-ai__footer">
        <div className="explorer-ai__attach-row">
          <button
            type="button"
            className="explorer-ai__attach-btn"
            title="Attach image (PNG/JPG)"
            onClick={() => imageInputRef.current?.click()}
          >
            <ImageIcon size={12} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="explorer-ai__attach-btn"
            title={`Attach active file (${fileName})`}
            onClick={() => void attachActiveFile()}
          >
            <Paperclip size={12} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="explorer-ai__attach-btn explorer-ai__attach-btn--danger"
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
        <div className="explorer-ai__input">
          <textarea
            placeholder="Ask AI to improve this file… (Enter to send)"
            aria-label="Ask AI"
            value={input}
            rows={1}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="explorer-ai__send"
            aria-label="Send"
            disabled={sending || !input.trim()}
            onClick={() => void send()}
          >
            {sending ? <Loader2 size={14} strokeWidth={1.5} className="explorer-ai__send-spin" /> : <ArrowRight size={14} strokeWidth={1.5} />}
          </button>
        </div>
        <div className="explorer-ai__footer-actions">
          <span className="explorer-ai__ctx-hint">Context: {fileName} {attachedFiles.length > 0 ? `+${attachedFiles.length} attached` : ''}</span>
        </div>
      </footer>
    </aside>
  );
}
