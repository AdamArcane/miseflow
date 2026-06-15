import {
	App,
	Modal,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
} from "obsidian";
import { FileSuggest, FolderSuggest } from "./folder-suggest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { linter, lintGutter, Diagnostic } from "@codemirror/lint";
import { classHighlighter } from "@lezer/highlight";
import { GroceryListManager } from "../grocery/manager";
import {
	DEFAULT_GI_DICTIONARY,
	validateGiDictionary,
} from "../parser/glycemic";
import {
	DEFAULT_CATEGORY_ORDER,
	DEFAULT_SETTINGS,
	MiseFlowSettings,
} from "../settings";
import { BadgeColor, CategoryOverride, CustomBadge } from "../types";
import { checkExprSyntax } from "../utils/expr-eval";

export interface SettingsHost {
	app: App;
	settings: MiseFlowSettings;
	saveSettings(): Promise<void>;
	manager: GroceryListManager;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Badge edit modal
// ---------------------------------------------------------------------------

class BadgeEditModal extends Modal {
	private draft: CustomBadge;
	private formulaEditor: EditorView | null = null;

	constructor(
		app: App,
		badge: CustomBadge,
		private readonly onSave: (badge: CustomBadge) => Promise<void>,
	) {
		super(app);
		this.draft = { ...badge };
	}

	override onOpen(): void {
		const { contentEl } = this;
		const isBuiltin = !!this.draft.builtin;
		contentEl.addClass("mise-badge-edit-modal");
		const badgeTitle = this.draft.label || this.draft.property;
		this.titleEl.setText(badgeTitle ? `Edit badge: ${badgeTitle}` : "Add badge");

		if (this.draft.valueType === "minutes") {
			const note = contentEl.createDiv({ cls: "mise-badge-edit-modal-note" });
			note.createSpan({ text: "ℹ️  " });
			note.createSpan({ text: "This value is stored as minutes and will be auto-formatted as a duration (e.g. 90 → 1h 30m). Prefix and suffix are applied after formatting." });
		}

		// ── Formula toggle ──────────────────────────────────────────────
		let useFormula = !!(this.draft.formula);

		const formulaSetting = new Setting(contentEl)
			.setName("Formula")
			.setDesc("JavaScript expression evaluated with all frontmatter properties in scope. Return a string or number.");
		formulaSetting.settingEl.addClass("mise-badge-formula-setting");
		const editorWrap = formulaSetting.settingEl.createDiv({ cls: "mise-badge-formula-editor" });

		const formulaLinter = linter((view): Diagnostic[] => {
			const doc = view.state.doc.toString().trim();
			this.draft.formula = doc || undefined;
			if (!doc) return [];
			const err = checkExprSyntax(doc);
			if (!err) return [];
			return [{ from: 0, to: view.state.doc.length, severity: "error", message: err }];
		}, { delay: 300 });

		const formulaTheme = EditorView.theme({
			"&": {
				fontSize: "var(--font-ui-smaller)",
				fontFamily: "var(--font-monospace)",
				border: "1px solid var(--background-modifier-border)",
				borderRadius: "var(--input-radius)",
				background: "var(--background-primary)",
			},
			"&.cm-focused": {
				outline: "none",
				borderColor: "var(--interactive-accent)",
				boxShadow: "0 0 0 2px color-mix(in srgb, var(--interactive-accent) 25%, transparent)",
			},
			".cm-content": {
				color: "var(--text-normal)",
				caretColor: "var(--text-normal)",
				padding: "8px",
				minHeight: "75px",
			},
			".cm-line": { lineHeight: "1.6" },
			".cm-gutters": {
				background: "var(--background-secondary)",
				border: "none",
				borderRight: "1px solid var(--background-modifier-border)",
				color: "var(--text-faint)",
			},
		});

		const formulaEditor = new EditorView({
			state: EditorState.create({
				doc: this.draft.formula ?? "",
				extensions: [
					javascript(),
					syntaxHighlighting(classHighlighter),
					keymap.of(defaultKeymap),
					formulaLinter,
					lintGutter(),
					formulaTheme,
					EditorView.lineWrapping,
				],
			}),
			parent: editorWrap,
		});
		this.formulaEditor = formulaEditor;

		const propertySetting = new Setting(contentEl)
			.setName("Property")
			.setDesc("Frontmatter key to read from the recipe note.")
			.addText(t =>
				t.setPlaceholder("E.g. Cuisine")
					.setValue(this.draft.property)
					.onChange(v => { this.draft.property = v.trim(); }),
			);

		const prefixSetting = new Setting(contentEl)
			.setName("Prefix")
			.setDesc("Text prepended to the value, e.g. \"$\".")
			.addText(t =>
				t.setPlaceholder("Ex. $")
					.setValue(this.draft.prefix)
					.onChange(v => { this.draft.prefix = v; }),
			);

		const suffixSetting = new Setting(contentEl)
			.setName("Suffix")
			.setDesc("Text appended to the value, e.g. \" kcal\" or \" min\".")
			.addText(t =>
				t.setPlaceholder("Ex. Kcal")
					.setValue(this.draft.suffix)
					.onChange(v => { this.draft.suffix = v; }),
			);

		const splitSetting = new Setting(contentEl)
			.setName("Split array")
			.setDesc("When the property is a list, show one badge per item instead of a single comma-joined badge.")
			.addToggle(t =>
				t.setValue(this.draft.splitArray).onChange(v => { this.draft.splitArray = v; }),
			);

		const applyVisibility = (): void => {
			toggleSetting.settingEl.style.display = isBuiltin ? "none" : "";
			formulaSetting.settingEl.style.display = useFormula ? "" : "none";
			propertySetting.settingEl.style.display = useFormula ? "none" : "";
			prefixSetting.settingEl.style.display = isBuiltin || useFormula ? "none" : "";
			suffixSetting.settingEl.style.display = isBuiltin || useFormula ? "none" : "";
			splitSetting.settingEl.style.display = isBuiltin || useFormula ? "none" : "";
		};

		// Insert the toggle *before* the fields we just built by prepending to contentEl.
		// Use a Setting so it gets standard styling.
		const toggleSetting = new Setting(contentEl)
			.setName("Use formula")
			.setDesc("Replace property lookup with a custom JavaScript expression.")
			.addToggle(t => t.setValue(useFormula).onChange(v => {
				useFormula = v;
				if (!v) this.draft.formula = undefined;
				applyVisibility();
			}));
		// Move the toggle above the formula/property fields.
		contentEl.insertBefore(toggleSetting.settingEl, formulaSetting.settingEl);

		applyVisibility();

		// ── Shared fields (always visible) ──────────────────────────────
		new Setting(contentEl)
			.setName("Label")
			.setDesc("Display label shown in the badge. Defaults to the property name.")
			.addText(t =>
				t.setPlaceholder("Ex. Cuisine")
					.setValue(this.draft.label)
					.onChange(v => { this.draft.label = v; }),
			);

		new Setting(contentEl)
			.setName("Show label")
			.setDesc("When off, only the value is shown with no label text.")
			.addToggle(t =>
				t.setValue(!this.draft.hideLabel).onChange(v => { this.draft.hideLabel = !v; }),
			);

		let iconPreviewEl: HTMLElement;
		new Setting(contentEl)
			.setName("Icon")
			.setDesc("Lucide icon name shown inside the badge. Leave blank for no icon.")
			.addText(t => {
				t.setPlaceholder("Ex. Tag, globe, bookmark")
					.setValue(this.draft.icon)
					.onChange(v => {
						this.draft.icon = v.trim();
						iconPreviewEl.empty();
						if (this.draft.icon) setIcon(iconPreviewEl, this.draft.icon);
					});
				iconPreviewEl = t.inputEl.parentElement!.createSpan({ cls: "mise-settings-badge-icon-preview" });
				if (this.draft.icon) setIcon(iconPreviewEl, this.draft.icon);
			});

		new Setting(contentEl)
			.setName("Color")
			.addDropdown(d => {
				const opts: { value: BadgeColor; label: string }[] = [
					{ value: "default", label: "Default" },
					{ value: "green", label: "Green" },
					{ value: "blue", label: "Blue" },
					{ value: "purple", label: "Purple" },
					{ value: "yellow", label: "Yellow" },
					{ value: "red", label: "Red" },
				];
				for (const o of opts) d.addOption(o.value, o.label);
				d.setValue(this.draft.color).onChange(v => { this.draft.color = v as BadgeColor; });
			});

		new Setting(contentEl)
			.addButton(b =>
				b.setButtonText("Save").setCta().onClick(async () => {
					await this.onSave({ ...this.draft });
					this.close();
				}),
			)
			.addButton(b =>
				b.setButtonText("Cancel").onClick(() => this.close()),
			);
	}

