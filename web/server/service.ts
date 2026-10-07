import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { DEFAULT_PORT_PROD } from "./constants.js";
import { getServicePath } from "./path-resolver.js";
import { COMPANION_HOME } from "./paths.js";

// ─── Shared Constants ───────────────────────────────────────────────────────────

const LOG_DIR = join(COMPANION_HOME, "logs");
const STDOUT_LOG = join(LOG_DIR, "companion.log");
const STDERR_LOG = join(LOG_DIR, "companion.error.log");

// ─── macOS (launchd) Constants ──────────────────────────────────────────────────

const LABEL = "sh.thecompanion.app";
const OLD_LABEL = "co.thevibecompany.companion";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const OLD_PLIST_PATH = join(PLIST_DIR, `${OLD_LABEL}.plist`);

// ─── Linux (systemd) Constants ──────────────────────────────────────────────────

const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_NAME = "the-companion.service";
const UNIT_PATH = join(SYSTEMD_DIR, UNIT_NAME);

/**
 * Exit code the server uses to ask an external supervisor (a system-wide
 * systemd unit, or anything configured via COMPANION_SERVICE_MODE=1) to
 * restart it after an in-app update. It must be non-zero so that units with
 * `Restart=on-failure` respawn the process, and it deliberately differs from
 * 42, which our own user-unit template lists in `SuccessExitStatus=`.
 * 75 is EX_TEMPFAIL from sysexits.h ("temporary failure, try again").
 */
export const UPDATE_RESTART_EXIT_CODE = 75;

// ─── Platform check ─────────────────────────────────────────────────────────────

function ensureSupportedPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error(
      "Service management is only supported on macOS (launchd) and Linux (systemd).",
    );
    process.exit(1);
  }
}

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

// ─── Plist generation (macOS) ───────────────────────────────────────────────────

interface PlistOptions {
  binPath: string;
  port?: number;
  path?: string;
}

export function generatePlist(opts: PlistOptions): string {
  const port = opts.port ?? DEFAULT_PORT_PROD;
  const home = homedir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${opts.binPath}</string>
        <string>start</string>
        <string>--foreground</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${home}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>

    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>${port}</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>${opts.path || getServicePath()}</string>
    </dict>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>`;
}

// ─── Systemd unit generation (Linux) ────────────────────────────────────────────

interface UnitOptions {
  binPath: string;
  port?: number;
  path?: string;
}

export function generateSystemdUnit(opts: UnitOptions): string {
  const port = opts.port ?? DEFAULT_PORT_PROD;
  const home = homedir();

  return `[Unit]
Description=The Companion - Web UI for Claude Code
After=network.target

[Service]
Type=simple
ExecStart=${opts.binPath} start --foreground
WorkingDirectory=${home}
Restart=always
RestartSec=5
SuccessExitStatus=42
StandardOutput=append:${STDOUT_LOG}
StandardError=append:${STDERR_LOG}
Environment=NODE_ENV=production
Environment=PORT=${port}
Environment=HOME=${home}
Environment=PATH=${opts.path || getServicePath()}

[Install]
WantedBy=default.target
`;
}

// ─── Binary resolution ──────────────────────────────────────────────────────────

function resolveBinPath(): string {
  try {
    const binPath = execSync("which the-companion", { encoding: "utf-8" }).trim();
    if (binPath) return binPath;
  } catch {
    // not found globally
  }

  console.error("the-companion must be installed globally for service mode.");
  console.error("");
  console.error("  bun install -g the-companion");
  console.error("");
  console.error("Then retry:");
  console.error("");
  console.error("  the-companion install");
  process.exit(1);
}

// ─── macOS helpers ──────────────────────────────────────────────────────────────

function unloadLaunchdService(plistPath: string): void {
  try {
    execSync(`launchctl unload -w "${plistPath}"`, { stdio: "pipe" });
  } catch {
    // Service may already be unloaded — that's fine
  }
}

function removePlist(plistPath: string): void {
  try {
    unlinkSync(plistPath);
  } catch {
    // Already gone
  }
}

function migrateLegacyInstallIfNeeded(): void {
  if (!existsSync(OLD_PLIST_PATH)) return;

  console.log("Found legacy The Vibe Companion service. Migrating...");
  unloadLaunchdService(OLD_PLIST_PATH);
  removePlist(OLD_PLIST_PATH);
}

function getInstalledLaunchdService():
  | { label: string; plistPath: string }
  | undefined {
  if (existsSync(PLIST_PATH)) return { label: LABEL, plistPath: PLIST_PATH };
  if (existsSync(OLD_PLIST_PATH)) {
    return { label: OLD_LABEL, plistPath: OLD_PLIST_PATH };
  }
  return undefined;
}

// ─── Linux helpers ──────────────────────────────────────────────────────────────

function isSystemdUnitInstalled(): boolean {
  return existsSync(UNIT_PATH);
}

function systemctlUser(cmd: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return execSync(`systemctl --user ${cmd}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    },
  });
}

