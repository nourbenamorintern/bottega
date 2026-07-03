import { Github, Bot, Terminal } from 'lucide-react';
import ClaudeLogo from './ClaudeLogo';

export interface ProviderIconProps {
  // Added `null` to gracefully handle empty database fields/API responses
  provider?: string | null | undefined;
  className?: string | undefined;
}

export function getProviderLabel(provider?: string | null ): string {
  if (provider === 'github-copilot') return 'Copilot';
  if (provider === 'openai') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude';
}

export function ProviderIcon({ provider, className = 'w-full h-full' }: ProviderIconProps) {
  if (provider === 'github-copilot') return <Github className={className} />;
  if (provider === 'openai') return <Bot className={className} />;
  if (provider === 'opencode') return <Terminal className={className} />;
  return <ClaudeLogo className={className} />;
}

export default ProviderIcon;