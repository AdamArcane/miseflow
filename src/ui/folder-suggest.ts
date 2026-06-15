import { AbstractInputSuggest, App, TFile, TFolder } from "obsidian";

/**
 * Autocomplete for vault folder paths.
 *
 * Pass `onPick` if the consumer needs to react when the user picks a suggestion
 * (e.g. to update a state variable that onChange won't catch).
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly onPick?: (path: string) => void | Promise<void>,
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		return this.app.vault
			.getAllFolders(true)
			.filter((f) => f.path.toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path || "(vault root)");
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		void this.onPick?.(folder.path);
		this.close();
	}
}

/** Autocomplete for vault markdown file paths (notes). */
export class FileSuggest extends AbstractInputSuggest<TFile> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly onPick?: (path: string) => void | Promise<void>,
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.setValue(file.path);
		void this.onPick?.(file.path);
		this.close();
	}
}
