//
// 0.1.5
// obsidian 1.13 version API compatibility
//
// to do
// ?improve logic of saving unique identifier.
//

// Import necessary classes and functions from the Obsidian API.
import {
    App,              // The main application object, giving access to the workspace, vault, etc.
    Editor,           // The editor object, for interacting with the text content.
    MarkdownView,     // A view that displays a Markdown file.
    MarkdownFileInfo, // The editor context passed to editor commands (a MarkdownView or an embedded editor).
    Plugin,           // The base class all plugins must extend.
    TFile,            // Represents a file in the vault.
    PluginSettingTab, // The base class for creating a settings tab.
    SettingDefinitionItem, // A declarative setting definition (Obsidian 1.13+).
    debounce,         // A utility function to limit how often a function is called.
    normalizePath,    // Converts a path to the vault path format (e.g., no leading or trailing slashes).
    Debouncer,        // The type returned by `debounce`, with `run()` to flush a pending call.
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
    restoringDelayTime: number; // The delay in milliseconds before restoring the cursor.
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
    restoringDelayTime: 50, // Default delay of 50ms.
    cursorPosition: {}, // Starts with no saved positions.
};


/**
 * Appends text to a fragment, rendering parts wrapped in backticks as <code> (monospace),
 * e.g. "• `Folder` includes only notes inside `Folder`."
 */
function appendTextWithCode(fragment: DocumentFragment, text: string): void {
    text.split('`').forEach((part, index) => {
        // Odd-indexed parts are the ones between a pair of backticks.
        if (index % 2 === 1) {
            fragment.createEl('code', { text: part });
        } else {
            fragment.appendText(part);
        }
    });
}


// Centralized constants for easy maintenance.
const PLUGIN_CONSTANT = {
    COMMANDS: {
        GO_TO_LAST_EDIT: {
            id: 'go-to-last-edit-location',
            name: 'Go to last edit location',
            notices: {
                noActiveFile: 'No active file.',
                folderNotIncluded: 'Last edit location is not active for this file (folder not included).',
                noSavedLocation: 'No last edit location found for this file.',
            },
        },
        SCROLL_TO_CENTER: {
            id: 'scroll-cursor-line-to-center',
            name: 'Scroll cursor line to center of view',
        },
    },
    DEBOUNCE_SAVE_DELAY: 2000,
    SETTINGS: {
        TITLES: {
            IDENTIFIER: 'Set a unique identifier',
            OPERATES_ON: 'Specify where the plugin operates',
            OTHER: 'Set restoring options',
            MANAGE_DATA: 'Manage data',
        },
        SOURCE_DROPDOWN: {
            name: 'Source',
            desc: 'Choose the source for the unique note identifier.',
            optionA: 'Option A. Plugin generated UUID',
            optionB: 'Option B. User provided field',
            optionC: 'Option C. File path',
        },
        GENERATED_ID_INPUT: {
            name: 'Option A. Plugin-generated UUID',
            // A function, because a DocumentFragment is emptied once it is added to the page.
            desc: (): DocumentFragment => createFragment(fragment => {
                fragment.appendText("Give a field name to which the plugin will add the generated UUID (version 1 of RFC 9562, https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-1).");
                fragment.createEl('br');
                fragment.appendText("• Required when 'Source' is set to 'Option A'.");
            }),
            placeholder: 'e.g., uuid or uid or id',
        },
        USER_ID_INPUT: {
            name: 'Option B. User provided field',
            desc: (): DocumentFragment => createFragment(fragment => {
                fragment.appendText("Choose an existing field name from the front matter to use as a unique ID for the note (e.g., 'created', 'title').");
                fragment.createEl('br');
                fragment.appendText("• The plugin will not generate any field name or value. If the field is not found, the cursor position will not be saved.");
                fragment.createEl('br');
                fragment.appendText("• Required when 'Source' is set to 'Option B'.");
            }),
            placeholder: 'e.g., created or title',
        },
        FILE_PATH_INFO: {
            name: 'Option C. File path',
            desc: "The plugin will use the note's relative path in the vault (e.g., 'folder/note.md') as the unique identifier. This is for those who do not use the front matter.",
        },
        INCLUDED_FOLDERS: {
            name: 'Working folders',
            desc: (): DocumentFragment => createFragment(fragment => {
                fragment.appendText("Choose folders where the plugin will be active. Provide one path per line.");
                fragment.createEl('br');
                fragment.appendText("• If this list is empty, the plugin will not function.");
                fragment.createEl('br');
                appendTextWithCode(fragment, "• '`Folder`' includes only notes inside `Folder`.");
                fragment.createEl('br');
                appendTextWithCode(fragment, "• '`Folder/*`' includes notes inside `Folder` and all its subfolders.");
                fragment.createEl('br');
                appendTextWithCode(fragment, "• '`/`' includes only notes in the vault's root.");
                fragment.createEl('br');
                appendTextWithCode(fragment, "• '`/*`' includes all notes in the entire vault.");
            }),
            placeholder: '/*\n/\nFolder\nFolder/*',
        },
        RESTORING_DELAY_SLIDER: {
            name: 'Restoring delay time',
            desc: 'The delay in milliseconds before restoring the cursor position. Increase this if the cursor does not restore consistently.',
        },
        CLEANUP_BUTTON: {
            name: 'Cleaning up the unnecessary',
            desc: (): DocumentFragment => createFragment(fragment => {
                fragment.appendText("Remove saved line data for notes that no longer exist or are not in the 'Working folders' list above.");
                fragment.createEl('br');
                fragment.appendText("• Beware. The stored identifiers other than the current ID set by the above 'source' option will be removed.");
            }),
            buttonText: 'Remove now',
            buttonTextCleaning: 'Cleaning...',
            notice: (count: number) => `Removed data for ${count} deleted or excluded note(s).`,
        }
    }
};


