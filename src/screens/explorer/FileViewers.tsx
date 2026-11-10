/** Special file viewers for the Explorer editor — images, markdown/svg
 * previews, PDFs and Office documents. Text files stay in Monaco; these
 * render when the extension routes away from the code editor. */
import { useEffect, useMemo, useState } from 'react';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { ExternalLink } from 'lucide-react';
import { openPathExternal } from '../../lib/tauriClient';
import { renderMarkdown } from '../../lib/markdown';
import './FileViewers.css';

export type ViewerKind =
  | 'image'
  | 'markdown'
  | 'svg'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'text';

/** Routes a repo path to its viewer kind (text = Monaco as usual). */
export function fileKindFor(path: string): ViewerKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'].includes(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  return 'text';
}

export interface BinaryContent {
  data: string;
  mime: string;
  size: number;
}

/** base64 → bytes (for libraries that want ArrayBuffers). */
function b64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function OpenExternal({ path }: { path: string }) {
  const [status, setStatus] = useState('');
  return (
    <button
      type="button"
      className="file-viewer__open-ext"
      onClick={() => {
        openPathExternal(path).then(
          () => setStatus('Opened'),
          (error) => setStatus(error instanceof Error ? error.message : String(error)),
        );
      }}
    >
      <ExternalLink size={11} strokeWidth={1.5} />
      {status || 'Open in default app'}
    </button>
  );
}

function ImageViewer({ bin }: { bin: BinaryContent }) {
  return (
    <div className="file-viewer file-viewer--image">
      <img src={`data:${bin.mime};base64,${bin.data}`} alt="file preview" />
      <span className="file-viewer__meta">
        {bin.mime} · {(bin.size / 1024).toFixed(1)} KB
      </span>
    </div>
  );
}

export function MarkdownViewer({ text }: { text: string }) {
  return (
    <div className="file-viewer file-viewer--md">
      {text ? renderMarkdown(text) : <p className="file-viewer__meta">Empty file</p>}
    </div>
  );
}

export function SvgViewer({ text }: { text: string }) {
  const src = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`,
    [text],
  );
  if (!text.trim()) return <div className="file-viewer__meta">Empty file</div>;
  return (
    <div className="file-viewer file-viewer--image">
      <img src={src} alt="svg preview" />
      <span className="file-viewer__meta">
        SVG · {(text.length / 1024).toFixed(1)} KB
      </span>
    </div>
  );
}

function PdfViewer({ bin, path }: { bin: BinaryContent; path: string }) {
  const url = useMemo(() => {
    const bytes = b64ToBytes(bin.data);
    return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }));
  }, [bin.data]);
  // Revoke on unmount so blob URLs don't pile up.
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="file-viewer file-viewer--fill">
      <iframe src={url} title={path} className="file-viewer__frame" />
    </div>
  );
}

function DocxViewer({ bin, path }: { bin: BinaryContent; path: string }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const bytes = b64ToBytes(bin.data);
    mammoth
      .convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer })
      .then((result) => {
        if (!cancelled) setHtml(result.value);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [bin.data]);
  if (error) {
    return (
      <div className="file-viewer file-viewer--fill">
        <div className="file-viewer__meta">Could not render this .docx: {error}</div>
        <OpenExternal path={path} />
      </div>
    );
  }
  return (
    <div className="file-viewer file-viewer--doc">
      <div
        className="file-viewer__docx"
        // mammoth output is generated from the file itself
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function XlsxViewer({ bin }: { bin: BinaryContent }) {
  const [table, setTable] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bytes = b64ToBytes(bin.data);
        const wb = XLSX.read(bytes, { type: 'array' });
        const first = wb.SheetNames[0];
        if (!first) {
          if (!cancelled) setTable('<p>No sheets</p>');
        } else if (!cancelled) {
          setTable(XLSX.utils.sheet_to_html(wb.Sheets[first]));
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bin.data]);
  if (error) return <div className="file-viewer__meta">Could not render this workbook: {error}</div>;
  return (
    <div className="file-viewer file-viewer--doc">
      <span className="file-viewer__meta">
        {bin.size ? `${(bin.size / 1024).toFixed(1)} KB` : ''}
      </span>
      <div className="file-viewer__xlsx" dangerouslySetInnerHTML={{ __html: table }} />
    </div>
  );
}

function PptxNotice({ path }: { path: string }) {
  return (
    <div className="file-viewer file-viewer--fill">
      <div className="file-viewer__meta">
        Presentations can't be previewed in-app — open it with PowerPoint.
      </div>
      <OpenExternal path={path} />
    </div>
  );
}

/** The routed viewer for a non-text file. */
export function FileViewer({
  kind,
  bin,
  path,
  textContent,
}: {
  kind: ViewerKind;
  bin: BinaryContent;
  path: string;
  /** Raw text for md/svg preview (from the code buffer). */
  textContent: string;
}) {
  switch (kind) {
    case 'image':
      return <ImageViewer bin={bin} />;
    case 'svg':
      return <SvgViewer text={textContent} />;
    case 'pdf':
      return <PdfViewer bin={bin} path={path} />;
    case 'docx':
      return <DocxViewer bin={bin} path={path} />;
    case 'xlsx':
      return <XlsxViewer bin={bin} />;
    case 'pptx':
      return <PptxNotice path={path} />;
    default:
      return <MarkdownViewer text={textContent} />;
  }
}
