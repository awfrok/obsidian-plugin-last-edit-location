//
// v 0.1.3.1
//

// Import necessary classes and functions from the Obsidian API.
import { 
    App,              // The main application object, giving access to the workspace, vault, etc.
    Editor,           // The editor object, for interacting with the text content.
    MarkdownView,     // A view that displays a Markdown file.
    Plugin,           // The base class all plugins must extend.
    TFile,            // Represents a file in the vault.
    PluginSettingTab, // The base class for creating a settings tab.
    Setting,          // A component for creating a setting UI element.
    Notice            // A function to show a temporary notification to the user.
} from 'obsidian';
import { v1 as uuidv1 } from 'uuid'; // Import the v1 function from the uuid package to generate unique identifiers.

// Define the structure for our plugin's settings that are saved to disk.
// This interface ensures type safety for the settings object.
interface LastEditLocationSettings {
    identifierSource: 'plugin-generated-UUID' | 'user-provided-field' | 'file-path'; // Determines how notes are uniquely identified.
    generatedIdName: string; // The frontmatter key to use when the plugin generates the UUID.
    userProvidedIdName: string; // The frontmatter key to use when the user provides the identifier.
    includedFolders: string; // A newline-separated string of folder paths where the plugin should be active.
    // A dictionary-like object mapping a file's unique ID to its last known cursor position.
    cursorPosition: Record<string, {line: number, ch: number}>; // 'ch' stands for character.
}


// Define the default settings that will be used when the plugin is first installed
// or when the settings data file (`data.json`) is missing or corrupted.
const DEFAULT_SETTINGS: LastEditLocationSettings = {
    identifierSource: 'plugin-generated-UUID', // Default to the plugin generating the ID.
    generatedIdName: '', // User must explicitly provide a name for the ID field.
    userProvidedIdName: '',
    includedFolders: '', // Plugin is inactive by default until folders are specified.
    cursorPosition: {}, // Starts with no saved positions.
};


// Centralized constants for easy maintenance.
const PLUGIN_CONSTANTS = {
    COMMANDS: {
        SCROLL_TO_CENTER: {
            id: 'scroll-cursor-line-to-center',
            name: 'Scroll cursor line to center of view',
        },
        GO_TO_LAST_EDIT: {
            id: 'go-to-last-edit-location',
            name: 'Go to last edit location',
        },
    },
    DEBOUNCE_SAVE_DELAY: 2000,
    RESTORE_CURSOR_DELAY: 10,
};


// This is the main class for our plugin. It extends the base Plugin class from Obsidian,
// inheriting its lifecycle methods like `onload` and `onunload`.
export default class LastEditLocationPlugin extends Plugin {
    settings: LastEditLocationSettings; // This will hold the currently loaded settings.

    // This Set tracks which files have had their cursor restored in the current session.
    // It prevents the cursor from being moved every time a file is focused.
    // It is temporary and resets every time Obsidian is restarted.
    private restoredInCurrentSession: Set<string>;

    // This holds the debounced version of our save function to improve performance
    // by limiting how often we write to the disk.
    private debouncedSave: () => void;

    /**
     * This is the entry point of the plugin. It runs when the plugin is loaded (e.g., on Obsidian startup or when enabled by the user).
     */
    async onload() {
        // Load the saved settings from the `data.json` file in the plugin's directory.
        await this.loadSettings();

        // Add a command to scroll the current cursor line to the vertical center of the view.
        // This is independent of the main plugin functionality.
        this.addCommand({
            id: PLUGIN_CONSTANTS.COMMANDS.SCROLL_TO_CENTER.id,
            name: PLUGIN_CONSTANTS.COMMANDS.SCROLL_TO_CENTER.name,
            editorCallback: (editor: Editor) => {
                const { line } = editor.getCursor();
                editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
            }
        });

        // Add a command to move the cursor to the last saved edit location and scroll it into view.
        this.addCommand({
            id: PLUGIN_CONSTANTS.COMMANDS.GO_TO_LAST_EDIT.id,
            name: PLUGIN_CONSTANTS.COMMANDS.GO_TO_LAST_EDIT.name,
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                const file = view.file;
                if (!file) {
                    new Notice("No active file.");
                    return;
                }

                if (!this.isFileIncluded(file)) {
                    new Notice("Last Edit Location is not active for this file (folder not included).");
                    return;
                }

                const uniqueIdentifier = await this.getUniqueIdentifier(file, false);
                const savedPosition = uniqueIdentifier ? this.settings.cursorPosition[uniqueIdentifier] : undefined;

                if (savedPosition && savedPosition.line <= editor.lastLine()) {
                    editor.setCursor(savedPosition);
                    editor.scrollIntoView({ from: savedPosition, to: savedPosition }, true);
                } else {
                    new Notice("No last edit location found for this file.");
                }
            }
        });
        
        
        // Initialize the session-only set for tracking restored files.
        this.restoredInCurrentSession = new Set<string>();

