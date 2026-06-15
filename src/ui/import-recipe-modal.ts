import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { fetchHtml } from "../importer/fetcher";
import { extractRecipe, ImportedRecipe } from "../importer/schema-extractor";
import { buildRecipeNote, titleToFilename } from "../importer/note-builder";
import { detectPlatform, extractSocialMeta } from "../importer/social-extractor";
import {
	extractRecipeFromText,
	groupsToTextarea,
	textareaToGroups,
} from "../importer/text-extractor";
import { MiseFlowSettings } from "../settings";
import { ConfirmModal } from "./confirm-modal";
import { FolderSuggest } from "./folder-suggest";
import { VIEW_TYPE_RECIPE } from "./recipe-view";

export interface ImportRecipeHost {
	getSettings(): MiseFlowSettings;
	saveSettings(): Promise<void>;
}

type Mode = "url" | "text";
type Stage = "input" | "review";

export class ImportRecipeModal extends Modal {
	// Input stage
	private mode: Mode = "url";
	private url = "";
	private rawText = "";
	private textTitle = "";
	private folder = "";

	// Review stage
	private stage: Stage = "input";
	private parsed: ImportedRecipe | null = null;
	private reviewTitle = "";
	private reviewDescription = "";
	private reviewServings = "";
	private reviewPrepTime = "";
	private reviewCookTime = "";
	private reviewTotalTime = "";
	private reviewIngredients = "";
	private reviewInstructions = "";
	private reviewCalories = "";
	private reviewProtein = "";
	private reviewFat = "";
	private reviewCarbs = "";
	private reviewUrl = "";

	constructor(
		app: App,
		private readonly host: ImportRecipeHost,
	) {
		super(app);
		this.folder = this.defaultFolder();
	}

	onOpen(): void {
		this.renderContent();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderContent(): void {
		const { contentEl } = this;
		contentEl.empty();

		if (this.stage === "input") {
			this.renderInputStage();
		} else {
			this.renderReviewStage();
		}
	}

	// ---------------------------------------------------------------------------
	// Input stage
	// ---------------------------------------------------------------------------

	private renderInputStage(): void {
		const { contentEl } = this;
		this.titleEl.setText("Import recipe");

		// Tab bar
		const tabBar = contentEl.createDiv({ cls: "mise-import-tabs" });
		this.renderTab(tabBar, "url", "From URL");
		this.renderTab(tabBar, "text", "From Text");

		// Form area
		const form = contentEl.createDiv({ cls: "mise-import-form" });
		if (this.mode === "url") {
			this.renderUrlForm(form);
		} else {
			this.renderTextForm(form);
		}

		// Buttons
		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Import")
					.setCta()
					.onClick(() => void this.submitImport()),
			);
	}

	private renderTab(container: HTMLElement, mode: Mode, label: string): void {
		const btn = container.createEl("button", {
			text: label,
			cls: ["mise-tab-btn", this.mode === mode ? "mise-tab-active" : ""].filter(Boolean),
		});
		btn.addEventListener("click", () => {
			if (this.mode !== mode) {
				this.mode = mode;
				this.renderContent();
			}
		});
	}

	private renderUrlForm(form: HTMLElement): void {
		new Setting(form)
			.setName("Recipe URL")
			.setDesc("Paste the URL of a recipe page or cooking video (YouTube, TikTok)")
			.addText((t) =>
				t
					.setPlaceholder("https://www.example.com/recipes/…")
					.setValue(this.url)
					.onChange((v) => {
						this.url = v.trim();
					}),
			);

		new Setting(form)
			.setName("Save to folder")
			.setDesc("Vault-relative folder path for the new note.")
			.addText((t) => {
				t.setPlaceholder("Recipes")
					.setValue(this.folder)
					.onChange((v) => {
						this.folder = v.trim();
					});
				new FolderSuggest(this.app, t.inputEl, (path) => {
					this.folder = path;
				});
			});
	}

	private renderTextForm(form: HTMLElement): void {
		new Setting(form)
			.setName("Title")
			.setDesc("Optional, extracted from the text if left blank.")
			.addText((t) =>
				t
					.setPlaceholder("Recipe title")
					.setValue(this.textTitle)
					.onChange((v) => {
						this.textTitle = v.trim();
					}),
			);

		new Setting(form).setName("Recipe text").setDesc(
			"Paste the full recipe text: ingredients, instructions, any format.",
		);
		const ta = form.createEl("textarea", {
			cls: "mise-text-input",
			attr: { rows: "14", placeholder: "Paste recipe here…" },
		});
		ta.value = this.rawText;
		ta.addEventListener("input", () => {
			this.rawText = ta.value;
		});

		new Setting(form)
			.setName("Save to folder")
			.setDesc("Vault-relative folder path for the new note.")
			.addText((t) => {
				t.setPlaceholder("Recipes")
					.setValue(this.folder)
					.onChange((v) => {
						this.folder = v.trim();
					});
				new FolderSuggest(this.app, t.inputEl, (path) => {
					this.folder = path;
				});
			});
	}