/**
 * Converts a frontmatter value to an identifier string.
 * Only scalar values are accepted; objects and arrays would stringify to '[object Object]'
 * or a joined list, which could make different notes share the same identifier.
 * @returns The identifier, or an empty string if the value is not usable.
 */
function toIdentifier(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return '';
}


/**
 * Normalizes a line of the 'Working folders' setting to the vault path format
 * (no leading or trailing slashes, '/' as the separator), keeping the special rules '/' and '/*'.
 * e.g. '/Notes/' -> 'Notes', 'Notes\Sub' -> 'Notes/Sub', '/Notes/*' -> 'Notes/*'.
 * @param rule A non-empty, trimmed line of the setting.
 * @returns The normalized rule.
 */
function normalizeFolderRule(rule: string): string {
    rule = rule.replace(/\\/g, '/');
    const isDeep = rule.endsWith('/*');
    // `normalizePath` removes leading/trailing and duplicate slashes; it returns '/' for the vault root.
    const folder = normalizePath(isDeep ? rule.slice(0, -2) : rule);
    if (folder === '/') {
        return isDeep ? '/*' : '/';
    }
    return isDeep ? `${folder}/*` : folder;
}


// This is the main class for our plugin. It extends the base Plugin class from Obsidian,
// inheriting its lifecycle methods like `onload` and `onunload`.
export default class LastEditLocationPlugin extends Plugin {
    settings!: LastEditLocationSettings; // This will hold the currently loaded settings.

    // This Set tracks which files have had their cursor restored in the current session.
    // It prevents the cursor from being moved every time a file is focused.
    // It is temporary and resets every time Obsidian is restarted.
    private hasBeenRestoredInCurrentSession = new Set<string>();

    // In-progress UUID creations, keyed by file path. An entry is kept until the metadata cache
    // reflects the new ID, so edits in between reuse it instead of writing to the file again.
    private pendingIdCreations = new Map<string, Promise<string>>();

    // This holds the debounced version of our save function to improve performance
    // by limiting how often we write to the disk.
    private debouncedSave!: Debouncer<[], Promise<void>>;

    /**
     * This is the entry point of the plugin. It runs when the plugin is loaded (e.g., on Obsidian startup or when enabled by the user).
     */
    async onload() {
        // Load the saved settings from the `data.json` file in the plugin's directory.
        await this.loadSettings();

        // Add a command to scroll the current cursor line to the vertical center of the view.
        // This is independent of the main plugin functionality.
        this.addCommand({
            id: PLUGIN_CONSTANT.COMMANDS.SCROLL_TO_CENTER.id,
            name: PLUGIN_CONSTANT.COMMANDS.SCROLL_TO_CENTER.name,
            editorCallback: (editor: Editor) => {
                const cursor = editor.getCursor();
                editor.scrollIntoView({ from: cursor, to: cursor }, true);
            }
        });

        // Add a command to move the cursor to the last saved edit location and scroll it into view.
        this.addCommand({
            id: PLUGIN_CONSTANT.COMMANDS.GO_TO_LAST_EDIT.id,
            name: PLUGIN_CONSTANT.COMMANDS.GO_TO_LAST_EDIT.name,
            editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
                const file = ctx.file;
                if (!file) {
                    new Notice(PLUGIN_CONSTANT.COMMANDS.GO_TO_LAST_EDIT.notices.noActiveFile);
                    return;
                }

                if (!this.isFileIncluded(file)) {
                    new Notice(PLUGIN_CONSTANT.COMMANDS.GO_TO_LAST_EDIT.notices.folderNotIncluded);
                    return;
                }

                const uniqueIdentifier = await this.getUniqueIdentifier(file, false);
                const savedPosition = uniqueIdentifier ? this.settings.cursorPosition[uniqueIdentifier] : undefined;

                if (savedPosition && savedPosition.line <= editor.lastLine()) {
                    editor.setCursor(savedPosition);
                    editor.scrollIntoView({ from: savedPosition, to: savedPosition }, true);
                } else {
                    new Notice(PLUGIN_CONSTANT.COMMANDS.GO_TO_LAST_EDIT.notices.noSavedLocation);
                }
            }
        });