        // Add a settings tab to Obsidian's settings window, allowing users to configure the plugin.
        this.addSettingTab(new LastEditLocationSettingTab(this.app, this));

        // Create a "debounced" version of our saveSettings function.
        // This prevents the plugin from saving to disk on every single keystroke,
        // which would be inefficient. It will only save, at most, once every 2 seconds.
        // The `true` argument makes it trigger on the leading edge of the wait interval.
        this.debouncedSave = debounce(() => this.saveSettings(), PLUGIN_CONSTANTS.DEBOUNCE_SAVE_DELAY, true);
        
        // `onLayoutReady` fires once the Obsidian workspace UI is fully loaded and ready.
        // This is the safest time to register events and interact with the workspace to avoid race conditions.
        this.app.workspace.onLayoutReady(() => {
            // This event listens for any change in the editor (e.g., typing, deleting).
            // We register it here to ensure it only starts listening after the workspace is fully loaded.
            this.registerEvent(
                this.app.workspace.on('editor-change', (editor, markdownView) => {
                    // When a change occurs, we save the new cursor position.
                    this.saveCursorPosition(editor, markdownView.file);
                })
            );

            // This event listens for when a new file is opened in the workspace.
            this.registerEvent(
                this.app.workspace.on('file-open', (file) => {
                    // When a file is opened, we run our logic to potentially restore the cursor.
                    this.handleFileOpen(file);
                })
            );
            
            // The 'file-open' event doesn't fire for the file that is already open when Obsidian starts.
            // So, we manually handle the very first file that's active on startup.
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                this.handleFileOpen(activeFile);
            }
        });
    }
    
    /**
     * This function runs when the plugin is disabled.
     * We can use it to clean up any resources, like event listeners or intervals.
     * In this case, `registerEvent` handles listener cleanup automatically, so this can be empty.
     */
    onunload() {}

    /**
     * Handles the logic for opening a file, checking if the cursor should be restored.
     * @param file The file that was just opened. Can be null if no file is open.
     */
    private async handleFileOpen(file: TFile | null) {
        // Exit if no file is actually open.
        if (!file) return;

        // MODIFICATION: Call getUniqueIdentifier with createIfMissing set to false.
        // We only want to read the identifier here, not create it just by opening a file.
        const uniqueIdentifier = await this.getUniqueIdentifier(file, false);
        if (!uniqueIdentifier) return;

        // Check if this file has already had its cursor restored in this session.
        // If not, we proceed to restore it.
        if (!this.restoredInCurrentSession.has(uniqueIdentifier)) {
            // Use a small timeout to ensure the editor is fully rendered and ready for cursor manipulation.
            // 10ms is usually enough time for the UI to update.
            setTimeout(() => {
                this.restoreCursorPosition(file);
                // Mark this file's ID as "restored" for this session to prevent this logic from running again
                // if the user switches back to this file.
                this.restoredInCurrentSession.add(uniqueIdentifier);
            }, PLUGIN_CONSTANTS.RESTORE_CURSOR_DELAY);
        }
    }

    /**
     * Loads the plugin's data from the `data.json` file in the plugin's directory.
     * `Object.assign` merges the loaded data with the default settings, ensuring that
     * any new settings added in an update will have a default value.
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    /**
     * Saves the plugin's current settings object to the `data.json` file.
     */
    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Checks if a given file is located in one of the user-defined included folders.
     * @param file The TFile object to check.
     * @returns True if the file should be included based on the settings, false otherwise.
     */
    isFileIncluded(file: TFile): boolean {
        // Split the textarea input into an array of folder paths, trimming whitespace and removing empty lines.
        const includedFolders = this.settings.includedFolders.split('\n').map(f => f.trim()).filter(f => f);
        // If the list is empty, the plugin is effectively disabled.
        if (includedFolders.length === 0) return false;
        
        // This acts as a special case to match the entire vault.
        if (includedFolders.includes('/*')) return true;

        // Iterate over each specified folder path.
        for (const folder of includedFolders) {
            if (folder === '/') {
                // Special case for the root folder: a file is in the root if its path contains no slashes.
                if (!file.path.includes('/')) return true;
            } else if (folder.endsWith('/*')) {
                // Deep include: matches the folder and all its subfolders.
                // We check if the file path starts with the base folder path (e.g., "Notes/").
                const basePath = folder.slice(0, -2);
                if (file.path.startsWith(basePath + '/')) return true;
            } else {
                // Shallow include: matches only files directly inside the folder, not in subfolders.
                if (file.path.startsWith(folder + '/')) {
                    // To check for shallowness, we see if the rest of the path contains any more slashes.
                    const remainingPath = file.path.substring(folder.length + 1);
                    if (!remainingPath.includes('/')) return true;
                }
            }
        }
        // If no rules match, the file is not included.
        return false;
    }

    /**
     * Saves the current cursor's line and character number for the given file.
     * @param editor The active editor instance.
     * @param file The file being edited.
     */
    async saveCursorPosition(editor: Editor, file: TFile | null) {
        // First, check if a file is actually open.
        if (!file) return;

        // Then, check if the current file is in a folder where the plugin should be active.
        if (!this.isFileIncluded(file)) return;

        // MODIFICATION: Call getUniqueIdentifier with createIfMissing set to true.
        // This is the only place where we want to create a UUID if it doesn't exist,
        // because this function is only triggered by an actual edit.
        const uniqueIdentifier = await this.getUniqueIdentifier(file, true);
        if (!uniqueIdentifier) return; // Exit if no ID could be found or created.

        // Get the current cursor position from the editor.
        const cursor = editor.getCursor();
        // Store the entire cursor position object (line and character) in our settings, keyed by the file's unique ID.
        this.settings.cursorPosition[uniqueIdentifier] = { line: cursor.line, ch: cursor.ch };
        
        // Call the debounced save function to write the settings to disk, preventing excessive writes.
        this.debouncedSave();
    }

    /**
     * Restores the cursor to the last known position for the given file and centers the view on that line.
     * @param file The file that was just opened.
     */
    async restoreCursorPosition(file: TFile) {
        // Check if the file is in an included folder.
        if (!this.isFileIncluded(file)) return;

        // MODIFICATION: Call getUniqueIdentifier with createIfMissing set to false.
        // We only want to read the identifier to find the saved position, not create one.
        const uniqueIdentifier = await this.getUniqueIdentifier(file, false);
        if (!uniqueIdentifier) return;

        // Retrieve the saved position object from settings using the file's ID.
        const savedPosition = this.settings.cursorPosition[uniqueIdentifier];
        // Get the active markdown view.
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        // Proceed only if we have a saved position and an active editor instance.
        if (savedPosition !== undefined && view && view.editor) {
            const editor = view.editor;
            // Sanity check: make sure the saved line number is still valid and doesn't exceed the file's current length.
            if (savedPosition.line <= editor.lastLine()) {
                // Set the cursor to the exact saved line and character.
                editor.setCursor({ line: savedPosition.line, ch: savedPosition.ch });
                // Scroll the editor to place the cursor's line in the vertical center of the viewport for better context.
                editor.scrollIntoView({ from: { line: savedPosition.line, ch: 0 }, to: { line: savedPosition.line, ch: 0 } }, true);
            }
        }
    }
    
    /**
     * Gets the currently active ID field name based on the user's settings for frontmatter-based options.
     * @returns The active ID field name as a string (e.g., "uuid" or "created"). Returns empty string if not applicable.
     */
    public getCurrentIdName(): string {
        if (this.settings.identifierSource === 'plugin-generated-UUID') {
            return this.settings.generatedIdName;
        } else if (this.settings.identifierSource === 'user-provided-field') {
            return this.settings.userProvidedIdName;
        }
        return ''; // Not applicable for 'file-path' source.
    }

    /**
     * Gets or creates the unique identifier for a file based on the plugin's settings.
     * This can be the file's relative path or a value from its frontmatter.
     * @param file The file to process.
     * @param createIfMissing If true, and the source is 'plugin-generated-UUID', a new UUID will be created and saved to the file if one doesn't exist.
     * @returns A Promise that resolves to the unique ID of the file, or an empty string if none is found/created.
     */
    public async getUniqueIdentifier(file: TFile, createIfMissing: boolean = false): Promise<string> {
        if (this.settings.identifierSource === 'file-path') {
            return file.path;
        }

        const idName = this.getCurrentIdName();
        if (!idName) return '';

        let fileUUID = '';
        // Use `processFrontMatter` to safely read and modify the file's metadata.
        // This is the recommended way to interact with frontmatter. Obsidian is smart enough
        // to only write to the file if the frontmatter object is actually mutated.
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            // Check if the ID field already exists in the frontmatter.
            if (frontmatter && frontmatter[idName]) {
                // If the ID already exists, just grab it.
                fileUUID = String(frontmatter[idName]);
            } else if (this.settings.identifierSource === 'plugin-generated-UUID' && createIfMissing) {
                // If it doesn't exist, the settings allow it, AND we've been explicitly told to create it,
                // then generate a new V1 UUID.
                const newUUID = uuidv1();
                // Add the new UUID to the frontmatter object. Obsidian will handle writing this back to the file.
                frontmatter[idName] = newUUID;
                fileUUID = newUUID;
            }
            // If the source is 'user-provided-field' and the field doesn't exist, we do nothing and fileUUID remains empty.
            // If 'plugin-generated-UUID' is the source but createIfMissing is false, we also do nothing, preventing file modification on open.
        });
        return fileUUID;
    }
}

