import defaultMdxComponents from "fumadocs-ui/mdx";
import { Heading } from "fumadocs-ui/components/heading";
import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { VideoEmbed } from "./video-embed";

/** Step headings the engine writes as `#### 3. Choose the competitor` get a numbered badge. */
function StepHeading({ children, ...props }: ComponentProps<"h4">) {
  const match = typeof children === "string" ? /^(\d+)\.\s+(.+)$/.exec(children) : null;
  if (!match) return <Heading as="h4" {...props}>{children}</Heading>;
  return (
    <Heading as="h4" {...props} className="aida-step">
      <span className="aida-step-number" aria-hidden="true">
        {match[1]}
      </span>
      <span className="sr-only">Step {match[1]}: </span>
      {match[2]}
    </Heading>
  );
}

/** Screenshots: framed like a window and zoomable. */
function Screenshot(props: ComponentProps<"img">) {
  return (
    <ImageZoom
      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 70vw, 900px"
      {...(props as ComponentProps<typeof ImageZoom>)}
      className="aida-screenshot"
    />
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    h4: StepHeading,
    img: Screenshot,
    VideoEmbed,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
