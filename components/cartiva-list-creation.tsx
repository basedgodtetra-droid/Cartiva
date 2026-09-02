"use client";

import { useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChefHat,
  ClipboardPaste,
  ListChecks,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  formatIngredientAmount,
  generateMealPlan,
  parseRecipeText,
  plannerExamplePrompts,
  removePlanMeal,
  replacePlanMeal,
  preserveReviewedPlanIngredients,
  scaleRecipeImport,
  updateConsolidatedIngredient,
  updatePlanMealServings,
  type ConsolidatedIngredient,
  type MealPlan,
  type PlannerGoalDraft,
  type RecipeImport,
} from "@/lib/cartiva-planning";
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
  omittedIngredientCount: number;
  availableIngredientSlots: number;
  heading: string;
  helper: string;
  onIngredients: (ingredients: ConsolidatedIngredient[]) => void;
  onCommit: () => void;
  commitLabel: string;
  emptyCopy: string;
  commitBlockedReason?: string;
  children?: ReactNode;
}

function IngredientReview({
  ingredients,
  omittedIngredientCount,
  availableIngredientSlots,
  heading,
  helper,
  onIngredients,
  onCommit,
  commitLabel,
  emptyCopy,
  commitBlockedReason,
  children,
}: IngredientReviewProps) {
  const [editingId, setEditingId] = useState<string>();
  const [editingName, setEditingName] = useState("");

  const commitEdit = (ingredientId: string) => {
    onIngredients(updateConsolidatedIngredient(ingredients, ingredientId, editingName));
    setEditingId(undefined);
    setEditingName("");
  };
  const overAvailableLimit = ingredients.length > availableIngredientSlots;

  return (
    <section className={styles.ingredientPanel} aria-labelledby={`${heading.replace(/\s+/g, "-").toLowerCase()}-heading`}>
      <div className={styles.planSectionHeading}>
        <div>
          <span>Ingredients</span>
          <h2 id={`${heading.replace(/\s+/g, "-").toLowerCase()}-heading`}>{heading}</h2>
          <p>{helper}</p>
        </div>
        <strong>{ingredients.length}</strong>
      </div>

      {children}

      {ingredients.length ? (
        <div className={styles.ingredientList}>
          {ingredients.map((ingredient) => (
            <div className={styles.ingredientRow} key={ingredient.id}>
              <span className={styles.ingredientCheck}><Check aria-hidden="true" /></span>
              <div className={styles.ingredientCopy}>
                {editingId === ingredient.id ? (
                  <input
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitEdit(ingredient.id);
                      if (event.key === "Escape") setEditingId(undefined);
                    }}
                    onBlur={() => commitEdit(ingredient.id)}
                    aria-label={`Change ${ingredient.name}`}
                    autoFocus
                  />
                ) : (
                  <>
                    <strong>{ingredient.name}</strong>
                    <span>{formatIngredientAmount(ingredient)}</span>
                  </>
                )}
              </div>
              <div className={styles.ingredientActions}>
                <button
                  type="button"
                  aria-label={`Change ${ingredient.name}`}
                  onClick={() => {
                    setEditingId(ingredient.id);
                    setEditingName(ingredient.name);
                  }}
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${ingredient.name}`}
                  onClick={() => onIngredients(ingredients.filter((item) => item.id !== ingredient.id))}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : <p className={styles.ingredientEmpty}>{emptyCopy}</p>}

      {omittedIngredientCount ? (
        <p className={styles.planWarning} role="status">
          {omittedIngredientCount} extra {omittedIngredientCount === 1 ? "ingredient is" : "ingredients are"} outside Cartiva&apos;s 24-item list limit. Remove or combine ingredients before adding this plan.
        </p>
      ) : null}
      {overAvailableLimit ? (
        <p className={styles.planWarning} role="status">
          Your current Cartiva list has room for {availableIngredientSlots} more {availableIngredientSlots === 1 ? "ingredient" : "ingredients"}. Remove {ingredients.length - availableIngredientSlots} here, or start a new list, before adding this draft.
        </p>
      ) : null}
      {commitBlockedReason ? <p className={styles.planWarning} role="status">{commitBlockedReason}</p> : null}

      <div className={styles.ingredientCommit}>
        <button
          type="button"
          className={styles.planPrimaryButton}
          onClick={onCommit}
          disabled={!ingredients.length || Boolean(omittedIngredientCount) || overAvailableLimit || Boolean(commitBlockedReason)}
        >
          {commitLabel}
          <ArrowRight aria-hidden="true" />
        </button>
        <p>Next, Cartiva will ask any needed product questions before comparing retailers.</p>
      </div>
    </section>
  );
}

interface CartivaPlanBuilderProps {
  availableIngredientSlots: number;
  onCommit: (ingredients: ConsolidatedIngredient[], suggestedName: string) => void;
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

export function CartivaPlanBuilder({ availableIngredientSlots, onCommit }: CartivaPlanBuilderProps) {
  const [fields, setFields] = useState<PlanFields>(() => fieldsFromDraft({ notes: "" }));
  const [plan, setPlan] = useState<MealPlan>();
  const [generationNote, setGenerationNote] = useState("");
  const [planDirty, setPlanDirty] = useState(false);

  const setField = (field: keyof PlanFields, value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
    if (plan) setPlanDirty(true);
  };

  const makePlan = (draft = draftFromFields(fields), note = "") => {
    const next = generateMealPlan(draft);
    setPlan(next);
    setFields(fieldsFromDraft(draft));
    setGenerationNote(note);
    setPlanDirty(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    makePlan();
  };

  const adjustPlan = (adjustment: "protein" | "cheaper" | "calories") => {
    const current = draftFromFields(fields);
    if (adjustment === "protein") {
      const proteinGrams = Math.min(350, (current.proteinGrams ?? plan?.goal.proteinGrams?.value ?? 120) + 20);
      makePlan({ ...current, proteinGrams }, `Protein goal increased to ${proteinGrams}g per day.`);
      return;
    }
    if (adjustment === "calories") {
      const dailyCalories = Math.max(900, (current.dailyCalories ?? plan?.goal.dailyCalories?.value ?? 2000) - 200);
      makePlan({ ...current, dailyCalories }, `Calorie target lowered to ${dailyCalories} per day.`);
      return;
    }
    const notes = `${current.notes} cheap budget-friendly ingredients`.replace(/\s+/g, " ").trim();
    makePlan({ ...current, notes }, "Rebuilt with lower-cost meal templates.");
  };

  const dayGroups = useMemo(() => {
    const groups = new Map<number, MealPlan["meals"]>();
    for (const meal of plan?.meals ?? []) groups.set(meal.day, [...(groups.get(meal.day) ?? []), meal]);
    return [...groups.entries()];
  }, [plan?.meals]);

  return (
    <div className={styles.planWorkspace}>
      <form className={styles.planGoalCard} onSubmit={submit}>
        <div className={styles.planCardIntro}>
          <span className={styles.planIcon}><WandSparkles aria-hidden="true" /></span>
          <div>
            <span>Goal</span>
            <h2>What should Cartiva build?</h2>
            <p>Describe the outcome. Every detail is optional—you can use the fields, write naturally, or combine both.</p>
          </div>
        </div>

        <div className={styles.planFieldGrid}>
          <label>
            <span>Daily calories <small>optional</small></span>
            <input type="number" min="900" max="5000" inputMode="numeric" value={fields.calories} onChange={(event) => setField("calories", event.target.value)} placeholder="1,800" />
          </label>
          <label>
            <span>Protein goal <small>optional</small></span>
            <div className={styles.inputWithSuffix}>
              <input type="number" min="20" max="350" inputMode="numeric" value={fields.protein} onChange={(event) => setField("protein", event.target.value)} placeholder="160" />
              <span>g / day</span>
            </div>
          </label>
          <label>
            <span>Budget <small>optional</small></span>
            <div className={styles.inputWithPrefix}>
              <span>$</span>
              <input type="number" min="10" max="2000" inputMode="decimal" value={fields.budget} onChange={(event) => setField("budget", event.target.value)} placeholder="80" />
            </div>
          </label>
          <label>
            <span>Days <small>optional</small></span>
            <input type="number" min="1" max="7" inputMode="numeric" value={fields.days} onChange={(event) => setField("days", event.target.value)} placeholder="5" />
          </label>
          <label>
            <span>People <small>optional</small></span>
            <input type="number" min="1" max="8" inputMode="numeric" value={fields.people} onChange={(event) => setField("people", event.target.value)} placeholder="1" />
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
          />
        </label>
        <p className={styles.planSafetyNote}>For allergies or medical restrictions, review every ingredient and retailer product label yourself.</p>

        <div className={styles.examplePrompts}>
          <span>Try an example</span>
          <div>
            {plannerExamplePrompts.map((example) => (
              <button type="button" key={example.label} onClick={() => {
                setFields(fieldsFromDraft(example.draft));
                if (plan) setPlanDirty(true);
              }}>
                {example.label}
              </button>
            ))}
          </div>
        </div>

        <button type="submit" className={styles.planPrimaryButton}>
          <Sparkles aria-hidden="true" />
          {plan ? "Rebuild my plan" : "Build my plan"}
        </button>
        <p className={styles.reviewFirstNote}>You&apos;ll review the meals and ingredients before anything is added to your list.</p>
      </form>

      {plan ? (
        <div className={styles.planResults}>
          <p className={styles.srOnly} role="status">Plan ready: {plan.meals.length} meals and {plan.ingredients.length} ingredients.</p>
          <section className={styles.mealPlanPanel} aria-labelledby="generated-plan-heading">
            <div className={styles.planResultHeader}>
              <div>
                <span>Plan</span>
                <h2 id="generated-plan-heading">{plan.title}</h2>
                <p>
                  {plan.meals.length} {plan.meals.length === 1 ? "meal" : "meals"} for {plan.goal.people.value} {plan.goal.people.value === 1 ? "person" : "people"}
                </p>
              </div>
              <span className={styles.estimateBadge}>Estimates</span>
            </div>

            <div className={styles.planEstimateNotice}>
              <strong>About {plan.estimatedDailyCalories.toLocaleString()} cal · {plan.estimatedDailyProteinGrams}g protein per person/day</strong>
              <p>Nutrition is estimated from typical portions, not a medical or exact nutrition calculation.</p>
              {plan.budgetIntent ? (
                plan.budgetIntent.likelyWithinTarget ? (
                  <p><strong>Designed around your ${plan.budgetIntent.targetDollars} budget.</strong> The actual total comes from Cartiva&apos;s matched retailer products.</p>
                ) : (
                  <p><strong>Your ${plan.budgetIntent.targetDollars} target may be too tight for this draft.</strong> Cartiva favored lower-cost meals, but only matched retailer products can confirm the total.</p>
                )
              ) : null}
            </div>

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

            <div className={styles.planAdjustments} aria-label="Adjust this plan">
              <button type="button" onClick={() => adjustPlan("protein")}><Plus aria-hidden="true" /> Increase protein</button>
              {plan.goal.dailyCalories ? <button type="button" onClick={() => adjustPlan("calories")}><Minus aria-hidden="true" /> Lower calories</button> : null}
              <button type="button" onClick={() => adjustPlan("cheaper")}><RefreshCw aria-hidden="true" /> Use cheaper ingredients</button>
            </div>
            {generationNote ? <p className={styles.generationNote} role="status">{generationNote}</p> : null}

            {dayGroups.length ? (
              <div className={styles.mealDays}>
                {dayGroups.map(([day, meals]) => (
                  <section className={styles.mealDay} key={day}>
                    <h3>Day {day}</h3>
                    {meals.map((meal) => (
                      <article className={styles.mealCard} key={meal.id}>
                        <div className={styles.mealCardTop}>
                          <span className={styles.mealSlot}>{meal.slot}</span>
                          <div className={styles.mealCardActions}>
                            <button type="button" onClick={() => setPlan((current) => current ? preserveReviewedPlanIngredients(current, replacePlanMeal(current, meal.id, 1)) : current)} aria-label={`Replace ${meal.name}`}>
                              Replace
                            </button>
                            <button type="button" onClick={() => setPlan((current) => current ? preserveReviewedPlanIngredients(current, replacePlanMeal(current, meal.id, 2)) : current)} aria-label={`Regenerate ${meal.name}`}>
                              <RefreshCw aria-hidden="true" />
                            </button>
                            <button type="button" onClick={() => setPlan((current) => current ? preserveReviewedPlanIngredients(current, removePlanMeal(current, meal.id)) : current)} aria-label={`Remove ${meal.name}`}>
                              <Trash2 aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <h4>{meal.name}</h4>
                        <p className={styles.mealNutrition}>≈ {meal.estimatedCaloriesPerServing} cal · {meal.estimatedProteinGramsPerServing}g protein</p>
                        <p className={styles.mealIngredients}>{meal.ingredients.map((ingredient) => ingredient.name).join(" · ")}</p>
                        <div className={styles.servingControl}>
                          <span>Servings</span>
                          <div>
                            <button type="button" onClick={() => setPlan((current) => current ? preserveReviewedPlanIngredients(current, updatePlanMealServings(current, meal.id, meal.servings - 1)) : current)} disabled={meal.servings <= 1} aria-label={`Decrease servings for ${meal.name}`}><Minus aria-hidden="true" /></button>
                            <strong>{meal.servings}</strong>
                            <button type="button" onClick={() => setPlan((current) => current ? preserveReviewedPlanIngredients(current, updatePlanMealServings(current, meal.id, meal.servings + 1)) : current)} disabled={meal.servings >= 12} aria-label={`Increase servings for ${meal.name}`}><Plus aria-hidden="true" /></button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </section>
                ))}
              </div>
            ) : (
              <div className={styles.noMealsState}>
                <ChefHat aria-hidden="true" />
                <h3>No meals left in this draft</h3>
                <p>Rebuild the plan above to start fresh.</p>
              </div>
            )}
          </section>

          <IngredientReview
            ingredients={plan.ingredients}
            omittedIngredientCount={plan.omittedIngredientCount}
            availableIngredientSlots={availableIngredientSlots}
            heading="Your consolidated list"
            helper="Duplicates are combined. Rename or remove ingredients before they enter Cartiva."
            onIngredients={(ingredients) => setPlan((current) => current ? { ...current, ingredients } : current)}
            onCommit={() => onCommit(plan.ingredients, plan.title)}
            commitLabel={`Add ${plan.ingredients.length} ${plan.ingredients.length === 1 ? "ingredient" : "ingredients"} to my list`}
            emptyCopy="Add or regenerate a meal to rebuild the ingredient list."
            commitBlockedReason={planDirty ? "Your goal changed. Rebuild the plan before adding these ingredients." : undefined}
          />
        </div>
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

  const extractRecipe = (event: FormEvent) => {
    event.preventDefault();
    const next = parseRecipeText(recipeText);
    if (!next.ingredients.length) {
      setRecipe(undefined);
      setError("We couldn’t find a clear ingredient list. Include the ingredient amounts or an “Ingredients” heading and try again.");
      return;
    }
    setError("");
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
            <button type="button" onClick={() => { setRecipe(undefined); setRecipeText(""); }} aria-label="Clear imported recipe"><X aria-hidden="true" /></button>
          </div>
          <IngredientReview
            ingredients={recipe.ingredients}
            omittedIngredientCount={recipe.omittedIngredientCount}
            availableIngredientSlots={availableIngredientSlots}
            heading="Review recipe ingredients"
            helper="Amounts are recipe estimates. Cartiva will match practical retailer products after you add them."
            onIngredients={(ingredients) => setRecipe((current) => current ? { ...current, ingredients } : current)}
            onCommit={() => onCommit(recipe.ingredients, recipe.title)}
            commitLabel={`Add ${recipe.ingredients.length} ${recipe.ingredients.length === 1 ? "ingredient" : "ingredients"} to my list`}
            emptyCopy="No ingredients remain. Extract the recipe again to start over."
          >
            <div className={styles.recipeServings}>
              <span>Adjust recipe servings</span>
              <div>
                <button type="button" onClick={() => setRecipe((current) => current ? scaleRecipeImport(current, current.servings - 1) : current)} disabled={recipe.servings <= 1} aria-label="Decrease recipe servings"><Minus aria-hidden="true" /></button>
                <strong>{recipe.servings}</strong>
                <button type="button" onClick={() => setRecipe((current) => current ? scaleRecipeImport(current, current.servings + 1) : current)} disabled={recipe.servings >= 24} aria-label="Increase recipe servings"><Plus aria-hidden="true" /></button>
              </div>
            </div>
          </IngredientReview>
        </div>
      ) : null}
    </div>
  );
}
