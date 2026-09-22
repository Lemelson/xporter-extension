// A fixed catalog: old custom backgrounds are no longer applied.
(function (root) {
    'use strict';
    const presets = [
    {
        "id": "classic-dark",
        "key": "themeClassicDark",
        "mode": "dark",
        "preview": {
            "background": "#151b24",
            "surface": "#202833",
            "header": "#1b222d",
            "text": "#edf2f8",
            "accent": "#8ac2ff",
            "button": "#1374cd",
            "buttonText": "#ffffff"
        }
    },
    {
        "id": "classic-light",
        "key": "themeClassicLight",
        "mode": "light",
        "preview": {
            "background": "#e9eef5",
            "surface": "#ffffff",
            "header": "#eef2f7",
            "text": "#202b3b",
            "accent": "#096ac8",
            "button": "#1374cd",
            "buttonText": "#ffffff"
        }
    },
    {
        "id": "glass-dark",
        "key": "themeColorGlass",
        "mode": "dark",
        "preview": {
            "background": "linear-gradient(145deg,#193541 0%,#713e68 50%,#193541 100%)",
            "surface": "#172732d9",
            "header": "#152833",
            "text": "#f1f4fa",
            "accent": "#9ef0e7",
            "button": "#456970",
            "buttonText": "#ffffff"
        }
    },
    {
        "id": "glass-light",
        "key": "themeColorGlass",
        "mode": "light",
        "preview": {
            "background": "linear-gradient(145deg,#c6f1ee 0%,#f6c9e5 50%,#c6f1ee 100%)",
            "surface": "#f2fcfbd9",
            "header": "#e0f7f6",
            "text": "#182536",
            "accent": "#217a78",
            "button": "#217a78",
            "buttonText": "#ffffff"
        }
    },
    {
        "id": "obsidian",
        "key": "themeObsidian",
        "mode": "dark",
        "preview": {
            "background": "linear-gradient(115deg,#080808 0%,#252525 47%,#080808 70%)",
            "surface": "#171717",
            "header": "#090909",
            "text": "#f5f5f5",
            "accent": "#ffffff",
            "button": "#ffffff",
            "buttonText": "#13170e"
        }
    },
    {
        "id": "signal",
        "key": "themeSignal",
        "mode": "dark",
        "preview": {
            "background": "#1b1e21",
            "surface": "#282d32",
            "header": "#141719",
            "text": "#f6f6f4",
            "accent": "#ff762c",
            "button": "#ff762c",
            "buttonText": "#13170e"
        }
    },
    {
        "id": "cobalt",
        "key": "themeCobalt",
        "mode": "light",
        "preview": {
            "background": "linear-gradient(180deg,#0644d4,#1266f0)",
            "surface": "#ffffff",
            "header": "#07349e",
            "text": "#101d39",
            "accent": "#194693",
            "headerText": "#ffffff",
            "checkText": "#ffffff",
            "button": "#ffffff",
            "buttonText": "#101010"
        }
    },
    {
        "id": "forest",
        "key": "themeForest",
        "mode": "dark",
        "preview": {
            "background": "linear-gradient(90deg,#092c25,#164438 55%,#092c25)",
            "surface": "#103d31",
            "header": "#08251e",
            "text": "#f8f2df",
            "accent": "#d4b979",
            "button": "#d4b979",
            "buttonText": "#13170e"
        }
    },
    {
        "id": "bordeaux",
        "key": "themeBordeaux",
        "mode": "dark",
        "preview": {
            "background": "linear-gradient(180deg,#34101d,#681e30 52%,#34101d)",
            "surface": "#24151b",
            "header": "#260e17",
            "text": "#fff0e6",
            "accent": "#eacaa9",
            "button": "#eacaa9",
            "buttonText": "#13170e"
        }
    },
    {
        "id": "porcelain",
        "key": "themePorcelain",
        "mode": "light",
        "preview": {
            "background": "linear-gradient(180deg,#fff2e9,#ecc5d1)",
            "surface": "#fffafa",
            "header": "#fff5f1",
            "text": "#482536",
            "accent": "#a52454",
            "button": "#a52454",
            "buttonText": "#ffffff"
        }
    },
    {
        "id": "iris",
        "key": "themeIris",
        "mode": "dark",
        "preview": {
            "background": "linear-gradient(155deg,#231253,#512ec4 55%,#211348)",
            "surface": "#201743",
            "header": "#190f38",
            "text": "#faf5ff",
            "accent": "#cfb9ff",
            "button": "#cfb9ff",
            "buttonText": "#13170e"
        }
    }
];
    function resolve(settings = {}) {
        return presets.find(preset => preset.id === settings.themePreset) ||
            presets.find(preset => preset.id === (settings.theme === 'light' ? 'classic-light' : 'classic-dark'));
    }
    function apply(element, settings) {
        const preset = resolve(settings);
        element.dataset.themePreset = preset.id;
        element.classList.toggle('light', preset.mode === 'light');
        element.classList.add('simplified');
        return preset;
    }
    root.XPorterThemes = Object.freeze({ presets: Object.freeze(presets.map(p => Object.freeze(p))), resolve, apply });
})(globalThis);
