import globals from "globals";
import js from "@eslint/js";

export default [
  {
    files: ["**/*.js", "**/*.cjs"],
    ignores: ["backend/**"],
    languageOptions: {
      globals: {
        ...globals.browser,
        indexedDB: "readonly"
      }
    }
  },
  {
    files: ["backend/**/*.js", "**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node
    }
  },
  {
    files: ["tests-connected/*.spec.cjs"],
    languageOptions: {
      // Variables del POS usadas exclusivamente por callbacks de page.evaluate.
      globals: {
        isAdmin: "readonly",
        currentUser: "readonly",
        unlockedModuleId: "writable",
        localDB: "readonly",
        createPosDatabase: "readonly",
        DEFAULT_BUSINESS_ID: "readonly"
      }
    }
  },
  js.configs.recommended
];