/**
 * A helper function that limits how often another function can be executed.
 * This is useful for performance-intensive tasks like saving to disk or making API calls.
 * @param func The function to debounce.
 * @param wait The time to wait in milliseconds before executing.
 * @param immediate If true, trigger the function on the leading edge of the wait interval instead of the trailing edge.
 */
function debounce(func: (...args: any[]) => any, wait: number, immediate: boolean = false) {
    let timeout: NodeJS.Timeout | null;

    return function(this: any, ...args: any[]) {
        const context = this; // `this` and `args` are preserved from the original call.
        
        // This function is what gets called after the `wait` time has passed.
        const later = function() {
            timeout = null; // Clear the timeout so it can be set again.
            if (!immediate) {
                // If not immediate, call the original function now.
                func.apply(context, args);
            }
        };

        const callNow = immediate && !timeout; // Determine if we should call the function immediately.

        if (timeout) {
            // If a timeout is already scheduled, clear it to reset the timer.
            clearTimeout(timeout);
        }

        // Set a new timeout.
        timeout = setTimeout(later, wait);

        if (callNow) {
            // If it's an immediate call, execute the function right away.
            func.apply(context, args);
        }
    };
}

// Defines the settings tab for the plugin, which appears in the main Obsidian settings window.
class LastEditLocationSettingTab extends PluginSettingTab {
    plugin: LastEditLocationPlugin;

