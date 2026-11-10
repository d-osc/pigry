/** VS Code-style conflict marker support for the Monaco editor:
 *  tints ours/incoming regions and attaches an action widget to every
 *  conflict block (accept current / incoming / both / compare). */
import type * as MonacoEditorNS from 'monaco-editor';

export interface ConflictRegion {
  /** '<<<<<<<' marker line (1-based). */
  startLine: number;
  oursStart: number;
  oursEnd: number;
  sepLine: number;
  theirsStart: number;
  theirsEnd: number;
  /** '>>>>>>>' marker line. */
  endLine: number;
}

/** Parses git conflict markers out of a text buffer. */
export function computeConflicts(text: string): ConflictRegion[] {
  const lines = text.split('\n');
  const regions: ConflictRegion[] = [];
  let inConflict = false;
  let region: ConflictRegion | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const n = i + 1;
    const line = lines[i];
    if (!inConflict && line.startsWith('<<<<<<<')) {
      region = {
        startLine: n,
        oursStart: n + 1,
        oursEnd: n,
        sepLine: 0,
        theirsStart: 0,
        theirsEnd: 0,
        endLine: n,
      };
      inConflict = true;
      continue;
    }
    if (inConflict && region) {
      if (line.startsWith('=======')) {
        region.sepLine = n;
        region.oursEnd = Math.max(region.oursStart, n - 1);
        region.theirsStart = n + 1;
        continue;
      }
      if (line.startsWith('>>>>>>>')) {
        region.theirsEnd = Math.max(region.theirsStart, n - 1);
        region.endLine = n;
        regions.push(region);
        region = null;
        inConflict = false;
        continue;
      }
      if (region.sepLine === 0) {
        region.oursEnd = n;
      } else {
        region.theirsEnd = n;
      }
    }
  }
  return regions;
}

type ApplyKind = 'current' | 'incoming' | 'both';

/** Replacement text when accepting a side of the region. */
export function acceptText(text: string, region: ConflictRegion, kind: ApplyKind): string {
  const lines = text.split('\n');
  const ours = lines.slice(region.oursStart - 1, region.oursEnd);
  const theirs = lines.slice(region.theirsStart - 1, region.theirsEnd);
  if (kind === 'current') return ours.join('\n');
  if (kind === 'incoming') return theirs.join('\n');
  return [...ours, ...theirs].join('\n');
}

/** Attaches accept/compare widgets + decorations to every conflict. */
export class ConflictController {
  private decorations: string[] = [];
  private zones: string[] = [];
  private diffEditors: MonacoEditorNS.editor.IStandaloneDiffEditor[] = [];
  private models: MonacoEditorNS.editor.ITextModel[] = [];
  private compareZone: string | null = null;
  onChange: ((text: string) => void) | null = null;

  constructor(
    private editor: MonacoEditorNS.editor.IStandaloneCodeEditor,
    private monaco: typeof import('monaco-editor'),
  ) {}

  /** True when the buffer contains conflict markers. */
  static hasMarkers(text: string): boolean {
    return text.includes('<<<<<<<') && text.includes('=======') && text.includes('>>>>>>>');
  }

  /** Removes all decorations + widgets (call before recompute/dispose). */
  clear(): void {
    if (this.decorations.length > 0) {
      this.editor.deltaDecorations(this.decorations, []);
    }
    this.decorations = [];
    for (const zone of this.zones) {
      this.editor.changeViewZones((a) => {
        a.removeZone(zone);
      });
    }
    this.zones = [];
    if (this.compareZone) {
      const staleCompare = this.compareZone;
      this.compareZone = null;
      this.editor.changeViewZones((a) => {
        a.removeZone(staleCompare);
      });
    }
    for (const diff of this.diffEditors) diff.dispose();
    this.diffEditors = [];
    for (const model of this.models) model.dispose();
    this.models = [];
  }

  dispose(): void {
    this.clear();
  }

