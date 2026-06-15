import {
	MarkdownView,
	Menu,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	createEl,
	debounce,
	setIcon,
} from "obsidian";
import { registerCommands } from "./commands";
import { GroceryListManager, SaveSink } from "./grocery/manager";
import { getOrCreateNote } from "./grocery/note-writer";
import {
	DEFAULT_CATEGORY_ORDER,
	DEFAULT_SETTINGS,
	MiseFlowSettings,
	RECIPE_FRONTMATTER,
} from "./settings";
import { MiseFlowSettingsTab } from "./ui/settings-tab";
import { RecipeView, VIEW_TYPE_RECIPE } from "./ui/recipe-view";
import { GroceryListView, VIEW_TYPE_GROCERY_LIST } from "./ui/view";
import {
	frontmatterTypeMatches,
	normalizeRecipeTypeToken,
} from "./utils/vault-files";
import { resolveNotePath } from "./utils/paths";

export default class MiseFlowPlugin extends Plugin {
	settings!: MiseFlowSettings;
	manager!: GroceryListManager;

	async onload(): Promise<void> {
		await this.loadSettings();

		const sink: SaveSink = makeSaveSink(this);
		this.manager = new GroceryListManager(this.app, sink);

		this.registerView(
			VIEW_TYPE_GROCERY_LIST,
			(leaf) =>
				new GroceryListView(leaf, {
					manager: this.manager,
					getSettings: () => this.settings,
					saveSettings: () => this.saveSettings(),
				}),
		);

		this.registerView(
			VIEW_TYPE_RECIPE,
			(leaf) =>
				new RecipeView(leaf, {
					getSettings: () => this.settings,
					openInMarkdown: (target) => this.openLeafInMarkdown(target),
					isInMealPlan: (recipePath) =>
						this.manager
							.getMealPlanEntries()
							.some((e) => e.recipePath === recipePath),
					addToMealPlan: (recipePath, day, mealType, contributions) =>
						this.manager.addToMealPlan(recipePath, day, mealType, contributions),
					removeFromMealPlan: (recipePath) =>
						this.manager.removeFromMealPlan(recipePath),
					onMealPlanChanged: () => {
						void this.manager.refresh();
					},
					addToGroceryOnly: (contributions) =>
						this.manager.addToGroceryOnly(contributions),
					getGroceryItems: () => this.manager.getItems(),
					onGroceryChanged: (cb) => this.manager.on("changed", cb),
					navigateToGroceryCategory: async (category) => {
						const path =
							resolveNotePath(this.settings.groceryListNotePath || "Grocery List.md");
						const file = await getOrCreateNote(
							this.app,
							path,
							"# Grocery List\n",
						);
						await this.app.workspace.openLinkText(
							`${file.basename}#${category}`,
							file.path,
							false,
						);
					},
					removeFromGroceryByKey: (key) =>
						this.manager.removeFromGroceryByKey(key),
				}),
		);

		this.addRibbonIcon("shopping-cart", "Open shopping assistant", () => {
			void this.activateView();
		});

		this.addRibbonIcon("square-kanban", "Open meal plan", () => {
			const path = resolveNotePath(this.settings.mealPlanNotePath || "Meal Plan.md");
			void getOrCreateNote(this.app, path, "# Meal Plan\n").then((file) => {
				void this.app.workspace.getLeaf(false).openFile(file);
			});
		});

		registerCommands({
			plugin: this,
			manager: this.manager,
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			openView: () => this.activateView(),
			openCurrentAsRecipe: () => this.openCurrentAsRecipe(),
			openCurrentAsMarkdown: () => this.openCurrentAsMarkdown(),
		});

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file) return;
				this.maybeAutoOpenRecipe(file);
			}),
		);

		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu, file, source, leaf) => {
					this.maybeAddRecipeModeMenuItem(menu, file, source, leaf);
				},
			),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.refreshMarkdownRecipeButtons();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.refreshMarkdownRecipeButtons();
			}),
		);

		this.addSettingTab(new MiseFlowSettingsTab(this, {
			app: this.app,
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			manager: this.manager,
		}));

		// Watch both notes for manual edits.
		const syncMealPlan = debounce(
			() => { void this.manager.syncFromMealPlanNote(); },
			500,
			true,
		);
		const syncGrocery = debounce(
			() => { void this.manager.refresh(); },
			300,
			true,
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path === resolveNotePath(this.settings.mealPlanNotePath)) syncMealPlan();
				else if (file.path === resolveNotePath(this.settings.groceryListNotePath)) syncGrocery();
			}),
		);

		// Still refresh on vault structural changes so the view stays current.
		this.registerEvent(
			this.app.vault.on("delete", () => void this.manager.refresh()),
		);
		this.registerEvent(
			this.app.vault.on("rename", () => void this.manager.refresh()),
		);

		this.app.workspace.onLayoutReady(() => {
			void this.manager.syncFromMealPlanNote().then(() =>
				this.manager.refresh(),
			);
		});

		this.app.workspace.trigger("parse-style-settings");
	}

	onunload(): void {
		// Leaves are detached automatically by Obsidian on unload.
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as
			| Partial<MiseFlowSettings>
			| null;
		this.settings = mergeSettings(raw);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.app.workspace.getLeavesOfType(VIEW_TYPE_RECIPE).forEach(leaf => {
			if (leaf.view instanceof RecipeView) leaf.view.refresh();
		});
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_GROCERY_LIST);
		if (existing.length > 0) {
			leaf = existing[0] ?? null;
		} else {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({
				type: VIEW_TYPE_GROCERY_LIST,
				active: true,
			});
		}
		if (leaf) {
			await workspace.revealLeaf(leaf);
		}
	}

	async openCurrentAsRecipe(): Promise<void> {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) return;
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") return;
		await leaf.setViewState({
			type: VIEW_TYPE_RECIPE,
			state: { file: file.path },
			active: true,
		});
	}

	async openCurrentAsMarkdown(): Promise<void> {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) return;
		await this.openLeafInMarkdown(leaf);
	}

	async openLeafInMarkdown(leaf: WorkspaceLeaf): Promise<void> {
		const view = leaf.view;
		const file =
			view instanceof RecipeView
				? view.file
				: this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) return;
		await leaf.setViewState({
			type: "markdown",
			state: { file: file.path, mode: "source" },
			active: true,
		});
	}

	private refreshMarkdownRecipeButtons(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			leaf.view.containerEl.querySelector(".mise-markdown-recipe-btn")?.remove();

			if (leaf.view.getViewType() !== "markdown") return;
			const file = (leaf.view as MarkdownView).file;
			if (!file || !this.isRecipeFile(file)) return;

			const actionsEl = leaf.view.containerEl.querySelector(".view-actions");
			if (!actionsEl) return;

			const btn = createEl("button", {
				cls: "view-action clickable-icon mise-markdown-recipe-btn",
				attr: { "aria-label": "Recipe view" },
			});
			setIcon(btn, "chef-hat");
			btn.addEventListener("click", () => {
				void leaf.setViewState({
					type: VIEW_TYPE_RECIPE,
					state: { file: file.path },
					active: true,
				});
			});
			const lastBtn = actionsEl.lastElementChild;
			if (lastBtn) {
				actionsEl.insertBefore(btn, lastBtn);
			} else {
				actionsEl.appendChild(btn);
			}
		});
	}

	private isRecipeFile(file: TFile): boolean {
		if (file.extension !== "md") return false;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const typeValue = fm[RECIPE_FRONTMATTER.type];
		const target = normalizeRecipeTypeToken(this.settings.recipeTypeValue);
		if (target) return frontmatterTypeMatches(typeValue, target);
		if (this.settings.recipeFolders.length > 0) {
			return this.settings.recipeFolders.some((folder) => {
				const prefix = folder.endsWith("/") ? folder : folder + "/";
				return file.path.startsWith(prefix);
			});
		}
		return false;
	}

	private maybeAddRecipeModeMenuItem(
		menu: Menu,
		file: TAbstractFile,
		source: string,
		leaf?: WorkspaceLeaf,
	): void {
		if (source !== "more-options") return;
		if (!leaf) return;
		if (!(file instanceof TFile)) return;
		if (file.extension !== "md") return;
		if (leaf.view.getViewType() === VIEW_TYPE_RECIPE) return;

		menu.addItem((item) => {
			item.setTitle("Recipe mode")
				.setIcon("chef-hat")
				.setSection("pane")
				.onClick(() => {
					void leaf.setViewState({
						type: VIEW_TYPE_RECIPE,
						state: { file: file.path },
						active: true,
					});
				});
		});
	}

	private maybeAutoOpenRecipe(file: TFile): void {
		if (!this.settings.autoOpenRecipeView) return;
		if (file.extension !== "md") return;

		const cache = this.app.metadataCache.getFileCache(file);
		const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const typeValue = fm[RECIPE_FRONTMATTER.type];
		const target = normalizeRecipeTypeToken(this.settings.recipeTypeValue);
		if (!target) return;
		if (!frontmatterTypeMatches(typeValue, target)) return;

		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) return;
		if (leaf.view.getViewType() === VIEW_TYPE_RECIPE) return;

		// Defer past Obsidian's internal file-open async chain, which completes
		// after the file-open event fires and would otherwise overwrite our call.
		window.setTimeout(() => {
			if (!leaf.parent) return; // leaf was detached before the timeout fired
			void leaf.setViewState({
				type: VIEW_TYPE_RECIPE,
				state: { file: file.path },
				active: true,
			});
		}, 100);
	}
}