/**
 * Run a command against the system-wide systemd instance (no `--user`).
 * Read-only queries (show / is-active) work unprivileged; mutating commands
 * need root or a polkit rule.
 */
function systemctlSystem(cmd: string): string {
  return execSync(`systemctl ${cmd}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export interface SystemUnitInfo {
  activeState: string;
  mainPid?: number;
  invocationId?: string;
  fragmentPath?: string;
  port?: number;
}

/**
 * Look up a system-wide `the-companion.service` (e.g. one an admin placed in
 * /etc/systemd/system with `User=...`). Returns undefined when no such unit
 * is loaded or systemctl is unavailable. Never throws.
 */
export function getSystemUnitInfo(): SystemUnitInfo | undefined {
  if (!isLinux()) return undefined;
  let output: string;
  try {
    output = systemctlSystem(
      `show ${UNIT_NAME} --property=LoadState,ActiveState,MainPID,InvocationID,FragmentPath,Environment --no-pager`,
    );
  } catch {
    return undefined;
  }
  if (typeof output !== "string") return undefined;
  const prop = (name: string): string | undefined => {
    const m = output.match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? m[1].trim() : undefined;
  };
  // LoadState=not-found is what systemd reports for units that don't exist.
  if (prop("LoadState") !== "loaded") return undefined;

  const pid = Number(prop("MainPID"));
  const portMatch = prop("Environment")?.match(/(?:^|\s)PORT=(\d+)/);
  return {
    activeState: prop("ActiveState") || "unknown",
    mainPid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
    invocationId: prop("InvocationID") || undefined,
    fragmentPath: prop("FragmentPath") || undefined,
    port: portMatch ? Number(portMatch[1]) : undefined,
  };
}

/** Explains how to manage a system-wide unit, which we can't do for the user. */
function printSystemUnitHint(action: string, info: SystemUnitInfo): void {
  console.log("The Companion is managed by a system-wide systemd unit:");
  console.log(`  Unit:   ${info.fragmentPath ?? UNIT_NAME}`);
  console.log(`  State:  ${info.activeState}`);
  console.log("");
  console.log(`Use: sudo systemctl ${action} ${UNIT_NAME}`);
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Handle start/stop/restart when only a system-wide unit exists. As root we
 * can drive it directly; otherwise print the sudo command and fail, rather
 * than falling through to `systemctl --user` (misleading) or, for `start`,
 * installing a second, conflicting user unit.
 */
function controlSystemUnit(action: "start" | "stop" | "restart", info: SystemUnitInfo): void {
  if (isRoot()) {
    try {
      systemctlSystem(`${action} ${UNIT_NAME}`);
    } catch (err: unknown) {
      console.error(`Failed to ${action} the system service with systemctl:`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const past = action === "stop" ? "stopped" : action === "start" ? "started" : "restarted";
    console.log(`The Companion system service has been ${past}.`);
    return;
  }
  printSystemUnitHint(action, info);
  process.exit(1);
}

/**
 * Resolve true when something is already listening on `port`. Binding with
 * no host uses the dual-stack wildcard, which conflicts with a listener on
 * any address, so this also catches servers bound to 0.0.0.0 or 127.0.0.1.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port);
  });
}

// ─── Install ────────────────────────────────────────────────────────────────────

export async function install(opts?: { port?: number }): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return installDarwin(opts);
  }
  return installLinux(opts);
}

async function installDarwin(opts?: { port?: number }): Promise<void> {
  migrateLegacyInstallIfNeeded();

  if (existsSync(PLIST_PATH)) {
    console.error("The Companion is already installed as a service.");
    console.error("Run 'the-companion uninstall' first to reinstall.");
    process.exit(1);
  }

  const binPath = resolveBinPath();
  const port = opts?.port ?? DEFAULT_PORT_PROD;

  // Create log directory
  mkdirSync(LOG_DIR, { recursive: true });

  // Generate and write plist (capture user's shell PATH at install time)
  const path = getServicePath();
  const plist = generatePlist({ binPath, port, path });
  mkdirSync(PLIST_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, plist, "utf-8");

  // Load the service
  try {
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch (err: unknown) {
    console.error("Failed to load the service with launchctl:");
    console.error(err instanceof Error ? err.message : String(err));
    // Clean up the plist on failure
    try { unlinkSync(PLIST_PATH); } catch { /* ok */ }
    process.exit(1);
  }

  console.log("The Companion has been installed as a background service.");
  console.log("");
  console.log(`  URL:    http://localhost:${port}`);
  console.log(`  Logs:   ${LOG_DIR}`);
  console.log(`  Plist:  ${PLIST_PATH}`);
  console.log("");
  console.log("The service will start automatically on login.");
  console.log("Use 'the-companion status' to check if it's running.");
}

async function installLinux(opts?: { port?: number }): Promise<void> {
  if (isSystemdUnitInstalled()) {
    console.error("The Companion is already installed as a service.");
    console.error("Run 'the-companion uninstall' first to reinstall.");
    process.exit(1);
  }

  // A system-wide unit already supervises the Companion on this host. A
  // second (user) unit would fight it for the port and crash-loop, or, if it
  // ever won, start with the wrong environment and an empty session store.
  const systemUnit = getSystemUnitInfo();
  if (systemUnit) {
    console.error("The Companion is already installed as a system-wide systemd unit:");
    console.error(`  ${systemUnit.fragmentPath ?? UNIT_NAME} (${systemUnit.activeState})`);
    console.error("");
    console.error("Refusing to install a second, per-user unit.");
    console.error(`Manage it with: sudo systemctl <start|stop|restart|status> ${UNIT_NAME}`);
    console.error("In-app updates work there too (see COMPANION_SERVICE_MODE in the docs).");
    process.exit(1);
  }

  const binPath = resolveBinPath();
  const port = opts?.port ?? DEFAULT_PORT_PROD;

  if (await isPortInUse(port)) {
    console.error(`Port ${port} is already in use.`);
    console.error("Another Companion (or something else) is listening there, so the");
    console.error("service would crash-loop. Stop it first, or install on another port:");
    console.error("  the-companion install --port <port>");
    process.exit(1);
  }

  // Create log directory
  mkdirSync(LOG_DIR, { recursive: true });

  // Generate and write systemd unit (capture user's shell PATH at install time)
  const path = getServicePath();
  const unit = generateSystemdUnit({ binPath, port, path });
  mkdirSync(SYSTEMD_DIR, { recursive: true });
  writeFileSync(UNIT_PATH, unit, "utf-8");

  // Reload systemd and enable + start the service
  try {
    systemctlUser("daemon-reload");
    systemctlUser(`enable --now ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to enable the service with systemctl:");
    console.error(err instanceof Error ? err.message : String(err));
    // Clean up the unit file on failure
    try { unlinkSync(UNIT_PATH); } catch { /* ok */ }
    process.exit(1);
  }

  // Enable linger so user services survive logout
  try {
    execSync("loginctl enable-linger", { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    console.warn(
      "Warning: Could not enable linger. The service may stop when you log out.",
    );
    console.warn("  sudo loginctl enable-linger $(whoami)");
  }

  console.log("The Companion has been installed as a background service.");
  console.log("");
  console.log(`  URL:    http://localhost:${port}`);
  console.log(`  Logs:   ${LOG_DIR}`);
  console.log(`  Unit:   ${UNIT_PATH}`);
  console.log("");
  console.log("The service will start automatically on login.");
  console.log("Use 'the-companion status' to check if it's running.");
}

// ─── Uninstall ──────────────────────────────────────────────────────────────────

export async function uninstall(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return uninstallDarwin();
  }
  return uninstallLinux();
}

async function uninstallDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("The Companion is not installed as a service.");
    return;
  }

  unloadLaunchdService(installedService.plistPath);
  removePlist(installedService.plistPath);

  console.log("The Companion service has been removed.");
  console.log(`Logs are preserved at ${LOG_DIR}`);
}

