/** Build a collapsible tree structure from a flat list of file paths. */

export interface TreeNode {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  children: TreeNode[];
}

/** Sorts folders before files, both alphabetically (case-insensitive). */
export function buildTree(paths: string[], emptyFolders: string[] = []): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };
  const indexes = new WeakMap<TreeNode, Map<string, TreeNode>>();

  for (const path of paths) {
    const segments = path.split('/');
    let node = root;
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      let childIndex = indexes.get(node);
      if (!childIndex) { childIndex = new Map(); indexes.set(node, childIndex); }
      const key = `${isFile ? 'file' : 'folder'}:${segment}`;
      let child = childIndex.get(key);
      if (!child) {
        child = {
          name: segment,
          path: segments.slice(0, index + 1).join('/'),
          kind: isFile ? 'file' : 'folder',
          children: [],
        };
        node.children.push(child);
        childIndex.set(key, child);
      }
      node = child;
    });
  }

  // Folders that are listed without their contents (ignored folders): shown as folder rows with no children.
  for (const folder of emptyFolders) {
    const segments = folder.split('/').filter(Boolean);
    let node = root;
    segments.forEach((segment, index) => {
      let childIndex = indexes.get(node);
      if (!childIndex) { childIndex = new Map(); indexes.set(node, childIndex); }
      const key = `folder:${segment}`;
      let child = childIndex.get(key);
      if (!child) {
        child = { name: segment, path: segments.slice(0, index + 1).join('/'), kind: 'folder', children: [] };
        node.children.push(child);
        childIndex.set(key, child);
      }
      node = child;
    });
  }

  sortTree(root);
  return root.children.map((child) => compactChains(child));
}

export function flattenVisibleTree(nodes: TreeNode[], expanded: Set<string>): { node: TreeNode; depth: number }[] {
  const rows: { node: TreeNode; depth: number }[] = [];
  const visit = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === 'folder' && expanded.has(node.path)) visit(node.children, depth + 1);
    }
  };
  visit(nodes, 0);
  return rows;
}

/**
 * VS Code "compact folders": folders that contain only a single child folder
 * are merged into one row (a/b/c). The node keeps the deepest folder's path.
 */
function compactChains(node: TreeNode): TreeNode {
  let name = node.name;
  let path = node.path;
  let children = node.children;
  if (node.kind === 'folder') {
    let chain = 0;
    while (children.length === 1 && children[0].kind === 'folder') {
      const child = children[0];
      name += `/${child.name}`;
      path = child.path;
      children = child.children;
      chain += 1;
      if (chain >= 8) break; // safety bound
    }
  }
  return {
    name,
    path,
    kind: node.kind,
    children: children.map((child) => compactChains(child)),
  };
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  node.children.forEach(sortTree);
}