        // Add a settings tab to Obsidian's settings window, allowing users to configure the plugin.
        this.addSettingTab(new LastEditLocationSettingTab(this.app, this));

        // Create a "debounced" version of our saveSettings function.
        // This prevents the plugin from saving to disk on every single keystroke,
        // which would be inefficient.
        // The `true` argument (`resetTimer`) restarts the timer on every call,
        // so it saves once, 2 seconds after the user stops typing.
        this.debouncedSave = debounce(() => this.saveSettings(), PLUGIN_CONSTANT.DEBOUNCE_SAVE_DELAY, true);

        // `onLayoutReady` fires once the Obsidian workspace UI is fully loaded and ready.
        // This is the safest time to register events and interact with the workspace to avoid race conditions.
        this.app.workspace.onLayoutReady(() => {
            // This event listens for any change in the editor (e.g., typing, deleting).
            // We register it here to ensure it only starts listening after the workspace is fully loaded.
            this.registerEvent(
                this.app.workspace.on('editor-change', (editor, markdownView) => {
                    // When a change occurs, we save the new cursor position.
                    void this.saveLastEditLocation(editor, markdownView.file);
                })
            );

            // This event listens for when a new file is opened in the workspace.
            this.registerEvent(
                this.app.workspace.on('file-open', async (file) => {
                    const uniqueIdentifier = await this.shouldRestoreCursor(file);
                    if (file && uniqueIdentifier) {
                        this.restoreLastEditLocation(file, uniqueIdentifier);
                    }
                })
            );

            // The 'file-open' event doesn't fire for the file that is already open when Obsidian starts.
            // So, we manually handle the very first file that's active on startup.
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                // We wrap this in an async IIFE (Immediately Invoked Function Expression)
                // to use await with shouldRestoreCursor.
                void (async () => {
                    const uniqueIdentifier = await this.shouldRestoreCursor(activeFile);
                    if (uniqueIdentifier) {
                        this.restoreLastEditLocation(activeFile, uniqueIdentifier);
                    }
                })();
            }
        });
    }

    /**
     * This function runs when the plugin is disabled.
     * `registerEvent` handles listener cleanup automatically.
     * A cursor position saved within the debounce delay is still pending, so write it now
     * instead of losing it when Obsidian closes or the plugin is disabled.
     */
    onunload() {
        void this.debouncedSave?.run();
    }

    /**
     * A query function that determines if the cursor should be restored for a given file.
     * @param file The file to check.
     * @returns The unique identifier of the file if the cursor should be restored, otherwise null.
     */
    private async shouldRestoreCursor(file: TFile | null): Promise<string | null> {
        // Perform all necessary checks.
        if (!file || !this.isFileIncluded(file)) {
            return null;
        }

        const uniqueIdentifier = await this.getUniqueIdentifier(file, false);
        if (!uniqueIdentifier || this.hasBeenRestoredInCurrentSession.has(uniqueIdentifier)) {
            return null;
        }

        // If all checks pass, return the identifier, signaling that a restoration should occur.
        return uniqueIdentifier;
    }

    /**
     * Loads the plugin's data from the `data.json` file in the plugin's directory.
     * `Object.assign` merges the loaded data with the default settings, ensuring that
     * any new settings added in an update will have a default value.
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LastEditLocationSettings> | null);
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
        // Each path is then normalized, so that e.g. '/Notes/', 'Notes\' and 'Notes' all mean the same folder.
        const includedFolders = this.settings.includedFolders.split('\n').map(f => f.trim()).filter(f => f).map(normalizeFolderRule);
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
    async saveLastEditLocation(editor: Editor, file: TFile | null) {
        // First, check if a file is actually open.
        if (!file) return;

        // Then, check if the current file is in a folder where the plugin should be active.
        if (!this.isFileIncluded(file)) return;

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
     * Restores the cursor to the last known position for a file and centers the view on that line.
     * This function assumes all checks have been passed.
     * @param file The file that was opened.
     * @param uniqueIdentifier The unique ID of the file to restore the cursor for.
     */
    private restoreLastEditLocation(file: TFile, uniqueIdentifier: string) {
        // Use a timeout to ensure the editor is fully rendered and ready for cursor manipulation.
        // This delay is now configurable in the plugin settings.
        window.setTimeout(() => {
            // Get the active markdown view.
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);

            // The user may have switched to another note during the delay.
            // In that case, do nothing and leave this file unmarked so it is restored the next time it is opened.
            if (view?.file !== file) return;

            // Retrieve the saved position object from settings using the file's ID.
            const savedPosition = this.settings.cursorPosition[uniqueIdentifier];

            // Proceed only if we have a saved position and an active editor instance.
            if (savedPosition !== undefined && view.editor) {
                const editor = view.editor;
                // Sanity check: make sure the saved line number is still valid and doesn't exceed the file's current length.
                if (savedPosition.line <= editor.lastLine()) {
                    // Set the cursor to the exact saved line and character.
                    editor.setCursor({ line: savedPosition.line, ch: savedPosition.ch });
                    // Scroll the editor to place the cursor's line in the vertical center of the viewport for better context.
                    editor.scrollIntoView({ from: savedPosition, to: savedPosition }, true);
                }
            }

            // Mark this file's ID as "restored" for this session to prevent this logic from running again
            // if the user switches back to this file.
            this.hasBeenRestoredInCurrentSession.add(uniqueIdentifier);
        }, this.settings.restoringDelayTime);
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

        // Always look in the metadata cache first. This is called on every keystroke,
        // so it must not read or write the file when the ID already exists.
        const fmValue: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[idName];
        if (fmValue) {
            // The cache now has the ID, so a pending creation for this file (if any) is no longer needed.
            this.pendingIdCreations.delete(file.path);
            return toIdentifier(fmValue);
        }

        // The ID may have just been written but the metadata cache has not caught up yet.
        const pending = this.pendingIdCreations.get(file.path);
        if (pending) return pending;

        // Only Option A creates an ID, and only when explicitly asked to (i.e. on an actual edit).
        // Option B never modifies the file; opening a note never modifies the file.
        if (!createIfMissing || this.settings.identifierSource !== 'plugin-generated-UUID') return '';

        // Share one creation between concurrent calls (e.g. fast typing) so only one UUID is generated.
        const creation = this.createIdentifier(file, idName);
        this.pendingIdCreations.set(file.path, creation);
        creation.catch(() => this.pendingIdCreations.delete(file.path));
        return creation;
    }

    /**
     * Writes a new UUID to the file's frontmatter, unless the field already exists on disk.
     * @param file The file to process.
     * @param idName The frontmatter key for the ID.
     * @returns A Promise that resolves to the ID stored in the file.
     */
    private async createIdentifier(file: TFile, idName: string): Promise<string> {
        let fileUUID = '';
        // Use `processFrontMatter` to read and modify the frontmatter atomically.
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
            // The metadata cache can be stale, so check the file itself before generating a new ID.
            if (frontmatter[idName]) {
                fileUUID = toIdentifier(frontmatter[idName]);
            } else {
                // Generate a new V1 UUID and add it to the frontmatter. Obsidian writes it back to the file.
                const newUUID = uuidv1();
                frontmatter[idName] = newUUID;
                fileUUID = newUUID;
            }
        });
        return fileUUID;
    }
}