	// ---------------------------------------------------------------------------
	// Review stage
	// ---------------------------------------------------------------------------

	private renderReviewStage(): void {
		const { contentEl } = this;
		this.titleEl.setText("Review recipe");

		// Title
		new Setting(contentEl)
			.setName("Title")
			.addText((t) =>
				t
					.setValue(this.reviewTitle)
					.onChange((v) => {
						this.reviewTitle = v;
					}),
			);

		// Servings (separate from timing)
		new Setting(contentEl)
			.setName("Servings")
			.addText((t) => {
				t.setPlaceholder("4").setValue(this.reviewServings).onChange((v) => {
					this.reviewServings = v.trim();
				});
				t.inputEl.setAttribute("type", "number");
				t.inputEl.setAttribute("min", "1");
				t.inputEl.addClass("mise-input-md");
			});

		// Timing row with always-visible labels
		const timingSetting = new Setting(contentEl).setName("Time (minutes)");
		const addTimingField = (label: string, value: string, onChange: (v: string) => void) => {
			timingSetting.controlEl.createSpan({ text: label, cls: "mise-timing-label" });
			timingSetting.addText((t) => {
				t.setValue(value).onChange((v) => onChange(v.trim()));
				t.inputEl.addClass("mise-input-sm");
			});
		};
		addTimingField("Prep", this.reviewPrepTime, (v) => { this.reviewPrepTime = v; });
		addTimingField("Cook", this.reviewCookTime, (v) => { this.reviewCookTime = v; });
		addTimingField("Total", this.reviewTotalTime, (v) => { this.reviewTotalTime = v; });

		// Description
		new Setting(contentEl).setName("Description");
		const descTa = contentEl.createEl("textarea", {
			cls: "mise-review-textarea",
			attr: { rows: "3" },
		});
		descTa.value = this.reviewDescription;
		descTa.addEventListener("input", () => {
			this.reviewDescription = descTa.value;
		});

		// Ingredients + Instructions side by side
		contentEl.createEl("div", {
			text: "One item per line, use ## heading to start a group",
			cls: "mise-review-col-hint",
		});
		const columnsEl = contentEl.createDiv({ cls: "mise-review-columns" });

		const ingCol = columnsEl.createDiv({ cls: "mise-review-col" });
		ingCol.createEl("div", { text: "Ingredients", cls: "mise-review-col-label" });
		const ingTa = ingCol.createEl("textarea", { cls: "mise-review-textarea", attr: { rows: "12" } });
		ingTa.value = this.reviewIngredients;
		ingTa.addEventListener("input", () => {
			this.reviewIngredients = ingTa.value;
		});

		const instCol = columnsEl.createDiv({ cls: "mise-review-col" });
		instCol.createEl("div", { text: "Instructions", cls: "mise-review-col-label" });
		const instTa = instCol.createEl("textarea", { cls: "mise-review-textarea", attr: { rows: "12" } });
		instTa.value = this.reviewInstructions;
		instTa.addEventListener("input", () => {
			this.reviewInstructions = instTa.value;
		});

		// Nutrition row
		const nutritionSetting = new Setting(contentEl).setName("Nutrition (per serving)");
		[
			{ label: "Cal", key: "reviewCalories" as const },
			{ label: "Protein", key: "reviewProtein" as const },
			{ label: "Fat", key: "reviewFat" as const },
			{ label: "Carbs", key: "reviewCarbs" as const },
		].forEach(({ label, key }) => {
			nutritionSetting.controlEl.createSpan({ text: label, cls: "mise-timing-label" });
			nutritionSetting.addText((t) => {
				t.setValue(this[key]).onChange((v) => {
					this[key] = v.trim();
				});
				t.inputEl.addClass("mise-input-sm");
			});
		});

		// Action buttons
		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("← back").onClick(() => {
					this.stage = "input";
					this.renderContent();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Save recipe")
					.setCta()
					.onClick(() => void this.submitSave()),
			);
	}

	// ---------------------------------------------------------------------------
	// Submit: input → review
	// ---------------------------------------------------------------------------

	private async submitImport(): Promise<void> {
		let recipe: ImportedRecipe | null = null;

		if (this.mode === "url") {
			if (!this.url) {
				new Notice("Please enter a URL.");
				return;
			}

			const platform = detectPlatform(this.url);

			if (platform === "instagram") {
				new Notice(
					"Instagram is not supported, copy the recipe caption and use the text import instead.",
				);
				return;
			}

			new Notice("Fetching recipe…");
			const html = await fetchHtml(this.url);
			if (!html) {
				new Notice("Could not fetch that URL. Check the address and try again.");
				return;
			}

			if (platform === "youtube" || platform === "tiktok") {
				const { title, text } = extractSocialMeta(html);
				if (!text) {
					new Notice(
						"Could not extract recipe content from that video. Try copying the description and using the text import instead.",
					);
					return;
				}
				if (platform === "tiktok" && text.length < 200) {
					new Notice(
						"Tik tok descriptions are sometimes truncated, verify the ingredients are complete.",
					);
				}
				recipe = extractRecipeFromText(text, title);
				recipe.url = this.url;
			} else {
				recipe = await extractRecipe(html, this.url);
				if (!recipe || !recipe.title) {
					new Notice(
						"No recipe data found on that page. The site may require a login or render via JavaScript.",
					);
					return;
				}
			}
		} else {
			if (!this.rawText.trim()) {
				new Notice("Please paste some recipe text.");
				return;
			}
			recipe = extractRecipeFromText(this.rawText, this.textTitle);
		}

		if (!recipe) {
			new Notice("Could not parse recipe data.");
			return;
		}

		// Populate review fields
		this.parsed = recipe;
		this.reviewTitle = recipe.title;
		this.reviewDescription = recipe.description;
		this.reviewServings = recipe.servings.match(/(\d+)/)?.[1] ?? "";
		this.reviewPrepTime = recipe.prepTime !== null ? String(recipe.prepTime) : "";
		this.reviewCookTime = recipe.cookTime !== null ? String(recipe.cookTime) : "";
		this.reviewTotalTime = recipe.totalTime !== null ? String(recipe.totalTime) : "";
		this.reviewIngredients = groupsToTextarea(recipe.ingredientGroups);
		this.reviewInstructions = groupsToTextarea(recipe.instructionGroups);
		this.reviewCalories = recipe.calories !== null ? String(recipe.calories) : "";
		this.reviewProtein = recipe.protein !== null ? String(recipe.protein) : "";
		this.reviewFat = recipe.fat !== null ? String(recipe.fat) : "";
		this.reviewCarbs = recipe.carbs !== null ? String(recipe.carbs) : "";
		this.reviewUrl = recipe.url;

		this.stage = "review";
		this.renderContent();
	}

	// ---------------------------------------------------------------------------
	// Submit: review → write note
	// ---------------------------------------------------------------------------

	private async submitSave(): Promise<void> {
		const recipe: ImportedRecipe = {
			title: this.reviewTitle.trim() || "Imported Recipe",
			description: this.reviewDescription,
			image: this.parsed?.image ?? "",
			servings: this.reviewServings,
			prepTime: toInt(this.reviewPrepTime),
			cookTime: toInt(this.reviewCookTime),
			totalTime: toInt(this.reviewTotalTime),
			ingredientGroups: textareaToGroups(this.reviewIngredients),
			instructionGroups: textareaToGroups(this.reviewInstructions),
			url: this.reviewUrl,
			calories: toInt(this.reviewCalories),
			protein: toInt(this.reviewProtein),
			fat: toInt(this.reviewFat),
			carbs: toInt(this.reviewCarbs),
		};

		const settings = this.host.getSettings();
		const content = await buildRecipeNote(this.app, recipe, settings);
		const filename = titleToFilename(recipe.title) + ".md";
		const folder = this.folder || this.defaultFolder();
		const notePath = folder ? `${folder}/${filename}` : filename;

		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			new ConfirmModal(this.app, {
				title: "Note already exists",
				message: `"${filename}" already exists. Overwrite it?`,
				confirmText: "Overwrite",
				destructive: true,
				onConfirm: () => void this.writeNote(notePath, content, true),
			}).open();
			return;
		}

		await this.writeNote(notePath, content, false);
	}