    constructor(app: App, plugin: LastEditLocationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * This method is called by Obsidian to render the content of the settings tab.
     * It should be used to create all the UI elements for the settings.
     */
    display(): void {
        const { containerEl } = this; // `containerEl` is the HTML element that holds the settings tab's content.
        
        // Clear any existing content to ensure a clean re-render.
        containerEl.empty();
        
        containerEl.createEl('h2', { text: 'Set an unique identifier' });

        // Setting 2: Dropdown to choose the source of the unique ID.
        new Setting(containerEl)
            .setName('Source')
            .setDesc('Choose the source for the unique note identifier.')
            .addDropdown(dropdown => dropdown
                .addOption('plugin-generated-UUID', 'Option A. Plugin generated UUID')
                .addOption('user-provided-field', 'Option B. User provided field')
                .addOption('file-path', 'Option C. File path')
                .setValue(this.plugin.settings.identifierSource)
                .onChange((value: 'plugin-generated-UUID' | 'user-provided-field' | 'file-path') => {
                    this.plugin.settings.identifierSource = value;
                    // Re-render the entire settings tab to enable/disable the correct text field below.
                    this.display();
                }));

        // Setting 3: Text input for the ID name when the plugin generates it.
        new Setting(containerEl)
            .setName('Option A. ID name for plugin generated UUID')
            .setDesc("Give a field name in which's value the plugin will add the generated UUID. • Required when 'Source' is set to 'Option A'.")
            .addText(text => {
                text
                    .setPlaceholder('e.g., uuid or uid or id')
                    .setValue(this.plugin.settings.generatedIdName)
                    // This text field is disabled if the user has not selected "Option A".
                    .setDisabled(this.plugin.settings.identifierSource !== 'plugin-generated-UUID')
                    .onChange(value => this.plugin.settings.generatedIdName = value.trim());
            });

        // Setting 4: Text input for the ID name when the user provides it.
        new Setting(containerEl)
            .setName('Option B. ID name for user provided field')
            .setDesc("Choose an existing field name from the front matter to use as an unique ID for the note (e.g., 'created', 'title'). • The plugin will not generate any field name or value. If the field is not found, the cursor position will not be saved. • Required when 'Source' is set to 'Option B'.")
            .addText(text => {
                text
                    .setPlaceholder('e.g., created or title')
                    .setValue(this.plugin.settings.userProvidedIdName)
                    // This text field is disabled if the user has not selected "Option B".
                    .setDisabled(this.plugin.settings.identifierSource !== 'user-provided-field')
                    .onChange(value => this.plugin.settings.userProvidedIdName = value.trim());
            });
        
        // Setting 5: Description for Option C. This is purely informational.
        new Setting(containerEl)
            .setName('Option C. File path')
            .setDesc("The plugin will use the note's relative path in the vault (e.g., 'folder/note.md') as the unique identifier. This is for those who does not use the front matter.");


        containerEl.createEl('h2', { text: 'Specify where the plugin operates' });

        // Setting 6: Text area for specifying which folders to include.
        new Setting(containerEl)
            .setName('List folders')
            .setDesc("Choose folders where the plugin will be active. Provide one path per line. \n• `Folder` includes only notes inside `Folder`.\n• `Folder/*` includes notes inside `Folder` and all its subfolders.\n• `/` includes only notes in the vault's root.\n• `/*` includes all notes in the entire vault.\nIf this list is empty, the plugin will not function.")
            .addTextArea(text => {
                text
                    .setPlaceholder('e.g.,\n/*\n/\nFolder\nFolder/*')
                    .setValue(this.plugin.settings.includedFolders)
                    .onChange(value => this.plugin.settings.includedFolders = value);
                // Make the text area larger for better usability.
                text.inputEl.style.minHeight = '120px';
            });

        containerEl.createEl('h2', { text: 'Manage data' });

        // Setting 7: Button to clean up stale data from the settings file.
        new Setting(containerEl)
            .setName('Clean up the unnecessary')
            .setDesc("Remove saved line data for notes that no longer exist or are not in the 'List folders' list above. • Beware. The stored identifiers other than the current ID set by the above 'source' option will be removed.")
            .addButton(button => {
                button
                    .setButtonText('Remove Now')
                    .onClick(async () => {
                        // Provide user feedback during the cleanup process.
                        button.setButtonText('Cleaning...').setDisabled(true);
                        
                        const allFiles = this.app.vault.getMarkdownFiles();
                        const validIdentifiers = new Set<string>();
                        const idName = this.plugin.getCurrentIdName();

                        // Step 1: Build a set of all valid identifiers from existing and included files.
                        for (const file of allFiles) {
                            if (this.plugin.isFileIncluded(file)) {
                                // Logic depends on the identifier source setting.
                                if (this.plugin.settings.identifierSource === 'file-path') {
                                    validIdentifiers.add(file.path);
                                } else if (idName) { // For frontmatter-based options
                                    // Use the metadata cache for performance instead of reading each file.
                                    const cachedFrontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
                                    if (cachedFrontmatter && cachedFrontmatter[idName]) {
                                        validIdentifiers.add(String(cachedFrontmatter[idName]));
                                    }
                                 }
                            }
                        }
            
                        // Step 2: Iterate through the saved cursor positions.
                        const savedIdentifiers = Object.keys(this.plugin.settings.cursorPosition);
                        let cleanedCount = 0;
            
                        for (const savedId of savedIdentifiers) {
                            // If a saved ID is not in our set of valid IDs, it's stale.
                            if (!validIdentifiers.has(savedId)) {
                                // Delete it from the settings object.
                                delete this.plugin.settings.cursorPosition[savedId];
                                cleanedCount++;
                            }
                        }
            
                        // Step 3: Save the cleaned settings and notify the user.
                        await this.plugin.saveSettings();
                        new Notice(`Removed data for ${cleanedCount} deleted or excluded note(s).`);
                        
                        // Reset the button to its original state.
                        button.setButtonText('Remove Now').setDisabled(false);
                    });
            });
    }

    /**
     * This method is called when the user leaves the settings tab.
     * It's the best place to save all changes.
     */
    hide(): void {
        // Save all settings when the tab is closed.
        this.plugin.saveSettings();
    }
}
