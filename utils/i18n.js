/**
 * i18n.js Localization Class 
 */
export class I18nManager {
    constructor(toggleId = 'languageToggle') {
        this.currentLang = 'en';
        this.toggleId = toggleId;
        this.translations = {};
        this.eventTarget = new EventTarget();
        this._defaultLanguage = null;
        this.initialized = false;
        this.initPromise = this.init();
    }

    async init() {
        // 从本地存储获取语言设置
        const savedLang = localStorage.getItem('preferredLanguage');
        if (savedLang) {
            this.currentLang = savedLang;
        }
        
        // 设置滑块状态
        const toggle = document.getElementById(this.toggleId);
        if (toggle) {
            toggle.checked = this.currentLang === 'zh-CN';
            toggle.addEventListener('change', (e) => {
                this.switchLanguage(e.target.checked ? 'zh-CN' : 'en');
            });
        }
        
        // Init EN as default language.
        if (!this._defaultLanguage) {
            const response = await fetch('./lang/en.json');
            this._defaultLanguage = await response.json();
        }

        // 加载语言文件
        await this.loadLanguageFile(this.currentLang);
        this.applyTranslations();

        this.initialized = true;
        this.eventTarget.dispatchEvent(new CustomEvent('initialized'));
    }

    async loadLanguageFile(lang) {
        try {
            const response = await fetch(`./lang/${lang}.json`);
            if (!response.ok) {
                throw new Error(`Language file not found: ${lang}`);
            }
            this.translations[lang] = await response.json();
        } catch (error) {
            console.error('Failed to load language file:', error);
            // 如果加载失败，尝试加载默认语言
            if (lang !== 'en') {
                this.translations[lang] = this._defaultLanguage;
            }
        }
    }

    async waitForInitialization() {
        if (this.initialized) {
            return;
        }
        await this.initPromise;
    }

    async switchLanguage(lang) {
        if (lang === this.currentLang) return;
        
        this.currentLang = lang;
        localStorage.setItem('preferredLanguage', lang);
        
        if (!this.translations[lang]) {
            await this.loadLanguageFile(lang);
        }
        
        this.applyTranslations();

        // 触发语言切换事件
        this.eventTarget.dispatchEvent(new CustomEvent('languageChanged', {
            detail: {
                language: lang,
                previousLanguage: this.previousLang
            }
        }));
        
        this.previousLang = lang; // 保存之前的语言
    }

    applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            if (this.isInclude(key)) {
                element.innerHTML = this.getTranslation(key);
            }
        });
        
        document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
            const key = element.getAttribute('data-i18n-placeholder');
            const translation = this.getTranslation(key); // Use getTranslation for consistency
            if (translation !== key) { // Check if a translation was found
                element.placeholder = translation; // Directly set the property
            } else {
                // Fallback to original placeholder if no translation found, or use default from HTML
                if (!element.hasAttribute('placeholder')) {
                    element.setAttribute('placeholder', key); // Use key as fallback if no original placeholder
                }
            }
        });
        
        const title = document.querySelector('title[data-i18n]');
        if (title) {
            const key = title.getAttribute('data-i18n');
            if (this.translations[this.currentLang] && this.translations[this.currentLang][key]) {
                document.title = this.translations[this.currentLang][key];
            }
        }

        document.querySelectorAll('[data-tooltip]').forEach(element => {
            const key = element.getAttribute('data-tooltip');
            const translation = this.getTranslation(key);
            if (translation) {
                element.setAttribute('data-tooltip', translation);
            }
        });
    }


    /**
     * 
     * @param {string} name Fighter Class_Name
     * @returns Localized Fighter Name
     */
    getFighterName(name) {
        if (!name) return name;
        return this.getTranslation(`FighterName.${(name).toUpperCase().replace(' ','_')}`);
    }

    /**
     * 
     * @param {*} name UI element's data-i18n key
     * @returns Localized Content
     */
    getUIElement(name) {
        return this.getTranslation(`UIElement.${name.toUpperCase()}`);
    }

    /**
     * 
     * @param {*} id UniqueID for all console/returning messages. If with {0} {1} placeholders, using 'formatString' to process.
     * @returns Localized Messages
     */
    getConsoleMsg(id) {
        return this.getTranslation(`ConsoleMessages.${id.toUpperCase()}`);
    }

    /**
     * 
     * @param {*} id UniqueID for popup/alert/thrown error messages. If with {0} {1} placeholders, using 'formatString' to process.
     * @returns Localized Messages
     */
    getAlertMsg(id) {
        return this.getTranslation(`Alerts.${id.toUpperCase()}`);
    }

    /**
     * 
     * @param {*} id 
     * @returns Localized
     */
    getBattleMsg(id){
        return this.getTranslation(`BattleInfo.${id.toUpperCase()}`);
    }

    /**
     *
     * @param {*} id
     * @returns Localized Optimizer output message
     */
    getOptimizerMsg(id) {
        return this.getTranslation(`OptimizerInfo.${id.toUpperCase()}`);
    }

    getMobInfo() {
        return this.getTranslation(`MobInfo`);
    }

    /**
     * 
     * @param {string} key Key to indentify localize resources, support '.' eg: 'ConsoleMessages.SUCC_IMPORT_FIGHTER'
     * @returns The key is exists: true/false
     */
    isInclude(key = null) {
        if (!key) return false;
        if (key.includes('.')) {
            const keys = key.split('.');
            let current = this.translations[this.currentLang];        
            
            for (const k of keys) {
                if (current && typeof current === 'object' && k in current) {
                    current = current[k];
                } else {
                    return false;
                }
            }
            return current;
        }

        return this.translations[this.currentLang] && this.translations[this.currentLang][key] 
            ? true
            : false;
    }

    /**
     * 
     * @param {string} key Key to indentify localize resources, support '.' eg: 'ConsoleMessages.SUCC_IMPORT_FIGHTER'
     * @returns Localized Content, if not localized will return original key.
     */
    getTranslation(key = null) {
        if (!key) return key;
        if (key.includes('.')) {
            const keys = key.split('.');
            let current = this.translations[this.currentLang];
        
            for (const k of keys) {
                if (current && typeof current === 'object' && k in current) {
                    current = current[k];
                } else {
                    return key;
                }
            }
            return current;
        }
        
        return this.translations[this.currentLang] && this.translations[this.currentLang][key] 
            ? this.translations[this.currentLang][key] 
            : key;
    }

    
    /**
     * Get Fighters' description
     * @param {string} className Fighter's classname
     * @returns Localized fighter name. All as a object if className is null.
     */
    getClassDescription(className = null) {
        // 如果没有提供类名，返回所有职业描述
        if (className === null || className === undefined) {

            if (this.translations[this.currentLang] && this.translations[this.currentLang].class_descriptions) {
                const translatedDescriptions = {};
                
                // Enum keys from defaultLanguage(EN)
                Object.keys(this._defaultLanguage.class_descriptions).forEach(classKey => {
                    // 将键转换为显示名称（如 "assassin" -> "Assassin"）
                    const displayName = classKey.split('_').map(word => 
                        word.charAt(0).toUpperCase() + word.slice(1)
                    ).join(' ');
                    
                    // Try using localized name or load from default.
                    if (this.translations[this.currentLang].class_descriptions[classKey]) {
                        translatedDescriptions[displayName] = this.translations[this.currentLang].class_descriptions[classKey];
                    } else {
                        translatedDescriptions[displayName] = this._defaultLanguage.class_descriptions[classKey];
                    }
                });
                
                return translatedDescriptions;
            }

            return null;
        }
        
        const classKey = className.toLowerCase().replace(/\s+/g, '_');

        if (this.translations[this.currentLang] && 
            this.translations[this.currentLang].class_descriptions && 
            this.translations[this.currentLang].class_descriptions[classKey]) {
            return this.translations[this.currentLang].class_descriptions[classKey];
        }
        
        return "No description available";
    }

    on(event, callback) {
        this.eventTarget.addEventListener(event, callback);
    }

    off(event, callback) {
        this.eventTarget.removeEventListener(event, callback);
    }
}

// formatting string like : {0} wins battle after {1} rounds.
/**
 * 
 * @param {string} str Strings need to be formatted with digital placeholders. {0}/{1}
 * @param  {...any} args Could be any, string/digital/object, object will be process by JSON.stringify.
 * @returns Formatted string.
 */
export function formatString (str, ...args) {
  return str.replace(/{(\d+)}/g, (match, index) => {
    const idx = Number(index);
    if (idx >= args.length) {
      throw new Error(`Missing argument for placeholder {${idx}}`);
    }

    const value = args[idx];

    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }

    return String(value);
  });
}

// 导出 I18nManager 类
export default I18nManager;