	override onClose(): void {
		this.formulaEditor?.destroy();
		this.formulaEditor = null;
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Separator edit modal
// ---------------------------------------------------------------------------

const SEPARATOR_PRESETS = ["·", "|", "•", "/", "—", "◆", "×"];

class SeparatorEditModal extends Modal {
	private char: string;

	constructor(
		app: App,
		badge: CustomBadge,
		private readonly onSave: (badge: CustomBadge) => Promise<void>,
	) {
		super(app);
		this.char = badge.label || "·";
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Edit separator");

		const presetRow = contentEl.createDiv({ cls: "mise-separator-presets" });
		for (const p of SEPARATOR_PRESETS) {
			const btn = presetRow.createEl("button", { cls: "mise-separator-preset-btn", text: p });
			if (p === this.char) btn.classList.add("is-active");
			btn.addEventListener("click", () => {
				this.char = p;
				input.value = p;
				presetRow.querySelectorAll(".mise-separator-preset-btn").forEach(b => b.classList.remove("is-active"));
				btn.classList.add("is-active");
			});
		}

		let input: HTMLInputElement;
		new Setting(contentEl)
			.setName("Custom")
			.setDesc("Any character or short string.")
			.addText(t => {
				input = t.inputEl;
				t.setValue(this.char).onChange(v => {
					this.char = v || "·";
					presetRow.querySelectorAll(".mise-separator-preset-btn").forEach(b => b.classList.remove("is-active"));
					// Highlight preset button if the typed value matches one
					presetRow.querySelectorAll<HTMLButtonElement>(".mise-separator-preset-btn").forEach(b => {
						if (b.textContent === v) b.classList.add("is-active");
					});
				});
			});

		new Setting(contentEl)
			.addButton(b => b.setButtonText("Save").setCta().onClick(async () => {
				await this.onSave({ label: this.char, type: "separator", property: "", icon: "", color: "default", valueType: "auto", prefix: "", suffix: "", splitArray: false, enabled: true });
				this.close();
			}))
			.addButton(b => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

export class MiseFlowSettingsTab extends PluginSettingTab {
	constructor(
		plugin: Plugin,
		private readonly host: SettingsHost,
	) {
		super(plugin.app, plugin);
	}

	override display(): void {
		this.renderSettings();
	}

	private renderSettings(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Header: logo + buy me a coffee ───────────────────────────────
		const header = containerEl.createDiv({ cls: "mise-settings-header" });

		header.createEl("img", {
			cls: "mise-settings-logo",
			attr: {
				src: "https://github.com/user-attachments/assets/1bd14075-406d-42af-b005-9a245a714811",
				alt: "MiseFlow",
			},
		});

		header.createEl("a", {
			cls: "mise-settings-bmc",
			text: "☕ buy me a coffee",
			href: "https://buymeacoffee.com/atommasi",
			attr: { target: "_blank", rel: "noopener" },
		});

		// ── Recipe Library ───────────────────────────────────────────────
		new Setting(containerEl).setName("Recipe library").setHeading();

		{
			const s = new Setting(containerEl)
				.setName("Recipe folders")
				.setDesc(
					"Folders the plugin scans for recipe notes. Leave empty to scan the entire vault.",
				);
			s.settingEl.addClass("mise-settings-has-list");
			this.renderFolderList(
				s.settingEl,
				this.host.settings.recipeFolders,
				async (folders) => {
					this.host.settings.recipeFolders = folders;
					await this.host.saveSettings();
				},
			);
		}

		new Setting(containerEl)
			.setName("Recipe type value")
			.setDesc(
				"Notes whose frontmatter `type` matches this value are treated as recipes. Used for auto-open and the recipe library.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Recipe")
					.setValue(this.host.settings.recipeTypeValue)
					.onChange(async (value) => {
						this.host.settings.recipeTypeValue =
							value.trim() || "recipe";
						await this.host.saveSettings();
					}),
			);

		// ── Notes & Storage ──────────────────────────────────────────────
		new Setting(containerEl).setName("Notes & storage").setHeading();

		new Setting(containerEl)
			.setName("Meal plan note")
			.setDesc(createMomentDesc("Vault-relative path of the note where your meal plan is stored."))
			.addText((text) => {
				text
					.setPlaceholder("Meal plan.md")
					.setValue(this.host.settings.mealPlanNotePath)
					.onChange(async (value) => {
						this.host.settings.mealPlanNotePath =
							value.trim() || "Meal Plan.md";
						await this.host.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl, async (path) => {
					this.host.settings.mealPlanNotePath = path;
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Grocery list note")
			.setDesc(createMomentDesc("Vault-relative path of the note where your grocery list is stored."))
			.addText((text) => {
				text
					.setPlaceholder("Grocery list.md")
					.setValue(this.host.settings.groceryListNotePath)
					.onChange(async (value) => {
						this.host.settings.groceryListNotePath =
							value.trim() || "Grocery List.md";
						await this.host.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl, async (path) => {
					this.host.settings.groceryListNotePath = path;
					await this.host.saveSettings();
				});
			});


		// Declare first so the toggle's onChange closure can reference it.
		// The Setting itself is appended to the DOM after the toggle below.
		let tagFilterSetting: Setting;

		new Setting(containerEl)
			.setName("Auto-add ingredients on sync")
			.setDesc(
				"When syncing the meal plan note, automatically extract ingredients from newly discovered recipes and add them to the grocery list.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.autoAddIngredientsOnSync)
					.onChange(async (value) => {
						this.host.settings.autoAddIngredientsOnSync = value;
						await this.host.saveSettings();
						tagFilterSetting.settingEl.style.display = value ? "" : "none";
					}),
			);

		tagFilterSetting = new Setting(containerEl)
			.setName("Tag filter")
			.setDesc(
				"Only auto-add ingredients from recipes that have this tag; leave blank to include all.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Tag")
					.setValue(this.host.settings.autoAddIngredientsTag)
					.onChange(async (value) => {
						this.host.settings.autoAddIngredientsTag =
							value.trim().replace(/^#/, "");
						await this.host.saveSettings();
					}),
			);
		tagFilterSetting.settingEl.style.display =
			this.host.settings.autoAddIngredientsOnSync ? "" : "none";


		// ── Recipe Import ─────────────────────────────────────────────────
		new Setting(containerEl).setName("Recipe import").setHeading();

		new Setting(containerEl)
			.setName("Import folder")
			.setDesc(
				"Vault-relative folder where imported recipes are saved. Leave blank to use the first recipe folder.",
			)
			.addText((text) => {
				text
					.setPlaceholder("Recipes")
					.setValue(this.host.settings.importFolder)
					.onChange(async (value) => {
						this.host.settings.importFolder = value.trim();
						await this.host.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl, async (path) => {
					this.host.settings.importFolder = path;
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Import template note")
			.setDesc(
				"Vault-relative path to a note used as the template for imported recipes. " +
				"Use {{title}}, {{ingredients}}, {{instructions}}, {{image}}, {{url}}, {{servings}}, {{prepTime}}, {{cookTime}}, {{totalTime}}, {{description}}, {{date}} as tokens. " +
				"Leave blank to use the built-in default. If you have Templater installed with 'trigger on file creation' enabled, Templater will also run on the new note automatically.",
			)
			.addText((text) => {
				text
					.setPlaceholder("Templates/Recipe Import.md")
					.setValue(this.host.settings.importTemplatePath)
					.onChange(async (value) => {
						this.host.settings.importTemplatePath = value.trim();
						await this.host.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl, async (path) => {
					this.host.settings.importTemplatePath = path;
					await this.host.saveSettings();
				});
			});



		// ── Recipe View ─────────────────────────────────────────────────
		new Setting(containerEl).setName("Recipe view").setHeading();

		new Setting(containerEl)
			.setName("Auto-open recipe view")
			.setDesc(
				"Automatically switch to the recipe card view when you open a note whose `type` matches the value above.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.autoOpenRecipeView)
					.onChange(async (value) => {
						this.host.settings.autoOpenRecipeView = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Ingredients heading")
			.setDesc(
				"The heading in your recipe notes that introduces the ingredients list (case-insensitive).",
			)
			.addText((text) =>
				text
					.setPlaceholder("Ingredients")
					.setValue(this.host.settings.ingredientsHeading)
					.onChange(async (value) => {
						this.host.settings.ingredientsHeading =
							value.trim() || "Ingredients";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Instructions heading")
			.setDesc(
				"The heading in your recipe notes that introduces the cooking steps (case-insensitive).",
			)
			.addText((text) =>
				text
					.setPlaceholder("Instructions")
					.setValue(this.host.settings.instructionsHeading)
					.onChange(async (value) => {
						this.host.settings.instructionsHeading =
							value.trim() || "Instructions";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Remove duplicate title")
			.setDesc(
				"Strip the leading h1 from a recipe note's body if it matches the note title, since the recipe view already shows the title above.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.stripBodyTitle)
					.onChange(async (value) => {
						this.host.settings.stripBodyTitle = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Remove duplicate hero image")
			.setDesc(
				"Strip inline images from a recipe note's body if they match the frontmatter image, since the recipe view already shows it as a hero image.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.stripBodyHeroImage)
					.onChange(async (value) => {
						this.host.settings.stripBodyHeroImage = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show jump bar")
			.setDesc(
				"Show a bar above the ingredients linking to extra sections like tips or notes",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showJumpBar)
					.onChange(async (value) => {
						this.host.settings.showJumpBar = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Rating property")
			.setDesc(
				"Frontmatter property name used to store a recipe's star rating (1–5). Shown as interactive stars in the mobile recipe header.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Rating")
					.setValue(this.host.settings.ratingProperty)
					.onChange(async (value) => {
						this.host.settings.ratingProperty = value.trim() || "rating";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show tags in header")
			.setDesc("Display frontmatter tags above the badges in the recipe header.")
			.addToggle(t => t
				.setValue(this.host.settings.showTagsInHeader)
				.onChange(async v => {
					this.host.settings.showTagsInHeader = v;
					await this.host.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Tag prefix")
			.setDesc("Prefix each tag with # when displaying.")
			.addToggle(t => t
				.setValue(this.host.settings.tagHeaderShowHash)
				.onChange(async v => {
					this.host.settings.tagHeaderShowHash = v;
					await this.host.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Tag format")
			.setDesc("Show the full tag path or only the last segment.")
			.addDropdown(d => d
				.addOption("full", "Full path  (cooking/italian)")
				.addOption("leaf", "Last segment  (italian)")
				.setValue(this.host.settings.tagHeaderFullPath ? "full" : "leaf")
				.onChange(async v => {
					this.host.settings.tagHeaderFullPath = v === "full";
					await this.host.saveSettings();
				}),
			);

		const badgeSetting = new Setting(containerEl)
			.setName("Header badges")
			.setDesc(
				"Frontmatter properties to surface as badges in the recipe view header. Click a row to edit, drag to reorder. The last made badge property should match the tracking setting in the cooking & tracking section.",
			);
		badgeSetting.settingEl.addClass("mise-settings-badge-section");
		this.renderBadgeList(badgeSetting.settingEl, this.host.settings.customBadges, async (badges) => {
			this.host.settings.customBadges = badges;
			await this.host.saveSettings();
		});

		new Setting(containerEl).setName("Recipe timers").setHeading();

		new Setting(containerEl)
			.setName("Step timers")
			.setDesc(
				'Detect duration phrases in cooking steps (e.g. "bake for 30 minutes") and show a clickable timer button.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.enableTimers)
					.onChange(async (value) => {
						this.host.settings.enableTimers = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-start timers")
			.setDesc(
				"Start counting down immediately when a timer button is clicked.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.timerAutoStart)
					.onChange(async (value) => {
						this.host.settings.timerAutoStart = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Compact timers by default")
			.setDesc(
				"Show timers in compact mode (time only) instead of the full widget. You can toggle per-timer using the resize button.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.timerDefaultCompact)
					.onChange(async (value) => {
						this.host.settings.timerDefaultCompact = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Time range default")
			.setDesc(
				'When a step says "10–15 minutes", which end of the range to use as the timer default.',
			)
			.addDropdown((dd) =>
				dd
					.addOptions({ max: "Max", min: "Min" })
					.setValue(this.host.settings.timerRangeDefault)
					.onChange(async (value) => {
						this.host.settings.timerRangeDefault = value as "max" | "min";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Timer increment")
			.setDesc("How many minutes the ▲/▼ stepper buttons add or subtract.")
			.addText((text) =>
				text
					.setPlaceholder("1")
					.setValue(String(this.host.settings.timerIncrementMinutes))
					.onChange(async (value) => {
						const n = parseFloat(value);
						if (isFinite(n) && n > 0) {
							this.host.settings.timerIncrementMinutes = n;
							await this.host.saveSettings();
						}
					}),
			);

		// ── Shopping ─────────────────────────────────────────────────────
		new Setting(containerEl).setName("Shopping").setHeading();

		new Setting(containerEl)
			.setName("Default grouping")
			.setDesc(
				"How items are grouped in the shopping assistant. By category is best for supermarket shopping; by recipe is useful for meal prep.",
			)
			.addDropdown((dd) =>
				dd
					.addOptions({
						category: "By category",
						recipe: "By recipe",
						source: "By source (Meal Plan vs Manually Added)",
						none: "Flat list",
					})
					.setValue(this.host.settings.grouping)
					.onChange(async (value) => {
						this.host.settings.grouping =
							value as MiseFlowSettings["grouping"];
						await this.host.saveSettings();
						this.host.manager.trigger("changed");
					}),
			);

		new Setting(containerEl)
			.setName("Auto-collapse completed sections")
			.setDesc(
				"Collapse a category or recipe section automatically once every item in it is checked off.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.autoCollapseCompleted)
					.onChange(async (value) => {
						this.host.settings.autoCollapseCompleted = value;
						await this.host.saveSettings();
					}),
			);

		// ── Categories ───────────────────────────────────────────────────
		new Setting(containerEl).setName("Categories").setHeading();

		new Setting(containerEl)
			.setName("Category source")
			.setDesc(
				"Where each grocery item's category comes from. Recipe tags use the trailing #tag on each ingredient line; dictionary uses the built-in keyword matcher.",
			)
			.addDropdown((dd) =>
				dd
					.addOptions({
						dictionary: "Built-in dictionary",
						tag: "Recipe tags",
						"tag-then-dictionary": "Recipe tags, then dictionary",
					})
					.setValue(this.host.settings.categorySource)
					.onChange(async (value) => {
						this.host.settings.categorySource =
							value as MiseFlowSettings["categorySource"];
						await this.host.saveSettings();
						this.host.manager.trigger("changed");
					}),
			);

		new Setting(containerEl)
			.setName("Sort categories alphabetically")
			.setDesc(
				"When on, categories are sorted a–z automatically. Turn off to set a custom order.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.categoryAutoSort)
					.onChange(async (value) => {
						this.host.settings.categoryAutoSort = value;
						await this.host.saveSettings();
						this.host.manager.trigger("changed");
						this.renderSettings();
					}),
			);

		if (!this.host.settings.categoryAutoSort) {
			new Setting(containerEl)
				.setName("Category order")
				.setDesc(
					"One category per line, in the order you want them to appear. Categories not listed here appear at the end alphabetically.",
				)
				.addTextArea((ta) => {
					ta.setPlaceholder(DEFAULT_CATEGORY_ORDER.join("\n"));
					ta.setValue(this.host.settings.categoryOrder.join("\n"));
					ta.inputEl.addClass("mise-settings-category-order-textarea");
					ta.onChange(async (value) => {
						this.host.settings.categoryOrder = value
							.split(/\r?\n/)
							.map((s) => s.trim())
							.filter(Boolean);
						await this.host.saveSettings();
						this.host.manager.trigger("changed");
					});
				});
		}

		{
			const s = new Setting(containerEl)
				.setName("Category overrides")
				.setDesc(
					"Force specific ingredients into a category, regardless of the dictionary or tags. Match is a case-insensitive substring of the ingredient name.",
				);
			s.settingEl.addClass("mise-settings-has-list");
			this.renderOverrideList(
				s.settingEl,
				this.host.settings.categoryOverrides,
				async (overrides) => {
					this.host.settings.categoryOverrides = overrides;
					await this.host.saveSettings();
					this.host.manager.trigger("changed");
				},
			);
		}

		new Setting(containerEl)
			.setName("Reset categories")
			.setDesc("Restore the default category order, re-enable alphabetical sorting, and remove all overrides.")
			.addButton((btn) =>
				btn.setButtonText("Reset").onClick(async () => {
					this.host.settings.categoryAutoSort = true;
					this.host.settings.categoryOrder = [...DEFAULT_CATEGORY_ORDER];
					this.host.settings.categoryOverrides = [];
					await this.host.saveSettings();
					this.renderSettings();
					this.host.manager.trigger("changed");
				}),
			);

		// ── Cooking & Tracking ───────────────────────────────────────────
		new Setting(containerEl).setName("Cooking & tracking").setHeading();

		new Setting(containerEl)
			.setName("Show mark as cooked button")
			.setDesc(
				"Show a button in the recipe view to manually record that you cooked a recipe, updating its last made date and cooked count.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showMarkCookedButton)
					.onChange(async (value) => {
						this.host.settings.showMarkCookedButton = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Cross off while cooking")
			.setDesc(
				"Click any ingredient or instruction step to cross it off while cooking. Resets when the note is reopened.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.crossOffWhileCooking)
					.onChange(async (value) => {
						this.host.settings.crossOffWhileCooking = value;
						await this.host.saveSettings();
					}),
			);


		new Setting(containerEl)
			.setName("Ask for date when marking cooked")
			.setDesc(
				"Open a date picker instead of using today's date when marking a recipe as cooked.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.markCookedAskDate)
					.onChange(async (value) => {
						this.host.settings.markCookedAskDate = value;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Track last made date")
			.setDesc(
				"Write today's date to a recipe's frontmatter when it's added to the meal plan. Powers the 'last made' badge in the recipe view.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.trackLastMade)
					.onChange(async (value) => {
						this.host.settings.trackLastMade = value;
						await this.host.saveSettings();
						this.renderSettings();
					}),
			);

		if (this.host.settings.trackLastMade) {
			new Setting(containerEl)
				.setName("Last made property")
				.setDesc(
					"Frontmatter property name used to store the last made date (yyyy-mm-dd).",
				)
				.addText((text) =>
					text
						.setPlaceholder("Last made")
						.setValue(this.host.settings.lastMadeProperty)
						.onChange(async (value) => {
							this.host.settings.lastMadeProperty =
								value.trim() || "lastMade";
							await this.host.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Track cooked count")
				.setDesc(
					"Increment a `cookedCount` frontmatter field each time a recipe is marked as cooked on a new day. Powers the cooking stats leaderboard.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.host.settings.trackCookedCount)
						.onChange(async (value) => {
							this.host.settings.trackCookedCount = value;
							await this.host.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Track cook history")
			.setDesc(
				"Append a dated entry to a cook history section inside the note body each time it is marked as cooked.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.trackCookHistory)
					.onChange(async (value) => {
						this.host.settings.trackCookHistory = value;
						await this.host.saveSettings();
						this.renderSettings();
					}),
			);

		if (this.host.settings.trackCookHistory) {
			new Setting(containerEl)
				.setName("Cook history heading")
				.setDesc(
					"Heading name used for the cook history section in the note body. Should match the heading in your recipe notes where you want the history to be appended (case-insensitive).",
				)
				.addText((text) =>
					text
						.setPlaceholder("Cook history")
						.setValue(this.host.settings.cookHistoryHeading)
						.onChange(async (value) => {
							this.host.settings.cookHistoryHeading =
								value.trim() || "Cook History";
							await this.host.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Prompt for notes when marking cooked")
				.setDesc(
					"Show a notes field in the mark-as-cooked modal. The text is appended to each history entry.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.host.settings.cookHistoryPromptNotes)
						.onChange(async (value) => {
							this.host.settings.cookHistoryPromptNotes = value;
							await this.host.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Track photos")
				.setDesc(
					"Show an image picker in the mark-as-cooked modal. The selected photo is saved as a vault attachment and embedded in the history entry.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.host.settings.cookHistoryTrackImages)
						.onChange(async (value) => {
							this.host.settings.cookHistoryTrackImages = value;
							await this.host.saveSettings();
						}),
				);
		}

		// ── Nutrition ────────────────────────────────────────────────────
		new Setting(containerEl).setName("Nutrition").setHeading();

		new Setting(containerEl)
			.setName("Nutrition display")
			.setDesc(
				"How nutrition values are shown in the recipe view — as per-serving numbers or as totals for the whole recipe.",
			)
			.addDropdown((dd) =>
				dd
					.addOptions({
						"per-serving": "Per serving",
						total: "Total",
					})
					.setValue(this.host.settings.nutritionDisplay)
					.onChange(async (value) => {
						this.host.settings.nutritionDisplay =
							value as MiseFlowSettings["nutritionDisplay"];
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Nutrition source")
			.setDesc(
				"Whether the nutrition values in your recipe frontmatter are totals for the whole recipe or already per serving.",
			)
			.addDropdown((dd) =>
				dd
					.addOptions({
						"recipe-total": "Recipe total",
						"per-serving": "Per serving",
					})
					.setValue(this.host.settings.nutritionSource)
					.onChange(async (value) => {
						this.host.settings.nutritionSource =
							value as MiseFlowSettings["nutritionSource"];
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Calories property")
			.setDesc("Frontmatter property name for the calories value.")
			.addText((text) =>
				text
					.setPlaceholder("Calories")
					.setValue(this.host.settings.caloriesProperty)
					.onChange(async (value) => {
						this.host.settings.caloriesProperty = value.trim() || "calories";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Protein property")
			.setDesc("Frontmatter property name for the protein value (grams).")
			.addText((text) =>
				text
					.setPlaceholder("Protein")
					.setValue(this.host.settings.proteinProperty)
					.onChange(async (value) => {
						this.host.settings.proteinProperty = value.trim() || "protein";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Fat property")
			.setDesc("Frontmatter property name for the fat value (grams).")
			.addText((text) =>
				text
					.setPlaceholder("Fat")
					.setValue(this.host.settings.fatProperty)
					.onChange(async (value) => {
						this.host.settings.fatProperty = value.trim() || "fat";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Carbs property")
			.setDesc("Frontmatter property name for the carbs value (grams).")
			.addText((text) =>
				text
					.setPlaceholder("Carbs")
					.setValue(this.host.settings.carbsProperty)
					.onChange(async (value) => {
						this.host.settings.carbsProperty = value.trim() || "carbs";
						await this.host.saveSettings();
					}),
			);

		// ── Meal Suggestions ─────────────────────────────────────────────
		new Setting(containerEl).setName("Meal suggestions").setHeading();

		new Setting(containerEl)
			.setName("Suggestion day window")
			.setDesc(
				"Recipes cooked within this many days are hidden from the meal suggester to encourage variety. Set to 0 to show all recipes.",
			)
			.addText((text) =>
				text
					.setPlaceholder("14")
					.setValue(String(this.host.settings.suggestionDayWindow))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isFinite(n) && n >= 0) {
							this.host.settings.suggestionDayWindow = Math.round(n);
							await this.host.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Suggestion count")
			.setDesc("How many recipe suggestions to show at once.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.host.settings.suggestionCount))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isFinite(n) && n >= 1) {
							this.host.settings.suggestionCount = Math.round(n);
							await this.host.saveSettings();
						}
					}),
			);

		// ── Health & Safety ─────────────────────────────────────────────
		new Setting(containerEl).setName("Health & safety").setHeading();

		new Setting(containerEl)
			.setName("Allergens property")
			.setDesc(
				"Frontmatter property that stores a recipe's allergens. Accepts both YAML lists and comma-separated text (e.g. Gluten, dairy).",
			)
			.addText((text) =>
				text
					.setPlaceholder("Allergens")
					.setValue(this.host.settings.allergensProperty)
					.onChange(async (value) => {
						this.host.settings.allergensProperty =
							value.trim() || "allergens";
						await this.host.saveSettings();
						this.host.manager.trigger("changed");
					}),
			);

		{
			const s = new Setting(containerEl)
				.setName("My allergens")
				.setDesc(
					"Recipes containing any of these allergens show a warning in the recipe view and shopping assistant.",
				);
			s.settingEl.addClass("mise-settings-has-list");
			this.renderStringList(
				s.settingEl,
				this.host.settings.myAllergens,
				"e.g. gluten",
				async (items) => {
					this.host.settings.myAllergens = items
						.map((s) => s.trim().toLowerCase())
						.filter(Boolean);
					await this.host.saveSettings();
					this.host.manager.trigger("changed");
				},
			);
		}

		new Setting(containerEl)
			.setName("Meat temperature warnings")
			.setDesc(
				"Show a safe internal temperature badge on meat ingredients in the recipe view.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showMeatTempWarnings)
					.onChange(async (value) => {
						this.host.settings.showMeatTempWarnings = value;
						await this.host.saveSettings();
					}),
			);



		new Setting(containerEl)
			.setName("High glycemic index warnings")
			.setDesc(
				"Show a high-gi badge on ingredients that may cause a rapid blood sugar spike. Informational only — not medical advice.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.diabeticMode)
					.onChange(async (value) => {
						this.host.settings.diabeticMode = value;
						await this.host.saveSettings();
						this.renderSettings();
					}),
			);

		if (this.host.settings.diabeticMode) {
			this.renderGiDictionarySetting(containerEl);
		}
	}

	// ── Private helpers ─────────────────────────────────────────────────────

	/**
	 * Renders a folder path list with per-item vault folder autocomplete.
	 */
	private renderFolderList(
		containerEl: HTMLElement,
		folders: string[],
		onChange: (folders: string[]) => Promise<void>,
	): void {
		this.renderStringList(containerEl, folders, "e.g. Recipes/", onChange, true);
	}

	private renderBadgeList(
		containerEl: HTMLElement,
		badges: CustomBadge[],
		onChange: (badges: CustomBadge[]) => Promise<void>,
	): void {
		const current: CustomBadge[] = badges.map(b => ({ ...b }));
		const listEl = containerEl.createDiv({ cls: "mise-settings-badge-list" });
		let dragIndex: number | null = null;

		const openModal = (badge: CustomBadge, onSave: (b: CustomBadge) => Promise<void>): void => {
			new BadgeEditModal(this.app, badge, onSave).open();
		};

		const renderRows = (): void => {
			listEl.empty();

			for (let i = 0; i < current.length; i++) {
				const entry = current[i]!;
				const isSeparator = entry.type === "separator";
				const isNewline = entry.type === "newline";
				const row = listEl.createDiv({ cls: "mise-settings-badge-row" });
				row.setAttribute("draggable", "true");

				const handle = row.createSpan({ cls: "mise-settings-badge-handle", attr: { title: "Drag to reorder" } });
				setIcon(handle, "grip-vertical");

				const info = row.createDiv({ cls: "mise-settings-badge-info" });
				if (isSeparator) {
					info.createSpan({ cls: "mise-settings-badge-separator-char", text: entry.label || "·" });
					info.createSpan({ cls: "mise-settings-badge-label-preview", text: "Separator" });
					info.addEventListener("click", () => {
						new SeparatorEditModal(this.app, { ...entry }, async (updated) => {
							current[i] = { ...current[i]!, label: updated.label };
							await onChange([...current]);
							renderRows();
						}).open();
					});
				} else if (isNewline) {
					const icon = info.createSpan({ cls: "mise-settings-badge-newline-icon" });
					setIcon(icon, "corner-down-left");
					info.createSpan({ cls: "mise-settings-badge-label-preview", text: "New line" });
				} else {
					if (entry.formula) {
						info.createSpan({ cls: "mise-settings-badge-property mise-settings-badge-formula-tag", text: "ƒ" });
						const preview = entry.formula.length > 40 ? entry.formula.slice(0, 40) + "…" : entry.formula;
						info.createSpan({ cls: entry.label ? "mise-settings-badge-property" : "mise-settings-badge-label-preview", text: entry.label || preview });
						if (entry.label) info.createSpan({ cls: "mise-settings-badge-label-preview", text: preview });
					} else {
						info.createSpan({ cls: "mise-settings-badge-property", text: entry.property || "(no property)" });
						if (entry.label) {
							info.createSpan({ cls: "mise-settings-badge-label-preview", text: entry.label });
						}
					}
					info.addEventListener("click", () => {
						openModal({ ...entry }, async (updated) => {
							current[i] = updated;
							await onChange([...current]);
							renderRows();
						});
					});
				}

				const enabledInput = row.createEl("input", { type: "checkbox", cls: "mise-settings-badge-checkbox" });
				enabledInput.checked = entry.enabled;
				enabledInput.setAttribute("title", entry.enabled ? "Visible" : "Hidden");
				enabledInput.addEventListener("change", () => {
					current[i] = { ...current[i]!, enabled: enabledInput.checked };
					void onChange([...current]);
				});

				const removeBtn = row.createEl("button", {
					cls: "mise-settings-badge-icon-btn clickable-icon",
					attr: { type: "button", "aria-label": "Remove badge" },
				});
				setIcon(removeBtn, "trash-2");
				removeBtn.addEventListener("click", () => {
					current.splice(i, 1);
					void onChange([...current]);
					renderRows();
				});

				// ── Drag and drop ──
				row.addEventListener("dragstart", (e) => {
					dragIndex = i;
					row.classList.add("is-dragging");
					if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				});
				row.addEventListener("dragend", () => {
					row.classList.remove("is-dragging");
					dragIndex = null;
					listEl.querySelectorAll(".mise-settings-badge-row").forEach(r => r.classList.remove("drag-over"));
				});
				row.addEventListener("dragover", (e) => {
					e.preventDefault();
					if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
					if (dragIndex !== null && dragIndex !== i) row.classList.add("drag-over");
				});
				row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
				row.addEventListener("drop", (e) => {
					e.preventDefault();
					row.classList.remove("drag-over");
					if (dragIndex !== null && dragIndex !== i) {
						const [moved] = current.splice(dragIndex, 1);
						current.splice(i, 0, moved!);
						void onChange([...current]);
						renderRows();
					}
					dragIndex = null;
				});
			}

			const footer = listEl.createDiv({ cls: "mise-settings-badge-footer" });

			const addBtn = footer.createEl("button", {
				cls: "mise-settings-list-add",
				attr: { type: "button" },
			});
			addBtn.setText("+ add badge");
			addBtn.addEventListener("click", () => {
				openModal(
					{ property: "", label: "", icon: "", color: "default", valueType: "auto", prefix: "", suffix: "", splitArray: false, enabled: true },
					async (newBadge) => {
						current.push(newBadge);
						await onChange([...current]);
						renderRows();
					},
				);
			});

			const addSepBtn = footer.createEl("button", { cls: "mise-settings-list-add", attr: { type: "button" } });
			addSepBtn.setText("+ separator");
			addSepBtn.addEventListener("click", () => {
				const newSep: CustomBadge = { type: "separator", property: "", label: "·", icon: "", color: "default", valueType: "auto", prefix: "", suffix: "", splitArray: false, enabled: true };
				new SeparatorEditModal(this.app, newSep, async (updated) => {
					current.push({ ...newSep, label: updated.label });
					await onChange([...current]);
					renderRows();
				}).open();
			});

			const addNlBtn = footer.createEl("button", { cls: "mise-settings-list-add", attr: { type: "button" } });
			addNlBtn.setText("+ new line");
			addNlBtn.addEventListener("click", () => {
				current.push({ type: "newline", property: "", label: "", icon: "", color: "default", valueType: "auto", prefix: "", suffix: "", splitArray: false, enabled: true });
				renderRows();
				void onChange([...current]);
			});

			const resetBtn = footer.createEl("button", {
				cls: "mise-settings-badge-reset",
				attr: { type: "button" },
			});
			resetBtn.setText("Reset to defaults");
			let resetPending = false;
			resetBtn.addEventListener("click", () => {
				if (!resetPending) {
					resetPending = true;
					resetBtn.setText("Confirm reset?");
					resetBtn.classList.add("is-warning");
					window.setTimeout(() => {
						if (resetPending) {
							resetPending = false;
							resetBtn.setText("Reset to defaults");
							resetBtn.classList.remove("is-warning");
						}
					}, 3000);
				} else {
					resetPending = false;
					current.splice(0, current.length, ...DEFAULT_SETTINGS.customBadges.map(b => ({ ...b })));
					renderRows();
					void onChange([...current]);
				}
			});
		};

		renderRows();
	}

	/**
	 * Renders an add/remove string list. When `folderSuggest` is true,
	 * attaches a FolderSuggest to each input for vault folder autocomplete.
	 */
	private renderStringList(
		containerEl: HTMLElement,
		items: string[],
		placeholder: string,
		onChange: (items: string[]) => Promise<void>,
		folderSuggest = false,
	): void {
		const current = [...items];
		const listEl = containerEl.createDiv({ cls: "mise-settings-list" });

		const renderRows = (): void => {
			listEl.empty();

			for (let i = 0; i < current.length; i++) {
				const row = listEl.createDiv({ cls: "mise-settings-list-row" });
				const input = row.createEl("input", {
					cls: "mise-settings-list-input",
					type: "text",
					value: current[i] ?? "",
					attr: { placeholder },
				});

				if (folderSuggest) {
					new FolderSuggest(this.app, input);
				}

				input.addEventListener("change", () => {
					current[i] = input.value.trim();
					void onChange(current.filter(Boolean));
				});

				const removeBtn = row.createEl("button", {
					cls: "mise-settings-list-remove clickable-icon",
					attr: { type: "button", "aria-label": "Remove" },
				});
				removeBtn.setText("×");
				removeBtn.addEventListener("click", () => {
					current.splice(i, 1);
					void onChange([...current]);
					renderRows();
				});
			}

			const addRow = listEl.createDiv({ cls: "mise-settings-list-add-row" });
			const addBtn = addRow.createEl("button", {
				cls: "mise-settings-list-add",
				attr: { type: "button" },
			});
			addBtn.setText("+ add");
			addBtn.addEventListener("click", () => {
				current.push("");
				renderRows();
				// Focus the new input.
				const inputs = listEl.querySelectorAll<HTMLInputElement>(
					".mise-settings-list-input",
				);
				inputs[inputs.length - 1]?.focus();
			});
		};

		renderRows();
	}

	/**
	 * Renders an add/remove list of CategoryOverride rows.
	 * Each row has two inputs: match (substring) and category.
	 */
	private renderOverrideList(
		containerEl: HTMLElement,
		overrides: CategoryOverride[],
		onChange: (overrides: CategoryOverride[]) => Promise<void>,
	): void {
		const current: CategoryOverride[] = overrides.map((o) => ({ ...o }));
		const listEl = containerEl.createDiv({ cls: "mise-settings-list" });
		const knownCategories = this.host.manager.getKnownCategories();

		// Build a datalist for category autocomplete.
		const datalistId = "mise-category-datalist";
		let datalist = containerEl.querySelector<HTMLDataListElement>(
			`#${datalistId}`,
		);
		if (!datalist) {
			datalist = containerEl.createEl("datalist");
			datalist.id = datalistId;
		}
		datalist.empty();
		for (const cat of knownCategories) {
			datalist.createEl("option", { value: cat });
		}

		const renderRows = (): void => {
			listEl.empty();

			for (let i = 0; i < current.length; i++) {
				const entry = current[i]!;
				const row = listEl.createDiv({
					cls: "mise-settings-list-row mise-settings-override-row",
				});

				const matchInput = row.createEl("input", {
					cls: "mise-settings-list-input",
					type: "text",
					value: entry.match,
					attr: { placeholder: "E.g. Chicken" },
				});

				row.createSpan({ cls: "mise-settings-override-arrow", text: "→" });

				const categoryInput = row.createEl("input", {
					cls: "mise-settings-list-input",
					type: "text",
					value: entry.category,
					attr: {
						placeholder: "E.g. Meat",
						list: datalistId,
					},
				});

				const save = async (): Promise<void> => {
					const m = matchInput.value.trim();
					const c = categoryInput.value.trim();
					if (m && c) {
						current[i] = { match: m, category: c };
						await onChange([...current]);
					}
				};

				matchInput.addEventListener("change", () => void save());
				categoryInput.addEventListener("change", () => void save());

				const removeBtn = row.createEl("button", {
					cls: "mise-settings-list-remove clickable-icon",
					attr: { type: "button", "aria-label": "Remove override" },
				});
				removeBtn.setText("×");
				removeBtn.addEventListener("click", () => {
					current.splice(i, 1);
					void onChange([...current]);
					renderRows();
				});
			}

			const addRow = listEl.createDiv({ cls: "mise-settings-list-add-row" });
			const addBtn = addRow.createEl("button", {
				cls: "mise-settings-list-add",
				attr: { type: "button" },
			});
			addBtn.setText("+ add override");
			addBtn.addEventListener("click", () => {
				current.push({ match: "", category: "" });
				renderRows();
				const inputs = listEl.querySelectorAll<HTMLInputElement>(
					".mise-settings-list-input",
				);
				inputs[inputs.length - 2]?.focus();
			});
		};

		renderRows();
	}

	private renderGiDictionarySetting(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("High glycemic index dictionary")
			.setDesc(
				"One regex per line, case-insensitive. Lines starting with # are comments. Matched ingredient names show an up-arrow badge in the recipe view. Gi values vary by source — informational only, not medical advice.",
			);

		const errorEl = containerEl.createDiv({
			cls: "mise-settings-gi-errors",
		});

		setting.addTextArea((ta) => {
			ta.setValue(this.host.settings.giDictionary);
			ta.inputEl.rows = 12;
			ta.inputEl.addClass("mise-settings-gi-textarea");
			ta.onChange(async (value) => {
				this.host.settings.giDictionary = value;
				await this.host.saveSettings();
				renderErrors(errorEl, validateGiDictionary(value));
			});
		});

		renderErrors(
			errorEl,
			validateGiDictionary(this.host.settings.giDictionary),
		);

		new Setting(containerEl)
			.setName("Reset gi dictionary")
			.setDesc("Restore the shipped list of commonly cited high-gi foods.")
			.addButton((btn) =>
				btn.setButtonText("Reset").onClick(async () => {
					this.host.settings.giDictionary = DEFAULT_GI_DICTIONARY;
					await this.host.saveSettings();
					this.renderSettings();
				}),
			);
	}
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function createMomentDesc(prefix: string): string {
	const frag = activeDocument.createDocumentFragment();
	frag.appendText(`${prefix} `);
	const link = frag.createEl("a", {
		text: "Moment.js format tokens",
		href: "https://momentjs.com/docs/#/displaying/format/",
		attr: { target: "_blank", rel: "noopener" },
	});
	frag.appendChild(link);
	frag.appendText(" supported, e.g. Meal Plan {YYYY-MM-DD}.md.");
	return frag.textContent || "";

}

function renderErrors(container: HTMLElement, errors: readonly string[]): void {
	container.empty();
	if (errors.length === 0) return;
	container.createDiv({
		cls: "mise-settings-gi-errors-title",
		text: `${errors.length} invalid pattern${errors.length === 1 ? "" : "s"} (skipped):`,
	});
	const list = container.createEl("ul", {
		cls: "mise-settings-gi-errors-list",
	});
	for (const err of errors) {
		list.createEl("li", { text: err });
	}
}
