"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Minus, Package2, Pencil, Plus, Trash2, X } from "lucide-react";
import type { GroceryNotepadItem } from "@/lib/grocery-notepad";
import type { CartivaLocation, ComparisonPhase } from "@/components/cartiva-workspace-types";
import styles from "@/components/cartiva-workspace.module.css";

interface CartivaGroceryListProps {
  items: GroceryNotepadItem[];
  quantities: Record<string, number>;
  locations: CartivaLocation[];
  selectedLocationId: string;
  fulfillmentMode: "pickup" | "delivery";
  comparisonPhase: ComparisonPhase;
  locked: boolean;
  canCompare: boolean;
  compareHint: string;
  onAdd: (value: string, source: "single" | "paste" | "plan" | "recipe") => void;
  onEdit: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onQuantity: (id: string, quantity: number) => void;
  onClarify: (index: number, clarificationId: string, value: string) => void;
  onLocation: (locationId: string) => void;
  onFulfillment: (mode: "pickup" | "delivery") => void;
  onCompare: () => void;
}

function categoryFor(item: GroceryNotepadItem) {
  const value = item.raw.toLowerCase();
  if (/egg|milk|yogurt|cheese|butter/.test(value)) return "Dairy & eggs";
  if (/chicken|beef|pork|bacon|sausage|turkey|meat|fish|salmon|tilapia|cod|catfish|shrimp|seafood/.test(value)) return "Meat & seafood";
  if (/bread|bagel|tortilla|bun|muffin/.test(value)) return "Bakery";
  if (/coke|cola|pepsi|soda|water|juice|coffee|tea/.test(value)) return "Beverages";
  if (/apple|banana|berry|berries|broccoli|lettuce|tomato|onion|produce|fruit|vegetable/.test(value)) return "Produce";
  if (/frozen|ice cream/.test(value)) return "Frozen";
  return "Pantry & grocery";
}

function groupedItems(items: GroceryNotepadItem[]) {
  const groups = new Map<string, Array<{ item: GroceryNotepadItem; index: number }>>();
  items.forEach((item, index) => {
    const category = categoryFor(item);
    groups.set(category, [...(groups.get(category) ?? []), { item, index }]);
  });
  return [...groups.entries()];
}

