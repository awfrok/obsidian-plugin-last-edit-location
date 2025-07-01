// Import necessary classes and functions from the Obsidian API.
import { 
    App,                 // The main application object, giving access to the workspace, vault, etc.
    Editor,              // The editor object, for interacting with the text content.
    MarkdownView,        // A view that displays a Markdown file.
    Plugin,              // The base class all plugins must extend.
    TFile,               // Represents a file in the vault.
    PluginSettingTab,    // The base class for creating a settings tab.
    Setting,             // A component for creating a setting UI element.
    Notice               // A function to show a temporary notification to the user.
} from 'obsidian';
import { v1 as uuidv1 } from 'uuid'; // Import the v1 function from the uuid package.

// Define the structure for our plugin's settings that are saved to disk.
interface LastEditLineSettings {
	isPluginEnabled: boolean;
	identifierSource: 'plugin-generated-UUID' | 'user-provided-field';
	generatedIdName: string;
	userProvidedIdName: string;
	includedFolders: string;
	cursorPosition: Record<string, {line: number, ch: number}>; // Store both line and character number for precise cursor position.
}

// Define the default settings that will be used when the plugin is first installed
// or when the settings data is missing or corrupted.
const DEFAULT_SETTINGS: LastEditLineSettings = {
	isPluginEnabled: false,
	identifierSource: 'plugin-generated-UUID',
	generatedIdName: '', // No default ID name, user must set it.
	userProvidedIdName: '',
	includedFolders: '',
	cursorPosition: {},
};

// This is the main class for our plugin. It extends the base Plugin class from Obsidian.
export default class LastEditLinePlugin extends Plugin {
	settings: LastEditLineSettings;
	// This Set tracks which files have had their cursor restored in the current session.
	// It is temporary and resets every time Obsidian is restarted.
	private restoredInCurrentSession: Set<string>;
	// This holds the debounced version of our save function to improve performance.
	private debouncedSave: () => void;