	// ---------------------------------------------------------------------------
	// Shared write + open
	// ---------------------------------------------------------------------------

	private async writeNote(
		notePath: string,
		content: string,
		overwrite: boolean,
	): Promise<void> {
		try {
			await ensureFolder(this.app, notePath);

			if (overwrite) {
				const file = this.app.vault.getAbstractFileByPath(notePath);
				if (file instanceof TFile) {
					await this.app.vault.modify(file, content);
				}
			} else {
				await this.app.vault.create(notePath, content);
			}

			this.close();
			new Notice(`Recipe imported: ${notePath.split("/").pop()}`);

			const file = this.app.vault.getAbstractFileByPath(notePath);
			if (file instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.setViewState({
					type: VIEW_TYPE_RECIPE,
					state: { file: file.path },
					active: true,
				});
				void this.app.workspace.revealLeaf(leaf);
			}
		} catch (err) {
			new Notice(`Import failed: ${String(err)}`);
		}
	}

	private defaultFolder(): string {
		const settings = this.host.getSettings();
		if (settings.importFolder) return settings.importFolder;
		return settings.recipeFolders[0] ?? "";
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toInt(s: string): number | null {
	if (!s.trim()) return null;
	const n = parseInt(s, 10);
	return Number.isFinite(n) ? n : null;
}

async function ensureFolder(app: App, filePath: string): Promise<void> {
	const parts = filePath.split("/");
	parts.pop();
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}
