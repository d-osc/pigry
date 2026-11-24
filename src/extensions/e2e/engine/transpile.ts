/** TypeScript specs (.cy.ts): compiled to JavaScript by the TypeScript service that Monaco already bundles
 * (types are stripped, nothing is type-checked). Loaded lazily — only when a .cy.ts spec runs. */
export async function transpileTs(source: string): Promise<string> {
  // the first load of the editor bundle can fail once while the dev server re-optimises dependencies
  try { return await transpileOnce(source); } catch { await new Promise((r) => setTimeout(r, 800)); return transpileOnce(source); }
}

async function transpileOnce(source: string): Promise<string> {
  await import('../../../editor/monacoSetup');
  const monaco = await import('monaco-editor');
  const ts = (monaco as unknown as {
    typescript?: {
      getTypeScriptWorker(): Promise<(uri: unknown) => Promise<{ getEmitOutput(uri: string): Promise<{ outputFiles: Array<{ name: string; text: string }> }> }>>;
      typescriptDefaults: { getCompilerOptions(): Record<string, unknown>; setCompilerOptions(o: Record<string, unknown>): void };
      ScriptTarget: { ES2020: number };
    };
  }).typescript;
  if (!ts) throw new Error('The TypeScript service is not available in this build');
  const current = ts.typescriptDefaults.getCompilerOptions();
  // CommonJS output: `import`/`export` become require()/exports, which the spec module loader runs
  if (typeof current.target !== 'number' || current.target < ts.ScriptTarget.ES2020 || current.module !== 1) ts.typescriptDefaults.setCompilerOptions({ ...current, target: ts.ScriptTarget.ES2020, module: 1 });
  const uri = monaco.Uri.parse(`file:///e2e-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  const model = monaco.editor.createModel(source, 'typescript', uri);
  try {
    const worker = await (await ts.getTypeScriptWorker())(uri);
    const out = await worker.getEmitOutput(uri.toString());
    const file = out.outputFiles.find((f) => f.name.endsWith('.js'));
    if (!file) throw new Error('The TypeScript compiler produced no output');
    return file.text;
  } finally { model.dispose(); }
}

type TsApi = {
  getTypeScriptWorker(): Promise<(uri: unknown) => Promise<{
    getSemanticDiagnostics(uri: string): Promise<Array<{ start?: number; length?: number; messageText: string | { messageText: string }; category: number; code: number }>>;
    getSyntacticDiagnostics(uri: string): Promise<Array<{ start?: number; messageText: string | { messageText: string } }>>;
  }>>;
  typescriptDefaults: { getExtraLibs(): Record<string, unknown>; addExtraLib(content: string, path: string): unknown; getCompilerOptions(): Record<string, unknown>; setCompilerOptions(o: Record<string, unknown>): void };
  ScriptTarget: { ES2020: number };
};

/** Type-checks a TypeScript spec against the Cypress typings (Monaco's TypeScript worker). Returns readable "line N: message" problems. */
export async function typeCheckTs(source: string, dts: string): Promise<string[]> {
  await import('../../../editor/monacoSetup');
  const monaco = await import('monaco-editor');
  const ts = (monaco as unknown as { typescript?: TsApi }).typescript;
  if (!ts) return [];
  if (!('ts:cypress.d.ts' in ts.typescriptDefaults.getExtraLibs())) ts.typescriptDefaults.addExtraLib(dts, 'ts:cypress.d.ts');
  const uri = monaco.Uri.parse(`file:///e2e-check-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  const model = monaco.editor.createModel(source, 'typescript', uri);
  try {
    const worker = await (await ts.getTypeScriptWorker())(uri);
    const [sem, syn] = await Promise.all([worker.getSemanticDiagnostics(uri.toString()), worker.getSyntacticDiagnostics(uri.toString())]);
    const text = (m: string | { messageText: string }) => (typeof m === 'string' ? m : m.messageText);
    return [...syn, ...sem].slice(0, 20).map((d) => {
      const pos = d.start ?? 0;
      const line = source.slice(0, pos).split('\n').length;
      return `line ${line}: ${text(d.messageText)}`;
    });
  } catch { return []; } finally { model.dispose(); }
}
