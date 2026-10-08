const { defineConfig } = require("@playwright/test");
const use = { baseURL: "http://127.0.0.1:5500/" };
if (process.env.POS_TEST_BROWSER_EXECUTABLE) use.launchOptions = { executablePath: process.env.POS_TEST_BROWSER_EXECUTABLE };

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.cjs",
  use
});
