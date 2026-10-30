// Build-time settings injected by build.mjs from config.json and package.json.
declare const __BB_CONFIG__: { catalogUrl: string; version: string };

export const CONFIG = __BB_CONFIG__;
