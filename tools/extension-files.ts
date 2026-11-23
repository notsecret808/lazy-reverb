export const extensionScripts = ["engine.js", "popup.js"] as const;
export const extensionAssets = ["manifest.json", "popup.html", "popup.css", "icon.svg"] as const;
export const extensionFiles = [...extensionAssets, ...extensionScripts];
