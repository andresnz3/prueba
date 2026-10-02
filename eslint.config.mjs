import globals from "globals";
import js from "@eslint/js";

export default [
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        indexedDB: "readonly"
      }
    }
  },
  js.configs.recommended
];