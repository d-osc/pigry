import { useState } from 'react';
import { DiffEditor } from '../../editor/ThemedEditors';
import type { PrDiffFile } from '../../lib/ghData';

export function PrInlineDiff({ diff }: { diff?: PrDiffFile | null }) {
  const [split, setSplit] = useState(false);

  if (!diff || (!diff.original && !diff.modified)) {
    return <p className="pr-section__muted">No text diff available for this file.</p>;
  }

  return (
    <>
      <div className="pr-file__compare-toolbar">
        <div className="segmented" role="group" aria-label="Diff layout">
          {(['Split', 'Unified'] as const).map((layout) => {
            const active = split === (layout === 'Split');
            return (
              <button
                key={layout}
                type="button"
                aria-pressed={active}
                className={`segmented__item${active ? ' is-active' : ''}`}
                onClick={() => setSplit(layout === 'Split')}
              >
                {layout}
              </button>
            );
          })}
        </div>
      </div>
      <DiffEditor
        height={280}
        original={diff.original}
        modified={diff.modified}
        language={diff.language}
        options={{
          readOnly: true,
          renderSideBySide: split,
          useInlineViewWhenSpaceIsLimited: false,
          ignoreTrimWhitespace: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
        }}
      />
    </>
  );
}
