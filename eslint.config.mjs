import globals from "globals";
import js from "@eslint/js";

export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  js.configs.recommended
];