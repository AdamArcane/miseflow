import { App, FuzzySuggestModal, TFile } from "obsidian";

const IMAGE_EXTENSIONS = new Set([
	"jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "heic", "heif",
]);

export class VaultImageSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onSelect: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("Search vault images…");
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onSelect(file);
	}
}
