/**
 * Slack CLI hooks for this Bun app (replaces the Node-only @slack/cli-hooks package).
 * Spec: https://docs.slack.dev/tools/slack-cli/reference/hooks/
 *
 *   get-hooks     → which commands the CLI runs for each hook
 *   get-manifest  → slack-manifest.yaml as JSON (stdout must hold only the JSON)
 *
 * `slack-cli run` runs the `start` hook with SLACK_BOT_TOKEN / SLACK_APP_TOKEN set for the dev app.
 */
const hook = Bun.argv[2];

switch (hook) {
  case "get-hooks":
    console.log(
      JSON.stringify({
        hooks: {
          "get-manifest": "bun run scripts/slack-hooks.ts get-manifest",
          start: "bun run src/index.ts",
        },
        config: {
          // Our code opens the Socket Mode connection itself (Bolt), the CLI only supplies tokens.
          "sdk-managed-connection-enabled": true,
          watch: {
            app: { paths: ["src"], "filter-regex": "\\.ts$" },
            manifest: { paths: ["slack-manifest.yaml"] },
          },
        },
        runtime: "bun",
      }),
    );
    break;

  case "get-manifest": {
    const manifest = Bun.YAML.parse(await Bun.file(new URL("../slack-manifest.yaml", import.meta.url)).text());
    console.log(JSON.stringify(manifest));
    break;
  }

  default:
    throw new Error(`Unknown Slack CLI hook: ${hook}`);
}
