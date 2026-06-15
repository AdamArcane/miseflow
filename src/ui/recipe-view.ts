import {
	MarkdownRenderer,
	Notice,
	Platform,
	TextFileView,
	TFile,
	WorkspaceLeaf,
	setIcon,
	EventRef,
} from "obsidian";
import { appendCookHistoryEntry, stampRecipeCooked } from "../grocery/selection";
import { GroceryContribution } from "../grocery/note-writer";
import { isHighGi, parseGiDictionary } from "../parser/glycemic";
import {
	parseIngredientLine,
	ingredientKey,
} from "../parser/ingredient";
import { detectMeatTemp, MeatTemp } from "../parser/meat";
import { formatQuantity } from "../parser/quantity";
import {
	splitBodyAroundIngredients,
	splitBodyAroundInstructions,
	stripFrontmatter,
	stripRedundantBodyContent,
} from "../parser/recipe";
import { clearAllTimers, processTimerButtons, TimerOptions } from "./timer";
import {
	formatMinutes,
	matchingAllergens,
	readAllergens,
	readFavorite,
	readTimes,
	RecipeTimes,
} from "../parser/recipe-meta";
import {
	CustomBadge,
	BadgeValueType,
	IngredientGroup,
	InstructionGroup,
	GroceryItem,
} from "../types";
import {
	MiseFlowSettings,
	RECIPE_FRONTMATTER,
} from "../settings";
import { MarkCookedModal, SelectedImage } from "./mark-cooked-modal";
import { AddToMealPlanModal } from "./add-to-meal-plan-modal";
import { AddToGroceryModal } from "./add-to-grocery-modal";

export const VIEW_TYPE_RECIPE = "mise-recipe";

interface RecipeViewDeps {
	getSettings: () => MiseFlowSettings;
	openInMarkdown: (leaf: WorkspaceLeaf) => Promise<void>;
	isInMealPlan: (recipePath: string) => boolean;
	addToMealPlan: (
		recipePath: string,
		day: string | undefined,
		mealType: string | undefined,
		contributions: Record<string, GroceryContribution>,
	) => Promise<void>;
	removeFromMealPlan: (recipePath: string) => Promise<void>;
	onMealPlanChanged: () => void;
	addToGroceryOnly: (
		contributions: Record<string, GroceryContribution>,
	) => Promise<void>;
	getGroceryItems: () => GroceryItem[];
	onGroceryChanged: (callback: () => void) => EventRef;
	navigateToGroceryCategory: (category: string) => Promise<void>;
	removeFromGroceryByKey: (key: string) => Promise<void>;
}

interface NutritionField {
	/** Frontmatter property name (user-configurable). */
	key: string;
	label: string;
	/** Display unit suffix (e.g. "g"). Absent for calories. */
	unit?: string;
	aliases: readonly string[];
}

function buildNutritionFields(settings: MiseFlowSettings): NutritionField[] {
	return [
		{
			key: settings.caloriesProperty,
			label: "Cal",
			aliases: ["kcal", "calorie", "energy"],
		},
		{ key: settings.proteinProperty, label: "Protein", unit: "g", aliases: ["proteins"] },
		{
			key: settings.fatProperty,
			label: "Fat",
			unit: "g",
			aliases: ["fats", "total fat", "totalfat", "total_fat"],
		},
		{
			key: settings.carbsProperty,
			label: "Carbs",
			unit: "g",
			aliases: ["carb", "carbohydrate", "carbohydrates", "net carbs"],
		},
	];
}

const SERVINGS_KEYS = [
	RECIPE_FRONTMATTER.servings,
	"serves",
	"serving",
	"yield",
	"portions",
] as const;

function readFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
	const raw = frontmatter["tags"] ?? frontmatter["tag"];
	const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	return arr
		.filter((t): t is string => typeof t === "string" && t.length > 0)
		.map(t => t.startsWith("#") ? t.slice(1) : t);
}

function stripWikiLink(s: string): string {
	return s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t: string, d?: string) => (d ?? t).trim());
}

function normalizeScalar(v: unknown, valueType: BadgeValueType): string {
	if (valueType === "minutes" && typeof v === "number") return formatMinutes(v);
	if (typeof v === "number") return String(v);
	if (typeof v === "string") {
		const s = stripWikiLink(v.trim());
		if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
			return new Date(s + "T00:00:00").toLocaleDateString(undefined, {
				year: "numeric", month: "short", day: "numeric",
			});
		}
		return s;
	}
	return "";
}

function evalFormula(expr: string, fm: Record<string, unknown>): string | number | boolean | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		const fn = new Function(...Object.keys(fm), `"use strict"; return (${expr});`) as (...args: unknown[]) => unknown;
		const result = fn(...Object.values(fm));
		if (result == null) return null;
		if (typeof result !== 'string' && typeof result !== 'number' && typeof result !== 'boolean') return null;
		return result;
	} catch {
		return null;
	}
}

function resolveBadgeValues(raw: unknown, badge: CustomBadge): string[] | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "boolean") return raw ? [""] : null;
	const items = Array.isArray(raw) ? raw : [raw];
	const values = items.map(v => normalizeScalar(v, badge.valueType)).filter(Boolean);
	if (values.length === 0) return null;
	if (Array.isArray(raw) && badge.splitArray) return values;
	return [values.join(", ")];
}

/**
 * Replacement view for markdown files that represent recipes.
 *
 * Uses the file's frontmatter for metadata (image, multiplier, servings,
 * nutrition) and renders the body in three pieces: anything before the
 * ingredients heading, an interactive ingredients list with scaled
 * quantities, and anything after.
 */
