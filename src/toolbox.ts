import * as vscode from "vscode";
import { exec, execFile } from "child_process";
import { EXTENSION_NAMESPACE } from "./types";

export const TOOLBOX_VIEW_ID = `${EXTENSION_NAMESPACE}.toolbox`;

// ── Tree-item types ────────────────────────────────────────────────

class ToolCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly categoryName: string,
    public readonly tools: ToolLeafItem[],
  ) {
    super(categoryName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = `${EXTENSION_NAMESPACE}.toolCategory`;
    this.iconPath = new vscode.ThemeIcon("folder-opened");
  }
}

class ToolLeafItem extends vscode.TreeItem {
  constructor(
    public readonly toolId: string,
    label: string,
    public readonly categoryName: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = `${EXTENSION_NAMESPACE}.toolItem`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command: `${EXTENSION_NAMESPACE}.runTool`,
      title: "Run Tool",
      arguments: [this],
    };
  }
}

type ToolboxTreeItem = ToolCategoryItem | ToolLeafItem;

// ── Registry of categories / tools ─────────────────────────────────

interface ToolDefinition {
  id: string;
  label: string;
  icon: string;
}

interface CategoryDefinition {
  name: string;
  tools: ToolDefinition[];
}

const CATEGORIES: CategoryDefinition[] = [
  {
    name: "Auth",
    tools: [
      { id: "awsSsoLogin", label: "AWS SSO Login", icon: "key" },
      { id: "awsListProfiles", label: "AWS List Profiles", icon: "list-unordered" },
    ],
  },
];

// ── Tree-data provider ─────────────────────────────────────────────

export class ToolboxTreeProvider implements vscode.TreeDataProvider<ToolboxTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ToolboxTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private categoryItems: ToolCategoryItem[];

  constructor() {
    this.categoryItems = CATEGORIES.map((cat) => {
      const leaves = cat.tools.map(
        (t) => new ToolLeafItem(t.id, t.label, cat.name, t.icon),
      );
      return new ToolCategoryItem(cat.name, leaves);
    });
  }

  getTreeItem(element: ToolboxTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ToolboxTreeItem): ToolboxTreeItem[] {
    if (!element) {
      return this.categoryItems;
    }
    if (element instanceof ToolCategoryItem) {
      return element.tools;
    }
    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}

// ── Tool runners ───────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, () => Promise<void>> = {
  awsSsoLogin: runAwsSsoLogin,
  awsListProfiles: runAwsListProfiles,
};

export function registerToolboxCommands(
  context: vscode.ExtensionContext,
  provider: ToolboxTreeProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${EXTENSION_NAMESPACE}.runTool`,
      async (item?: ToolLeafItem) => {
        if (!item) { return; }
        const handler = TOOL_HANDLERS[item.toolId];
        if (handler) {
          await handler();
        } else {
          vscode.window.showWarningMessage(`No handler for tool: ${item.label}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      `${EXTENSION_NAMESPACE}.refreshToolbox`,
      () => provider.refresh(),
    ),
  );
}

// ── AWS SSO Login ──────────────────────────────────────────────────

