import type { Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import Link from "next/link";
import type { ComponentProps } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { cn } from "@/lib/cn";

function Heading({ level, className, children, id, ...rest }: ComponentProps<"h2"> & { level: 2 | 3 | 4 }) {
  const Tag = `h${level}` as const;
  return (
    <Tag
      id={id}
      className={cn(
        "group scroll-mt-20 text-ink-50",
        level === 2 && "mt-10 border-b border-ink-750 pb-2 font-display text-[20px] first:mt-0",
        level === 3 && "mt-8 font-display text-[16px]",
        level === 4 && "mt-6 text-[14px] font-semibold",
        className,
      )}
      {...rest}
    >
      {children}
      {id ? (
        <a
          href={`#${id}`}
          aria-label={`Link to this section`}
          className="ml-2 text-ink-400 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          #
        </a>
      ) : null}
    </Tag>
  );
}

function Anchor({ href = "", children, ...rest }: ComponentProps<"a">) {
  const className = "text-ember-300 underline decoration-ember-700 underline-offset-4 transition-colors hover:text-ember-200 hover:decoration-ember-300";
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className} {...rest}>
        {children}
      </Link>
    );
  }
  if (href.startsWith("#")) {
    return (
      <a href={href} className={className} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} {...rest}>
      {children}
    </a>
  );
}

function Placeholder({ children, ...rest }: ComponentProps<"span">) {
  const deployed = rest["data-deployed" as keyof typeof rest] === "true";
  return (
    <span
      {...rest}
      className={cn(
        deployed
          ? "text-ink-50"
          : "inline-flex items-center rounded-sm border border-warning-400/40 bg-warning-400/10 px-1 font-sans text-[11.5px] text-warning-400",
      )}
    >
      {children}
    </span>
  );
}

const components: Partial<Components> = {
  h1: (props) => <Heading level={2} {...props} />,
  h2: (props) => <Heading level={2} {...props} />,
  h3: (props) => <Heading level={3} {...props} />,
  h4: (props) => <Heading level={4} {...props} />,
  p: (props) => <p className="my-4 text-[14px] leading-relaxed text-ink-200" {...props} />,
  a: Anchor,
  ul: (props) => <ul className="my-4 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-ink-200 marker:text-ink-400" {...props} />,
  ol: (props) => <ol className="my-4 list-decimal space-y-1.5 pl-5 text-[14px] leading-relaxed text-ink-200 marker:text-ink-400" {...props} />,
  li: (props) => <li className="[&>p]:my-1" {...props} />,
  strong: (props) => <strong className="font-semibold text-ink-50" {...props} />,
  em: (props) => <em className="italic" {...props} />,
  hr: () => <hr className="my-8 border-ink-750" />,
  blockquote: (props) => <blockquote className="my-4 border-l-2 border-ember-600 pl-4 text-ink-300" {...props} />,
  code: (props) => (
    <code
      className="rounded-sm bg-ink-800 px-1 py-0.5 font-mono text-[12.5px] text-ink-100 [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-inherit"
      {...props}
    />
  ),
  pre: (props) => (
    <pre
      className="my-5 overflow-x-auto rounded-md border border-ink-750 bg-ink-900 p-4 font-mono text-[12.5px] leading-relaxed text-ink-100"
      {...props}
    />
  ),
  table: (props) => (
    // A wide table scrolls sideways on a phone: edge shadows mark the side that holds more columns, and the region takes keyboard focus.
    <div className="scroll-cue my-5 overflow-x-auto rounded-md border border-ink-750" role="region" aria-label="Table" tabIndex={0} data-docs-table>
      <table className="w-full border-collapse text-[13px]" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-ink-900" {...props} />,
  th: (props) => (
    <th
      className="border-b border-ink-750 px-3 py-2 text-left align-bottom font-display text-[11px] font-normal uppercase tracking-wide text-ink-400"
      {...props}
    />
  ),
  td: (props) => <td className="border-b border-ink-800 px-3 py-2 align-top leading-relaxed text-ink-200 [tr:last-child>&]:border-b-0" {...props} />,
  span: (props) => ("data-placeholder" in props ? <Placeholder {...props} /> : <span {...props} />),
};

/** Renders a compiled docs page with the design-system typography. */
export function DocsArticle({ tree, className }: { tree: Root; className?: string }) {
  return <div className={cn("min-w-0", className)}>{toJsxRuntime(tree, { Fragment, jsx, jsxs, components })}</div>;
}
