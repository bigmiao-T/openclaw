import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(
  ["extensions/agent-checkpoint/**/*.test.ts"],
  {
    dir: "extensions",
    name: "extension-agent-checkpoint",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  },
);