async function uninstallLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    const systemUnit = getSystemUnitInfo();
    if (systemUnit) {
      // Never remove an admin-managed unit on the user's behalf.
      console.log("The Companion is managed by a system-wide systemd unit, which");
      console.log("'the-companion uninstall' does not remove. To remove it:");
      console.log(`  sudo systemctl disable --now ${UNIT_NAME}`);
      console.log(`  sudo rm ${systemUnit.fragmentPath ?? `/etc/systemd/system/${UNIT_NAME}`}`);
      console.log("  sudo systemctl daemon-reload");
      return;
    }
    console.log("The Companion is not installed as a service.");
    return;
  }

  try {
    systemctlUser(`disable --now ${UNIT_NAME}`);
  } catch {
    // Service may already be stopped — that's fine
  }

  try {
    unlinkSync(UNIT_PATH);
  } catch {
    // Already gone
  }

  try {
    systemctlUser("daemon-reload");
  } catch {
    // Best-effort reload
  }

  console.log("The Companion service has been removed.");
  console.log(`Logs are preserved at ${LOG_DIR}`);
}

// ─── Stop / Restart ────────────────────────────────────────────────────────────

export async function start(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return startDarwin();
  }
  return startLinux();
}

async function startDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("The Companion is not installed as a service.");
    console.log("Run 'the-companion install' first.");
    return;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domain = uid !== undefined ? `gui/${uid}` : "gui";
  const domainTarget = uid !== undefined
    ? `gui/${uid}/${installedService.label}`
    : installedService.label;

  try {
    execSync(`launchctl kickstart -k "${domainTarget}"`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`launchctl bootstrap "${domain}" "${installedService.plistPath}"`, { stdio: "pipe" });
    } catch {
      try {
        execSync(`launchctl load -w "${installedService.plistPath}"`, { stdio: "pipe" });
      } catch (err: unknown) {
        console.error("Failed to start the service with launchctl:");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
  }

  console.log("The Companion service has been started.");
}

