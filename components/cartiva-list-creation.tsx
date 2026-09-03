"use client";

import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChefHat,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  ListChecks,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  adjustPlanMeal,
  confirmRecipeServings,
  formatIngredientAmount,
  generateMealPlan,
  isPantryIngredient,
  MAX_CARTIVA_INGREDIENTS,
  parseRecipeText,
  plannerExamplePrompts,
  removePlanMeal,
  replacePlanMeal,
  preserveReviewedPlanIngredients,
  regenerateMealPlan,
  scaleRecipeImport,
  updateConsolidatedIngredientDetails,
  updatePlanMealServings,
  type ConsolidatedIngredient,
  type MealPlan,
  type PlanMealAdjustment,
  type PlannedMeal,
  type PlannerGoalDraft,
  type RecipeImport,
} from "@/lib/cartiva-planning";
import type { CartivaSavedPlan } from "@/lib/cartiva-library";
import styles from "@/components/cartiva-workspace.module.css";

export type CartivaCreationMode = "grocery-list" | "build-plan" | "paste-recipe";

interface CartivaCreationModeTabsProps {
  mode: CartivaCreationMode;
  onMode: (mode: CartivaCreationMode) => void;
}

const MODES = [
  { id: "grocery-list", label: "Grocery list", icon: ListChecks },
  { id: "build-plan", label: "Build my plan", icon: Sparkles },
  { id: "paste-recipe", label: "Paste a recipe", icon: ClipboardPaste },
] as const;

