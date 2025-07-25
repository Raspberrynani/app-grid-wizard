import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

// Constants
const SHOW_INDICATOR = false;
const APP_FOLDER_SCHEMA_ID = 'org.gnome.desktop.app-folders';
const APP_FOLDER_SCHEMA_PATH = '/org/gnome/desktop/app-folders/folders/';
const DEBOUNCE_DELAY = 500; // Reduced from 1000ms

// Folder configurations
const FOLDER_CONFIGS = {
    'accessories': {name: 'Accessories', categories: ['Utility']},
    'chrome-apps': {name: 'Chrome Apps', categories: ['chrome-apps']},
    'games': {name: 'Games', categories: ['Game']},
    'graphics': {name: 'Graphics', categories: ['Graphics']},
    'internet': {name: 'Internet', categories: ['Network', 'WebBrowser', 'Email']},
    'office': {name: 'Office', categories: ['Office']},
    'programming': {name: 'Programming', categories: ['Development']},
    'science': {name: 'Science', categories: ['Science']},
    'sound---video': {name: 'Sound & Video', categories: ['AudioVideo', 'Audio', 'Video']},
    'system-tools': {name: 'System Tools', categories: ['System', 'Settings']},
    'universal-access': {name: 'Universal Access', categories: ['Accessibility']},
    'wine': {name: 'Wine', categories: ['Wine', 'X-Wine', 'Wine-Programs-Accessories']},
    'waydroid': {name: 'Waydroid', categories: ['Waydroid', 'X-WayDroid-App']}
};

class AppFolderManager {
    constructor() {
        this._folderSettings = new Gio.Settings({schema_id: APP_FOLDER_SCHEMA_ID});
        this._folderSchemas = new Map(); // Cache folder schemas
        this._setupTimeoutId = null;
        this._isSettingUp = false;
    }

    _getFolderSchema(folderId) {
        if (!this._folderSchemas.has(folderId)) {
            const folderPath = `${APP_FOLDER_SCHEMA_PATH}${folderId}/`;
            const folderSchema = Gio.Settings.new_with_path('org.gnome.desktop.app-folders.folder', folderPath);
            this._folderSchemas.set(folderId, folderSchema);
        }
        return this._folderSchemas.get(folderId);
    }

