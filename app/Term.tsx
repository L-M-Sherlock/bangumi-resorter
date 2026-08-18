"use client";

import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  safePolygon,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
} from "@floating-ui/react";
import { ReactNode, useCallback, useId, useState } from "react";
import { sitePath } from "@/lib/site-path";
import { TERM_DEFINITIONS, TermKey } from "@/lib/terminology";

export function Term({ term, children, className = "" }: { term: TermKey; children?: ReactNode; className?: string }) {
  const definition = TERM_DEFINITIONS[term];
  const [open, setOpen] = useState(false);
  const rawId = useId();
  const popoverId = `term-popover-${rawId.replace(/:/g, "")}`;
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top",
    middleware: [offset(9), flip({ padding: 12 }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false, handleClose: safePolygon() });
  const focus = useFocus(context);
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, click, dismiss]);
  const setReference = useCallback((node: HTMLElement | null) => refs.setReference(node), [refs]);
  const setFloating = useCallback((node: HTMLElement | null) => refs.setFloating(node), [refs]);

  return <>
    <button
      ref={setReference}
      type="button"
      className={`term-trigger ${className}`.trim()}
      data-term-key={term}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popoverId : undefined}
      {...getReferenceProps()}
    >{children ?? definition.label}</button>
    {open && <FloatingPortal>
      <aside
        ref={setFloating}
        id={popoverId}
        className="term-popover"
        style={floatingStyles}
        role="dialog"
        aria-label={`${definition.label}解释`}
        {...getFloatingProps()}
      >
        <strong>{definition.label}</strong>
        <p>{definition.summary}</p>
        <a href={sitePath(`/principles#${definition.sectionId}`)}>查看完整原理 <span aria-hidden="true">→</span></a>
      </aside>
    </FloatingPortal>}
  </>;
}
