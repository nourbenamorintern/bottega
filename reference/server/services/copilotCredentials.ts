// bottega\reference\server\services\copilotCredentials.ts
// Per-user GitHub OAuth token store for the GitHub Copilot provider.
//
// Mirrors claudeCredentials.ts structure: one file per user under
// ~/.config/bottega/users/{userId}/github_oauth_token.
//
// Security notes:
//  - Token files written mode 0600, directory mode 0700.
//  - On POSIX the mode bits are validated on read; on Windows we apply
//    NTFS ACLs via icacls automatically — no manual PowerShell needed.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const DEFAULT_CONFIG_ROOT = path.join(os.homedir(), '.config', 'bottega', 'users');
const GITHUB_TOKEN_FILE_NAME = 'github_oauth_token';

export class GitHubCopilotCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubCopilotCredentialsError';
  }
}

function normalizeUserId(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (
    !Number.isInteger(numericUserId) ||
    numericUserId <= 0 ||
    String(numericUserId) !== String(userId)
  ) {
    throw new GitHubCopilotCredentialsError(
      'Cannot access GitHub Copilot credentials without a valid authenticated user ID',
    );
  }
  return String(numericUserId);
}

export function getCopilotConfigRoot(): string {
  return process.env.CLAUDE_CONFIG_ROOT || DEFAULT_CONFIG_ROOT;
}

export function resolveGitHubUserDir(userId: number | string | undefined): string {
  return path.join(getCopilotConfigRoot(), normalizeUserId(userId));
}

export function resolveGitHubTokenPath(userId: number | string | undefined): string {
  return path.join(resolveGitHubUserDir(userId), GITHUB_TOKEN_FILE_NAME);
}

/**
 * Applies NTFS ACL lockdown on Windows via icacls.
 * Uses process.env.USERNAME (not %USERNAME%) so Node expands it correctly.
 * Errors are logged but never thrown — a permission warning is better than
 * crashing the entire auth flow.
 */
function secureWindowsPath(targetPath: string): void {
  const username = process.env.USERNAME;
  if (!username) {
    console.warn('[Security] USERNAME env var not set — skipping Windows ACL lockdown');
    return;
  }
  try {
    // Remove all inherited permissions
    execSync(`icacls "${targetPath}" /inheritance:r`, { stdio: 'ignore' });
    // Grant full control to the current user only
    execSync(`icacls "${targetPath}" /grant:r "${username}":(F)`, { stdio: 'ignore' });
    // Keep SYSTEM and Administrators so OS processes are not broken
    execSync(`icacls "${targetPath}" /grant:r "*S-1-5-18":(F)`, { stdio: 'ignore' });
    execSync(`icacls "${targetPath}" /grant:r "*S-1-5-32-544":(F)`, { stdio: 'ignore' });
  } catch (error) {
    console.error(
      `[Security] Failed to apply Windows NTFS restrictions to ${targetPath}:`,
      error,
    );
  }
}

function ensureUserDir(userId: number | string | undefined): string {
  const userDir = resolveGitHubUserDir(userId);
  try {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      secureWindowsPath(userDir);
    } else {
      fs.chmodSync(userDir, 0o700);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new GitHubCopilotCredentialsError(
        `GitHub Copilot credential directory is not writable: ${getCopilotConfigRoot()}. ` +
          'Check permissions or set CLAUDE_CONFIG_ROOT in your .env to a writable path.',
      );
    }
    throw error;
  }
  return userDir;
}

function validateTokenFileSecurity(
  userId: number | string | undefined,
  tokenPath: string,
): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(tokenPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitHubCopilotCredentialsError(
        `GitHub OAuth token is not provisioned for user ${userId}. ` +
          'Connect GitHub Copilot via Settings → Providers.',
      );
    }
    throw err;
  }

  if (!stats.isFile()) {
    throw new GitHubCopilotCredentialsError(
      `GitHub OAuth token path for user ${userId} is not a file: ${tokenPath}`,
    );
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new GitHubCopilotCredentialsError(
      `GitHub OAuth token for user ${userId} must be owned by the current user`,
    );
  }

  // Skip POSIX mode check on Windows — fs.statSync returns synthetic bits,
  // not real ACLs. Security is enforced by icacls on write instead.
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new GitHubCopilotCredentialsError(
      `GitHub OAuth token for user ${userId} must not be accessible by group or other users; ` +
        `run chmod 600 ${tokenPath}`,
    );
  }
}

export interface ReadGitHubTokenResult {
  token: string;
  tokenPath: string;
}

export function readGitHubOAuthToken(
  userId: number | string | undefined,
): ReadGitHubTokenResult {
  const tokenPath = resolveGitHubTokenPath(userId);

  try {
    validateTokenFileSecurity(userId, tokenPath);
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!token) {
      throw new GitHubCopilotCredentialsError(
        `GitHub OAuth token file is empty for user ${userId}: ${tokenPath}`,
      );
    }
    return { token, tokenPath };
  } catch (error) {
    // Fallback 1: environment variable (CI/CD or manual override)
    const envToken = process.env.COPILOT_GITHUB_TOKEN
      || process.env.GITHUB_TOKEN
      || process.env.GH_TOKEN;
    if (envToken?.trim()) {
      return { token: envToken.trim(), tokenPath: 'env:COPILOT_GITHUB_TOKEN' };
    }

    // Fallback 2: GitHub CLI (gh auth token) — useful for developers
    try {
      const cliToken = execSync('gh auth token', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (cliToken) {
        return { token: cliToken, tokenPath: 'gh CLI' };
      }
    } catch {
      // gh CLI not installed or not authenticated — continue
    }

    // Nothing worked — surface the original missing-file error
    throw error;
  }
}

export function writeGitHubOAuthToken(
  userId: number | string | undefined,
  token: unknown,
): string {
  if (typeof token !== 'string' || !token.trim()) {
    throw new GitHubCopilotCredentialsError(
      `Refusing to persist empty GitHub OAuth token for user ${userId}`,
    );
  }
  ensureUserDir(userId);
  const tokenPath = resolveGitHubTokenPath(userId);
  fs.writeFileSync(tokenPath, token.trim(), { mode: 0o600 });
  if (process.platform === 'win32') {
    secureWindowsPath(tokenPath);
  } else {
    fs.chmodSync(tokenPath, 0o600);
  }
  return tokenPath;
}

export function clearGitHubOAuthToken(userId: number | string | undefined): boolean {
  const tokenPath = resolveGitHubTokenPath(userId);
  try {
    fs.unlinkSync(tokenPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export interface GitHubCopilotAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  tokenPath: string;
  tokenFingerprint?: string;
  reason?: string;
}

export async function getGitHubCopilotAuthStatus(
  userId: number | string | undefined,
): Promise<GitHubCopilotAuthStatus> {
  const tokenPath = resolveGitHubTokenPath(userId);
  try {
    const { token } = readGitHubOAuthToken(userId);
    return {
      authenticated: true,
      status: 'authenticated',
      tokenPath,
      tokenFingerprint: token.slice(-6),
    };
  } catch (error) {
    if (error instanceof GitHubCopilotCredentialsError) {
      return {
        authenticated: false,
        status: 'missing',
        reason: error.message,
        tokenPath,
      };
    }
    throw error;
  }
}

export function buildCopilotSdkEnv(
  userId: number | string | undefined,
): Record<string, string | undefined> {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    BOTTEGA_USER_ID: String(userId ?? ''),
  };
}