function runCmd(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function isAwsCliInstalled(): Promise<boolean> {
  try {
    const output = await runCmd("aws --version");
    // AWS CLI v2 outputs "aws-cli/2.x.x ..."
    return /aws-cli\/2\./i.test(output);
  } catch {
    return false;
  }
}

async function listSsoProfiles(): Promise<string[]> {
  try {
    const output = await runCmd("aws configure list-profiles");
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function runAwsSsoLogin(): Promise<void> {
  // 1. Check AWS CLI 2
  const installed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Checking AWS CLI..." },
    () => isAwsCliInstalled(),
  );

  if (!installed) {
    const action = await vscode.window.showWarningMessage(
      "AWS CLI 2.0 is required but was not found. Please install it first.",
      "Open Download Page",
    );
    if (action === "Open Download Page") {
      vscode.env.openExternal(
        vscode.Uri.parse("https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"),
      );
    }
    return;
  }

  // 2. Ask for profile name
  const existingProfiles = await listSsoProfiles();

  const profileName = await vscode.window.showInputBox({
    title: "AWS SSO Login",
    prompt: "Enter the AWS SSO profile name",
    placeHolder: "my-sso-profile",
    validateInput: (v) => (v.trim() ? undefined : "Profile name is required"),
  });

  if (!profileName) { return; }
  const profile = profileName.trim();

  // 3. Check if profile exists
  if (!existingProfiles.includes(profile)) {
    const create = await vscode.window.showWarningMessage(
      `Profile "${profile}" does not exist. Would you like to configure it now?`,
      "Configure Profile",
      "Cancel",
    );
    if (create !== "Configure Profile") { return; }
    await configureSsoProfile(profile);
    return;
  }

  // 4. Run SSO login
  await runSsoLoginInTerminal(profile);
}

async function runSsoLoginInTerminal(profile: string): Promise<void> {
  const terminal = vscode.window.createTerminal({ name: `AWS SSO: ${profile}` });
  terminal.show();
  terminal.sendText(`aws sso login --profile ${profile}`);
}

// ── SSO profile configuration ──────────────────────────────────────

interface SsoProfileConfig {
  ssoStartUrl: string;
  ssoRegion: string;
  ssoAccountId: string;
  ssoRoleName: string;
  defaultRegion: string;
  defaultOutput: string;
}

async function configureSsoProfile(profile: string): Promise<void> {
  // Collect required information via a series of input boxes
  const ssoStartUrl = await vscode.window.showInputBox({
    title: `Configure SSO Profile: ${profile} (1/6)`,
    prompt: "SSO Start URL",
    placeHolder: "https://my-sso-portal.awsapps.com/start",
    validateInput: (v) => {
      const trimmed = v.trim();
      if (!trimmed) { return "SSO Start URL is required"; }
      try {
        new URL(trimmed);
        return undefined;
      } catch {
        return "Please enter a valid URL";
      }
    },
  });
  if (!ssoStartUrl) { return; }

  const ssoRegion = await vscode.window.showInputBox({
    title: `Configure SSO Profile: ${profile} (2/6)`,
    prompt: "SSO Region",
    placeHolder: "us-east-1",
    value: "us-east-1",
    validateInput: (v) => (v.trim() ? undefined : "SSO Region is required"),
  });
  if (!ssoRegion) { return; }

  const ssoAccountId = await vscode.window.showInputBox({
    title: `Configure SSO Profile: ${profile} (3/6)`,
    prompt: "SSO Account ID",
    placeHolder: "123456789012",
    validateInput: (v) => {
      const trimmed = v.trim();
      if (!trimmed) { return "Account ID is required"; }
      if (!/^\d{12}$/.test(trimmed)) { return "Account ID must be a 12-digit number"; }
      return undefined;
    },
  });
  if (!ssoAccountId) { return; }

  const ssoRoleName = await vscode.window.showInputBox({
    title: `Configure SSO Profile: ${profile} (4/6)`,
    prompt: "SSO Role Name",
    placeHolder: "AdministratorAccess",
    validateInput: (v) => (v.trim() ? undefined : "Role name is required"),
  });
  if (!ssoRoleName) { return; }

  const defaultRegion = await vscode.window.showInputBox({
    title: `Configure SSO Profile: ${profile} (5/6)`,
    prompt: "Default CLI Region",
    placeHolder: "us-east-1",
    value: ssoRegion.trim(),
    validateInput: (v) => (v.trim() ? undefined : "Default region is required"),
  });
  if (!defaultRegion) { return; }

  const defaultOutput = await vscode.window.showQuickPick(
    ["json", "yaml", "text", "table"],
    {
      title: `Configure SSO Profile: ${profile} (6/6)`,
      placeHolder: "Default output format",
    },
  );
  if (!defaultOutput) { return; }

  const config: SsoProfileConfig = {
    ssoStartUrl: ssoStartUrl.trim(),
    ssoRegion: ssoRegion.trim(),
    ssoAccountId: ssoAccountId.trim(),
    ssoRoleName: ssoRoleName.trim(),
    defaultRegion: defaultRegion.trim(),
    defaultOutput,
  };

  // Run aws configure set commands for the profile
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating SSO profile "${profile}"...`,
      cancellable: false,
    },
    async () => {
      const commands = [
        `aws configure set sso_start_url "${config.ssoStartUrl}" --profile ${profile}`,
        `aws configure set sso_region ${config.ssoRegion} --profile ${profile}`,
        `aws configure set sso_account_id ${config.ssoAccountId} --profile ${profile}`,
        `aws configure set sso_role_name "${config.ssoRoleName}" --profile ${profile}`,
        `aws configure set region ${config.defaultRegion} --profile ${profile}`,
        `aws configure set output ${config.defaultOutput} --profile ${profile}`,
      ];

      for (const cmd of commands) {
        await runCmd(cmd);
      }
    },
  );

  vscode.window.showInformationMessage(
    `SSO profile "${profile}" created successfully.`,
  );

  // Offer to log in right away
  const loginNow = await vscode.window.showInformationMessage(
    `Would you like to log in with profile "${profile}" now?`,
    "Login Now",
    "Later",
  );

  if (loginNow === "Login Now") {
    await runSsoLoginInTerminal(profile);
  }
}

// ── AWS List Profiles ──────────────────────────────────────────────

interface ProfileDetail {
  name: string;
  region?: string;
  output?: string;
  ssoStartUrl?: string;
}

async function getProfileDetail(profile: string): Promise<ProfileDetail> {
  const detail: ProfileDetail = { name: profile };
  try {
    detail.region = (await runCmd(`aws configure get region --profile ${profile}`)) || undefined;
  } catch { /* not set */ }
  try {
    detail.output = (await runCmd(`aws configure get output --profile ${profile}`)) || undefined;
  } catch { /* not set */ }
  try {
    detail.ssoStartUrl = (await runCmd(`aws configure get sso_start_url --profile ${profile}`)) || undefined;
  } catch { /* not set */ }
  return detail;
}

async function runAwsListProfiles(): Promise<void> {
  // 1. Check AWS CLI
  const installed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Checking AWS CLI..." },
    () => isAwsCliInstalled(),
  );

  if (!installed) {
    const action = await vscode.window.showWarningMessage(
      "AWS CLI 2.0 is required but was not found. Please install it first.",
      "Open Download Page",
    );
    if (action === "Open Download Page") {
      vscode.env.openExternal(
        vscode.Uri.parse("https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"),
      );
    }
    return;
  }

  // 2. List profiles
  const profiles = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Loading AWS profiles..." },
    () => listSsoProfiles(),
  );

  if (profiles.length === 0) {
    vscode.window.showInformationMessage("No AWS profiles found.");
    return;
  }

  // 3. Fetch details for all profiles
  const details = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Loading profile details..." },
    () => Promise.all(profiles.map(getProfileDetail)),
  );

  // 4. Show quick-pick with profile details
  const items = details.map((d) => {
    const parts: string[] = [];
    if (d.ssoStartUrl) { parts.push("SSO"); }
    if (d.region) { parts.push(d.region); }
    if (d.output) { parts.push(d.output); }
    return {
      label: d.name,
      description: parts.join(" | ") || undefined,
      detail: d.ssoStartUrl ? `SSO: ${d.ssoStartUrl}` : undefined,
      profileDetail: d,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: "AWS Profiles",
    placeHolder: "Select a profile for actions",
  });

  if (!selected) { return; }

  // 5. Offer actions for the selected profile
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(terminal) SSO Login", id: "sso-login" },
      { label: "$(copy) Copy Profile Name", id: "copy-name" },
    ],
    {
      title: `Profile: ${selected.label}`,
      placeHolder: "Choose an action",
    },
  );

  if (!action) { return; }

  switch (action.id) {
    case "sso-login":
      await runSsoLoginInTerminal(selected.label);
      break;
    case "copy-name":
      await vscode.env.clipboard.writeText(selected.label);
      vscode.window.setStatusBarMessage(`Copied: ${selected.label}`, 2000);
      break;
  }
}