export class RecipeView extends TextFileView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: RecipeViewDeps,
	) {
		super(leaf);
		this.icon = "chef-hat";
		this.navigation = true;

		this.addAction("file-text", "Edit as Markdown", () => {
			void this.deps.openInMarkdown(this.leaf);
		});
	}

	getViewType(): string {
		return VIEW_TYPE_RECIPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Recipe";
	}

	getViewData(): string {
		return this.data;
	}

	setViewData(data: string, _clear: boolean): void {
		this.data = data;
		this.render();
	}

	clear(): void {
		this.data = "";
		this.contentEl.empty();
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.registerEvent(
			this.app.metadataCache.on("changed", (changed) => {
				if (this.file && changed.path === this.file.path) {
					this.render();
				}
			}),
		);
		this.registerEvent(
			this.deps.onGroceryChanged(() => {
				this.render();
			}),
		);
	}

	refresh(): void {
		this.render();
	}

	private render(): void {
		clearAllTimers();
		const root = this.contentEl;
		root.empty();
		root.addClass("mise-recipe-view");

		const file = this.file;
		if (!file) return;

		const settings = this.deps.getSettings();
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = (cache?.frontmatter ?? {}) as Record<
			string,
			unknown
		>;

		const multiplier =
			readNumericFromKeys(frontmatter, [
				RECIPE_FRONTMATTER.multiplier,
			]) ?? 1;
		const servings = readNumericFromKeys(frontmatter, SERVINGS_KEYS);
		const isInPlan = this.deps.isInMealPlan(file.path);

		const rawBody = stripFrontmatter(this.data);
		const imageValue = readStringFromKeys(frontmatter, IMAGE_KEYS) ?? null;
		const body = stripRedundantBodyContent(rawBody, {
			title: file.basename,
			imageValue,
			stripTitle: settings.stripBodyTitle,
			stripImage: settings.stripBodyHeroImage,
		});
		const split = splitBodyAroundIngredients(
			body,
			settings.ingredientsHeading,
		);

		const allergens = readAllergens(frontmatter, settings.allergensProperty);
		const times = readTimes(frontmatter);
		const isFavorite = readFavorite(frontmatter);
		const allergenWarnings = matchingAllergens(
			allergens,
			settings.myAllergens,
		);

		const timerOptions: TimerOptions | null = settings.enableTimers
			? {
				autoStart: settings.timerAutoStart,
				compact: settings.timerDefaultCompact,
				rangeDefault: settings.timerRangeDefault,
				incrementSeconds: Math.round(settings.timerIncrementMinutes * 60),
				recipeName: file.basename,
				onOpenRecipe: () => {
					void this.app.workspace.openLinkText(
						file.basename,
						file.path,
						false,
					);
				},
			}
			: null;

		this.renderTitle(root, file, frontmatter, settings);
		if (allergenWarnings.length > 0) {
			this.renderAllergenWarning(root, allergenWarnings);
		}

		if (Platform.isMobile) {
			this.renderMobileLayout(
				root, file, frontmatter, split,
				multiplier, servings, isInPlan, isFavorite,
				times, settings, timerOptions,
			);
		} else {
			this.renderDesktopLayout(
				root, file, frontmatter, split,
				multiplier, servings, isInPlan, isFavorite,
				times, settings, timerOptions,
			);


		}
	}

	private renderDesktopLayout(
		root: HTMLElement,
		file: TFile,
		frontmatter: Record<string, unknown>,
		split: { before: string; ingredientGroups: IngredientGroup[]; after: string },
		multiplier: number,
		servings: number | null,
		isInPlan: boolean,
		isFavorite: boolean,
		times: RecipeTimes,
		settings: MiseFlowSettings,
		timerOptions: TimerOptions | null,
	): void {
		this.renderMetaBanner(
			root,
			file,
			frontmatter,
			multiplier,
			servings,
			isInPlan,
			isFavorite,
			settings,
		);

		if (split.before.trim()) {
			void this.renderMarkdown(root, split.before, file.path);
		}

		if (settings.showJumpBar) {
			const jumpSections = extractExtraSections(split.after, settings.instructionsHeading);
			if (jumpSections.length > 0) {
				this.renderJumpBar(root, jumpSections);
			}
		}

		const bodyRow = root.createDiv({ cls: "mise-recipe-body" });
		const ingredientsCol = bodyRow.createDiv({ cls: "mise-recipe-body-main" });
		if (split.ingredientGroups.length > 0) {
			this.renderIngredients(ingredientsCol, file, split.ingredientGroups, multiplier, settings);
		}
		this.renderImageCard(bodyRow, file, frontmatter);
		this.renderAfterIngredients(root, split.after, file.path, settings.instructionsHeading, timerOptions, settings.crossOffWhileCooking);
	}

	private renderMobileLayout(
		root: HTMLElement,
		file: TFile,
		frontmatter: Record<string, unknown>,
		split: { before: string; ingredientGroups: IngredientGroup[]; after: string },
		multiplier: number,
		servings: number | null,
		isInPlan: boolean,
		isFavorite: boolean,
		times: RecipeTimes,
		settings: MiseFlowSettings,
		timerOptions: TimerOptions | null,
	): void {
		// ── Hero row: image (left) + rating/stats card (right) ──────────
		this.renderMobileHero(root, file, frontmatter, times, servings, multiplier, settings);

		// ── Actions row (favorite, mark cooked, meal plan) ───────────────
		const actions = root.createDiv({ cls: "mise-recipe-meta-actions" });
		this.renderFavoriteToggle(actions, file, isFavorite);
		if (settings.showMarkCookedButton) {
			this.renderMarkCookedButton(actions, file, settings);
		}
		this.renderMealPlanButton(actions, file, isInPlan, settings);

		// Tab container
		const tabsEl = root.createDiv({ cls: "mise-recipe-tabs" });
		const tabBar = tabsEl.createDiv({ cls: "mise-recipe-tab-bar" });

		type TabId = "ingredients" | "steps" | "info";
		const TAB_IDS: TabId[] = ["ingredients", "steps", "info"];
		const TAB_LABELS: Record<TabId, string> = {
			ingredients: "Ingredients",
			steps: "Steps",
			info: "Recipe Info",
		};

		let activeTab: TabId = "ingredients";
		const tabButtons = new Map<TabId, HTMLButtonElement>();
		const tabPanels = new Map<TabId, HTMLElement>();

		for (const id of TAB_IDS) {
			const btn = tabBar.createEl("button", {
				cls: "mise-recipe-tab" + (id === activeTab ? " is-active" : ""),
				text: TAB_LABELS[id],
				attr: { type: "button", "data-tab": id },
			});
			tabButtons.set(id, btn);
		}

		const contentArea = tabsEl.createDiv({ cls: "mise-recipe-tab-content-area" });

		for (const id of TAB_IDS) {
			const panel = contentArea.createDiv({
				cls: "mise-recipe-tab-panel" + (id === activeTab ? " is-active" : ""),
				attr: { "data-tab": id },
			});
			tabPanels.set(id, panel);
		}

		const switchTab = (id: TabId): void => {
			activeTab = id;
			for (const [t, btn] of tabButtons) btn.toggleClass("is-active", t === id);
			for (const [t, panel] of tabPanels) panel.toggleClass("is-active", t === id);
		};

		for (const [id, btn] of tabButtons) {
			btn.addEventListener("click", () => switchTab(id));
		}

		// Render panel contents
		this.renderMobileIngredientsTab(
			tabPanels.get("ingredients")!,
			file, split.ingredientGroups, multiplier, servings, settings,
		);
		this.renderMobileStepsTab(
			tabPanels.get("steps")!,
			split.after, file.path, settings.instructionsHeading, timerOptions, times, settings.crossOffWhileCooking,
		);
		void this.renderMobileInfoTab(
			tabPanels.get("info")!,
			file, frontmatter, split.before, split.after, settings.instructionsHeading,
			settings, servings,
		);
	}

	private renderMobileHero(
		root: HTMLElement,
		file: TFile,
		frontmatter: Record<string, unknown>,
		times: RecipeTimes,
		servings: number | null,
		multiplier: number,
		settings: MiseFlowSettings,
	): void {
		// Image + rating card side by side
		const heroRow = root.createDiv({ cls: "mise-recipe-mobile-hero" });

		// Left: recipe image
		this.renderImageCard(heroRow, file, frontmatter);

		// Right: rating stars + time/servings labels
		const heroMeta = heroRow.createDiv({ cls: "mise-recipe-mobile-hero-meta" });

		// Star rating
		const ratingProp = settings.ratingProperty || "rating";
		const ratingRaw = frontmatter[ratingProp];
		const currentRating = typeof ratingRaw === "number"
			? Math.min(5, Math.max(0, Math.round(ratingRaw)))
			: typeof ratingRaw === "string"
				? Math.min(5, Math.max(0, Math.round(Number(ratingRaw) || 0)))
				: 0;

		const ratingBlock = heroMeta.createDiv({ cls: "mise-recipe-mobile-hero-rating" });
		ratingBlock.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Rating" });
		const starsRow = ratingBlock.createDiv({ cls: "mise-recipe-mobile-stars" });

		const renderStars = (value: number): void => {
			starsRow.empty();
			for (let i = 1; i <= 5; i++) {
				const star = starsRow.createSpan({
					cls: "mise-recipe-mobile-star" + (i <= value ? " is-filled" : ""),
					text: "★",
					attr: { "data-value": String(i), role: "button", "aria-label": `Rate ${i} stars` },
				});
				star.addEventListener("click", () => {
					const next = i === value ? 0 : i;
					void this.setRating(file, next, ratingProp).then(() => renderStars(next));
				});
			}
		};
		renderStars(currentRating);

		// Divider
		heroMeta.createDiv({ cls: "mise-recipe-mobile-hero-divider" });

		// Time / servings mini-stats
		const statsBlock = heroMeta.createDiv({ cls: "mise-recipe-mobile-hero-stats" });

		if (times.prep !== null) {
			const cell = statsBlock.createDiv({ cls: "mise-recipe-mobile-hero-stat" });
			cell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Prep" });
			cell.createDiv({ cls: "mise-recipe-mobile-hero-stat-value", text: formatMinutes(times.prep) });
		}
		if (times.cook !== null) {
			const cell = statsBlock.createDiv({ cls: "mise-recipe-mobile-hero-stat" });
			cell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Cook" });
			cell.createDiv({ cls: "mise-recipe-mobile-hero-stat-value", text: formatMinutes(times.cook) });
		}
		if (times.prep === null && times.cook === null && times.total !== null) {
			const cell = statsBlock.createDiv({ cls: "mise-recipe-mobile-hero-stat" });
			cell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Total" });
			cell.createDiv({ cls: "mise-recipe-mobile-hero-stat-value", text: formatMinutes(times.total) });
		}
		if (servings !== null) {
			const total = servings * multiplier;
			const cell = statsBlock.createDiv({ cls: "mise-recipe-mobile-hero-stat" });
			cell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Serves" });
			cell.createDiv({ cls: "mise-recipe-mobile-hero-stat-value", text: formatNumberValue(total) });
		}
	}

	private async setRating(file: TFile, value: number, property: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(
			file,
			(fm: Record<string, unknown>) => {
				if (value === 0) {
					delete fm[property];
				} else {
					fm[property] = value;
				}
			},
		);
	}

	private renderMobileIngredientsTab(
		root: HTMLElement,
		file: TFile,
		ingredientGroups: IngredientGroup[],
		multiplier: number,
		servings: number | null,
		settings: MiseFlowSettings,
	): void {
		const scaleHeader = root.createDiv({ cls: "mise-recipe-mobile-scale-header" });

		// Scale cell with stepper
		const scaleCell = scaleHeader.createDiv({ cls: "mise-recipe-mobile-scale-cell" });
		scaleCell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Scale" });
		const stepper = scaleCell.createDiv({
			cls: "mise-recipe-stepper",
			attr: { "aria-label": "Recipe multiplier" },
		});
		const minus = stepper.createEl("button", {
			cls: "mise-recipe-stepper-button",
			text: "\u2212",
			attr: { type: "button", "aria-label": "Decrease multiplier" },
		});
		minus.addEventListener("click", () => void this.updateMultiplier(file, multiplier - 0.5));
		const input = stepper.createEl("input", { cls: "mise-recipe-stepper-input", type: "number" });
		input.value = formatNumberValue(multiplier);
		input.step = "0.5";
		input.min = "0.5";
		input.addEventListener("change", () => {
			const next = Number(input.value);
			if (Number.isFinite(next) && next > 0) void this.updateMultiplier(file, next);
			else input.value = formatNumberValue(multiplier);
		});
		const plus = stepper.createEl("button", {
			cls: "mise-recipe-stepper-button",
			text: "+",
			attr: { type: "button", "aria-label": "Increase multiplier" },
		});
		plus.addEventListener("click", () => void this.updateMultiplier(file, multiplier + 0.5));

		// Servings cell
		const servingsCell = scaleHeader.createDiv({ cls: "mise-recipe-mobile-servings-cell" });
		servingsCell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Servings" });
		const total = servings === null ? null : servings * multiplier;
		const servingsValue = servingsCell.createDiv({
			cls: "mise-recipe-meta-value",
			text: total === null ? "\u2014" : formatNumberValue(total),
		});
		if (total === null) servingsValue.addClass("is-empty");

		// Ingredient list
		if (ingredientGroups.length > 0) {
			this.renderIngredients(root, file, ingredientGroups, multiplier, settings);
		} else {
			root.createDiv({ cls: "mise-recipe-empty-tab", text: "No ingredients found." });
		}
	}

	private renderMobileStepsTab(
		root: HTMLElement,
		afterMarkdown: string,
		sourcePath: string,
		instructionsHeading: string,
		timerOptions: TimerOptions | null,
		times: RecipeTimes,
		crossOff = false,
	): void {
		const hasPrep = times.prep !== null;
		const hasCook = times.cook !== null;
		const hasTotal = times.total !== null && !hasPrep && !hasCook;

		if (hasPrep || hasCook || hasTotal) {
			const timesHeader = root.createDiv({ cls: "mise-recipe-mobile-times-header" });
			if (hasPrep) {
				const cell = timesHeader.createDiv({ cls: "mise-recipe-mobile-time-cell" });
				cell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Prep" });
				cell.createDiv({ cls: "mise-recipe-mobile-time-value", text: formatMinutes(times.prep!) });
			}
			if (hasCook) {
				const cell = timesHeader.createDiv({ cls: "mise-recipe-mobile-time-cell" });
				cell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Cook" });
				cell.createDiv({ cls: "mise-recipe-mobile-time-value", text: formatMinutes(times.cook!) });
			}
			if (hasTotal) {
				const cell = timesHeader.createDiv({ cls: "mise-recipe-mobile-time-cell" });
				cell.createDiv({ cls: "mise-recipe-mobile-meta-label", text: "Total" });
				cell.createDiv({ cls: "mise-recipe-mobile-time-value", text: formatMinutes(times.total!) });
			}
		}

		this.renderAfterIngredients(root, afterMarkdown, sourcePath, instructionsHeading, timerOptions, crossOff);
	}

	private async renderMobileInfoTab(
		root: HTMLElement,
		file: TFile,
		frontmatter: Record<string, unknown>,
		bodyBefore: string,
		bodyAfter: string,
		instructionsHeading: string,
		settings: MiseFlowSettings,
		servings: number | null,
	): Promise<void> {
		// Source URL / link
		const sourceUrl = readStringFromKeys(frontmatter, SOURCE_URL_KEYS);
		if (sourceUrl) {
			const row = root.createDiv({ cls: "mise-recipe-mobile-info-row" });
			const iconEl = row.createSpan({ cls: "mise-recipe-mobile-info-icon" });
			setIcon(iconEl, "link");
			if (/^https?:/i.test(sourceUrl)) {
				row.createEl("a", {
					cls: "mise-recipe-mobile-info-link",
					text: sourceUrl,
					attr: { href: sourceUrl, target: "_blank", rel: "noopener noreferrer" },
				});
			} else {
				row.createSpan({ cls: "mise-recipe-mobile-info-value", text: sourceUrl });
			}
		}

		// Nutrition section — only shown if at least one value is available
		const nutritionFields = buildNutritionFields(settings);
		const anyNutrition = nutritionFields.some(
			(f) => readNutritionValue(frontmatter, f) !== null,
		);
		if (anyNutrition) {
			const section = root.createDiv({
				cls: "mise-recipe-mobile-info-nutrition",
			});
			const grid = section.createDiv({
				cls: "mise-recipe-mobile-info-nutrition-grid",
			});
			for (const field of nutritionFields) {
				const baseValue = readNutritionValue(frontmatter, field);
				const displayValue = resolveNutritionDisplayValue(
					baseValue,
					servings,
					settings.nutritionSource,
					settings.nutritionDisplay,
				);
				const cell = grid.createDiv({
					cls: "mise-recipe-mobile-info-nutrition-cell",
				});
				cell.createDiv({
					cls: "mise-recipe-mobile-meta-label",
					text: field.label,
				});
				const valueText =
					displayValue === null
						? "—"
						: roundForDisplay(displayValue) + (field.unit ?? "");
				const valEl = cell.createDiv({
					cls: "mise-recipe-mobile-info-nutrition-value",
					text: valueText,
				});
				if (displayValue === null) valEl.addClass("is-empty");
			}
		}

		// Full markdown body minus the ingredients section and instructions section
		const instSplit = splitBodyAroundInstructions(bodyAfter, instructionsHeading);
		const infoBody = [bodyBefore, instSplit.before, instSplit.after]
			.filter((s) => s.trim())
			.join("\n\n");
		if (infoBody.trim()) {
			await this.renderMarkdown(root, infoBody, file.path);
		}
	}

	private renderAfterIngredients(
		root: HTMLElement,
		afterMarkdown: string,
		sourcePath: string,
		instructionsHeading: string,
		timerOptions: TimerOptions | null,
		crossOff = false,
	): void {
		if (!afterMarkdown.trim()) return;

		const split = splitBodyAroundInstructions(
			afterMarkdown,
			instructionsHeading,
		);

		if (split.groups.length === 0) {
			void this.renderMarkdown(root, afterMarkdown, sourcePath);
			return;
		}

		if (split.before.trim()) {
			void this.renderMarkdown(root, split.before, sourcePath);
		}

		void this.renderInstructions(
			root,
			split.groups,
			sourcePath,
			instructionsHeading,
			timerOptions,
			crossOff,
		);

		if (split.after.trim()) {
			void this.renderMarkdown(root, split.after, sourcePath);
		}
	}

	private async renderInstructions(
		root: HTMLElement,
		groups: InstructionGroup[],
		sourcePath: string,
		title: string,
		timerOptions: TimerOptions | null,
		crossOff = false,
	): Promise<void> {
		const wrap = root.createDiv({
			cls: "mise-recipe-instructions",
		});

		const header = wrap.createDiv({
			cls: "mise-recipe-instructions-header",
		});
		const headerIcon = header.createSpan({
			cls: "mise-recipe-instructions-icon",
		});
		setIcon(headerIcon, "list-ordered");
		header.createEl("h2", {
			cls: "mise-recipe-instructions-title",
			text: title,
		});

		for (const group of groups) {
			const groupEl = wrap.createDiv({
				cls: "mise-recipe-instruction-group",
			});

			if (group.heading) {
				const levelCls =
					group.headingLevel >= 4
						? "mise-recipe-instruction-group-heading--sub"
						: "mise-recipe-instruction-group-heading--section";
				const headingBtn = groupEl.createEl("button", {
					cls: `mise-recipe-instruction-group-heading ${levelCls}`,
					attr: { type: "button" },
				});
				const chevronEl = headingBtn.createSpan({ cls: "mise-chevron" });
				setIcon(chevronEl, "chevron-down");
				headingBtn.createSpan({ text: group.heading });
				headingBtn.addEventListener("click", () => {
					groupEl.toggleClass("is-collapsed", !groupEl.hasClass("is-collapsed"));
				});
			}

			if (group.steps.length > 0) {
				const list = groupEl.createEl("ol", {
					cls: "mise-recipe-instruction-list",
				});

				for (let i = 0; i < group.steps.length; i++) {
					const step = group.steps[i] ?? "";
					const li = list.createEl("li", {
						cls: "mise-recipe-instruction",
					});
					li.createDiv({
						cls: "mise-recipe-instruction-number",
						text: String(i + 1),
					});
					const body = li.createDiv({
						cls: "mise-recipe-instruction-body",
					});
					await MarkdownRenderer.render(
						this.app,
						step,
						body,
						sourcePath,
						this,
					);
					if (timerOptions) {
						processTimerButtons(body, timerOptions);
					}

					if (crossOff) {
						li.addClass("mise-crossoff");
						li.addEventListener("click", (e) => {
							if ((e.target as HTMLElement).closest("button")) return;
							li.toggleClass("is-done", !li.hasClass("is-done"));
						});
					}
				}
			}
		}
	}

	private renderJumpBar(root: HTMLElement, sections: string[]): void {
		const bar = root.createDiv({ cls: "mise-recipe-jump-bar" });
		bar.createSpan({ cls: "mise-recipe-jump-label", text: "Jump to:" });
		for (const heading of sections) {
			const link = bar.createEl("button", {
				cls: "mise-recipe-jump-link",
				text: heading,
				attr: { type: "button" },
			});
			link.addEventListener("click", () => {
				const all = root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6");
				for (const el of Array.from(all)) {
					if (el.textContent?.trim().toLowerCase() === heading.toLowerCase()) {
						el.scrollIntoView({ behavior: "smooth", block: "start" });
						break;
					}
				}
			});
		}
	}

	private renderImageCard(
		root: HTMLElement,
		file: TFile,
		frontmatter: Record<string, unknown>,
	): void {
		const card = root.createDiv({
			cls: "mise-recipe-image-card",
		});

		const raw = readStringFromKeys(frontmatter, IMAGE_KEYS);
		const url = raw ? this.resolveImage(raw, file) : null;

		if (!url) {
			this.renderImagePlaceholder(card);
			return;
		}

		const img = card.createEl("img", {
			cls: "mise-recipe-image",
			attr: { alt: file.basename, src: url },
		});
		img.addEventListener("error", () => {
			img.remove();
			this.renderImagePlaceholder(card);
		});
	}

	private renderImagePlaceholder(card: HTMLElement): void {
		card.addClass("is-placeholder");
		const inner = card.createDiv({
			cls: "mise-recipe-image-placeholder",
		});
		const icon = inner.createSpan({
			cls: "mise-recipe-image-placeholder-icon",
		});
		setIcon(icon, "image-off");
		inner.createDiv({
			cls: "mise-recipe-image-placeholder-text",
			text: "No image",
		});
	}

	private resolveImage(value: string, file: TFile): string | null {
		const trimmed = value.trim();
		if (!trimmed) return null;

		if (/^(https?:|data:|app:|capacitor:)/i.test(trimmed)) {
			return trimmed;
		}

		const wikilink = trimmed.match(/^!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
		const target = ((wikilink ? wikilink[1] : trimmed) ?? trimmed).trim();

		const linked = this.app.metadataCache.getFirstLinkpathDest(
			target,
			file.path,
		);
		if (linked) {
			return this.app.vault.getResourcePath(linked);
		}
		const direct = this.app.vault.getAbstractFileByPath(target);
		if (direct instanceof TFile) {
			return this.app.vault.getResourcePath(direct);
		}
		return null;
	}

	private renderTitle(
		root: HTMLElement,
		file: TFile,
		frontmatter: Record<string, unknown>,
		settings: MiseFlowSettings,
	): void {
		const header = root.createDiv({ cls: "mise-recipe-title-block" });
		header.createEl("h1", {
			cls: "mise-recipe-title",
			text: file.basename,
		});

		// Star rating
		const ratingProp = settings.ratingProperty || "rating";
		const ratingRaw = frontmatter[ratingProp];
		const currentRating = typeof ratingRaw === "number"
			? Math.min(5, Math.max(0, Math.round(ratingRaw)))
			: typeof ratingRaw === "string"
				? Math.min(5, Math.max(0, Math.round(Number(ratingRaw) || 0)))
				: 0;

		const ratingBlock = header.createDiv({
			cls: "mise-recipe-hero-rating" + (currentRating === 0 ? " is-unrated" : ""),
		});
		const starsRow = ratingBlock.createSpan({ cls: "mise-recipe-header-stars" });

		const renderStars = (value: number): void => {
			ratingBlock.toggleClass("is-unrated", value === 0);
			starsRow.empty();
			const starEls: HTMLElement[] = [];
			for (let i = 1; i <= 5; i++) {
				const star = starsRow.createSpan({
					cls: "mise-recipe-header-star" + (i <= value ? " is-filled" : ""),
					text: "★",
					attr: { "data-value": String(i), role: "button", "aria-label": `Rate ${i} stars` },
				});
				starEls.push(star);
				star.addEventListener("mouseenter", () => {
					starEls.forEach((s, j) => s.toggleClass("is-preview", j < i));
				});
				star.addEventListener("click", () => {
					const next = i === value ? 0 : i;
					void this.setRating(file, next, ratingProp).then(() => renderStars(next));
				});
			}
			starsRow.addEventListener("mouseleave", () => {
				starEls.forEach(s => s.removeClass("is-preview"));
			});
		};
		renderStars(currentRating);

		if (settings.showTagsInHeader) {
			const tags = readFrontmatterTags(frontmatter);
			if (tags.length > 0) {
				const tagsEl = header.createDiv({ cls: "mise-recipe-header-tags" });
				for (const tag of tags) {
					const display = settings.tagHeaderFullPath ? tag : (tag.split("/").pop() ?? tag);
					const text = settings.tagHeaderShowHash ? `#${display}` : display;
					const a = tagsEl.createEl("a", { cls: "tag", text, href: `#${tag}` });
					a.addEventListener("click", (e) => {
						e.preventDefault();
						interface AppWithSearch {
							internalPlugins?: {
								getPluginById(id: string): { instance?: { openGlobalSearch(q: string): void } } | undefined;
							};
						}
						(this.app as unknown as AppWithSearch).internalPlugins
							?.getPluginById("global-search")
							?.instance
							?.openGlobalSearch(`tag:#${tag}`);
					});
				}
			}
		}

		const resolvedBadges = (settings.customBadges ?? [])
			.filter(b => b.enabled && (b.type === "separator" || b.type === "newline" || b.formula || b.property))
			.map(b => {
				if (b.type === "separator" || b.type === "newline") return { badge: b, values: null };
				const values = b.formula
					? (() => {
						const v = evalFormula(b.formula, frontmatter);
						if (v === null) return null;
						const s = normalizeScalar(v, b.valueType);
						return s ? [s] : null;
					})()
					: resolveBadgeValues(frontmatter[b.property], b);
				return { badge: b, values };
			});

		const hasRealBadges = resolvedBadges.some(({ badge, values }) =>
			badge.type !== "separator" && badge.type !== "newline" && values !== null);
		if (!hasRealBadges) return;

		const badgesEl = header.createDiv({ cls: "mise-recipe-badges" });
		for (const { badge, values } of resolvedBadges) {
			if (badge.type === "newline") {
				badgesEl.createSpan({ cls: "mise-badge-newline" });
				continue;
			}
			if (badge.type === "separator") {
				badgesEl.createSpan({ cls: "mise-badge-separator", text: badge.label || "·" });
				continue;
			}
			if (values === null) continue;
			for (const val of values) {
				this.renderBadge(badgesEl, badge, val);
			}
		}
	}

	private renderBadge(row: HTMLElement, badge: CustomBadge, value: string): void {
		const colorCls = badge.color !== "default" ? ` mise-badge-custom-${badge.color}` : "";
		const el = row.createSpan({ cls: `mise-badge${colorCls}` });
		if (badge.icon) {
			const iconEl = el.createSpan({ cls: "mise-badge-icon" });
			setIcon(iconEl, badge.icon);
		}
		const label = badge.label || badge.property;
		if (!badge.hideLabel) {
			el.createSpan({ cls: "mise-badge-label", text: label });
		}
		if (value) {
			el.createSpan({ cls: "mise-badge-value", text: `${badge.prefix}${value}${badge.suffix}` });
		}
		const display = value ? `${badge.prefix}${value}${badge.suffix}` : "";
		el.setAttribute("title", display ? `${label}: ${display}` : label);
	}

	private renderAllergenWarning(
		root: HTMLElement,
		matches: readonly string[],
	): void {
		const banner = root.createDiv({
			cls: "mise-recipe-allergen-warning",
			attr: { role: "alert" },
		});
		const icon = banner.createSpan({
			cls: "mise-recipe-allergen-warning-icon",
		});
		setIcon(icon, "alert-octagon");
		const body = banner.createDiv({
			cls: "mise-recipe-allergen-warning-body",
		});
		body.createDiv({
			cls: "mise-recipe-allergen-warning-title",
			text: "Allergen warning",
		});
		body.createDiv({
			cls: "mise-recipe-allergen-warning-text",
			text: `Contains ${matches.join(", ")}.`,
		});
	}

	private renderMetaBanner(
		root: HTMLElement,
		file: TFile,
		frontmatter: Record<string, unknown>,
		multiplier: number,
		servings: number | null,
		isInPlan: boolean,
		isFavorite: boolean,
		settings: MiseFlowSettings,
	): void {
		const banner = root.createDiv({
			cls: "mise-recipe-meta-banner",
		});
		const cells = banner.createDiv({
			cls: "mise-recipe-meta-cells",
		});

		this.renderMultiplierCell(cells, file, multiplier);
		this.renderServingsCell(cells, servings, multiplier);
		for (const field of buildNutritionFields(settings)) {
			this.renderNutritionCell(
				cells,
				field,
				frontmatter,
				servings,
				settings.nutritionSource,
				settings.nutritionDisplay,
			);
		}

		const actions = banner.createDiv({
			cls: "mise-recipe-meta-actions",
		});
		this.renderFavoriteToggle(actions, file, isFavorite);
		if (settings.showMarkCookedButton) {
			this.renderMarkCookedButton(actions, file, settings);
		}
		this.renderMealPlanButton(actions, file, isInPlan, settings);
	}

	private renderFavoriteToggle(
		actions: HTMLElement,
		file: TFile,
		isFavorite: boolean,
	): void {
		const toggle = actions.createEl("button", {
			cls: "mise-recipe-favorite-toggle",
			attr: { type: "button" },
		});
		let state = isFavorite;
		const update = (favorite: boolean): void => {
			state = favorite;
			toggle.toggleClass("is-favorite", favorite);
			toggle.setAttribute("aria-pressed", favorite ? "true" : "false");
			const label = favorite ? "Remove favorite" : "Mark as favorite";
			toggle.setAttribute("aria-label", label);
			toggle.title = label;
			toggle.empty();
			setIcon(toggle, "star");
		};
		update(isFavorite);

		toggle.addEventListener("click", () => {
			const next = !state;
			void this.setFavorite(file, next).then(() => {
				update(next);
			});
		});
	}

	private async setFavorite(file: TFile, next: boolean): Promise<void> {
		await this.app.fileManager.processFrontMatter(
			file,
			(fm: Record<string, unknown>) => {
				if (next) {
					fm[RECIPE_FRONTMATTER.favorite] = true;
				} else {
					delete fm[RECIPE_FRONTMATTER.favorite];
				}
			},
		);
	}

	private renderMarkCookedButton(
		actions: HTMLElement,
		file: TFile,
		settings: MiseFlowSettings,
	): void {
		const btn = actions.createEl("button", {
			cls: "mise-recipe-mark-cooked-button",
			attr: { type: "button", "aria-label": "Mark as cooked", title: "Mark as cooked" },
		});
		setIcon(btn, "chef-hat");

		btn.addEventListener("click", () => {
			if (settings.trackCookHistory || settings.markCookedAskDate) {
				new MarkCookedModal(
					this.app,
					{
						showNotes: settings.trackCookHistory && settings.cookHistoryPromptNotes,
						showImage: settings.trackCookHistory && settings.cookHistoryTrackImages,
					},
					(date, notes, image) => this.markAsCooked(file, date, notes, image, settings),
				).open();
			} else {
				const today = localDateISO();
				void this.markAsCooked(file, today, "", null, settings);
			}
		});
	}

	private async markAsCooked(
		file: TFile,
		date: string,
		notes: string,
		image: SelectedImage | null,
		settings: MiseFlowSettings,
	): Promise<void> {
		const { newCount } = await stampRecipeCooked(this.app, file, date, settings);

		if (settings.trackCookHistory) {
			let imageLink: string | null = null;
			if (image) {
				let imageFile: TFile;
				if (image.type === "upload") {
					const fm = this.app.fileManager as typeof this.app.fileManager & {
						getAvailablePathForAttachment(name: string, sourcePath: string): Promise<string>;
					};
					const attachPath = await fm.getAvailablePathForAttachment(image.name, file.path);
					imageFile = await this.app.vault.createBinary(attachPath, image.data);
				} else {
					imageFile = image.file;
				}
				imageLink = `![[${imageFile.path}]]`;
			}

			await appendCookHistoryEntry(
				this.app,
				file,
				date,
				notes,
				settings.cookHistoryHeading,
				imageLink,
			);
		}

		if (newCount !== null) {
			new Notice(`Marked "${file.basename}" as cooked. Total: ${newCount} time${newCount === 1 ? "" : "s"}.`);
		} else {
			new Notice(`Marked "${file.basename}" as cooked.`);
		}
	}

	private renderMealPlanButton(
		actions: HTMLElement,
		file: TFile,
		isInPlan: boolean,
		_settings: MiseFlowSettings,
	): void {
		const btn = actions.createEl("button", {
			cls: "mise-recipe-meal-plan-toggle",
			attr: { type: "button" },
		});
		let inPlan = isInPlan;

		const update = (planned: boolean): void => {
			inPlan = planned;
			btn.toggleClass("is-planned", planned);
			btn.setAttribute("aria-pressed", planned ? "true" : "false");
			const label = planned ? "Remove from meal plan" : "Add to meal plan";
			btn.setAttribute("aria-label", label);
			btn.title = label;
			btn.empty();
			setIcon(btn, planned ? "calendar-minus" : "calendar-plus");
		};
		update(isInPlan);

		btn.addEventListener("click", () => {
			if (inPlan) {
				void this.deps.removeFromMealPlan(file.path).then(() => {
					update(false);
					this.deps.onMealPlanChanged();
				});
			} else {
				new AddToMealPlanModal(this.app, file, {
					getSettings: this.deps.getSettings,
					onConfirm: async (day, mealType, contributions) => {
						await this.deps.addToMealPlan(file.path, day, mealType, contributions);
						update(true);
						this.deps.onMealPlanChanged();
					},
				}).open();
			}
		});
	}

	private renderMultiplierCell(
		grid: HTMLElement,
		file: TFile,
		multiplier: number,
	): void {
		const cell = grid.createDiv({
			cls: "mise-recipe-meta-cell",
		});
		const main = cell.createDiv({
			cls: "mise-recipe-meta-cell-main",
		});

		const stepper = main.createDiv({
			cls: "mise-recipe-stepper",
			attr: { "aria-label": "Recipe multiplier" },
		});

		const minus = stepper.createEl("button", {
			cls: "mise-recipe-stepper-button",
			text: "\u2212",
			attr: { type: "button", "aria-label": "Decrease multiplier" },
		});
		minus.addEventListener("click", () => {
			void this.updateMultiplier(file, multiplier - 0.5);
		});

		const input = stepper.createEl("input", {
			cls: "mise-recipe-stepper-input",
			type: "number",
		});
		input.value = formatNumberValue(multiplier);
		input.step = "0.5";
		input.min = "0.5";
		input.addEventListener("change", () => {
			const next = Number(input.value);
			if (Number.isFinite(next) && next > 0) {
				void this.updateMultiplier(file, next);
			} else {
				input.value = formatNumberValue(multiplier);
			}
		});

		const plus = stepper.createEl("button", {
			cls: "mise-recipe-stepper-button",
			text: "+",
			attr: { type: "button", "aria-label": "Increase multiplier" },
		});
		plus.addEventListener("click", () => {
			void this.updateMultiplier(file, multiplier + 0.5);
		});
	}

	private async updateMultiplier(file: TFile, value: number): Promise<void> {
		const next = Math.max(0.5, Math.round(value * 100) / 100);
		await this.app.fileManager.processFrontMatter(
			file,
			(fm: Record<string, unknown>) => {
				if (next === 1) {
					delete fm[RECIPE_FRONTMATTER.multiplier];
				} else {
					fm[RECIPE_FRONTMATTER.multiplier] = next;
				}
			},
		);
		this.deps.onMealPlanChanged();
	}

	private renderServingsCell(
		grid: HTMLElement,
		baseServings: number | null,
		multiplier: number,
	): void {
		const cell = grid.createDiv({
			cls: "mise-recipe-meta-cell",
		});
		const main = cell.createDiv({
			cls: "mise-recipe-meta-cell-main",
		});
		main.createDiv({
			cls: "mise-recipe-meta-label",
			text: "Serves",
		});

		const total =
			baseServings === null ? null : baseServings * multiplier;
		const value = main.createDiv({
			cls: "mise-recipe-meta-value",
			text: total === null ? "—" : formatNumberValue(total),
		});
		if (total === null) value.addClass("is-empty");
	}

	private renderNutritionCell(
		container: HTMLElement,
		field: NutritionField,
		frontmatter: Record<string, unknown>,
		baseServings: number | null,
		sourceMode: MiseFlowSettings["nutritionSource"],
		displayMode: MiseFlowSettings["nutritionDisplay"],
	): void {
		const baseValue = readNutritionValue(frontmatter, field);
		const displayValue = resolveNutritionDisplayValue(
			baseValue,
			baseServings,
			sourceMode,
			displayMode,
		);

		const cell = container.createDiv({
			cls: "mise-recipe-meta-cell",
		});
		const main = cell.createDiv({
			cls: "mise-recipe-meta-cell-main",
		});
		main.createDiv({
			cls: "mise-recipe-meta-label",
			text: field.label,
		});

		const valueEl = main.createDiv({
			cls: "mise-recipe-nutrition-value",
			text: displayValue === null ? "—" : roundForDisplay(displayValue) + (field.unit ?? ""),
		});
		if (displayValue === null) valueEl.addClass("is-empty");
	}

	private renderIngredients(
		root: HTMLElement,
		file: TFile,
		ingredientGroups: IngredientGroup[],
		multiplier: number,
		settings: MiseFlowSettings,
	): void {
		const wrap = root.createDiv({
			cls: "mise-recipe-ingredients",
		});

		const header = wrap.createDiv({
			cls: "mise-recipe-ingredients-header",
		});

		const headerIcon = header.createSpan({
			cls: "mise-recipe-ingredients-icon",
		});
		setIcon(headerIcon, "chef-hat");
		header.createEl("h2", {
			cls: "mise-recipe-ingredients-title",
			text: settings.ingredientsHeading,
		});

		const addBtn = header.createEl("button", {
			cls: "mise-recipe-add-to-grocery-link",
			text: "",
			attr: { type: "button", title: "Add ingredients to grocery list" },
		});
		const icon = addBtn.createSpan({
			cls: "mise-recipe-ingredient-gi-icon",
		});
		setIcon(icon, "shopping-cart");

		addBtn.addEventListener("click", () => {
			new AddToGroceryModal(this.app, file, {
				getSettings: this.deps.getSettings,
				getGroceryItems: this.deps.getGroceryItems,
				onConfirm: (contributions) =>
					this.deps.addToGroceryOnly(contributions),
				removeFromGroceryByKey: (key) =>
					this.deps.removeFromGroceryByKey(key),
			}).open();
		});

		const giDictionary = settings.diabeticMode
			? parseGiDictionary(settings.giDictionary)
			: [];

		const groceryItems = this.deps.getGroceryItems();

		for (const group of ingredientGroups) {
			if (group.lines.length === 0 && !group.heading) continue;

			const groupEl = wrap.createDiv({
				cls: "mise-recipe-ingredient-group",
			});

			if (group.heading) {
				const headingBtn = groupEl.createEl("button", {
					cls: "mise-recipe-ingredient-group-heading",
					attr: { type: "button" },
				});
				const chevronEl = headingBtn.createSpan({ cls: "mise-chevron" });
				setIcon(chevronEl, "chevron-down");
				headingBtn.createSpan({ text: group.heading });
				headingBtn.addEventListener("click", () => {
					groupEl.toggleClass("is-collapsed", !groupEl.hasClass("is-collapsed"));
				});
			}

			if (group.lines.length === 0) continue;

			const ul = groupEl.createEl("ul", {
				cls: "mise-recipe-ingredient-list",
			});

			for (const raw of group.lines) {
				const parsed = parseIngredientLine(raw);
				if (!parsed) continue;

				const li = ul.createEl("li", {
					cls: "mise-recipe-ingredient",
				});

				const scaledQty =
					parsed.quantity === null
						? null
						: parsed.quantity * multiplier;
				const qtyText = formatQuantity(scaledQty);
				const qtyDisplay = [qtyText, parsed.unit]
					.filter(Boolean)
					.join(" ");

				const qtyEl = li.createSpan({
					cls: "mise-recipe-ingredient-qty",
					text: qtyDisplay,
				});
				if (!qtyDisplay) qtyEl.addClass("is-empty");

				li.createSpan({
					cls: "mise-recipe-ingredient-name",
					text: titleCase(parsed.name),
				});

				if (settings.showMeatTempWarnings) {
					const meatTemp = detectMeatTemp(parsed.name);
					if (meatTemp) {
						this.renderMeatTempBadge(li, meatTemp);
					}
				}

				if (settings.diabeticMode && isHighGi(parsed.name, giDictionary)) {
					this.renderHighGiBadge(li);
				}

				// Remove from list icon if ingredient is on grocery list
				const key = ingredientKey(parsed.name, parsed.unit);
				const groceryItem = groceryItems.find((i) => i.key === key) ?? null;
				if (groceryItem) {
					const cartBtn = li.createEl("button", {
						cls: "mise-recipe-ingredient-cart is-on-list",
						attr: {
							type: "button",
							"aria-label": `Remove from grocery list`,
							title: `Remove from grocery list`,
						},
					});
					cartBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						void this.deps.removeFromGroceryByKey(key);
					});
					const cartIconEl = cartBtn.createSpan({
						cls: "mise-recipe-ingredient-cart-icon",
					});
					setIcon(cartIconEl, "list-x");
				}

				if (settings.crossOffWhileCooking) {
					li.addClass("mise-crossoff");
					li.addEventListener("click", (e) => {
						if ((e.target as HTMLElement).closest("button")) return;
						li.toggleClass("is-done", !li.hasClass("is-done"));
					});
				}
			}
		}
	}

	private renderHighGiBadge(li: HTMLElement): void {
		const tooltip =
			"High glycemic index - may cause a faster blood-sugar spike.";
		const badge = li.createSpan({
			cls: "mise-recipe-ingredient-gi",
			attr: {
				role: "note",
				"aria-label": tooltip,
				title: tooltip,
			},
		});
		const icon = badge.createSpan({
			cls: "mise-recipe-ingredient-gi-icon",
		});
		setIcon(icon, "arrow-up");
		badge.createSpan({
			cls: "mise-recipe-ingredient-gi-text",
			text: "GI",
		});
	}

	private renderMeatTempBadge(li: HTMLElement, temp: MeatTemp): void {
		const tooltip = `Cook ${temp.category.toLowerCase()} to a safe internal temperature of ${temp.fahrenheit}°F (${temp.celsius}°C).`;
		const badge = li.createSpan({
			cls: "mise-recipe-ingredient-temp",
			attr: {
				role: "note",
				"aria-label": tooltip,
				title: tooltip,
			},
		});
		const icon = badge.createSpan({
			cls: "mise-recipe-ingredient-temp-icon",
		});
		setIcon(icon, "alert-triangle");
		badge.createSpan({
			cls: "mise-recipe-ingredient-temp-text",
			text: `${temp.fahrenheit}°F`,
		});
	}

	private async renderMarkdown(
		root: HTMLElement,
		markdown: string,
		sourcePath: string,
	): Promise<void> {
		const block = root.createDiv({
			cls: "mise-recipe-markdown",
		});
		await MarkdownRenderer.render(this.app, markdown, block, sourcePath, this);
	}
}

