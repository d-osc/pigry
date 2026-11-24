/** Agent tools for the Diagram editor. Diagrams are plain files
 * (.pigry/diagrams/<owner>/<name>.diagram.json, one folder per agent); these
 * tools read, create, edit and export them, and make the editor show the result. */
import type { ToolSpec } from '../../lib/agentTools';
import {
  applyOperations, autoLayout, normalizeDiagram, renderDiagramSvg, summarizeDiagram, toMermaid, validateDiagram,
  NODE_KINDS, DIAGRAM_TYPES, DIAGRAM_EXT, type Diagram, type DiagramOp,
} from './diagram';
import {
  diagramPath, flushDiagramEditors, listDiagramRefs, loadDiagram, requestOpenDiagram, resolveDiagram, saveDiagram,
} from './diagramStore';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import { writeWorktreeFile } from '../../lib/tauriClient';

/** Models sometimes send arrays as JSON strings — accept both. */
function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.diagram ?? '').trim();
/** The calling agent's username, injected by the agent loop (owner folder name). */
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');

/** Loads the diagram a name refers to (any owner), or an error string. */
async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; diagram: Diagram; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return 'error: needs a name (see diagram_list)';
  await flushDiagramEditors();
  const resolved = await resolveDiagram(name, callerOf(input));
  if ('error' in resolved) return `error: ${resolved.error} (see diagram_list)`;
  try {
    const { diagram, warnings } = await loadDiagram(resolved.ref);
    return { ref: resolved.ref, diagram, warnings };
  } catch (error) {
    return `error: could not read diagram "${name}" — ${error instanceof Error ? error.message : String(error)}`;
  }
}

const NODE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short unique id, e.g. "user" or "check_stock". Edges refer to it.' },
    kind: { type: 'string', enum: NODE_KINDS, description: 'Shape: process, terminator (start/end), decision, io, database, document, entity (table with fields), actor, usecase, system (boundary box around nodes whose parent is its id), note, cloud (external system), queue' },
    label: { type: 'string', description: 'Text shown in the shape (entity: the table name)' },
    fields: { type: 'array', items: { type: 'string' }, description: 'Entity rows as "name [type] [PK|FK|UK]", e.g. "id PK", "user_id FK", "email varchar"' },
    parent: { type: 'string', description: 'Id of the system boundary this node sits inside' },
    x: { type: 'number' }, y: { type: 'number' },
    w: { type: 'number' }, h: { type: 'number' },
  },
  required: ['label'],
};

const EDGE_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Source node id (or unique label)' },
    to: { type: 'string', description: 'Target node id (or unique label)' },
    label: { type: 'string', description: 'Text on the line, e.g. "yes", "places", "HTTPS"' },
    fromLabel: { type: 'string', description: 'Cardinality at the source end for ERDs: 1, 0..1, N, 1..N' },
    toLabel: { type: 'string', description: 'Cardinality at the target end for ERDs' },
    dashed: { type: 'boolean' },
    arrow: { type: 'string', enum: ['end', 'both', 'none'] },
  },
  required: ['from', 'to'],
};

