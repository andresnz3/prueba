const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.cjs",
  use: {
    baseURL: "http://127.0.0.1:5500/"
  }
});