const IMAGE_KEYS = [RECIPE_FRONTMATTER.image] as const;

const SOURCE_URL_KEYS = ["source", "url", "link", "website", "recipe_url"] as const;

/**
 * Looks up a string value in a frontmatter object trying several keys
 * case-insensitively. Returns the trimmed string, or null if no key
 * holds a non-empty string.
 */
function readStringFromKeys(
	fm: Record<string, unknown>,
	keys: readonly string[],
): string | null {
	const lookup = new Map<string, unknown>();
	for (const k of Object.keys(fm)) {
		lookup.set(k.toLowerCase(), fm[k]);
	}
	for (const key of keys) {
		const raw = lookup.get(key.toLowerCase());
		if (typeof raw === "string") {
			const trimmed = raw.trim();
			if (trimmed) return trimmed;
		}
	}
	return null;
}

function parseNumericValue(raw: unknown): number | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
	if (typeof raw === "string") {
		const match = raw.trim().match(/^[+-]?\d+(?:[.,]\d+)?/);
		if (!match) return null;
		const n = Number(match[0].replace(",", "."));
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * Look up a number from a frontmatter object trying several keys
 * case-insensitively, accepting either bare numbers or strings that begin
 * with a number (so values like "350 kcal" still parse).
 */
function readNumericFromKeys(
	fm: Record<string, unknown>,
	keys: readonly string[],
): number | null {
	const lookup = new Map<string, unknown>();
	for (const k of Object.keys(fm)) {
		lookup.set(k.toLowerCase(), fm[k]);
	}
	for (const key of keys) {
		const parsed = parseNumericValue(lookup.get(key.toLowerCase()));
		if (parsed !== null) return parsed;
	}
	return null;
}

/**
 * Read a nutrition value, looking at the configured key plus a few common
 * aliases ("fats" for fat, "carbohydrates" for carbs, etc.) and also
 * inside a nested `nutrition: { ... }` block.
 */
function readNutritionValue(
	fm: Record<string, unknown>,
	field: NutritionField,
): number | null {
	const keys = [field.key, ...field.aliases];
	const flat = readNumericFromKeys(fm, keys);
	if (flat !== null) return flat;
	const nested = fm.nutrition;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		return readNumericFromKeys(
			nested as Record<string, unknown>,
			keys,
		);
	}
	return null;
}