    setupFoldersDebounced() {
        // Cancel any pending setup
        if (this._setupTimeoutId) {
            GLib.source_remove(this._setupTimeoutId);
            this._setupTimeoutId = null;
        }

        // Skip if already setting up
        if (this._isSettingUp) {
            return;
        }

        this._setupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_DELAY, () => {
            this.setupFolders();
            this._setupTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    setupFolders() {
        if (this._isSettingUp) {
            return;
        }

        this._isSettingUp = true;

        try {
            // Get current folder children to avoid unnecessary updates
            const currentFolders = this._folderSettings.get_strv('folder-children');
            const targetFolders = Object.keys(FOLDER_CONFIGS);
            
            // Only update if different
            if (!this._arraysEqual(currentFolders, targetFolders)) {
                this._folderSettings.set_strv('folder-children', targetFolders);
            }

            // Batch folder updates
            const updates = [];
            for (const [folderId, config] of Object.entries(FOLDER_CONFIGS)) {
                const folderSchema = this._getFolderSchema(folderId);
                
                // Only update if values are different
                if (folderSchema.get_string('name') !== config.name) {
                    updates.push(() => folderSchema.set_string('name', config.name));
                }
                
                const currentCategories = folderSchema.get_strv('categories');
                if (!this._arraysEqual(currentCategories, config.categories)) {
                    updates.push(() => folderSchema.set_strv('categories', config.categories));
                }
            }

            // Apply all updates
            updates.forEach(update => update());

            // Single sync call instead of multiple
            if (updates.length > 0) {
                Gio.Settings.sync();
                this._refreshAppDisplayOptimized();
            }

        } catch (error) {
            console.error('App-Grid-Wizard: Error setting up folders:', error);
        } finally {
            this._isSettingUp = false;
        }
    }

    clearFolders() {
        console.log('App-Grid-Wizard: Clearing folders...');
        try {
            this._folderSettings.set_strv('folder-children', []);
            Gio.Settings.sync();
            this._refreshAppDisplayOptimized();
            console.log('App-Grid-Wizard: Folders cleared');
        } catch (error) {
            console.error('App-Grid-Wizard: Error clearing folders:', error);
        }
    }

    _arraysEqual(a, b) {
        return a.length === b.length && a.every((val, i) => val === b[i]);
    }

    _refreshAppDisplayOptimized() {
        // Use idle callback to avoid blocking UI
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                const appDisplay = Main.overview.viewSelector?._appDisplay || 
                                 Main.overview.viewSelector?.appDisplay ||
                                 Main.overview._overview?.viewSelector?._appDisplay;
                
                if (appDisplay && appDisplay._redisplay) {
                    appDisplay._redisplay();
                }
            } catch (error) {
                console.error('App-Grid-Wizard: Error refreshing app display:', error);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._setupTimeoutId) {
            GLib.source_remove(this._setupTimeoutId);
            this._setupTimeoutId = null;
        }
        
        // Clear cached schemas
        this._folderSchemas.clear();
    }
}

const WizardToggle = GObject.registerClass(
class WizardToggle extends QuickToggle {
    _init() {
        super._init({
            title: 'App Grid Wizard',
            iconName: 'view-grid-symbolic',
            toggleMode: true,
        });

        this._folderManager = new AppFolderManager();
        this._monitorId = null;
        this.checked = false;
        
        this.connect('clicked', this._onClicked.bind(this));
    }

    _onClicked() {
        if (this.checked) {
            this._folderManager.setupFolders();
            this._startMonitoring();
        } else {
            this._folderManager.clearFolders();
            this._stopMonitoring();
        }
    }

    _startMonitoring() {
        console.log('App-Grid-Wizard: Started monitoring for app changes');

        if (this._monitorId) return;

        const appSystem = Shell.AppSystem.get_default();
        this._monitorId = appSystem.connect('installed-changed', () => {
            console.log('App-Grid-Wizard: Detected app installation/removal');
            // Use debounced setup to avoid multiple rapid updates
            this._folderManager.setupFoldersDebounced();
        });
    }

    _stopMonitoring() {
        if (this._monitorId) {
            const appSystem = Shell.AppSystem.get_default();
            appSystem.disconnect(this._monitorId);
            this._monitorId = null;
            console.log('App-Grid-Wizard: Stopped monitoring');
        }
    }

    destroy() {
        this._stopMonitoring();
        this._folderManager.destroy();
        super.destroy();
    }
});

const WizardIndicator = GObject.registerClass(
class WizardIndicator extends SystemIndicator {
    _init() {
        super._init();

        this._toggle = new WizardToggle();
        
        if (SHOW_INDICATOR) {
            this._indicator = this._addIndicator();
            this._indicator.iconName = 'view-grid-symbolic';
            this._toggle.bind_property('checked', this._indicator, 'visible', GObject.BindingFlags.SYNC_CREATE);
        }

        this.quickSettingsItems.push(this._toggle);
    }

    getToggle() {
        return this._toggle;
    }
});

export default class WizardManagerExtension extends Extension {
    enable() {
        this._indicator = new WizardIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        const toggle = this._indicator.getToggle();
        if (toggle) {
            toggle.checked = false;
        }

        // Reduced initial delay and optimized setup
        console.log('App-Grid-Wizard: Started Initial app folder creation.');
        this._initTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            const toggle = this._indicator.getToggle();
            if (toggle && !toggle.checked) {
                toggle.checked = true;
                toggle._onClicked();
            }
            console.log('App-Grid-Wizard: End of Initial app folder creation.');
            this._initTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._initTimeoutId) {
            GLib.source_remove(this._initTimeoutId);
            this._initTimeoutId = null;
        }

        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
