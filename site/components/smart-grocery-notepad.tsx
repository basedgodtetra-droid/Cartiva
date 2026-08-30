"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  applyGroceryClarification,
  interpretGroceryInput,
  type GroceryNotepadItem,
} from "@/lib/grocery-notepad";

function replaceItem(
  items: GroceryNotepadItem[],
  itemIndex: number,
  nextValue: string | null,
) {
  return items
    .flatMap((item, index) => {
      if (index !== itemIndex) return [item.raw];
      return nextValue?.trim() ? [nextValue.trim()] : [];
    })
    .join("\n");
}

export function SmartGroceryNotepad() {
  const [rawInput, setRawInput] = useState("");
  const [parsedInput, setParsedInput] = useState("");
  const [zip, setZip] = useState("");
  const [undoImplicitSplits, setUndoImplicitSplits] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const hiddenListRef = useRef<HTMLInputElement>(null);
  const skipEditCommitRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setParsedInput(rawInput), 140);
    return () => window.clearTimeout(timer);
  }, [rawInput]);

  const interpretation = useMemo(
    () => interpretGroceryInput(parsedInput, { undoImplicitSplits }),
    [parsedInput, undoImplicitSplits],
  );
  const zipIsValid = /^\d{5}$/.test(zip);
  const canCompare = interpretation.items.length > 0
    && interpretation.unresolvedCount === 0
    && !interpretation.limitReached
    && zipIsValid;

  const statusText = interpretation.limitReached
    ? "More than 24 items detected · shorten the list to continue"
    : interpretation.items.length === 0
    ? "Ready when you are"
    : interpretation.unresolvedCount > 0
      ? `${interpretation.readyCount} of ${interpretation.items.length} ready · ${interpretation.unresolvedCount} ${interpretation.unresolvedCount === 1 ? "item needs" : "items need"} details`
      : `${interpretation.items.length} ${interpretation.items.length === 1 ? "item" : "items"} ready for comparison`;

  const ctaText = interpretation.limitReached
    ? "Reduce list to 24 items"
    : interpretation.items.length === 0
    ? "Add groceries to compare"
    : interpretation.unresolvedCount > 0
      ? `${interpretation.unresolvedCount} ${interpretation.unresolvedCount === 1 ? "item needs" : "items need"} details`
      : !zipIsValid
        ? "Add ZIP to compare"
        : "Compare full carts";

  const updateRawInput = (value: string) => {
    setRawInput(value);
    if (!value.trim()) setUndoImplicitSplits(false);
  };

  const updateStructuredInput = (value: string) => {
    setRawInput(value);
    setParsedInput(value);
  };

  const currentInterpretation = () => interpretGroceryInput(rawInput, { undoImplicitSplits });

  const handleClarification = (item: GroceryNotepadItem, itemIndex: number, id: string, value: string, label: string) => {
    const latest = currentInterpretation();
    const resolved = applyGroceryClarification(latest.items[itemIndex]?.raw ?? item.raw, id, value);
    updateStructuredInput(replaceItem(latest.items, itemIndex, resolved));
    setAnnouncement(`${item.name}: ${label} selected.`);
  };

  const beginEdit = (item: GroceryNotepadItem) => {
    setEditingId(item.id);
    setEditingValue(item.raw);
  };

  const commitEdit = (itemIndex: number) => {
    const latest = currentInterpretation();
    updateStructuredInput(replaceItem(latest.items, itemIndex, editingValue));
    setEditingId(null);
    setAnnouncement(editingValue.trim() ? "Item updated." : "Item removed.");
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      skipEditCommitRef.current = true;
      event.currentTarget.blur();
      setEditingId(null);
      setEditingValue("");
    }
  };

  const removeItem = (item: GroceryNotepadItem, itemIndex: number) => {
    const latest = currentInterpretation();
    updateStructuredInput(replaceItem(latest.items, itemIndex, null));
    setAnnouncement(`${item.name} removed.`);
  };

  const addAnotherItem = () => {
    setRawInput((current) => current.trimEnd() ? `${current.trimEnd()}\n` : current);
    window.setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
    setAnnouncement("Ready for another grocery item.");
  };

  const undoSmartSplit = () => {
    setUndoImplicitSplits(true);
    setAnnouncement("Smart split undone. Your original phrasing is now one editable item.");
  };

  const resumeSmartSplit = () => {
    setUndoImplicitSplits(false);
    setAnnouncement("Smart space splitting resumed.");
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    const nextValue = `${rawInput.slice(0, start)}${event.clipboardData.getData("text")}${rawInput.slice(end)}`;
    setParsedInput(nextValue);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const latest = currentInterpretation();
    if (hiddenListRef.current) hiddenListRef.current.value = latest.serialized;
    const latestCanCompare = latest.items.length > 0
      && latest.unresolvedCount === 0
      && !latest.limitReached
      && zipIsValid;
    if (latestCanCompare) return;
    event.preventDefault();

    if (latest.limitReached) {
      textareaRef.current?.focus();
      setAnnouncement("Cartiva supports up to 24 items per comparison. Shorten the list to continue.");
      return;
    }

    if (latest.items.length === 0) {
      textareaRef.current?.focus();
      setAnnouncement("Add at least one grocery item before comparing.");
      return;
    }

    if (latest.unresolvedCount > 0) {
      const firstChoice = event.currentTarget.querySelector<HTMLButtonElement>(
        "[data-needs-detail='true'] button[data-clarification-option]",
      );
      if (firstChoice) firstChoice.focus();
      else textareaRef.current?.focus();
      setAnnouncement("Choose the missing item detail before comparing.");
      return;
    }

    zipRef.current?.focus();
    setAnnouncement("Enter a five-digit ZIP code before comparing.");
  };

  return (
    <form
      action="/compare"
      method="get"
      noValidate
      data-hero-comparison-form
      onSubmit={handleSubmit}
      className="smart-notepad hero-enter hero-enter--4 order-4 mt-10 overflow-hidden rounded-[30px]"
    >
      <input ref={hiddenListRef} type="hidden" name="list" value={interpretation.serialized} />

      <div className="smart-notepad-header flex flex-wrap items-start justify-between gap-4 border-b border-white/70 px-5 py-5 sm:px-6">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[#28734f]">
            <span className="size-2 rounded-full bg-[#23a76d] shadow-[0_0_0_4px_rgba(35,167,109,0.12)]" aria-hidden="true" />
            Smart Grocery Notepad
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.035em] text-[#183526] sm:text-2xl">
            Start your grocery list here
          </h2>
        </div>
        <span className="rounded-full border border-[#76b68e]/25 bg-white/45 px-3 py-1.5 text-xs font-semibold text-[#557066]">
          Write it your way
        </span>
      </div>

      <div className="smart-notepad-composer relative border-b border-white/70 px-5 py-5 sm:px-6">
        <label htmlFor="grocery-list" className="sr-only">Grocery list</label>
        <textarea
          ref={textareaRef}
          id="grocery-list"
          rows={8}
          value={rawInput}
          onChange={(event) => updateRawInput(event.target.value)}
          onPaste={handlePaste}
          placeholder={"Start your grocery list...\neggs, milk, white bread...\nchicken breast 2 lb; bananas"}
          spellCheck="true"
          autoCapitalize="sentences"
          aria-describedby="grocery-list-help grocery-list-status"
          className="smart-notepad-textarea w-full resize-none border-0 bg-transparent p-0 text-base leading-8 text-[#20372a] outline-none placeholder:text-[#718178]/75"
        />
        <p id="grocery-list-help" className="mt-3 text-xs leading-5 text-[#617269]">
          Type naturally with spaces, commas, semicolons, or one item per line. Cartiva interprets everything locally while you type.
        </p>
      </div>

      {interpretation.items.length > 0 ? (
        <div className="smart-notepad-interpretation">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/65 bg-white/22 px-5 py-3 sm:px-6">
            <p className="text-xs font-bold uppercase tracking-[0.11em] text-[#52675b]">Cartiva&apos;s interpretation</p>
            {interpretation.usedSmartSplit ? (
              <button
                type="button"
                onClick={undoSmartSplit}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-[#17623f] hover:bg-white/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17623f]"
              >
                Split into {interpretation.items.length} items
                <span aria-hidden="true">·</span>
                <RotateCcw className="size-3.5" aria-hidden="true" /> Undo
              </button>
            ) : undoImplicitSplits ? (
              <button
                type="button"
                onClick={resumeSmartSplit}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-[#17623f] hover:bg-white/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17623f]"
              >
                Smart split paused <span aria-hidden="true">·</span> Resume
              </button>
            ) : null}
          </div>

          <ol className="smart-notepad-rows" aria-label="Interpreted grocery items">
            {interpretation.items.map((item, index) => (
              <li
                key={item.id}
                className="smart-notepad-row px-5 py-3.5 sm:px-6"
                data-needs-detail={item.status === "needs-detail" ? "true" : "false"}
              >
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                  <span
                    className={`smart-notepad-status grid size-7 place-items-center rounded-full ${item.status === "ready" ? "smart-notepad-status--ready" : "smart-notepad-status--warning"}`}
                    title={item.status === "ready" ? "Ready for matching—not purchased" : item.clarification?.shortLabel}
                  >
                    {item.status === "ready" ? <Check className="size-3.5" aria-hidden="true" /> : <CircleAlert className="size-3.5" aria-hidden="true" />}
                    <span className="sr-only">
                      {item.status === "ready" ? "Ready for matching—not purchased" : item.clarification?.shortLabel}
                    </span>
                  </span>

                  {editingId === item.id ? (
                    <input
                      autoFocus
                      value={editingValue}
                      onChange={(event) => setEditingValue(event.target.value)}
                      onBlur={() => {
                        if (skipEditCommitRef.current) {
                          skipEditCommitRef.current = false;
                          return;
                        }
                        commitEdit(index);
                      }}
                      onKeyDown={handleEditKeyDown}
                      aria-label={`Edit item ${index + 1}`}
                      className="min-h-11 w-full rounded-xl border border-[#3b9063]/35 bg-white/65 px-3 text-sm font-semibold text-[#1f3d2d] outline-none focus:border-[#168052] focus:ring-4 focus:ring-[#3ba872]/12"
                    />
                  ) : (
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#203a2b]">{item.name}</p>
                      <p className={`mt-0.5 text-xs ${item.status === "ready" ? "text-[#617269]" : "font-semibold text-[#896229]"}`}>
                        {item.detail ?? (item.clarification?.shortLabel || "Ready for matching")}
                      </p>
                    </div>
                  )}

                  <div className="smart-notepad-row-actions flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => beginEdit(item)}
                      className="grid size-10 place-items-center rounded-full text-[#52675b] hover:bg-white/65 hover:text-[#17623f] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#17623f]"
                      aria-label={`Edit ${item.name}`}
                    >
                      <Pencil className="size-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(item, index)}
                      className="grid size-10 place-items-center rounded-full text-[#68776e] hover:bg-[#fff2ed]/80 hover:text-[#934b3a] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#934b3a]"
                      aria-label={`Remove ${item.name}`}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {item.clarification ? (
                  <fieldset className="ml-10 mt-3 min-w-0">
                    <legend className="text-xs font-semibold text-[#50675a]">{item.clarification.prompt}</legend>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.clarification.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          data-clarification-option
                          onClick={() => handleClarification(item, index, item.clarification!.id, option.value, option.label)}
                          className="smart-notepad-option inline-flex min-h-10 items-center rounded-full border border-[#65a77e]/28 bg-white/48 px-3 text-xs font-bold text-[#285a40] hover:border-[#3e9867]/50 hover:bg-white/76 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17623f]"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </li>
            ))}
          </ol>

          <button
            type="button"
            onClick={addAnotherItem}
            className="ml-4 inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-bold text-[#17623f] hover:bg-white/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17623f] sm:ml-5"
          >
            <Plus className="size-4" aria-hidden="true" /> Add another item
          </button>
        </div>
      ) : null}

      <div className="smart-notepad-footer border-t border-white/70">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 sm:px-6">
          <p id="grocery-list-status" aria-live="polite" className="text-xs font-semibold text-[#52675b]">{statusText}</p>
          {interpretation.limitReached ? <p className="text-xs font-semibold text-[#896229]">Maximum 24 items</p> : null}
        </div>
        <div className="grid border-t border-white/70 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="relative border-b border-white/70 sm:border-b-0 sm:border-r">
            <label htmlFor="zip" className="sr-only">ZIP code</label>
            <MapPin className="pointer-events-none absolute left-5 top-1/2 size-4 -translate-y-1/2 text-[#268158]" aria-hidden="true" />
            <input
              ref={zipRef}
              id="zip"
              name="zip"
              value={zip}
              onChange={(event) => setZip(event.target.value.replace(/\D/g, "").slice(0, 5))}
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={5}
              pattern="[0-9]{5}"
              placeholder="Enter ZIP code"
              className="min-h-16 w-full border-0 bg-white/14 pl-12 pr-4 text-base font-bold text-[#234331] outline-none placeholder:font-semibold placeholder:text-[#758078] focus:bg-white/34"
            />
          </div>
          <button
            type="submit"
            aria-disabled={!canCompare}
            className="smart-notepad-compare primary-cta pressable inline-flex min-h-16 items-center justify-center gap-3 px-6 text-sm font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white sm:min-w-52"
          >
            {ctaText}
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    </form>
  );
}
