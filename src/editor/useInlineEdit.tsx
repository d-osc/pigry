/** Ctrl+I inline edit for the Explorer editor, like VS Code inline chat: the user selects code (or leaves the
 * cursor on a line), types an instruction, and the model's replacement shows in place as a diff — the old lines
 * marked red in the editor, the new lines green in a panel right under them — until the user picks Accept
 * (the edit goes in as one undo step) or Discard (the code stays as it was). */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type * as MonacoNS from 'monaco-editor';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { EDIT_CONTEXT_CHARS } from '../lib/inlineAi';
import { requestInlineEdit, withThinking } from '../lib/inlineAiClient';
import './inlineEdit.css';

type Monaco = typeof MonacoNS;
type Editor = MonacoNS.editor.IStandaloneCodeEditor;

interface Session {
  id: number;
  /** Overlay-widget node the panel is portalled into. */
  host: HTMLDivElement;
  selected: boolean;
  instruction: string;
  phase: 'ask' | 'working' | 'review' | 'error';
  code?: string;
  used?: string;
  error?: string;
}

export interface InlineEditFile {
  path: string;
  language: string;
  /** Why this file must not be sent to the model, or null. */
  skipReason: () => string | null;
}

const LINE_HEIGHT = 19;

function zoneHeight(session: Session): number {
  if (session.phase === 'review') return 36 + Math.max(1, (session.code ?? '').split('\n').length) * LINE_HEIGHT + 8;
  return session.phase === 'error' ? 66 : 42;
}

/** The region an edit rewrites: the selected lines (a selection ending at column 1 leaves that line out), or the cursor's line. */
function regionFor(monaco: Monaco, editor: Editor): { range: MonacoNS.Range; selected: boolean } | null {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return null;
  const selected = !sel.isEmpty();
  const start = sel.startLineNumber;
  const end = selected && sel.endColumn === 1 && sel.endLineNumber > start ? sel.endLineNumber - 1 : sel.endLineNumber;
  return { range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)), selected };
}

interface Box {
  /** Top of the view zone in editor-viewport pixels; null until Monaco has placed it. */
  top: number | null;
  left: number;
  width: number;
}

const measure = (editor: Editor) => {
  const info = editor.getLayoutInfo();
  return { left: info.contentLeft, width: Math.max(200, info.contentWidth - info.verticalScrollbarWidth - 8) };
};

