import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
  runIsolatedModuleScript,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("Doctor CLI migration refusal", () => {
  it("fails closed with manual recovery for an unsupported workspace and conflicting exec policy", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-unsupported-state-"));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    const sourcePath = path.join(stateDir, "exec-approvals.json");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { ownership: "explicit", entries: { main: { workspace: workspaceDir } } },
        plugins: { enabled: false },
      }),
    );
    const legacy = JSON.stringify({ version: 1, defaults: { security: "full" }, agents: {} });
    fs.writeFileSync(sourcePath, legacy);
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      NO_COLOR: "1",
      CI: "1",
    };
    const runtimeRoot = createBuiltRuntime(root);
    await runIsolatedModuleScript(
      env,
      `
      import { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } from "./src/state/openclaw-state-db.ts";
      import { resolveWorkspaceStateIdentity } from "./src/agents/workspace-state-identity.ts";
      import { writeExecApprovalsConfigRow } from "./src/infra/exec-approvals-sqlite.ts";
      const { db } = openOpenClawStateDatabase();
      const identity = resolveWorkspaceStateIdentity(${JSON.stringify(workspaceDir)});
      db.prepare("INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, updated_at) VALUES (?, ?, 99, 1)").run(identity.workspaceKey, identity.workspacePath);
      writeExecApprovalsConfigRow({ db, file: { version: 1, defaults: { security: "deny" }, agents: {} } });
      closeOpenClawStateDatabaseForTest();
    `,
      { runtimeRoot, timeoutMs: 60_000 },
    );
    const result = runBuiltRuntime(
      runtimeRoot,
      env,
      ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
      60_000,
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const text = output.replaceAll("│", " ").replace(/\s+/g, " ");
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain(databasePath);
    expect(output).toContain(workspaceDir);
    expect(text).toContain("unsupported workspace setup version 99");
    expect(text).toContain("compatible OpenClaw build");
    expect(output).toContain(sourcePath);
    expect(text).toContain("reconcile this file");
    expect(text).not.toMatch(/(?:openclaw\s+)?doctor\s+--(?:fix|repair)/i);
    expect(output).not.toContain("Doctor complete.");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(legacy);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT version FROM workspace_setup_state").all()).toEqual([
        { version: 99 },
      ]);
      const policy = db
        .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
        .get();
      expect(JSON.parse(String(policy?.raw_json))).toMatchObject({
        defaults: { security: "deny" },
      });
    } finally {
      db.close();
    }
  }, 120_000);

  it.each([false, true])(
    "honors the ordered graph with valid TUI=%s",
    async (validTui) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-doctor-refusal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const tuiPath = path.join(stateDir, "tui", "last-session.json");
      const approvalsPath = path.join(stateDir, "exec-approvals.json");
      const tuiRaw = validTui
        ? JSON.stringify({
            terminal: { sessionKey: "agent:main:tui:behavior-validator", updatedAt: 100 },
          }) + "\n"
        : "not json\n";
      const approvalsRaw =
        JSON.stringify({
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss" },
          agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
        }) + "\n";
      fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
      fs.writeFileSync(configPath, "{}\n");
      fs.writeFileSync(tuiPath, tuiRaw);
      fs.writeFileSync(approvalsPath, approvalsRaw);
      const runtimeRoot = createBuiltRuntime(root);
      const result = runBuiltRuntime(
        runtimeRoot,
        {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          NO_COLOR: "1",
          CI: "1",
        },
        ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
        60_000,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.signal, output).toBeNull();
      const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const approvals = db
          .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
          .all();
        if (validTui) {
          expect(result.status, output).toBe(0);
          expect(output).toContain("Doctor complete.");
          expect(output.indexOf("TUI last-session pointer(s)")).toBeGreaterThanOrEqual(0);
          expect(output.indexOf("Imported legacy exec approvals")).toBeGreaterThan(
            output.indexOf("TUI last-session pointer(s)"),
          );
          expect(fs.existsSync(tuiPath)).toBe(false);
          expect(fs.existsSync(approvalsPath)).toBe(false);
          expect(approvals).toHaveLength(1);
        } else {
          expect(fs.existsSync(approvalsPath), output).toBe(true);
          expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsRaw);
          expect(fs.readFileSync(tuiPath, "utf8")).toBe(tuiRaw);
          expect(approvals).toEqual([]);
          expect(result.status, output).toBe(1);
          expect(output).toContain("Failed reading legacy TUI last-session state");
          expect(output).not.toContain("Imported legacy exec approvals");
          expect(output).not.toContain("Doctor complete.");
          expect(output).not.toContain("rerun doctor --fix");
        }
      } finally {
        db.close();
      }
    },
    60_000,
  );
});
