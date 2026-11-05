// Build-time settings injected by build.mjs from config.json and package.json.
declare const __PN_CONFIG__: { catalogUrl: string; reportUrl: string; sourceUrl: string; privacyUrl: string; supportedModels: string[]; makerworldOrigins: string[]; version: string };

export const CONFIG = __PN_CONFIG__;