export function useInlineEdit(editor: Editor | null, monaco: Monaco | null, file: InlineEditFile) {
  const [session, setSession] = useState<Session | null>(null);
  const [box, setBox] = useState<Box>({ top: null, left: 0, width: 0 });
  const sessionRef = useRef<Session | null>(null);
  const regionRef = useRef<MonacoNS.editor.IEditorDecorationsCollection | null>(null);
  const nextId = useRef(0);
  const fileRef = useRef(file);
  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  const update = (next: Session | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  const close = () => {
    regionRef.current?.clear();
    regionRef.current = null;
    update(null);
  };

  const submit = async (current: Session, instruction: string) => {
    const model = editor?.getModel();
    const range = regionRef.current?.getRange(0);
    if (!editor || !model || !range || !instruction.trim()) return;
    const skip = fileRef.current.skipReason();
    if (skip) {
      update({ ...current, instruction, phase: 'error', error: `AI is off for this file (${skip}).` });
      return;
    }
    const working: Session = { ...current, instruction, phase: 'working', error: undefined };
    update(working);
    const startOffset = model.getOffsetAt(range.getStartPosition());
    const endOffset = model.getOffsetAt(range.getEndPosition());
    const text = model.getValue();
    try {
      const { code, used } = await withThinking(() => requestInlineEdit({
        path: fileRef.current.path,
        language: fileRef.current.language,
        instruction,
        before: text.slice(Math.max(0, startOffset - EDIT_CONTEXT_CHARS), startOffset),
        region: text.slice(startOffset, endOffset),
        after: text.slice(endOffset, endOffset + EDIT_CONTEXT_CHARS),
        selected: current.selected,
      }));
      if (sessionRef.current?.id !== current.id) return;
      update({ ...working, phase: 'review', code, used });
    } catch (error) {
      if (sessionRef.current?.id !== current.id) return;
      update({ ...working, phase: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Starts an edit on the selection / cursor line; with `instruction` and `run`, sends it straight away. */
  const open = (instruction = '', run = false) => {
    if (!editor || !monaco) return;
    const region = regionFor(monaco, editor);
    if (!region) return;
    regionRef.current?.clear();
    regionRef.current = editor.createDecorationsCollection([
      { range: region.range, options: { isWholeLine: true, className: 'inline-edit-region', stickiness: 1 } },
    ]);
    const host = document.createElement('div');
    host.className = 'inline-edit-host';
    setBox({ top: null, ...measure(editor) });
    nextId.current += 1;
    const next: Session = { id: nextId.current, host, selected: region.selected, instruction, phase: 'ask' };
    update(next);
    if (run && instruction.trim()) void submit(next, instruction);
  };

  const accept = () => {
    const current = sessionRef.current;
    const range = regionRef.current?.getRange(0);
    if (!editor || !current || current.phase !== 'review' || current.code === undefined || !range) return;
    editor.pushUndoStop();
    editor.executeEdits('pigry-ai-edit', [{ range, text: current.code, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    close();
    editor.focus();
  };

  const discard = () => {
    close();
    editor?.focus();
  };

  // The panel lives in an overlay widget placed over a view zone that opens a gap under the region.
  const height = session ? zoneHeight(session) : 0;
  const sessionId = session?.id ?? 0;
  const host = session?.host ?? null;
  useEffect(() => {
    if (!editor || !host) return;
    const range = regionRef.current?.getRange(0);
    if (!range) return;
    const widget: MonacoNS.editor.IOverlayWidget = { getId: () => `pigry.inlineEdit.${sessionId}`, getDomNode: () => host, getPosition: () => null };
    editor.addOverlayWidget(widget);
    let zoneId = '';
    editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone({
        afterLineNumber: range.endLineNumber,
        heightInPx: height,
        domNode: document.createElement('div'),
        onDomNodeTop: (top) => setBox((current) => (current.top === top ? current : { ...current, top })),
      });
    });
    const sub = editor.onDidLayoutChange(() => setBox((current) => ({ ...current, ...measure(editor) })));
    return () => {
      sub.dispose();
      editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
      editor.removeOverlayWidget(widget);
    };
  }, [editor, host, sessionId, height]);

  // In review the old lines turn red (the green replacement is in the panel).
  const phase = session?.phase;
  useEffect(() => {
    const collection = regionRef.current;
    const range = collection?.getRange(0);
    if (!collection || !range) return;
    collection.set([{
      range,
      options: { isWholeLine: true, stickiness: 1, className: phase === 'review' ? 'inline-edit-removed' : 'inline-edit-region' },
    }]);
  }, [phase, sessionId]);

  // Switching files or unmounting drops the edit.
  useEffect(() => () => {
    regionRef.current?.clear();
    regionRef.current = null;
    sessionRef.current = null;
  }, [editor]);

  const portal: ReactNode = session
    ? createPortal(
        <InlineEditPanel
          key={session.id}
          session={session}
          box={box}
          onSubmit={(instruction) => void submit(session, instruction)}
          onAccept={accept}
          onDiscard={discard}
        />,
        session.host,
      )
    : null;

  return { open, portal, active: session !== null };
}

function InlineEditPanel({ session, box, onSubmit, onAccept, onDiscard }: {
  session: Session;
  box: Box;
  onSubmit: (instruction: string) => void;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const [draft, setDraft] = useState(session.instruction);
  // autoFocus can't work: the panel mounts before Monaco puts its host in the page. Focus once it's placed.
  const focusRef = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  const placed = box.top !== null;
  useEffect(() => {
    if (placed) focusRef.current?.focus();
  }, [placed, session.phase]);
  const working = session.phase === 'working';
  // Esc discards from anywhere in the panel; in review, Enter on the focused Accept button accepts.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onDiscard();
  };
  return (
    <div className={`inline-edit inline-edit--${session.phase}`} style={{ top: box.top ?? 0, left: box.left, width: box.width, visibility: box.top === null ? 'hidden' : undefined }} role="dialog" aria-label="AI inline edit" onKeyDown={onKeyDown}>
      {session.phase === 'review' ? (
        <>
          <div className="inline-edit__bar">
            <Sparkles size={12} strokeWidth={1.75} />
            <span className="inline-edit__title" title={session.instruction}>{session.instruction}</span>
            {session.used && <span className="inline-edit__used">{session.used}</span>}
            <button type="button" className="primary-button inline-edit__button" onClick={onAccept} ref={(node) => { focusRef.current = node; }}>
              <Check size={12} strokeWidth={2} />
              Accept
            </button>
            <button type="button" className="outline-button inline-edit__button" onClick={onDiscard}>
              Discard
            </button>
          </div>
          <pre className="inline-edit__added" aria-label="Suggested code">
            {(session.code ?? '').split('\n').map((line, index) => (
              <div key={index} className="inline-edit__line">{line || ' '}</div>
            ))}
          </pre>
        </>
      ) : (
        <>
          <form
            className="inline-edit__bar"
            onSubmit={(event) => {
              event.preventDefault();
              if (!working) onSubmit(draft);
            }}
          >
            {working ? <Loader2 size={12} strokeWidth={1.75} className="inline-edit__spin" /> : <Sparkles size={12} strokeWidth={1.75} />}
            <input
              className="inline-edit__input"
              aria-label="Edit instruction"
              placeholder={session.selected ? 'Edit the selected code — e.g. add error handling, convert to async' : 'Generate code here — e.g. add a function that…'}
              value={draft}
              readOnly={working}
              ref={(node) => { focusRef.current = node; }}
              onChange={(event) => setDraft(event.target.value)}
            />
            {working ? (
              <span className="inline-edit__status" role="status">Generating…</span>
            ) : (
              <button type="submit" className="primary-button inline-edit__button" disabled={!draft.trim()}>
                Generate
              </button>
            )}
            <button type="button" className="inline-edit__close" aria-label="Close inline edit" title="Close (Esc)" onClick={onDiscard}>
              <X size={12} strokeWidth={1.75} />
            </button>
          </form>
          {session.phase === 'error' && (
            <div className="inline-edit__error" role="alert">
              Couldn’t edit the code: {session.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