export function CartivaCreationModeTabs({ mode, onMode }: CartivaCreationModeTabsProps) {
  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % MODES.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + MODES.length) % MODES.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = MODES.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = MODES[nextIndex];
    onMode(next.id);
    document.getElementById(`creation-tab-${next.id}`)?.focus();
  };

  return (
    <div className={styles.creationModeTabs} role="tablist" aria-label="Choose how to build your grocery list">
      {MODES.map((option, index) => {
        const Icon = option.icon;
        return (
          <button
            id={`creation-tab-${option.id}`}
            type="button"
            role="tab"
            aria-selected={mode === option.id}
            aria-controls={`creation-panel-${option.id}`}
            data-active={mode === option.id}
            tabIndex={mode === option.id ? 0 : -1}
            key={option.id}
            onClick={() => onMode(option.id)}
            onKeyDown={(event) => selectFromKeyboard(event, index)}
          >
            <Icon aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

interface IngredientReviewProps {
  ingredients: ConsolidatedIngredient[];
  ownedIngredientIds: Set<string>;
  omittedIngredientCount: number;
  availableIngredientSlots: number;
  heading: string;
  helper: string;
  onIngredients: (ingredients: ConsolidatedIngredient[]) => void;
  onOwnedIngredientIds: (ingredientIds: Set<string>) => void;
  onCommit: (neededIngredients: ConsolidatedIngredient[]) => void;
  commitLabel: (neededCount: number) => string;
  emptyCopy: string;
  commitBlockedReason?: string;
  allowEmptyCommit?: boolean;
  contained?: boolean;
  children?: ReactNode;
}

function IngredientReview({
  ingredients,
  ownedIngredientIds,
  omittedIngredientCount,
  availableIngredientSlots,
  heading,
  helper,
  onIngredients,
  onOwnedIngredientIds,
  onCommit,
  commitLabel,
  emptyCopy,
  commitBlockedReason,
  allowEmptyCommit = false,
  contained = false,
  children,
}: IngredientReviewProps) {
  const [editingId, setEditingId] = useState<string>();
  const [editingName, setEditingName] = useState("");
  const [editingAmount, setEditingAmount] = useState("");
  const [editingError, setEditingError] = useState("");

  const commitEdit = (ingredientId: string) => {
    const cleanName = editingName.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    const amount = Number(editingAmount);
    if (!cleanName) {
      setEditingError("Enter an ingredient name.");
      window.requestAnimationFrame(() => document.getElementById(`ingredient-name-${ingredientId}`)?.focus());
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
      setEditingError("Enter a quantity greater than 0 and no more than 10,000.");
      window.requestAnimationFrame(() => document.getElementById(`ingredient-amount-${ingredientId}`)?.focus());
      return;
    }
    const updated = updateConsolidatedIngredientDetails(
      ingredients,
      ingredientId,
      cleanName,
      amount,
    );
    if (ownedIngredientIds.has(ingredientId) && !updated.some((ingredient) => ingredient.id === ingredientId)) {
      const normalizedName = cleanName.toLocaleLowerCase().replace(/\s+/g, " ").trim();
      const retained = updated.find((ingredient) => (
        ingredient.name.toLocaleLowerCase().replace(/\s+/g, " ").trim() === normalizedName
      ));
      const nextOwned = new Set(ownedIngredientIds);
      nextOwned.delete(ingredientId);
      if (retained) nextOwned.add(retained.id);
      onOwnedIngredientIds(nextOwned);
    }
    onIngredients(updated);
    setEditingId(undefined);
    setEditingName("");
    setEditingAmount("");
    setEditingError("");
  };
  const neededIngredients = ingredients.filter((ingredient) => !ownedIngredientIds.has(ingredient.id));
  const overAvailableLimit = neededIngredients.length > availableIngredientSlots;
  const pantryIngredients = ingredients.filter(isPantryIngredient);
  const groceryIngredients = ingredients.filter((ingredient) => !isPantryIngredient(ingredient));
  const allPantryOwned = pantryIngredients.length > 0
    && pantryIngredients.every((ingredient) => ownedIngredientIds.has(ingredient.id));

  const toggleOwned = (ingredientId: string, owned: boolean) => {
    const next = new Set(ownedIngredientIds);
    if (owned) next.add(ingredientId);
    else next.delete(ingredientId);
    onOwnedIngredientIds(next);
  };

  const renderIngredientRows = (rows: ConsolidatedIngredient[]) => (
    <div className={styles.ingredientList}>
      {rows.map((ingredient) => {
        const owned = ownedIngredientIds.has(ingredient.id);
        return (
          <div className={styles.ingredientRow} data-owned={owned} key={ingredient.id}>
            <label className={styles.haveItControl}>
              <input
                type="checkbox"
                checked={owned}
                onChange={(event) => toggleOwned(ingredient.id, event.target.checked)}
                aria-label={`I already have ${ingredient.name}`}
              />
              <span aria-hidden="true">{owned ? <Check /> : null}</span>
              <em>Have it</em>
            </label>
            <div className={styles.ingredientCopy}>
              {editingId === ingredient.id ? (
                <>
                  <div className={styles.ingredientEditFields}>
                    <input
                      id={`ingredient-name-${ingredient.id}`}
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitEdit(ingredient.id);
                        if (event.key === "Escape") { setEditingId(undefined); setEditingError(""); }
                      }}
                      aria-label={`Change or replace ${ingredient.name}`}
                      aria-invalid={Boolean(editingError)}
                      aria-describedby={editingError ? `ingredient-edit-error-${ingredient.id}` : undefined}
                      autoFocus
                    />
                    <label>
                      <span className={styles.srOnly}>Quantity for {ingredient.name}</span>
                      <input
                        id={`ingredient-amount-${ingredient.id}`}
                        type="number"
                        min="0.1"
                        max="10000"
                        step="0.1"
                        inputMode="decimal"
                        value={editingAmount}
                        onChange={(event) => setEditingAmount(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitEdit(ingredient.id);
                          if (event.key === "Escape") { setEditingId(undefined); setEditingError(""); }
                        }}
                        aria-invalid={Boolean(editingError)}
                        aria-describedby={editingError ? `ingredient-edit-error-${ingredient.id}` : undefined}
                      />
                      <span>{ingredient.unit}</span>
                    </label>
                  </div>
                  {editingError ? <p className={styles.ingredientEditError} id={`ingredient-edit-error-${ingredient.id}`} role="alert">{editingError}</p> : null}
                </>
              ) : (
                <>
                  <strong>{ingredient.name}</strong>
                  <span>{owned ? "Already have" : formatIngredientAmount(ingredient)}</span>
                </>
              )}
            </div>
            <div className={styles.ingredientActions}>
              {editingId === ingredient.id ? (
                <button type="button" onClick={() => commitEdit(ingredient.id)} aria-label={`Save changes to ${ingredient.name}`}>
                  <Check aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={`Edit quantity or replace ${ingredient.name}`}
                  onClick={() => {
                    setEditingId(ingredient.id);
                    setEditingName(ingredient.name);
                    setEditingAmount(String(ingredient.amount));
                    setEditingError("");
                  }}
                >
                  <Pencil aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                aria-label={`Remove ${ingredient.name}`}
                onClick={() => {
                  onIngredients(ingredients.filter((item) => item.id !== ingredient.id));
                  if (owned) toggleOwned(ingredient.id, false);
                }}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <section className={styles.ingredientPanel} data-contained={contained} aria-labelledby={`${heading.replace(/\s+/g, "-").toLowerCase()}-heading`}>
      <div className={styles.planSectionHeading}>
        <div>
          <span>Ingredients</span>
          <h2 id={`${heading.replace(/\s+/g, "-").toLowerCase()}-heading`}>{heading}</h2>
          <p>{helper}</p>
        </div>
        <strong>{ingredients.length}</strong>
      </div>

      <div className={styles.ingredientReviewBody}>
        {children}

        {ingredients.length ? (
          <>
            {groceryIngredients.length ? renderIngredientRows(groceryIngredients) : null}
            {pantryIngredients.length ? (
              <section className={styles.pantryCheck} aria-labelledby={`${heading.replace(/\s+/g, "-").toLowerCase()}-pantry-heading`}>
                <div>
                  <span>
                    <strong id={`${heading.replace(/\s+/g, "-").toLowerCase()}-pantry-heading`}>Pantry check</strong>
                    <small>You may already have these.</small>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(ownedIngredientIds);
                      for (const ingredient of pantryIngredients) {
                        if (allPantryOwned) next.delete(ingredient.id);
                        else next.add(ingredient.id);
                      }
                      onOwnedIngredientIds(next);
                    }}
                  >
                    {allPantryOwned ? "Add pantry items back" : "I have all of these"}
                  </button>
                </div>
                {renderIngredientRows(pantryIngredients)}
              </section>
            ) : null}
          </>
        ) : <p className={styles.ingredientEmpty}>{emptyCopy}</p>}

        {omittedIngredientCount ? (
          <p className={styles.planWarning} role="status">
            {omittedIngredientCount} extra {omittedIngredientCount === 1 ? "ingredient is" : "ingredients are"} outside Cartiva&apos;s 24-item list limit. Remove or combine ingredients before adding this plan.
          </p>
        ) : null}
        {overAvailableLimit ? (
          <p className={styles.planWarning} role="status">
            Your current Cartiva list has room for {availableIngredientSlots} more {availableIngredientSlots === 1 ? "ingredient" : "ingredients"}. Remove or mark {neededIngredients.length - availableIngredientSlots} as already owned before adding this draft.
          </p>
        ) : null}
        {commitBlockedReason ? <p className={styles.planWarning} role="status">{commitBlockedReason}</p> : null}
      </div>

      <div className={styles.ingredientCommit}>
        <strong>{neededIngredients.length} {neededIngredients.length === 1 ? "grocery" : "groceries"} needed</strong>
        <button
          type="button"
          className={styles.planPrimaryButton}
          onClick={() => onCommit(neededIngredients)}
          disabled={(!neededIngredients.length && !allowEmptyCommit) || Boolean(omittedIngredientCount) || overAvailableLimit || Boolean(commitBlockedReason)}
        >
          {commitLabel(neededIngredients.length)}
          <ArrowRight aria-hidden="true" />
        </button>
        <p>Next, Cartiva will ask any needed product questions before comparing retailers.</p>
      </div>
    </section>
  );
}

interface CartivaPlanBuilderProps {
  availableIngredientSlots: number;
  savedPlans: CartivaSavedPlan[];
  basketOverageCents?: number;
  committedPlanId?: string;
  replacementIngredientSlots?: number;
  onSavePlan: (input: {
    id?: string;
    name: string;
    plan: MealPlan;
    ownedIngredientIds: string[];
  }) => string;
  onCommit: (ingredients: ConsolidatedIngredient[], suggestedName: string, plan: MealPlan) => void;
}

function numberOrUndefined(value: string) {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
}

function fieldsFromDraft(draft: Partial<PlannerGoalDraft>) {
  return {
    calories: draft.dailyCalories?.toString() ?? "",
    protein: draft.proteinGrams?.toString() ?? "",
    budget: draft.budgetDollars?.toString() ?? "",
    days: draft.days?.toString() ?? "",
    people: draft.people?.toString() ?? "",
    notes: draft.notes ?? "",
  };
}

type PlanFields = ReturnType<typeof fieldsFromDraft>;
type PlannerPhase = "goal_entry" | "generating" | "plan_ready" | "plan_editing" | "ingredient_review" | "error";
type PlannerResultTab = "meals" | "groceries";

function draftFromFields(fields: PlanFields): PlannerGoalDraft {
  return {
    dailyCalories: numberOrUndefined(fields.calories),
    proteinGrams: numberOrUndefined(fields.protein),
    budgetDollars: numberOrUndefined(fields.budget),
    days: numberOrUndefined(fields.days),
    people: numberOrUndefined(fields.people),
    notes: fields.notes,
  };
}

function fieldsFromPlan(plan: MealPlan) {
  return fieldsFromDraft({
    dailyCalories: plan.goal.dailyCalories?.value,
    proteinGrams: plan.goal.proteinGrams?.value,
    budgetDollars: plan.goal.budgetDollars?.value,
    days: plan.goal.days.value,
    people: plan.goal.people.value,
    notes: plan.goal.originalPrompt,
  });
}

function planGoalSummary(plan: MealPlan) {
  return [
    plan.goal.dailyCalories ? `${plan.goal.dailyCalories.value.toLocaleString()} cal/day` : undefined,
    plan.goal.proteinGrams ? `${plan.goal.proteinGrams.value}g protein/day` : undefined,
    plan.goal.budgetDollars ? `$${plan.goal.budgetDollars.value} budget` : undefined,
    `${plan.goal.days.value} ${plan.goal.days.value === 1 ? "day" : "days"}`,
    `${plan.goal.people.value} ${plan.goal.people.value === 1 ? "person" : "people"}`,
  ].filter(Boolean).join(" · ");
}

function savedPlanSignature(name: string, plan: MealPlan, ownedIngredientIds: Set<string> | string[]) {
  return JSON.stringify({
    name: name.replace(/\s+/g, " ").trim(),
    plan,
    ownedIngredientIds: [...ownedIngredientIds].sort(),
  });
}

function replacementOptions(plan: MealPlan, mealId: string) {
  const options = new Map<string, { step: number; name: string; calories: number; protein: number }>();
  for (let step = 1; step <= 5 && options.size < 3; step += 1) {
    const replacement = replacePlanMeal(plan, mealId, step).meals.find((meal) => meal.id === mealId);
    if (!replacement || replacement.templateId === plan.meals.find((meal) => meal.id === mealId)?.templateId) continue;
    options.set(replacement.templateId, {
      step,
      name: replacement.name,
      calories: replacement.estimatedCaloriesPerServing,
      protein: replacement.estimatedProteinGramsPerServing,
    });
  }
  return [...options.values()];
}

export function CartivaPlanBuilder({
  availableIngredientSlots,
  savedPlans,
  basketOverageCents,
  committedPlanId,
  replacementIngredientSlots,
  onSavePlan,
  onCommit,
}: CartivaPlanBuilderProps) {
  const [fields, setFields] = useState<PlanFields>(() => fieldsFromDraft({ notes: "" }));
  const [plan, setPlan] = useState<MealPlan>();
  const [planDirty, setPlanDirty] = useState(false);
  const [phase, setPhase] = useState<PlannerPhase>("goal_entry");
  const [goalsOpen, setGoalsOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<PlannerResultTab>("meals");
  const [expandedDays, setExpandedDays] = useState<Set<number>>(() => new Set([1]));
  const [ownedIngredientIds, setOwnedIngredientIds] = useState<Set<string>>(() => new Set());
  const [replacementMealId, setReplacementMealId] = useState<string>();
  const [mealMenuId, setMealMenuId] = useState<string>();
  const [actionStatus, setActionStatus] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [activeSavedPlanId, setActiveSavedPlanId] = useState<string>();
  const [saveName, setSaveName] = useState("");
  const [lastSavedSignature, setLastSavedSignature] = useState<string>();
  const generationRequestRef = useRef(0);

  const setField = (field: keyof PlanFields, value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
    if (plan) setPlanDirty(true);
  };

  const makePlan = (draft = draftFromFields(fields)) => {
    const requestId = ++generationRequestRef.current;
    const previousPlan = plan;
    setPhase("generating");
    setGenerationError("");
    setActionStatus("");
    window.setTimeout(() => {
      try {
        if (requestId !== generationRequestRef.current) return;
        const next = previousPlan
          ? regenerateMealPlan(previousPlan, draft)
          : generateMealPlan(draft);
        setPlan(next);
        setFields(fieldsFromDraft(draft));
        setPlanDirty(false);
        setGoalsOpen(false);
        setActiveTab("meals");
        setExpandedDays(new Set([1]));
        setOwnedIngredientIds((current) => {
          if (!previousPlan) return new Set();
          const availableIds = new Set(next.ingredients.map((ingredient) => ingredient.id));
          return new Set([...current].filter((id) => availableIds.has(id)));
        });
        setActiveSavedPlanId(undefined);
        setSaveName(next.title);
        setLastSavedSignature(undefined);
        setPhase("plan_ready");
        window.requestAnimationFrame(() => document.getElementById("generated-plan-heading")?.focus());
      } catch {
        if (requestId !== generationRequestRef.current) return;
        setGenerationError("We couldn’t build the plan yet. Your goals are still here.");
        setPhase("error");
      }
    }, 0);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    makePlan();
  };

  const loadSavedPlan = (saved: CartivaSavedPlan) => {
    generationRequestRef.current += 1;
    const restored = JSON.parse(JSON.stringify(saved.plan)) as MealPlan;
    setPlan(restored);
    setFields(fieldsFromPlan(restored));
    setOwnedIngredientIds(new Set(saved.ownedIngredientIds));
    setActiveSavedPlanId(saved.id);
    setSaveName(saved.name);
    setLastSavedSignature(savedPlanSignature(saved.name, restored, saved.ownedIngredientIds));
    setGoalsOpen(false);
    setPlanDirty(false);
    setActiveTab("meals");
    setExpandedDays(new Set([1]));
    setPhase("plan_ready");
    setActionStatus(`${saved.name} is ready to review.`);
    window.requestAnimationFrame(() => document.getElementById("generated-plan-heading")?.focus());
  };

  const saveCurrentPlan = () => {
    if (!plan) return;
    const id = onSavePlan({
      id: activeSavedPlanId,
      name: saveName.trim() || plan.title,
      plan,
      ownedIngredientIds: [...ownedIngredientIds],
    });
    setActiveSavedPlanId(id);
    setSaveName(saveName.trim() || plan.title);
    setLastSavedSignature(savedPlanSignature(saveName.trim() || plan.title, plan, ownedIngredientIds));
    setActionStatus(`${saveName.trim() || plan.title} saved. You can reuse it next time.`);
  };

  const applyMealChange = (
    mealId: string,
    nextPlan: MealPlan,
    message: string,
    restoreMealFocus = true,
  ) => {
    if (!plan) return;
    const reviewed = preserveReviewedPlanIngredients(plan, nextPlan);
    setPlan(reviewed);
    setOwnedIngredientIds((current) => {
      const availableIds = new Set(reviewed.ingredients.map((ingredient) => ingredient.id));
      return new Set([...current].filter((id) => availableIds.has(id)));
    });
    setReplacementMealId(undefined);
    setMealMenuId(undefined);
    setActionStatus(message);
    if (restoreMealFocus) {
      window.requestAnimationFrame(() => document.getElementById(`meal-${mealId}`)?.focus());
    }
  };

  const removeMeal = (mealId: string, mealName: string) => {
    if (!plan) return;
    const index = plan.meals.findIndex((meal) => meal.id === mealId);
    const fallbackId = plan.meals[index + 1]?.id ?? plan.meals[index - 1]?.id;
    const day = plan.meals[index]?.day;
    applyMealChange(mealId, removePlanMeal(plan, mealId), `${mealName} removed from the plan.`, false);
    window.requestAnimationFrame(() => {
      (fallbackId ? document.getElementById(`meal-${fallbackId}`) : document.getElementById(`plan-day-toggle-${day}`))?.focus();
    });
  };

  const applyTargetedAdjustment = (
    mealId: string,
    adjustment: PlanMealAdjustment,
    successMessage: string,
  ) => {
    if (!plan) return;
    const next = adjustPlanMeal(plan, mealId, adjustment);
    const currentMeal = plan.meals.find((meal) => meal.id === mealId);
    const nextMeal = next.meals.find((meal) => meal.id === mealId);
    if (!currentMeal || !nextMeal || currentMeal.templateId === nextMeal.templateId) {
      setMealMenuId(undefined);
      setActionStatus(`This meal is already the strongest ${adjustment.replace("-", " ")} option in this plan.`);
      return;
    }
    applyMealChange(mealId, next, successMessage);
  };

  const dayGroups = useMemo(() => {
    const groups = new Map<number, MealPlan["meals"]>();
    for (const meal of plan?.meals ?? []) groups.set(meal.day, [...(groups.get(meal.day) ?? []), meal]);
    return [...groups.entries()];
  }, [plan?.meals]);

  const selectResultTabFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: PlannerResultTab,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab: PlannerResultTab = event.key === "Home"
      ? "meals"
      : event.key === "End"
        ? "groceries"
        : currentTab === "meals" ? "groceries" : "meals";
    setActiveTab(nextTab);
    setReplacementMealId(undefined);
    setMealMenuId(undefined);
    setPhase(nextTab === "groceries" ? "ingredient_review" : "plan_ready");
    window.requestAnimationFrame(() => document.getElementById(`plan-tab-${nextTab}`)?.focus());
  };

  const neededIngredientCount = plan?.ingredients.filter((ingredient) => !ownedIngredientIds.has(ingredient.id)).length ?? 0;
  const currentSavedSignature = plan ? savedPlanSignature(saveName, plan, ownedIngredientIds) : undefined;
  const planSaved = Boolean(activeSavedPlanId && lastSavedSignature === currentSavedSignature);
  const expensiveMeals = useMemo(() => [...(plan?.meals ?? [])]
    .sort((left, right) => (right.estimatedCostPerServing * right.servings) - (left.estimatedCostPerServing * left.servings))
    .slice(0, 3), [plan?.meals]);

  const reviewMealForBudget = (meal: PlannedMeal) => {
    setActiveTab("meals");
    setPhase("plan_ready");
    setExpandedDays((current) => new Set([...current, meal.day]));
    setMealMenuId(meal.id);
    setReplacementMealId(undefined);
    setActionStatus(`${meal.name} is ready for a shopper-approved lower-cost change.`);
    window.requestAnimationFrame(() => document.getElementById(`meal-${meal.id}`)?.focus());
  };

  return (
    <div className={styles.planWorkspace} data-phase={phase}>
      {goalsOpen || !plan ? <form className={styles.planGoalCard} onSubmit={submit} aria-busy={phase === "generating"}>
        <div className={styles.planCardIntro}>
          <span className={styles.planIcon}><WandSparkles aria-hidden="true" /></span>
          <div>
            <span>Goal</span>
            <h2>What should Cartiva build?</h2>
            <p>Describe the outcome. Every detail is optional—you can use the fields, write naturally, or combine both.</p>
          </div>
        </div>

        {savedPlans.length ? (
          <div className={styles.savedPlanPicker} aria-label="Saved meal plans">
            <span>Reuse a saved plan</span>
            <div>
              {savedPlans.map((saved, index) => (
                <button type="button" key={saved.id} onClick={() => loadSavedPlan(saved)} disabled={phase === "generating"}>
                  {index === 0 ? "Use last week’s plan" : "Open"}: {saved.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.planFieldGrid}>
          <label>
            <span>Daily calories <small>optional</small></span>
            <input type="number" min="900" max="5000" inputMode="numeric" value={fields.calories} onChange={(event) => setField("calories", event.target.value)} placeholder="1,800" disabled={phase === "generating"} />
          </label>
          <label>
            <span>Protein goal <small>optional</small></span>
            <div className={styles.inputWithSuffix}>
              <input type="number" min="20" max="350" inputMode="numeric" value={fields.protein} onChange={(event) => setField("protein", event.target.value)} placeholder="160" disabled={phase === "generating"} />
              <span>g / day</span>
            </div>
          </label>
          <label>
            <span>Budget <small>optional</small></span>
            <div className={styles.inputWithPrefix}>
              <span>$</span>
              <input type="number" min="10" max="2000" inputMode="decimal" value={fields.budget} onChange={(event) => setField("budget", event.target.value)} placeholder="80" disabled={phase === "generating"} />
            </div>
          </label>
          <label>
            <span>Days <small>optional</small></span>
            <input type="number" min="1" max="7" inputMode="numeric" value={fields.days} onChange={(event) => setField("days", event.target.value)} placeholder="5" disabled={phase === "generating"} />
          </label>
          <label>
            <span>People <small>optional</small></span>
            <input type="number" min="1" max="8" inputMode="numeric" value={fields.people} onChange={(event) => setField("people", event.target.value)} placeholder="1" disabled={phase === "generating"} />
          </label>
        </div>

        <label className={styles.planPromptField}>
          <span>Anything else? <small>optional</small></span>
          <textarea
            rows={3}
            maxLength={500}
            value={fields.notes}
            onChange={(event) => setField("notes", event.target.value)}
            placeholder="High protein, easy meals, no fish, I like chicken and ground beef"
            disabled={phase === "generating"}
          />
        </label>
        <p className={styles.planSafetyNote}>For allergies or medical restrictions, review every ingredient and retailer product label yourself.</p>

        <div className={styles.examplePrompts}>
          <span>Try an example</span>
          <div>
            {plannerExamplePrompts.map((example) => (
              <button type="button" key={example.label} disabled={phase === "generating"} onClick={() => {
                setFields(fieldsFromDraft(example.draft));
                if (plan) setPlanDirty(true);
              }}>
                {example.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.planFormActions}>
          <button type="submit" className={styles.planPrimaryButton} disabled={phase === "generating"}>
            {phase === "generating" ? <RefreshCw className={styles.spin} aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {phase === "generating" ? "Building meals around your goals…" : plan ? "Regenerate plan" : "Build my plan"}
          </button>
          {plan ? (
            <button type="button" className={styles.planQuietButton} onClick={() => {
              generationRequestRef.current += 1;
              setFields(fieldsFromPlan(plan));
              setPlanDirty(false);
              setGoalsOpen(false);
              setPhase(activeTab === "groceries" ? "ingredient_review" : "plan_ready");
              window.requestAnimationFrame(() => document.getElementById("edit-plan-goals")?.focus());
            }}>Cancel</button>
          ) : null}
        </div>
        <p className={styles.reviewFirstNote}>You&apos;ll review the meals and ingredients before anything is added to your list.</p>
        {generationError ? (
          <div className={styles.planGenerationError} role="alert">
            <span>{generationError}</span>
            <button type="button" onClick={() => makePlan()}>Try again</button>
          </div>
        ) : null}
      </form> : null}

      {plan && !goalsOpen ? (
        <section className={styles.planGoalSummary} aria-labelledby="current-plan-goal-heading">
          <div>
            <span>Your plan</span>
            <h2 id="current-plan-goal-heading">{planGoalSummary(plan)}</h2>
            <p>{plan.goal.originalPrompt || "A practical meal plan ready for review."}</p>
          </div>
          <div className={styles.planGoalActions}>
            <button id="edit-plan-goals" type="button" onClick={() => { setGoalsOpen(true); setPhase("plan_editing"); }}>
              <Pencil aria-hidden="true" /> Edit goals
            </button>
            <label className={styles.planSaveName}>
              <span className={styles.srOnly}>Saved plan name</span>
              <input value={saveName} maxLength={80} onChange={(event) => setSaveName(event.target.value)} aria-label="Saved plan name" />
            </label>
            <button type="button" onClick={saveCurrentPlan} data-saved={planSaved} disabled={planSaved}>
              {planSaved ? <Check aria-hidden="true" /> : <Save aria-hidden="true" />}
              {planSaved ? "Saved" : activeSavedPlanId ? "Save changes" : "Save plan"}
            </button>
          </div>
        </section>
      ) : null}

      {plan && !goalsOpen ? (
        <section className={styles.planResults} aria-labelledby="generated-plan-heading">
          <p className={styles.srOnly} role="status">Plan ready: {plan.meals.length} meals and {plan.ingredients.length} ingredients.</p>
          <header className={styles.planOverview}>
            <div className={styles.planResultHeader}>
              <div>
                <span>Goal → plan → groceries</span>
                <h2 id="generated-plan-heading" tabIndex={-1}>{plan.title}</h2>
              </div>
              <span className={styles.estimateBadge}>Estimated</span>
            </div>
            <div className={styles.planSummaryGrid} aria-label="Plan summary">
              <span><strong>{plan.goal.days.value}</strong><small>days</small></span>
              <span><strong>{plan.meals.length}</strong><small>meals</small></span>
              <span><strong>{neededIngredientCount}</strong><small>groceries</small></span>
              <span><strong>~{plan.estimatedDailyCalories.toLocaleString()}</strong><small>cal/day</small></span>
              <span><strong>~{plan.estimatedDailyProteinGrams}g</strong><small>protein/day</small></span>
              {plan.goal.budgetDollars ? <span><strong>${plan.goal.budgetDollars.value}</strong><small>planned budget</small></span> : null}
            </div>
          </header>

          <div className={styles.planResultTabs} role="tablist" aria-label="Plan results">
            <button
              id="plan-tab-meals"
              type="button"
              role="tab"
              aria-selected={activeTab === "meals"}
              aria-controls="plan-panel-meals"
              tabIndex={activeTab === "meals" ? 0 : -1}
              data-active={activeTab === "meals"}
              onClick={() => { setActiveTab("meals"); setPhase("plan_ready"); setReplacementMealId(undefined); setMealMenuId(undefined); }}
              onKeyDown={(event) => selectResultTabFromKeyboard(event, "meals")}
            >Meals <span>{plan.meals.length}</span></button>
            <button
              id="plan-tab-groceries"
              type="button"
              role="tab"
              aria-selected={activeTab === "groceries"}
              aria-controls="plan-panel-groceries"
              tabIndex={activeTab === "groceries" ? 0 : -1}
              data-active={activeTab === "groceries"}
              onClick={() => { setActiveTab("groceries"); setPhase("ingredient_review"); setReplacementMealId(undefined); setMealMenuId(undefined); }}
              onKeyDown={(event) => selectResultTabFromKeyboard(event, "groceries")}
            >Grocery list <span>{neededIngredientCount}</span></button>
          </div>

          <p className={styles.srOnly} role="status" aria-live="polite">{actionStatus}</p>
          <div className={styles.planResultScroll} data-tab={activeTab} role="region" aria-label={`${activeTab === "meals" ? "Meals" : "Grocery list"} for ${plan.title}`} tabIndex={0}>
            {basketOverageCents && committedPlanId === plan.id ? (
              <section className={styles.planBudgetReview} aria-labelledby="lower-basket-plan-heading">
                <div>
                  <span>Real Kroger basket</span>
                  <h3 id="lower-basket-plan-heading" tabIndex={-1}>${(basketOverageCents / 100).toFixed(2)} over the planning budget</h3>
                  <p>Cartiva has not changed anything. Review the highest planning-cost meals and approve any cheaper option you want.</p>
                </div>
                <div aria-label="Meals to review for a lower basket">
                  {expensiveMeals.map((meal) => (
                    <button type="button" key={`budget-${meal.id}`} onClick={() => reviewMealForBudget(meal)}>
                      Review {meal.name}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <section id="plan-panel-meals" className={styles.mealPlanPanel} role="tabpanel" aria-labelledby="plan-tab-meals" hidden={activeTab !== "meals"}>
                <div className={styles.planEstimateNotice}>
                  <strong>Nutrition is estimated, not guaranteed.</strong>
                  <strong>Average per day: ~{plan.estimatedDailyCalories.toLocaleString()} calories · ~{plan.estimatedDailyProteinGrams}g protein</strong>
                  <p>Estimated from typical portions. Brand, serving size, preparation, and substitutions change nutrition.</p>
                  {plan.budgetIntent ? (
                    <p><strong>Designed around your ${plan.budgetIntent.targetDollars} budget.</strong> The actual total comes from Cartiva&apos;s retailer comparison after products are matched.</p>
                  ) : null}
                </div>

                {plan.goalWarnings?.map((warning) => <p className={styles.planWarning} role="status" key={warning}>{warning}</p>)}

                {plan.goal.preferences.length || plan.goal.exclusions.length ? (
                  <div className={styles.understoodConstraints}>
                    <strong>Understood</strong>
                    <div>
                      {plan.goal.preferences.map((preference) => <span key={preference}>{preference.replace(/-/g, " ")}</span>)}
                      {plan.goal.exclusions.map((exclusion) => <span key={`no-${exclusion}`}>no {exclusion.replace(/-/g, " ")}</span>)}
                    </div>
                    {plan.goal.exclusions.length ? <p>Dietary filters are planning aids. Check product labels yourself for allergies or medical restrictions.</p> : null}
                  </div>
                ) : null}

                {dayGroups.length ? (
                  <div className={styles.mealDays}>
                    {dayGroups.map(([day, meals]) => {
                      const expanded = expandedDays.has(day);
                      const dayCalories = meals.reduce((total, meal) => total + meal.estimatedCaloriesPerServing, 0);
                      const dayProtein = meals.reduce((total, meal) => total + meal.estimatedProteinGramsPerServing, 0);
                      return <section className={styles.mealDay} key={day}>
                        <h3>
                          <button
                            id={`plan-day-toggle-${day}`}
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={`plan-day-${day}`}
                            onClick={() => {
                              const next = new Set(expandedDays);
                              if (expanded) next.delete(day);
                              else next.add(day);
                              setExpandedDays(next);
                              setReplacementMealId(undefined);
                              setMealMenuId(undefined);
                            }}
                          >
                            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                            <span>Day {day}</span>
                            <small>~{dayCalories.toLocaleString()} cal · ~{dayProtein}g protein</small>
                          </button>
                        </h3>
                        {expanded ? <div id={`plan-day-${day}`}>
                          {meals.map((meal) => {
                            const alternatives = replacementMealId === meal.id ? replacementOptions(plan, meal.id) : [];
                            return <article className={styles.mealCard} key={meal.id} id={`meal-${meal.id}`} tabIndex={-1}>
                        <div className={styles.mealCardTop}>
                          <span className={styles.mealSlot}>{meal.slot}</span>
                          <div className={styles.mealCardActions}>
                            <button type="button" onClick={() => { setReplacementMealId(replacementMealId === meal.id ? undefined : meal.id); setMealMenuId(undefined); }} aria-expanded={replacementMealId === meal.id} aria-controls={`replacement-${meal.id}`} aria-label={`Replace ${meal.name}`}>
                              Replace
                            </button>
                            <button type="button" onClick={() => { setMealMenuId(mealMenuId === meal.id ? undefined : meal.id); setReplacementMealId(undefined); }} aria-expanded={mealMenuId === meal.id} aria-controls={`meal-actions-${meal.id}`} aria-label={`More actions for ${meal.name}`}>
                              <MoreHorizontal aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <h4>{meal.name}</h4>
                        <p className={styles.mealNutrition}>≈ {meal.estimatedCaloriesPerServing} cal · {meal.estimatedProteinGramsPerServing}g protein</p>
                        <p className={styles.mealIngredients}>{meal.ingredients.map((ingredient) => ingredient.name).join(" · ")}</p>
                        {replacementMealId === meal.id ? (
                          <div className={styles.mealAlternatives} id={`replacement-${meal.id}`} role="group" aria-label={`Replacement choices for ${meal.name}`}>
                            <strong>Choose a replacement</strong>
                            {alternatives.map((option) => (
                              <button type="button" key={`${meal.id}-${option.step}`} onClick={() => applyMealChange(meal.id, replacePlanMeal(plan, meal.id, option.step), `${meal.name} replaced with ${option.name}.`)}>
                                <span>{option.name}</span><small>{option.calories} cal · {option.protein}g protein</small>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {mealMenuId === meal.id ? (
                          <div className={styles.mealActionMenu} id={`meal-actions-${meal.id}`} role="group" aria-label={`Adjust ${meal.name}`}>
                            <button type="button" onClick={() => applyTargetedAdjustment(meal.id, "cheaper", `${meal.name} changed to a lower-cost planning option. Actual savings require retailer pricing.`)}>Make this cheaper</button>
                            <button type="button" onClick={() => applyTargetedAdjustment(meal.id, "higher-protein", `${meal.name} changed to a higher-protein option.`)}>More protein</button>
                            <button type="button" onClick={() => applyTargetedAdjustment(meal.id, "lower-calorie", `${meal.name} changed to a lower-calorie option.`)}>Lower calories</button>
                            <button type="button" onClick={() => removeMeal(meal.id, meal.name)}><Trash2 aria-hidden="true" /> Remove meal</button>
                          </div>
                        ) : null}
                        <div className={styles.servingControl}>
                          <span>Servings</span>
                          <div>
                            <button type="button" onClick={() => applyMealChange(meal.id, updatePlanMealServings(plan, meal.id, meal.servings - 1), `Servings for ${meal.name} changed to ${Math.max(1, meal.servings - 1)}.`, false)} disabled={meal.servings <= 1} aria-label={`Decrease servings for ${meal.name}`}><Minus aria-hidden="true" /></button>
                            <strong>{meal.servings}</strong>
                            <button type="button" onClick={() => applyMealChange(meal.id, updatePlanMealServings(plan, meal.id, meal.servings + 1), `Servings for ${meal.name} changed to ${Math.min(12, meal.servings + 1)}.`, false)} disabled={meal.servings >= 12} aria-label={`Increase servings for ${meal.name}`}><Plus aria-hidden="true" /></button>
                          </div>
                        </div>
                              </article>;
                          })}
                        </div> : null}
                      </section>;
                    })}
                  </div>
                ) : (
                  <div className={styles.noMealsState}>
                    <ChefHat aria-hidden="true" />
                    <h3>No meals left in this draft</h3>
                    <p>Edit your goals and rebuild the plan to start fresh.</p>
                  </div>
                )}
            </section>
            <div id="plan-panel-groceries" role="tabpanel" aria-labelledby="plan-tab-groceries" hidden={activeTab !== "groceries"}>
                <IngredientReview
                  ingredients={plan.ingredients}
                  ownedIngredientIds={ownedIngredientIds}
                  omittedIngredientCount={plan.omittedIngredientCount}
                  availableIngredientSlots={committedPlanId === plan.id
                    ? replacementIngredientSlots ?? MAX_CARTIVA_INGREDIENTS
                    : availableIngredientSlots}
                  heading="Your consolidated list"
                  helper="Duplicates are combined. Edit amounts, replace ingredients, or mark pantry items you already have."
                  onIngredients={(ingredients) => setPlan((current) => current ? { ...current, ingredients } : current)}
                  onOwnedIngredientIds={setOwnedIngredientIds}
                  onCommit={(neededIngredients) => onCommit(neededIngredients, plan.title, plan)}
                  commitLabel={(count) => committedPlanId === plan.id
                    ? count === 0
                      ? "Remove this plan’s groceries from my list"
                      : `Update ${count} plan ${count === 1 ? "grocery" : "groceries"} in my list`
                    : `Add ${count} ${count === 1 ? "ingredient" : "ingredients"} to my list`}
                  emptyCopy="Add or replace a meal to rebuild the ingredient list."
                  commitBlockedReason={planDirty ? "Your goal changed. Rebuild the plan before adding these ingredients." : undefined}
                  allowEmptyCommit={committedPlanId === plan.id}
                  contained
                />
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

interface CartivaRecipeImporterProps {
  availableIngredientSlots: number;
  onCommit: (ingredients: ConsolidatedIngredient[], suggestedName: string) => void;
}

export function CartivaRecipeImporter({ availableIngredientSlots, onCommit }: CartivaRecipeImporterProps) {
  const [recipeText, setRecipeText] = useState("");
  const [recipe, setRecipe] = useState<RecipeImport>();
  const [error, setError] = useState("");
  const [ownedIngredientIds, setOwnedIngredientIds] = useState<Set<string>>(() => new Set());

  const extractRecipe = (event: FormEvent) => {
    event.preventDefault();
    const next = parseRecipeText(recipeText);
    if (!next.ingredients.length) {
      setRecipe(undefined);
      setError("We couldn’t find a clear ingredient list. Include the ingredient amounts or an “Ingredients” heading and try again.");
      return;
    }
    setError("");
    setOwnedIngredientIds(new Set());
    setRecipe(next);
  };

  return (
    <div className={styles.recipeWorkspace}>
      <form className={styles.recipePasteCard} onSubmit={extractRecipe}>
        <div className={styles.planCardIntro}>
          <span className={styles.planIcon}><ClipboardPaste aria-hidden="true" /></span>
          <div>
            <span>Recipe</span>
            <h2>Paste any recipe</h2>
            <p>Cartiva will pull out the ingredients and servings. You&apos;ll review everything before it joins your grocery list.</p>
          </div>
        </div>
        <label className={styles.recipeTextField}>
          <span>Recipe text or ingredients</span>
          <textarea
            rows={12}
            value={recipeText}
            onChange={(event) => {
              setRecipeText(event.target.value);
              setRecipe(undefined);
              setError("");
            }}
            placeholder={"Chicken taco bowls\nServes 4\n\nIngredients\n1.5 lb chicken breast\n2 cups rice\n1 can black beans\n1 cup salsa\n8 oz shredded cheese\n\nDirections…"}
          />
        </label>
        {error ? <p className={styles.recipeError} role="alert">{error}</p> : null}
        <button type="submit" className={styles.planPrimaryButton} disabled={!recipeText.trim()}>
          <WandSparkles aria-hidden="true" />
          Find ingredients
        </button>
      </form>

      {recipe ? (
        <div className={styles.recipeResult}>
          <p className={styles.srOnly} role="status">Recipe ready: {recipe.ingredients.length} ingredients found.</p>
          <div className={styles.recipeFoundBanner}>
            <span><ListChecks aria-hidden="true" /></span>
            <div>
              <strong>We found {recipe.ingredients.length} {recipe.ingredients.length === 1 ? "ingredient" : "ingredients"}</strong>
              <p>{recipe.title}</p>
            </div>
            <button type="button" onClick={() => { setRecipe(undefined); setRecipeText(""); setOwnedIngredientIds(new Set()); }} aria-label="Clear imported recipe"><X aria-hidden="true" /></button>
          </div>
          <IngredientReview
            ingredients={recipe.ingredients}
            ownedIngredientIds={ownedIngredientIds}
            omittedIngredientCount={recipe.omittedIngredientCount}
            availableIngredientSlots={availableIngredientSlots}
            heading="Review recipe ingredients"
            helper="Amounts are recipe estimates. Cartiva will match practical retailer products after you add them."
            onIngredients={(ingredients) => setRecipe((current) => current ? { ...current, ingredients } : current)}
            onOwnedIngredientIds={setOwnedIngredientIds}
            onCommit={(neededIngredients) => onCommit(neededIngredients, recipe.title)}
            commitLabel={(count) => `Add ${count} ${count === 1 ? "ingredient" : "ingredients"} to my list`}
            emptyCopy="No ingredients remain. Extract the recipe again to start over."
            commitBlockedReason={!recipe.servingsConfirmed ? "Confirm the recipe servings before adding these ingredients." : undefined}
          >
            <div className={styles.recipeServings}>
              <span>{recipe.servingsConfirmed ? "Recipe servings" : "How many servings?"}</span>
              <div>
                <button type="button" onClick={() => setRecipe((current) => current ? scaleRecipeImport(current, current.servings - 1) : current)} disabled={recipe.servings <= 1} aria-label="Decrease recipe servings"><Minus aria-hidden="true" /></button>
                <strong>{recipe.servings}</strong>
                <button type="button" onClick={() => setRecipe((current) => current ? scaleRecipeImport(current, current.servings + 1) : current)} disabled={recipe.servings >= 24} aria-label="Increase recipe servings"><Plus aria-hidden="true" /></button>
              </div>
              {!recipe.servingsConfirmed ? (
                <button type="button" className={styles.confirmServingsButton} onClick={() => setRecipe((current) => current ? confirmRecipeServings(current) : current)}>
                  Use {recipe.servings} servings
                </button>
              ) : null}
            </div>
          </IngredientReview>
        </div>
      ) : null}
    </div>
  );
}