async function startLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    const systemUnit = getSystemUnitInfo();
    if (systemUnit) return controlSystemUnit("start", systemUnit);
    console.log("Service not yet installed. Installing now...");
    await installLinux();
    return; // installLinux uses enable --now which starts the service
  }

  // Ensure the installed unit file matches the latest template (e.g.
  // SuccessExitStatus=42, Restart=always) so that stale definitions from
  // older versions don't cause restart loops after an auto-update.
  refreshServiceDefinition();

  try {
    systemctlUser(`start ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to start the service with systemctl:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log("The Companion service has been started.");
}

export async function stop(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return stopDarwin();
  }
  return stopLinux();
}

async function stopDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("The Companion is not installed as a service.");
    return;
  }

  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const domainTarget = uid !== undefined
      ? `gui/${uid}/${installedService.label}`
      : installedService.label;
    // `stop` is not enough with KeepAlive=true: launchd can immediately restart it.
    // Booting out unloads the job from launchd while keeping the plist installed.
    execSync(`launchctl bootout "${domainTarget}"`, { stdio: "pipe" });
  } catch {
    // Fallback for environments where bootout/domain targeting is unavailable.
    unloadLaunchdService(installedService.plistPath);
  }

  console.log("The Companion service has been stopped.");
  console.log("Run 'the-companion restart' to start it again.");
}

async function stopLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    const systemUnit = getSystemUnitInfo();
    if (systemUnit) return controlSystemUnit("stop", systemUnit);
    console.log("The Companion is not installed as a service.");
    return;
  }

  try {
    systemctlUser(`stop ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to stop the service with systemctl:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log("The Companion service has been stopped.");
  console.log("Run 'the-companion restart' to start it again.");
}

export async function restart(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return restartDarwin();
  }
  return restartLinux();
}

