import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Aperçu Markdown. Le HTML brut n'est jamais interprété (react-markdown) ;
 * les images `assets/…` sont remplacées par les données fournies par le processus principal.
 */
export function MarkdownPreview({
  markdown,
  images,
  label,
}: {
  markdown: string;
  images: Readonly<Record<string, string>>;
  label: string;
}) {
  return (
    <article
      aria-label={label}
      className="max-h-96 overflow-auto rounded-md border border-border bg-background p-4 text-sm [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-1 [&_table]:my-2 [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc"
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const data = typeof src === 'string' ? images[src] : undefined;
            return data ? (
              <img src={data} alt={alt ?? ''} className="max-h-48" />
            ) : (
              <span className="text-muted-foreground">[image : {alt || String(src)}]</span>
            );
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline">
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </article>
  );
}