// Defines the settings tab for the plugin, which appears in the main Obsidian settings window.
class LastEditLocationSettingTab extends PluginSettingTab {
    plugin: LastEditLocationPlugin;

    constructor(app: App, plugin: LastEditLocationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Called by Obsidian (1.13+) to build the settings tab declaratively.
     * Controls with a `key` are read from and written to `this.plugin.settings`
     * through `getControlValue` / `setControlValue`. The definitions are also indexed by the settings search.
     */
    getSettingDefinitions(): SettingDefinitionItem<keyof LastEditLocationSettings>[] {
        const S = PLUGIN_CONSTANT.SETTINGS;
        return [
            {
                type: 'group',
                heading: S.TITLES.IDENTIFIER,
                items: [
                    // Dropdown to choose the source of the unique ID.
                    {
                        name: S.SOURCE_DROPDOWN.name,
                        desc: S.SOURCE_DROPDOWN.desc,
                        control: {
                            type: 'dropdown',
                            key: 'identifierSource',
                            options: {
                                'plugin-generated-UUID': S.SOURCE_DROPDOWN.optionA,
                                'user-provided-field': S.SOURCE_DROPDOWN.optionB,
                                'file-path': S.SOURCE_DROPDOWN.optionC,
                            },
                        },
                    },
                    // Text input for the ID name when the plugin generates it.
                    // Disabled unless "Option A" is selected.
                    {
                        name: S.GENERATED_ID_INPUT.name,
                        desc: S.GENERATED_ID_INPUT.desc(),
                        control: {
                            type: 'text',
                            key: 'generatedIdName',
                            placeholder: S.GENERATED_ID_INPUT.placeholder,
                            disabled: () => this.plugin.settings.identifierSource !== 'plugin-generated-UUID',
                        },
                    },
                    // Text input for the ID name when the user provides it.
                    // Disabled unless "Option B" is selected.
                    {
                        name: S.USER_ID_INPUT.name,
                        desc: S.USER_ID_INPUT.desc(),
                        control: {
                            type: 'text',
                            key: 'userProvidedIdName',
                            placeholder: S.USER_ID_INPUT.placeholder,
                            disabled: () => this.plugin.settings.identifierSource !== 'user-provided-field',
                        },
                    },
                    // Description for Option C. This is purely informational.
                    {
                        name: S.FILE_PATH_INFO.name,
                        desc: S.FILE_PATH_INFO.desc,
                    },
                ],
            },
            {
                type: 'group',
                heading: S.TITLES.OPERATES_ON,
                items: [
                    // Text area for specifying which folders to include.
                    {
                        name: S.INCLUDED_FOLDERS.name,
                        desc: S.INCLUDED_FOLDERS.desc(),
                        control: {
                            type: 'textarea',
                            key: 'includedFolders',
                            placeholder: S.INCLUDED_FOLDERS.placeholder,
                            rows: 8,
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: S.TITLES.OTHER,
                items: [
                    // Slider for the cursor restore delay.
                    {
                        name: S.RESTORING_DELAY_SLIDER.name,
                        desc: S.RESTORING_DELAY_SLIDER.desc,
                        control: {
                            type: 'slider',
                            key: 'restoringDelayTime',
                            min: 10, // Min: 10ms
                            max: 1000, // Max: 1000ms
                            step: 10, // Step: 10ms
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: S.TITLES.MANAGE_DATA,
                items: [
                    // Button to clean up stale data from the settings file.
                    {
                        name: S.CLEANUP_BUTTON.name,
                        desc: S.CLEANUP_BUTTON.desc(),
                        render: (setting) => {
                            setting.addButton(button => {
                                button
                                    .setButtonText(S.CLEANUP_BUTTON.buttonText)
                                    .onClick(async () => {
                                        // Provide user feedback during the cleanup process.
                                        button.setButtonText(S.CLEANUP_BUTTON.buttonTextCleaning).setDisabled(true);
                                        const cleanedCount = await this.cleanUpStaleData();
                                        new Notice(S.CLEANUP_BUTTON.notice(cleanedCount));
                                        // Reset the button to its original state.
                                        button.setButtonText(S.CLEANUP_BUTTON.buttonText).setDisabled(false);
                                    });
                            });
                        },
                    },
                ],
            },
        ];
    }

    /**
     * Persists a changed control value to `this.plugin.settings`.
     * Trims the ID names, and re-evaluates the `disabled` state of the ID name inputs when the source changes.
     */
    async setControlValue(key: string, value: unknown): Promise<void> {
        if ((key === 'generatedIdName' || key === 'userProvidedIdName') && typeof value === 'string') {
            value = value.trim();
        }
        await super.setControlValue(key, value);
        if (key === 'identifierSource') {
            this.refreshDomState();
        }
    }

    /**
     * Removes saved cursor positions for notes that no longer exist or are not in the working folders.
     * @returns The number of removed entries.
     */
    private async cleanUpStaleData(): Promise<number> {
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
                    const cachedFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                    const cachedId = cachedFrontmatter?.[idName] ? toIdentifier(cachedFrontmatter[idName]) : '';
                    if (cachedId) {
                        validIdentifiers.add(cachedId);
                    }
                }
            }
        }

        // Step 2: Iterate through the saved cursor positions.
        let cleanedCount = 0;
        for (const savedId of Object.keys(this.plugin.settings.cursorPosition)) {
            // If a saved ID is not in our set of valid IDs, it's stale.
            if (!validIdentifiers.has(savedId)) {
                delete this.plugin.settings.cursorPosition[savedId];
                cleanedCount++;
            }
        }

        // Step 3: Save the cleaned settings.
        await this.plugin.saveSettings();
        return cleanedCount;
    }
}
