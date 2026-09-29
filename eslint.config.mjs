import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig(
  globalIgnores([
    "**/.next/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "next-env.d.ts",
  ]),

  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },

  {
    files: ["apps/web/**/*.{js,jsx,ts,tsx}"],
    extends: [...nextVitals],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
);