function makeSaveSink(plugin: MiseFlowPlugin): SaveSink {
	return {
		get settings() {
			return plugin.settings;
		},
		save: () => plugin.saveSettings(),
	};
}

function mergeSettings(
	raw: Partial<MiseFlowSettings> | null,
): MiseFlowSettings {
	const base: MiseFlowSettings = {
		...DEFAULT_SETTINGS,
		categoryOrder: [...DEFAULT_CATEGORY_ORDER],
		categoryOverrides: [],
		recipeFolders: [],
		state: {
			mealPlanEntries: [],
			oneOffs: [],
			collapsedGroups: {},
		},
	};
	if (!raw) return base;

	const merged: MiseFlowSettings = {
		...base,
		...raw,
		mealPlanNotePath:
			typeof raw.mealPlanNotePath === "string" && raw.mealPlanNotePath.trim()
				? raw.mealPlanNotePath.trim()
				: base.mealPlanNotePath,
		groceryListNotePath:
			typeof raw.groceryListNotePath === "string" && raw.groceryListNotePath.trim()
				? raw.groceryListNotePath.trim()
				: base.groceryListNotePath,
		grouping:
			raw.grouping === "category" ||
				raw.grouping === "recipe" ||
				raw.grouping === "source" ||
				raw.grouping === "none"
				? raw.grouping
				: base.grouping,
		categorySource:
			raw.categorySource === "tag" ||
				raw.categorySource === "tag-then-dictionary" ||
				raw.categorySource === "dictionary"
				? raw.categorySource
				: base.categorySource,
		categoryAutoSort:
			typeof raw.categoryAutoSort === "boolean"
				? raw.categoryAutoSort
				: base.categoryAutoSort,
		autoCollapseCompleted:
			typeof raw.autoCollapseCompleted === "boolean"
				? raw.autoCollapseCompleted
				: base.autoCollapseCompleted,
		autoOpenRecipeView:
			typeof raw.autoOpenRecipeView === "boolean"
				? raw.autoOpenRecipeView
				: base.autoOpenRecipeView,
		recipeTypeValue:
			typeof raw.recipeTypeValue === "string" && raw.recipeTypeValue.trim()
				? raw.recipeTypeValue.trim()
				: base.recipeTypeValue,
		nutritionDisplay:
			raw.nutritionDisplay === "per-serving" ||
				raw.nutritionDisplay === "total"
				? raw.nutritionDisplay
				: base.nutritionDisplay,
		nutritionSource:
			raw.nutritionSource === "recipe-total" ||
				raw.nutritionSource === "per-serving"
				? raw.nutritionSource
				: base.nutritionSource,
		showMarkCookedButton:
			typeof raw.showMarkCookedButton === "boolean"
				? raw.showMarkCookedButton
				: base.showMarkCookedButton,
		markCookedAskDate:
			typeof raw.markCookedAskDate === "boolean"
				? raw.markCookedAskDate
				: base.markCookedAskDate,
		state: {
			mealPlanEntries: Array.isArray(raw.state?.mealPlanEntries)
				? (raw.state?.mealPlanEntries ?? [])
				: [],
			oneOffs: Array.isArray(raw.state?.oneOffs)
				? (raw.state?.oneOffs ?? [])
				: [],
			collapsedGroups:
				raw.state?.collapsedGroups &&
					typeof raw.state.collapsedGroups === "object"
					? { ...raw.state.collapsedGroups }
					: {},
		},
		categoryOrder: Array.isArray(raw.categoryOrder)
			? raw.categoryOrder
			: base.categoryOrder,
		categoryOverrides: Array.isArray(raw.categoryOverrides)
			? raw.categoryOverrides
			: base.categoryOverrides,
		recipeFolders: Array.isArray(raw.recipeFolders)
			? raw.recipeFolders
			: base.recipeFolders,
		allergensProperty:
			typeof raw.allergensProperty === "string" && raw.allergensProperty.trim()
				? raw.allergensProperty.trim()
				: base.allergensProperty,
		myAllergens: Array.isArray(raw.myAllergens)
			? raw.myAllergens
				.filter((s): s is string => typeof s === "string")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean)
			: base.myAllergens,
		showMeatTempWarnings:
			typeof raw.showMeatTempWarnings === "boolean"
				? raw.showMeatTempWarnings
				: base.showMeatTempWarnings,
		trackCookedCount:
			typeof raw.trackCookedCount === "boolean"
				? raw.trackCookedCount
				: base.trackCookedCount,
		suggestionDayWindow:
			typeof raw.suggestionDayWindow === "number" &&
				Number.isFinite(raw.suggestionDayWindow) &&
				raw.suggestionDayWindow >= 0
				? Math.round(raw.suggestionDayWindow)
				: base.suggestionDayWindow,
		suggestionCount:
			typeof raw.suggestionCount === "number" &&
				Number.isFinite(raw.suggestionCount) &&
				raw.suggestionCount >= 1
				? Math.round(raw.suggestionCount)
				: base.suggestionCount,
		diabeticMode:
			typeof raw.diabeticMode === "boolean"
				? raw.diabeticMode
				: base.diabeticMode,
		giDictionary:
			typeof raw.giDictionary === "string"
				? raw.giDictionary
				: base.giDictionary,
	};
	return merged;
}
