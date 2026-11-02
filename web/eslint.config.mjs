import next from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...next,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { ignoreRestSiblings: true, varsIgnorePattern: "^_" },
      ],
    },
  },
  { ignores: [".next/**", "next-env.d.ts", "tests/e2e/.output/**"] },
];

export default config;