  /** Rebuilds decorations + action widgets for the current buffer. */
  update(): void {
    this.clear();
    const model = this.editor.getModel();
    if (!model) return;
    const text = model.getValue();
    if (!ConflictController.hasMarkers(text)) return;

    const decorations: MonacoEditorNS.editor.IModelDeltaDecoration[] = [];
    for (const region of computeConflicts(text)) {
      // Ours — green tint including its marker line.
      decorations.push({
        range: new this.monaco.Range(region.startLine, 1, region.oursEnd, model.getLineMaxColumn(region.oursEnd)),
        options: { isWholeLine: true, className: 'pigry-conflict-ours' },
      });
      // Separator + theirs — blue tint including the end marker.
      decorations.push({
        range: new this.monaco.Range(region.sepLine, 1, region.endLine, model.getLineMaxColumn(region.endLine)),
        options: { isWholeLine: true, className: 'pigry-conflict-theirs' },
      });
      // Marker lines — red highlight.
      decorations.push({
        range: new this.monaco.Range(region.startLine, 1, region.startLine, model.getLineMaxColumn(region.startLine)),
        options: { isWholeLine: true, className: 'pigry-conflict-marker' },
      });
      decorations.push({
        range: new this.monaco.Range(region.endLine, 1, region.endLine, model.getLineMaxColumn(region.endLine)),
        options: { isWholeLine: true, className: 'pigry-conflict-marker' },
      });

      this.addActionZone(region);
    }
    this.decorations = this.editor.deltaDecorations([], decorations);
  }

  /** Replaces the whole conflict block with the accepted side. */
  accept(kind: ApplyKind, region: ConflictRegion): void {
    const model = this.editor.getModel();
    if (!model) return;
    const regions = computeConflicts(model.getValue());
    // Line numbers may have shifted after prior edits — prefer the region
    // that still starts on the same line, else the first conflict.
    const fresh = regions.find((r) => r.startLine === region.startLine) ?? regions[0];
    if (!fresh) return;
    const replacement = acceptText(model.getValue(), fresh, kind);
    const endCol = model.getLineMaxColumn(fresh.endLine);
    this.editor.executeEdits('pigry-conflict', [
      {
        range: new this.monaco.Range(fresh.startLine, 1, fresh.endLine, endCol),
        text: replacement,
      },
    ]);
    this.update();
    this.onChange?.(this.editor.getModel()?.getValue() ?? '');
  }

  private addActionZone(region: ConflictRegion): void {
    const dom = document.createElement('div');
    dom.className = 'pigry-conflict-actions';
    const make = (label: string, title: string, kind: ApplyKind | 'compare') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      button.className =
        'pigry-conflict-btn' + (kind === 'compare' ? ' pigry-conflict-btn--compare' : '');
      button.addEventListener('click', () => {
        if (kind === 'compare') {
          this.toggleCompare(region);
          return;
        }
        this.accept(kind, region);
        this.onChange?.(this.editor.getModel()?.getValue() ?? '');
      });
      dom.appendChild(button);
    };
    make('✓ Accept Current Change', 'Keep the version from your branch', 'current');
    make('✓ Accept Incoming Change', 'Keep the version being merged in', 'incoming');
    make('⇉ Accept Both Changes', 'Keep both versions', 'both');
    make('⇄ Compare Changes', 'Diff current vs incoming', 'compare');

    let zoneId = '';
    this.editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone({
        afterLineNumber: region.endLine,
        heightInPx: 26,
        domNode: dom,
      });
    });
    this.zones.push(zoneId);
  }

  /** Inline diff of ours vs theirs in a view zone under the conflict. */
  private toggleCompare(region: ConflictRegion): void {
    if (this.compareZone) {
      const stale = this.compareZone;
      this.compareZone = null;
      this.editor.changeViewZones((a) => {
        a.removeZone(stale);
      });
      return;
    }
    const model = this.editor.getModel();
    if (!model) return;
    const lines = model.getValue().split('\n');
    const oursText = lines.slice(region.oursStart - 1, region.oursEnd).join('\n');
    const theirsText = lines.slice(region.theirsStart - 1, region.theirsEnd).join('\n');
    const lineCount = Math.max(
      region.oursEnd - region.oursStart + 1,
      region.theirsEnd - region.theirsStart + 1,
    );
    const dom = document.createElement('div');
    dom.className = 'pigry-conflict-compare';
    let zoneId = '';
    this.editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone({
        afterLineNumber: region.endLine,
        heightInPx: Math.max(lineCount, 2) * 19 + 30,
        domNode: dom,
      });
    });
    this.compareZone = zoneId;
    requestAnimationFrame(() => {
      const diff = this.monaco.editor.createDiffEditor(dom, {
        readOnly: true,
        renderSideBySide: true,
        fontSize: 11,
        lineHeight: 19,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderOverviewRuler: false,
      });
      const oursModel = this.monaco.editor.createModel(oursText, 'plaintext');
      const theirsModel = this.monaco.editor.createModel(theirsText, 'plaintext');
      diff.setModel({ original: oursModel, modified: theirsModel });
      this.diffEditors.push(diff);
      this.models.push(oursModel, theirsModel);
    });
  }
}
