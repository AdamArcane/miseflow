import { Notice, Plugin, TFile } from "obsidian";
import { GroceryListManager } from "../grocery/manager";
import { MiseFlowSettings } from "../settings";
import { AddOneOffModal } from "../ui/add-item-modal";
import { AddToMealPlanModal } from "../ui/add-to-meal-plan-modal";
import { ExportListModal } from "../ui/export-modal";
import { ImportRecipeModal, ImportRecipeHost } from "../ui/import-recipe-modal";
import { LeaderboardModal } from "../ui/leaderboard-modal";
import { SuggestMealModal } from "../ui/suggest-modal";

export interface CommandsHost {
	plugin: Plugin;
	manager: GroceryListManager;
	settings: MiseFlowSettings;
	saveSettings(): Promise<void>;
	openView(): Promise<void>;
	openCurrentAsRecipe(): Promise<void>;
	openCurrentAsMarkdown(): Promise<void>;
}


export function registerCommands(host: CommandsHost): void {
	const { plugin, manager } = host;

	plugin.addCommand({
		id: "open-grocery-list",
		name: "Shopping assistant",
		callback: () => {
			void host.openView();
		},
	});

	plugin.addCommand({
		id: "refresh-grocery-list",
		name: "Sync grocery list from meal plan note",
		callback: async () => {
			await manager.syncFromMealPlanNote();
			new Notice("Meal plan synced.");
		},
	});

	plugin.addCommand({
		id: "clear-grocery-list",
		name: "Clear meal plan and grocery list",
		callback: async () => {
			await manager.clearAll();
		},
	});

	plugin.addCommand({
		id: "reset-grocery-checks",
		name: "Reset grocery list checks",
		callback: async () => {
			await manager.resetChecks();
			new Notice("Grocery list checks reset.");
		},
	});

	plugin.addCommand({
		id: "add-one-off-item",
		name: "Add one-off grocery item",
		callback: () => {
			new AddOneOffModal(plugin.app, manager).open();
		},
	});

	plugin.addCommand({
		id: "toggle-meal-plan",
		name: "Add/remove this recipe from meal plan",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || file.extension !== "md") {
				return false;
			}
			if (checking) return true;
			const isInPlan = manager
				.getMealPlanEntries()
				.some((e) => e.recipePath === file.path);
			if (isInPlan) {
				void manager.removeFromMealPlan(file.path).then(() => {
					new Notice(`${file.basename} removed from meal plan.`);
				});
			} else {
				new AddToMealPlanModal(plugin.app, file, {
					getSettings: () => host.settings,
					onConfirm: async (day, mealType, contributions) => {
						await manager.addToMealPlan(
							file.path,
							day,
							mealType,
							contributions,
						);
						new Notice(`${file.basename} added to meal plan.`);
					},
				}).open();
			}
			return true;
		},
	});

	plugin.addCommand({
		id: "open-as-recipe",
		name: "Open as recipe",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || file.extension !== "md") {
				return false;
			}
			if (checking) return true;
			void host.openCurrentAsRecipe();
			return true;
		},
	});

	plugin.addCommand({
		id: "open-as-markdown",
		name: "Open as Markdown",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || file.extension !== "md") {
				return false;
			}
			if (checking) return true;
			void host.openCurrentAsMarkdown();
			return true;
		},
	});

	plugin.addCommand({
		id: "suggest-meal",
		name: "Suggest a meal",
		callback: () => {
			new SuggestMealModal(plugin.app, {
				getSettings: () => host.settings,
				manager,
			}).open();
		},
	});

	plugin.addCommand({
		id: "show-cooking-stats",
		name: "Show cooking stats",
		callback: () => {
			new LeaderboardModal(plugin.app, {
				getSettings: () => host.settings,
			}).open();
		},
	});

	plugin.addCommand({
		id: "export-grocery-list",
		name: "Export grocery list",
		callback: () => {
			new ExportListModal(plugin.app, {
				getSettings: () => host.settings,
				manager,
			}).open();
		},
	});

	const importHost: ImportRecipeHost = {
		getSettings: () => host.settings,
		saveSettings: () => host.saveSettings(),
	};

	plugin.addCommand({
		id: "import-recipe",
		name: "Import recipe",
		callback: () => {
			new ImportRecipeModal(plugin.app, importHost).open();
		},
	});
}