async function restartDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("The Companion is not installed as a service.");
    return;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domainTarget = uid !== undefined
    ? `gui/${uid}/${installedService.label}`
    : installedService.label;

  try {
    execSync(`launchctl kickstart -k "${domainTarget}"`, { stdio: "pipe" });
  } catch {
    // Fallback for environments where kickstart/domain targeting is unavailable.
    unloadLaunchdService(installedService.plistPath);
    try {
      execSync(`launchctl load -w "${installedService.plistPath}"`, { stdio: "pipe" });
    } catch (err: unknown) {
      console.error("Failed to restart the service with launchctl:");
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  console.log("The Companion service has been restarted.");
}

async function restartLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    const systemUnit = getSystemUnitInfo();
    if (systemUnit) return controlSystemUnit("restart", systemUnit);
    console.log("The Companion is not installed as a service.");
    return;
  }

  // Keep the unit file in sync with the latest template before restarting.
  refreshServiceDefinition();

  try {
    systemctlUser(`restart ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to restart the service with systemctl:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log("The Companion service has been restarted.");
}

// ─── Status ─────────────────────────────────────────────────────────────────────

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  port?: number;
  /** Linux only: "system" when managed by a system-wide unit. */
  scope?: "user" | "system";
}

/**
 * How the current process is supervised, which decides how an in-app update
 * restarts it:
 * - "launchd" / "systemd-user": our own `the-companion install` units; the
 *   updater asks the service manager to restart us.
 * - "systemd-system": a system-wide `the-companion.service` (typically with
 *   `User=...`), which an unprivileged process can't restart, so the updater
 *   exits with UPDATE_RESTART_EXIT_CODE and lets `Restart=` respawn it.
 * - "external": COMPANION_SERVICE_MODE=1, i.e. the operator promises some
 *   supervisor restarts the process on a non-zero exit. Same exit strategy.
 */
export type ServiceKind = "launchd" | "systemd-user" | "systemd-system" | "external";

function serviceModeEnv(): "on" | "off" | undefined {
  const raw = process.env.COMPANION_SERVICE_MODE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return "on";
  if (["0", "false", "no", "off"].includes(raw)) return "off";
  return undefined;
}

/**
 * Detect how (and whether) the current process runs as a managed service.
 * Never calls process.exit() and never throws.
 *
 * COMPANION_SERVICE_MODE=0 forces service mode off; =1 forces it on when no
 * known service manager is detected.
 */
export function detectServiceKind(): ServiceKind | null {
  const envMode = serviceModeEnv();
  if (envMode === "off") return null;

  if (isDarwin()) {
    const installedService = getInstalledLaunchdService();
    if (installedService) {
      try {
        const output = execSync(`launchctl list "${installedService.label}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (/"PID"\s*=\s*\d+/.test(output)) return "launchd";
      } catch { /* not loaded */ }
    }
  } else if (isLinux()) {
    if (isSystemdUnitInstalled()) {
      try {
        if (systemctlUser(`is-active ${UNIT_NAME}`).trim() === "active") {
          return "systemd-user";
        }
      } catch { /* inactive or no user bus */ }
    }
    if (envMode !== "on" && isUnderSystemUnit()) return "systemd-system";
  }

  return envMode === "on" ? "external" : null;
}

/**
 * True when this process was started by systemd as the system-wide
 * the-companion.service. systemd exports INVOCATION_ID to every service it
 * starts; matching it against the unit's InvocationID proves we are that
 * unit's process rather than, say, a foreground run on a host that also has
 * the unit installed.
 */
function isUnderSystemUnit(): boolean {
  const invocationId = process.env.INVOCATION_ID?.trim();
  if (!invocationId) return false;
  const info = getSystemUnitInfo();
  if (!info) return false;
  if (info.activeState !== "active" && info.activeState !== "reloading") return false;
  // Very old systemd versions don't expose InvocationID; fall back to the
  // active state alone there.
  return !info.invocationId || info.invocationId === invocationId.replace(/-/g, "");
}

let detectedServiceKind: ServiceKind | null = null;

/**
 * Safe check for whether the current process is running as a managed service.
 * Unlike status(), this never calls process.exit() and works on all platforms.
 * The detected kind is remembered for getDetectedServiceKind().
 */
export function isRunningAsService(): boolean {
  detectedServiceKind = detectServiceKind();
  return detectedServiceKind !== null;
}

/** The kind found by the last isRunningAsService() call (null if none). */
export function getDetectedServiceKind(): ServiceKind | null {
  return detectedServiceKind;
}

export interface UpdateRestartPlan {
  /** Command to spawn (detached) before exiting, if any. */
  command?: string[];
  /** Extra environment for the command. */
  env?: Record<string, string>;
  /** Exit code for the current process once the command was spawned. */
  exitCode: number;
}

/**
 * How to get the new version running after `bun install -g` succeeded.
 * A null/undefined kind keeps the historical platform-based behaviour.
 */