export const DIAGRAM_TOOLS: ToolSpec[] = [
  {
    id: 'diagram_list',
    name: 'diagram_list',
    description: 'List the diagrams saved in the workspace (.pigry/diagrams/<owner>/) with their type and size.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushDiagramEditors();
      const refs = await listDiagramRefs();
      if (refs.length === 0) return 'No diagrams yet. Create one with diagram_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try {
          const { diagram } = await loadDiagram(ref);
          rows.push(`- ${refKey(ref)}: "${diagram.title}" (${diagram.type}, ${diagram.nodes.length} nodes, ${diagram.edges.length} edges)`);
        } catch {
          rows.push(`- ${refKey(ref)}: (unreadable file)`);
        }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'diagram_read',
    name: 'diagram_read',
    description: 'Read a diagram. format "summary" (default) lists node ids/kinds/labels and edges; "json" returns the full file; "mermaid" returns Mermaid source. Always read a diagram before editing it.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Diagram name, or owner/name (file name without .diagram.json)' },
        format: { type: 'string', enum: ['summary', 'json', 'mermaid'] },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { diagram, warnings, ref } = opened;
      const format = String(input.format ?? 'summary');
      if (format === 'mermaid') return toMermaid(diagram);
      if (format === 'json') {
        const json = JSON.stringify(diagram, null, 1);
        return json.length > 16_000 ? json.slice(0, 16_000) + '\n[truncated — use the summary or diagram_edit]' : json;
      }
      const issues = [...warnings, ...validateDiagram(diagram)];
      return `${refKey(ref)}\n${summarizeDiagram(diagram)}${issues.length ? '\nIssues:\n- ' + issues.join('\n- ') : ''}`;
    },
  },
  {
    id: 'diagram_write',
    name: 'diagram_write',
    description: 'Create a new diagram (or fully replace your own with overwrite: true) from nodes and edges. It is saved in your own folder and shown in the Diagram editor. Omit x/y to get an automatic layered layout. For changes to an existing diagram prefer diagram_edit.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Diagram name; becomes .pigry/diagrams/<you>/<name>.diagram.json' },
        title: { type: 'string' },
        type: { type: 'string', enum: DIAGRAM_TYPES, description: 'flowchart, erd, usecase, architecture or generic' },
        direction: { type: 'string', enum: ['TB', 'LR'], description: 'Layout direction: top-to-bottom or left-to-right' },
        nodes: { type: 'array', items: NODE_SCHEMA, description: 'Nodes (a JSON string of the array is also accepted)' },
        edges: { type: 'array', items: EDGE_SCHEMA, description: 'Edges between node ids' },
        layout: { type: 'string', enum: ['auto', 'keep'], description: '"auto" (default when positions are missing) or "keep" the given x/y' },
        overwrite: { type: 'boolean', description: 'Replace an existing diagram of the same name in your folder (default false)' },
      },
      required: ['name', 'nodes'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return 'error: diagram_write needs a name';
      const nodes = asArray(input.nodes);
      if (!nodes || nodes.length === 0) return 'error: diagram_write needs a non-empty nodes array';
      const edges = asArray(input.edges) ?? [];
      const caller = callerOf(input);
      const parsed = parseRefName(name, [DIAGRAM_EXT]);
      if (parsed.owner && parsed.owner !== caller) return `error: you can only create diagrams in your own folder (${caller}/) — change another owner's diagram with diagram_edit`;
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushDiagramEditors();
      const exists = (await listDiagramRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug);
      if (exists && input.overwrite !== true) {
        return `error: diagram "${refKey(ref)}" already exists. Read it with diagram_read and change it with diagram_edit, or pass overwrite: true to replace it.`;
      }
      const { diagram, warnings, needsLayout } = normalizeDiagram(
        { title: input.title ?? name, type: input.type, direction: input.direction, nodes, edges },
        parsed.slug,
      );
      const laid = input.layout === 'keep' && !needsLayout ? diagram : autoLayout(diagram, diagram.direction);
      const path = await saveDiagram(ref, laid, 'agent');
      const issues = [...warnings, ...validateDiagram(laid)];
      return `saved ${path}\n${summarizeDiagram(laid)}${issues.length ? '\nIssues:\n- ' + issues.join('\n- ') : ''}\nShow it to the user with diagram_open.`;
    },
  },
  {
    id: 'diagram_edit',
    name: 'diagram_edit',
    description: 'Edit an existing diagram with a list of operations: add_node {id?,kind,label,fields?,parent?}, update_node {id,label?,kind?,fields?,x?,y?,w?,h?,parent?}, remove_node {id}, add_edge {from,to,label?,fromLabel?,toLabel?,dashed?,arrow?}, update_edge {id | from+to, label?,...}, remove_edge {id | from+to}, set_meta {title?,type?,direction?}, layout {direction?}. Nodes can be addressed by id or unique label. New nodes without x/y trigger a re-layout.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Diagram name, or owner/name' },
        operations: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order (a JSON string of the array is also accepted)' },
      },
      required: ['name', 'operations'],
    },
    run: async (input) => {
      const ops = asArray(input.operations);
      if (!ops || ops.length === 0) return 'error: diagram_edit needs a non-empty operations array';
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const result = applyOperations(opened.diagram, ops as DiagramOp[]);
      if (result.log.length === 0 && result.errors.length > 0) {
        return `error: nothing was applied\n- ${result.errors.join('\n- ')}`;
      }
      const path = await saveDiagram(opened.ref, result.diagram, 'agent');
      const issues = validateDiagram(result.diagram);
      return `saved ${path}\n${result.log.map((line) => `✓ ${line}`).join('\n')}`
        + (result.errors.length ? `\nNot applied:\n- ${result.errors.join('\n- ')}` : '')
        + (issues.length ? `\nIssues:\n- ${issues.join('\n- ')}` : '');
    },
  },
  {
    id: 'diagram_export',
    name: 'diagram_export',
    description: 'Export a diagram as SVG (saved to a file you can embed in reports) or Mermaid text. SVG is saved next to the diagram (.pigry/diagrams/<owner>/<name>.svg) unless path is given; Mermaid is returned (and saved when path is given). Paths must stay inside .pigry/.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Diagram name, or owner/name' },
        format: { type: 'string', enum: ['svg', 'mermaid'] },
        path: { type: 'string', description: 'Optional output path under .pigry/ (.svg for svg; .mmd or .md for mermaid), e.g. .pigry/reports/sa/login-flow.svg' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '');
      if (format !== 'svg' && format !== 'mermaid') return 'error: format must be "svg" or "mermaid"';
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { diagram, ref } = opened;
      const given = typeof input.path === 'string' ? input.path.trim().replace(/\\/g, '/') : '';
      const target = given || (format === 'svg' ? diagramPath(ref).replace(/\.diagram\.json$/, '.svg') : '');
      if (target) {
        const okExt = format === 'svg' ? /\.svg$/i.test(target) : /\.(mmd|md)$/i.test(target);
        if (!okExt || !target.startsWith('.pigry/') || /^[A-Za-z]:/.test(target) || target.split('/').includes('..')) {
          return `error: exports must stay inside .pigry/ (no "..") and end in ${format === 'svg' ? '.svg' : '.mmd or .md'}`;
        }
      }
      const content = format === 'svg' ? renderDiagramSvg(diagram) : toMermaid(diagram);
      if (target) {
        await writeWorktreeFile(target, format === 'mermaid' && /\.md$/i.test(target) ? '```mermaid\n' + content + '\n```\n' : content);
      }
      return format === 'svg'
        ? `saved ${target} (${content.length} bytes). Embed it in a Markdown report with ![${diagram.title}](<path relative to the report>).`
        : `${target ? `saved ${target}\n` : ''}${content}`;
    },
  },
  {
    id: 'diagram_open',
    name: 'diagram_open',
    description: 'Open a diagram in the Diagram editor so the user can see it.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Diagram name, or owner/name' } },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return 'error: diagram_open needs a name';
      const resolved = await resolveDiagram(name, callerOf(input));
      if ('error' in resolved) return `error: ${resolved.error} (see diagram_list)`;
      requestOpenDiagram(refKey(resolved.ref));
      return `opened "${refKey(resolved.ref)}" in the Diagram editor`;
    },
  },
];