export function CartivaGroceryList({
  items,
  quantities,
  locations,
  selectedLocationId,
  fulfillmentMode,
  comparisonPhase,
  locked,
  canCompare,
  compareHint,
  onAdd,
  onEdit,
  onRemove,
  onQuantity,
  onClarify,
  onLocation,
  onFulfillment,
  onCompare,
}: CartivaGroceryListProps) {
  const [addValue, setAddValue] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [editingValue, setEditingValue] = useState("");

  const addItems = (value: string, source: "single" | "paste") => {
    if (!value.trim()) return;
    onAdd(value, source);
    setAddValue("");
    setPasteValue("");
    setPasteOpen(false);
  };

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    addItems(addValue, "single");
  };

  const startEditing = (item: GroceryNotepadItem) => {
    setEditingId(item.id);
    setEditingValue(item.raw);
  };

  const commitEditing = (index: number) => {
    const item = items[index];
    if (item && editingValue.trim() !== item.raw.trim()) {
      onEdit(index, editingValue);
    }
    setEditingId(undefined);
    setEditingValue("");
  };

  const editingKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditing(index);
    }
    if (event.key === "Escape") {
      setEditingId(undefined);
      setEditingValue("");
    }
  };

  const busy = comparisonPhase === "finding-store" || comparisonPhase === "searching";

  return (
    <section className={styles.listCard} aria-labelledby="grocery-list-heading">
      <div className={styles.cardHeading}>
        <h2 id="grocery-list-heading">My grocery list</h2>
        <span>{items.length} {items.length === 1 ? "item" : "items"}</span>
      </div>

      <form className={styles.addForm} onSubmit={submitAdd}>
        <Plus aria-hidden="true" />
        <label htmlFor="add-grocery" className={styles.srOnly}>Add a grocery item</label>
        <input
          id="add-grocery"
          value={addValue}
          onChange={(event) => setAddValue(event.target.value)}
          placeholder="Add milk, produce, pantry…"
          autoComplete="off"
          disabled={locked}
        />
        <button type="submit" disabled={locked || !addValue.trim()}><Plus aria-hidden="true" /> Add</button>
      </form>
      <p className={styles.entryHelper}>Write your list however you normally would.</p>

      <button type="button" className={styles.pasteToggle} onClick={() => setPasteOpen((current) => !current)} disabled={locked}>
        {pasteOpen ? <X aria-hidden="true" /> : <Package2 aria-hidden="true" />}
        {pasteOpen ? "Close grocery paste" : "Paste grocery list"}
      </button>

      {pasteOpen ? (
        <div className={styles.pastePanel}>
          <label htmlFor="paste-groceries">Paste groceries, one per line</label>
          <textarea
            id="paste-groceries"
            rows={5}
            value={pasteValue}
            onChange={(event) => setPasteValue(event.target.value)}
            placeholder={"Large eggs, 18 count\n2% milk, 1 gallon\nWhite bread"}
            disabled={locked}
          />
          <button type="button" className={styles.secondaryButton} onClick={() => addItems(pasteValue, "paste")} disabled={locked || !pasteValue.trim()}>
            Add list
          </button>
        </div>
      ) : null}

      <div className={styles.listContent}>
        {items.length === 0 ? (
          <div className={styles.emptyList}>
            <span><Package2 aria-hidden="true" /></span>
            <h3>Your weekly list starts here</h3>
            <p>Type one item, or paste the whole list. Retailer work starts only when you compare.</p>
          </div>
        ) : groupedItems(items).map(([category, entries]) => (
          <div className={styles.categoryGroup} key={category}>
            <h3>{category}</h3>
            {entries.map(({ item, index }) => {
              const quantity = quantities[item.id] ?? 1;
              return (
                <div id={`list-item-${item.id}`} className={styles.groceryItem} key={item.id} data-needs-detail={item.status === "needs-detail"}>
                  <span className={styles.itemGlyph}><Package2 aria-hidden="true" /></span>
                  <div className={styles.itemCopy}>
                    {editingId === item.id ? (
                      <input
                        id={`edit-input-${item.id}`}
                        className={styles.itemEditInput}
                        value={editingValue}
                        onChange={(event) => setEditingValue(event.target.value)}
                        onKeyDown={(event) => editingKeyDown(event, index)}
                        onBlur={() => commitEditing(index)}
                        autoFocus
                        aria-label={`Edit ${item.name}`}
                      />
                    ) : (
                      <>
                        <strong>{item.name}</strong>
                        <span>{item.detail ?? (item.status === "needs-detail" ? item.clarification?.shortLabel : "Ready to match")}</span>
                      </>
                    )}
                    {item.clarification ? (
                      <div className={styles.clarification}>
                        <p>{item.clarification.prompt}</p>
                        <div>
                          {item.clarification.options.map((option) => (
                            <button
                              type="button"
                              key={option.id}
                              onClick={() => onClarify(index, item.clarification!.id, option.value)}
                              disabled={locked}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.itemActions}>
                    <div className={styles.quantityControl} aria-label={`Quantity for ${item.name}`}>
                      <button type="button" onClick={() => onQuantity(item.id, Math.max(1, quantity - 1))} disabled={locked || quantity <= 1} aria-label={`Decrease ${item.name} quantity`}><Minus aria-hidden="true" /></button>
                      <span aria-live="polite">{quantity}</span>
                      <button type="button" onClick={() => onQuantity(item.id, Math.min(99, quantity + 1))} disabled={locked || quantity >= 99} aria-label={`Increase ${item.name} quantity`}><Plus aria-hidden="true" /></button>
                    </div>
                    <button id={`edit-${item.id}`} type="button" className={styles.rowIconButton} onClick={() => startEditing(item)} aria-label={`Edit ${item.name}`} disabled={locked}><Pencil aria-hidden="true" /></button>
                    <button type="button" className={styles.rowIconButton} onClick={() => onRemove(index)} aria-label={`Remove ${item.name}`} disabled={locked}><Trash2 aria-hidden="true" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className={styles.listSettings}>
        <div>
          <label htmlFor="store-select">Store area</label>
          {locations.length ? (
            <select id="store-select" value={selectedLocationId} onChange={(event) => onLocation(event.target.value)} disabled={locked}>
              {locations.map((location) => (
                <option value={location.locationId} key={location.locationId}>
                  {location.chain} · {location.name}
                </option>
              ))}
            </select>
          ) : <span>Enter a ZIP above</span>}
        </div>
        <div>
          <span>Fulfillment</span>
          <div className={styles.segmentedControl} role="group" aria-label="Fulfillment method">
            <button type="button" aria-pressed={fulfillmentMode === "pickup"} data-active={fulfillmentMode === "pickup"} onClick={() => onFulfillment("pickup")} disabled={locked}><Check aria-hidden="true" /> Pickup</button>
            <button type="button" aria-pressed={fulfillmentMode === "delivery"} data-active={fulfillmentMode === "delivery"} onClick={() => onFulfillment("delivery")} disabled={locked}><Check aria-hidden="true" /> Delivery</button>
          </div>
        </div>
      </div>

      <div className={styles.compareAction}>
        <button
          type="button"
          className={comparisonPhase === "complete" ? styles.secondaryCompareButton : styles.primaryButton}
          onClick={onCompare}
          disabled={locked || !canCompare || busy}
        >
          {comparisonPhase === "finding-store"
            ? "Finding stores…"
            : comparisonPhase === "searching"
              ? "Comparing Kroger basket…"
              : comparisonPhase === "complete" ? "Compare again" : "Compare basket"}
        </button>
        <p role="status" aria-live="polite">{busy ? "Real Kroger results are usually ready in 8–15 seconds." : compareHint}</p>
      </div>
    </section>
  );
}