function formatNumberValue(num: number): string {
	if (Number.isInteger(num)) return String(num);
	return String(Math.round(num * 100) / 100);
}

function roundForDisplay(num: number): string {
	if (Number.isInteger(num)) return String(num);
	const rounded = Math.round(num * 10) / 10;
	if (Math.abs(rounded - Math.round(rounded)) < 0.05) {
		return String(Math.round(rounded));
	}
	return rounded.toFixed(1);
}

function resolveNutritionDisplayValue(
	baseValue: number | null,
	baseServings: number | null,
	sourceMode: MiseFlowSettings["nutritionSource"],
	displayMode: MiseFlowSettings["nutritionDisplay"],
): number | null {
	if (baseValue === null) return null;

	const hasServings =
		baseServings !== null && Number.isFinite(baseServings) && baseServings > 0;
	const perServing =
		sourceMode === "per-serving"
			? baseValue
			: hasServings
				? baseValue / baseServings
				: null;
	const total =
		sourceMode === "recipe-total"
			? baseValue
			: hasServings
				? baseValue * baseServings
				: null;

	if (displayMode === "per-serving") {
		return perServing ?? baseValue;
	}
	return total ?? baseValue;
}

function extractExtraSections(afterIngredients: string, instructionsHeading: string): string[] {
	const instSplit = splitBodyAroundInstructions(afterIngredients, instructionsHeading);
	const postInstructions = instSplit.after;
	if (!postInstructions.trim()) return [];
	const headingPattern = /^#{1,6}\s+(.+?)\s*#*\s*$/gm;
	const headings: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = headingPattern.exec(postInstructions)) !== null) {
		const text = (match[1] ?? "").trim();
		if (text) headings.push(text);
	}
	return headings;
}

function localDateISO(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function titleCase(name: string): string {
	return name.replace(
		/(^|[\s-])([a-z])/g,
		(_match, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`,
	);
}

