import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauri } from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';

const components: Components = {
  a: ({ href, children, title }) => <SummaryLink href={href} title={title}>{children}</SummaryLink>,
};

function SummaryLink({ href, title, children }: React.ComponentProps<'a'>) {
  const { notify } = useRepository();
  if (!href) return <>{children}</>;
  const external = !href.startsWith('#');
  return (
    <a
      href={href}
      title={title}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      onClick={(event) => {
        if (!external || !isTauri()) return;
        event.preventDefault();
        void openUrl(href).catch((error: unknown) => {
          notify(error instanceof Error ? error.message : String(error), 'error');
        });
      }}
    >
      {children}
    </a>
  );
}

export function PrSummary({ body, url }: { body: string; url: string }) {
  if (!body.trim()) return null;

  return (
    <div className="pr-summary">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={components}
        urlTransform={(value, key) => {
          const safe = defaultUrlTransform(value);
          if (!safe || (key === 'href' && safe.startsWith('#'))) return safe || undefined;
          try {
            const resolved = new URL(safe, url || undefined);
            if (resolved.protocol === 'https:' || resolved.protocol === 'http:') return resolved.href;
          } catch {
            return undefined;
          }
          return undefined;
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