	/**
	 * This is the entry point of the plugin. It runs when the plugin is enabled.
	 */
	async onload() {
		// Load the saved settings from the disk.
		await this.loadSettings();
		
		// Initialize the session-only set for tracking restored files.
		this.restoredInCurrentSession = new Set<string>();

		// Add a settings tab to Obsidian's settings window.
		this.addSettingTab(new LastEditLineSettingTab(this.app, this));

		// Create a "debounced" version of our saveSettings function.
		// This prevents the plugin from saving to disk on every single keystroke,
		// which would be inefficient. It will only save, at most, once every 2 seconds.
		this.debouncedSave = debounce(() => this.saveSettings(), 2000, true);
		
		// `onLayoutReady` fires once the UI is ready. This is the best time to handle the
		// file that's open on startup and to register our event listeners to prevent race conditions.
		this.app.workspace.onLayoutReady(() => {
			// This event handles all edits. We register it here to ensure it only
			// starts listening after the workspace is fully loaded.
			this.registerEvent(
				this.app.workspace.on('editor-change', (editor, markdownView) => {
					this.saveCursorPosition(editor, markdownView.file);
				})
			);

			// This event handles all subsequent file opens after the initial load.
			this.registerEvent(
				this.app.workspace.on('file-open', (file) => {
					this.handleFileOpen(file);
				})
			);
			
			// Handle the very first file that's open on startup.
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				this.handleFileOpen(activeFile);
			}
		});
	}
	
	/**
	 * This function runs when the plugin is disabled.
	 * We can clean up any resources here if needed.
	 */
	onunload() {}

	/**
	 * Handles the logic for opening a file, checking if the cursor should be restored.
	 * @param file The file that was just opened.
	 */
	private async handleFileOpen(file: TFile | null) {
		if (!file) return;
		const idName = this.getCurrentIdName();
		if (!idName) return;

		const fileUUID = await this.ensureFileUUID(file);
		if (!fileUUID) return;

		// If the file's UUID is not in our session list, it means this is the first time
		// opening it in this session, so we should restore the cursor.
		if (!this.restoredInCurrentSession.has(fileUUID)) {
			// Use a timeout to ensure the editor is fully ready
			setTimeout(() => {
				this.restoreCursorPosition(file);
				// Mark this file's UUID as "restored" for this session to prevent it from running again.
				this.restoredInCurrentSession.add(fileUUID);
			}, 10);
		}
	}

	/**
	 * Loads the plugin's data from the `data.json` file in the plugin's directory.
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/**
	 * Saves the plugin's current settings to the `data.json` file.
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Checks if a given file is located in one of the user-defined included folders.
	 * @param file The TFile to check.
	 * @returns True if the file should be included, false otherwise.
	 */
	isFileIncluded(file: TFile): boolean {
		const includedFolders = this.settings.includedFolders.split('\n').map(f => f.trim()).filter(f => f);
		if (includedFolders.length === 0) return false; // Plugin is inactive if list is empty
		if (includedFolders.includes('*')) return true; // Wildcard for the entire vault

		for (const folder of includedFolders) {
			if (folder === '/') {
				// Special case for root folder: path should not contain any slashes.
				if (!file.path.includes('/')) return true;
			} else if (folder.endsWith('/*')) {
				// Deep include: folder and all its subfolders.
				const basePath = folder.slice(0, -2);
				if (file.path.startsWith(basePath + '/')) return true;
			} else {
				// Shallow include: folder only, no subfolders.
				if (file.path.startsWith(folder + '/')) {
					const remainingPath = file.path.substring(folder.length + 1);
					if (!remainingPath.includes('/')) return true;
				}
			}
		}
		return false; // File is not in any of the included locations.
	}

	/**
	 * Saves the current cursor's line and character number for the given file.
	 * @param editor The active editor instance.
	 * @param file The file being edited.
	 */
	async saveCursorPosition(editor: Editor, file: TFile | null) {
		// Check master switch and if a file is actually open.
		if (!this.settings.isPluginEnabled || !file) return;

		// Check if the current file is in an included folder.
		if (!this.isFileIncluded(file)) return;

		// Get or create the unique ID for the file.
		const fileUUID = await this.ensureFileUUID(file);
		if (!fileUUID) return;

		// Get the current cursor position from the editor.
		const cursor = editor.getCursor();
		// Store the entire cursor position object (line and character).
		this.settings.cursorPosition[fileUUID] = { line: cursor.line, ch: cursor.ch };
		
		// Call the debounced save function to write the settings to disk.
		this.debouncedSave();
	}

	/**
	 * Restores the cursor to the last known position for the given file and centers the view.
	 * @param file The file that was just opened.
	 */
	async restoreCursorPosition(file: TFile) {
		// Check master switch and if file is in an included folder.
		if (!this.settings.isPluginEnabled || !this.isFileIncluded(file)) return;

		// Get the file's unique ID.
		const fileUUID = await this.ensureFileUUID(file);
		if (!fileUUID) return;

		// Retrieve the saved position object from settings.
		const savedPosition = this.settings.cursorPosition[fileUUID];
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		// Proceed only if we have a saved position and an active editor.
		if (savedPosition !== undefined && view && view.editor) {
			const editor = view.editor;
			// Sanity check: make sure the saved line number is still valid.
			if (savedPosition.line <= editor.lastLine()) {
				// Set the cursor to the exact saved line and character.
				editor.setCursor({ line: savedPosition.line, ch: savedPosition.ch });
                // Scroll the editor to place the cursor's line in the vertical center.
                editor.scrollIntoView({ from: { line: savedPosition.line, ch: 0 }, to: { line: savedPosition.line, ch: 0 } }, true);
			}
		}
	}
	
	/**
	 * Gets the currently active ID field name based on the user's settings.
	 * @returns The active ID field name as a string.
	 */
	public getCurrentIdName(): string {
		if (this.settings.identifierSource === 'plugin-generated-UUID') {
			return this.settings.generatedIdName;
		} else {
			return this.settings.userProvidedIdName;
		}
	}

	/**
	 * Gets the unique ID from a file's frontmatter. If it doesn't exist, it creates one,
	 * but only if the 'plugin-generated-UUID' source is selected.
	 * @param file The file to process.
	 * @returns The unique ID of the file, or an empty string if none is found/created.
	 */
	private async ensureFileUUID(file: TFile): Promise<string> {
		const idName = this.getCurrentIdName();
		if (!idName) return '';

		let fileUUID = '';
		// Use processFrontMatter to safely read and modify the file's metadata.
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (frontmatter && frontmatter[idName]) {
				// If the ID already exists, just grab it.
				fileUUID = String(frontmatter[idName]);
			} else if (this.settings.identifierSource === 'plugin-generated-UUID') {
				// If it doesn't exist and the settings allow it, create a new V1 UUID.
				const newUUID = uuidv1();
				frontmatter[idName] = newUUID;
				fileUUID = newUUID;
			}
		});
		return fileUUID;
	}
}

/**
 * A helper function that limits how often another function can be executed.
 * @param func The function to debounce.
 * @param wait The time to wait in milliseconds.
 * @param immediate If true, trigger the function on the leading edge instead of the trailing.
 */
function debounce(func: (...args: any[]) => any, wait: number, immediate: boolean = false) {
    let timeout: NodeJS.Timeout | null;
    return function(this: any, ...args: any[]) {
        const context = this;
        const later = function() {
            timeout = null;
            if (!immediate) func.apply(context, args);
        };
        const callNow = immediate && !timeout;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(context, args);
    };
}

// Defines the settings tab for the plugin.
class LastEditLineSettingTab extends PluginSettingTab {
	plugin: LastEditLinePlugin;