export function getUpdateRestartPlan(kind: ServiceKind | null | undefined): UpdateRestartPlan {
  if (kind === "systemd-system" || kind === "external") {
    // Nothing to spawn: an unprivileged process can't restart a system unit,
    // and the non-zero exit makes Restart=on-failure (or always) respawn us.
    return { exitCode: UPDATE_RESTART_EXIT_CODE };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (kind === "systemd-user" || (!kind && process.platform === "linux")) {
    return {
      command: ["systemctl", "--user", "restart", UNIT_NAME],
      env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid ?? 1000}` },
      exitCode: 0,
    };
  }
  return {
    command: uid !== undefined
      ? ["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`]
      : ["launchctl", "kickstart", "-k", LABEL],
    exitCode: 0,
  };
}

/**
 * Re-write the service definition (plist or systemd unit) using the current
 * binary path and the latest template, preserving the user's custom port.
 * On Linux this also calls daemon-reload so systemd picks up the changes.
 */
export function refreshServiceDefinition(): void {
  if (isDarwin()) {
    const installedService = getInstalledLaunchdService();
    if (!installedService) return;

    let port = DEFAULT_PORT_PROD;
    try {
      const content = readFileSync(installedService.plistPath, "utf-8");
      const portMatch = content.match(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/);
      if (portMatch) port = Number(portMatch[1]);
    } catch { /* use default */ }

    const binPath = resolveBinPath();
    const path = getServicePath();
    const plist = generatePlist({ binPath, port, path });
    writeFileSync(installedService.plistPath, plist, "utf-8");
  } else if (isLinux()) {
    if (!isSystemdUnitInstalled()) return;

    let port = DEFAULT_PORT_PROD;
    try {
      const content = readFileSync(UNIT_PATH, "utf-8");
      const portMatch = content.match(/Environment=PORT=(\d+)/);
      if (portMatch) port = Number(portMatch[1]);
    } catch { /* use default */ }

    const binPath = resolveBinPath();
    const path = getServicePath();
    const unit = generateSystemdUnit({ binPath, port, path });
    writeFileSync(UNIT_PATH, unit, "utf-8");

    try {
      systemctlUser("daemon-reload");
    } catch { /* best effort */ }
  }
}

export async function status(): Promise<ServiceStatus> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return statusDarwin();
  }
  return statusLinux();
}

async function statusDarwin(): Promise<ServiceStatus> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    return { installed: false, running: false };
  }

  // Read port from the plist
  let port = DEFAULT_PORT_PROD;
  try {
    const plistContent = readFileSync(installedService.plistPath, "utf-8");
    const portMatch = plistContent.match(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/);
    if (portMatch) port = Number(portMatch[1]);
  } catch { /* use default */ }

  // Check if service is running via launchctl
  try {
    const output = execSync(`launchctl list "${installedService.label}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse PID from the launchctl list output
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) {
      return { installed: true, running: true, pid: Number(pidMatch[1]), port };
    }

    // Service is loaded but not running (no PID)
    return { installed: true, running: false, port };
  } catch {
    // launchctl list fails if service is not loaded
    return { installed: true, running: false, port };
  }
}

async function statusLinux(): Promise<ServiceStatus> {
  if (!isSystemdUnitInstalled()) {
    const systemUnit = getSystemUnitInfo();
    if (!systemUnit) return { installed: false, running: false };
    const running = systemUnit.activeState === "active" && !!systemUnit.mainPid;
    return {
      installed: true,
      running,
      pid: running ? systemUnit.mainPid : undefined,
      port: systemUnit.port ?? DEFAULT_PORT_PROD,
      scope: "system",
    };
  }

  // Read port from the unit file
  let port = DEFAULT_PORT_PROD;
  try {
    const unitContent = readFileSync(UNIT_PATH, "utf-8");
    const portMatch = unitContent.match(/Environment=PORT=(\d+)/);
    if (portMatch) port = Number(portMatch[1]);
  } catch { /* use default */ }

  // Check if service is running via systemctl
  try {
    const output = systemctlUser(`show ${UNIT_NAME} --property=ActiveState,MainPID --no-pager`);
    const activeMatch = output.match(/ActiveState=(\w+)/);
    const pidMatch = output.match(/MainPID=(\d+)/);

    const isActive = activeMatch?.[1] === "active";
    const pid = pidMatch ? Number(pidMatch[1]) : undefined;

    if (isActive && pid && pid > 0) {
      return { installed: true, running: true, pid, port };
    }

    return { installed: true, running: false, port };
  } catch {
    return { installed: true, running: false, port };
  }
}
