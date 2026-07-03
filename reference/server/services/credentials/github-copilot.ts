// GitHub Copilot adapter for the ProviderCredentialStore interface.
//
// Thin facade over copilotCredentials.ts — same pattern as anthropic.ts.

import {
  GitHubCopilotCredentialsError,
  readGitHubOAuthToken,
  writeGitHubOAuthToken,
  clearGitHubOAuthToken,
  getGitHubCopilotAuthStatus,
  resolveGitHubTokenPath,
  buildCopilotSdkEnv,
} from '../copilotCredentials.js';
import type { ProviderCredentialStore } from './types.js';

export const githubCopilotCredentialStore: ProviderCredentialStore = {
  read(userId) {
    const { token } = readGitHubOAuthToken(userId);
    return { token, tokenPath: resolveGitHubTokenPath(userId) };
  },
  write(userId, payload) {
    writeGitHubOAuthToken(userId, payload);
    return { tokenPath: resolveGitHubTokenPath(userId) };
  },
  clear(userId) {
    return clearGitHubOAuthToken(userId);
  },
  async getStatus(userId) {
    const s = await getGitHubCopilotAuthStatus(userId);
    return {
      authenticated: s.authenticated,
      status: s.status,
      tokenPath: s.tokenPath,
      ...(s.tokenFingerprint !== undefined ? { tokenFingerprint: s.tokenFingerprint } : {}),
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
    };
  },
  buildSdkEnv(userId) {
    return buildCopilotSdkEnv(userId);
  },
};

export { GitHubCopilotCredentialsError };
