"use client";

import {
  Fragment,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

export interface ThemedSelectOption<Value extends string> {
  value: Value;
  label: string;
  group?: string;
}

export function ThemedSelect<Value extends string>({
  id,
  value,
  options,
  ariaLabel,
  menuLabel,
  disabled = false,
  compact = false,
  alignMenu = "start",
  rootClassName,
  triggerClassName,
  title,
  onChange,
}: {
  id: string;
  value: Value;
  options: readonly ThemedSelectOption<Value>[];
  ariaLabel: string;
  menuLabel?: string;
  disabled?: boolean;
  compact?: boolean;
  alignMenu?: "start" | "end";
  rootClassName?: string;
  triggerClassName?: string;
  title?: string;
  onChange: (value: Value) => void | Promise<void>;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [opensUpward, setOpensUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = `${id}-options`;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function normalizedIndex(index: number) {
    return (index + options.length) % options.length;
  }

  function focusOption(index: number) {
    setActiveIndex(normalizedIndex(index));
  }

  function openMenu(index = selectedIndex) {
    if (disabled || options.length === 0) return;
    const bounds = rootRef.current?.getBoundingClientRect();
    if (bounds) {
      const estimatedHeight = Math.min(360, options.length * 44 + 12);
      const spaceBelow = window.innerHeight - bounds.bottom - 12;
      const spaceAbove = bounds.top - 12;
      setOpensUpward(spaceBelow < estimatedHeight && spaceAbove > spaceBelow);
    }
    setActiveIndex(normalizedIndex(index));
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(option: ThemedSelectOption<Value>) {
    closeMenu(true);
    if (option.value !== value) void onChange(option.value);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (open) focusOption(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      else openMenu(selectedIndex);
    } else if ((event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      openMenu(selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openMenu(options.length - 1);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu();
    }
  }

  if (!selectedOption) return null;

  const rootClasses = [
    "themed-select",
    compact ? "compact" : "",
    alignMenu === "end" ? "align-end" : "",
    opensUpward ? "opens-upward" : "",
    open ? "open" : "",
    rootClassName ?? "",
  ].filter(Boolean).join(" ");

  return <div
    ref={rootRef}
    className={rootClasses}
    data-themed-select={id}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu();
    }}
  >
    <button
      id={id}
      ref={triggerRef}
      className={`themed-select-trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
      type="button"
      data-value={value}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      disabled={disabled}
      title={title}
      onClick={() => open ? closeMenu() : openMenu()}
      onKeyDown={handleTriggerKeyDown}
    >
      <span className="themed-select-value">{selectedOption.label}</span>
      <span className="themed-select-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div id={listboxId} className="themed-select-menu" role="listbox" aria-label={menuLabel ?? `${ariaLabel}选项`}>
      {options.map((option, index) => <Fragment key={option.value}>
        {option.group && option.group !== options[index - 1]?.group && <div className="themed-select-group" aria-hidden="true">{option.group}</div>}
        <button
          ref={(element) => { optionRefs.current[index] = element; }}
          className={`themed-select-option${activeIndex === index ? " active" : ""}`}
          type="button"
          data-value={option.value}
          role="option"
          aria-selected={option.value === value}
          tabIndex={activeIndex === index ? 0 : -1}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(option)}
          onKeyDown={(event) => handleOptionKeyDown(event, index)}
        >
          <span>{option.label}</span>
          <span className="themed-select-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
        </button>
      </Fragment>)}
    </div>}
  </div>;
}