	constructor(app: App, plugin: LastEditLinePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		
		new Setting(containerEl)
			.setName('Enable or disable the plugin')
			.setDesc('This will be turned off automatically unless an ID name is specified.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.isPluginEnabled)
				.onChange((value) => {
					this.plugin.settings.isPluginEnabled = value;
				}));
		
		containerEl.createEl('h2', { text: 'Set an unique identifier' });

		new Setting(containerEl)
			.setName('Source')
			.setDesc('Choose whether the plugin should generate a unique ID or use an existing field you provide. Then, give an id name in either of the following two options in accordance with this option.')
			.addDropdown(dropdown => dropdown
				.addOption('plugin-generated-UUID', 'Option A. Plugin generated UUID')
				.addOption('user-provided-field', 'Option B. User provided field')
				.setValue(this.plugin.settings.identifierSource)
				.onChange((value: 'plugin-generated-UUID' | 'user-provided-field') => {
					this.plugin.settings.identifierSource = value;
					this.display(); // Re-render to enable/disable the correct text field.
				}));

		new Setting(containerEl)
			.setName('Option A. ID name for plugin generated UUID')
			.setDesc("Give a field name in which's value the plugin will add the generated UUID. • Required when 'Source' is set to 'Option A. Plugin generated UUID'.")
			.addText(text => {
				text
					.setPlaceholder('e.g., uuid or uid or id')
					.setValue(this.plugin.settings.generatedIdName)
					.setDisabled(this.plugin.settings.identifierSource !== 'plugin-generated-UUID')
					.onChange(value => this.plugin.settings.generatedIdName = value.trim());
			});

		new Setting(containerEl)
			.setName('Option B. ID name for user provided field')
			.setDesc("Choose an existing field name from the front matter to use as an unique ID for the note (e.g., 'created', 'title'). • This option is for those who do not want to add UUID to the front matter. The plugin will not generate any field name or value. So, if the plugin cannot find the field name in the front matter, the plugin does not save the cursor position. • Required when 'Source' is set to 'Option B. User provided field name'.")
			.addText(text => {
				text
					.setPlaceholder('e.g., created or title')
					.setValue(this.plugin.settings.userProvidedIdName)
					.setDisabled(this.plugin.settings.identifierSource !== 'user-provided-field')
					.onChange(value => this.plugin.settings.userProvidedIdName = value.trim());
			});

		containerEl.createEl('h2', { text: 'Specify where the plugin operates' });

		new Setting(containerEl)
			.setName('List folders')
			.setDesc("Choose folders where the plugin will be active. Provide one path per line. \n• `Folder` includes only notes inside `Folder`.\n• `Folder/*` includes notes inside `Folder` and all its subfolders.\n• `/` includes only notes in the vault's root.\n• `*` includes all notes in the entire vault.\nIf this list is empty, the plugin will not function.")
			.addTextArea(text => {
				text
					.setPlaceholder('e.g.,\n*\n/\nFolder\nFolder/*')
					.setValue(this.plugin.settings.includedFolders)
					.onChange(value => this.plugin.settings.includedFolders = value);
				text.inputEl.style.minHeight = '120px';
			});

		containerEl.createEl('h2', { text: 'Manage data' });

		new Setting(containerEl)
			.setName('Clean up the unnecessary')
			.setDesc("Remove saved line data for notes that no longer exist or are not in the 'Include folders' list above. Requires an 'ID name' to be set.")
			.addButton(button => {
				button
					.setButtonText('Remove Now')
					.setDisabled(!this.plugin.getCurrentIdName())
					.onClick(async () => {
						button.setButtonText('Cleaning...').setDisabled(true);
						
						const idName = this.plugin.getCurrentIdName();
						const allFiles = this.app.vault.getMarkdownFiles();
						const validUUIDs = new Set<string>();

						for (const file of allFiles) {
							if (this.plugin.isFileIncluded(file)) {
								const cachedFrontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
								if (cachedFrontmatter && cachedFrontmatter[idName]) {
									validUUIDs.add(String(cachedFrontmatter[idName]));
								}
							}
						}
				
						const savedUUIDs = Object.keys(this.plugin.settings.cursorPosition);
						let cleanedCount = 0;
				
						for (const savedUUID of savedUUIDs) {
							if (!validUUIDs.has(savedUUID)) {
								delete this.plugin.settings.cursorPosition[savedUUID];
								cleanedCount++;
							}
						}
				
						await this.plugin.saveSettings();
						new Notice(`Removed data for ${cleanedCount} deleted or excluded note(s).`);
						button.setButtonText('Remove Now').setDisabled(false);
					});
			});
	}

	/**
	 * This method is called when the user leaves the settings tab.
	 * All changes are saved at this point.
	 */
	hide(): void {
		// If no ID name is configured for the active source, disable the plugin.
		if (!this.plugin.getCurrentIdName()) {
			this.plugin.settings.isPluginEnabled = false;
		}
		this.plugin.saveSettings();
	}
}
