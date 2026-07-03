import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  memo,
  type FormEvent,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ChangeEvent,
  type RefObject,
} from 'react';

import { api, type FileTreeEntry } from '../utils/api';
import TokenUsagePie from './TokenUsagePie';
import { MicButton } from './MicButton';
import { isCoarsePointer } from '../utils/isCoarsePointer';
import FileUploadButton from './FileUploadButton';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { PermissionMode } from '../../shared/websocket/messages';
import type { SlashCommand } from './CommandMenu';

interface FlatFile {
  name: string;
  path: string;
}

interface ProjectLike {
  id?: number;
}

interface ContextUsageReadout {
  totalTokens?: number | null;
  maxTokens?: number | null;
}

export interface MessageInputProps {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  handleSubmit: (e: FormEvent<HTMLFormElement>) => void;
  isConnected: boolean;
  isSending: boolean;
  isStreaming: boolean;
  selectedProject: ProjectLike | null | undefined;
  permissionMode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  contextUsage?: ContextUsageReadout | null;
  onContextClick?: () => void;
  slashCommands?: SlashCommand[];
  showCommandMenu?: boolean;
  onToggleCommandMenu?: () => void;
  isUserScrolledUp?: boolean;
  onScrollToBottom?: (() => void) | null;
  onSlashDetected?: (position: number, query: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement>;
  selectedCommandIndex?: number;
  filteredCommands?: SlashCommand[];
  onCommandSelect?: (
    command: SlashCommand,
    index: number,
    isHover: boolean,
  ) => void;
  onCloseCommandMenu?: () => void;
  showTokenUsage?: boolean;
  showConnectionWarning?: boolean;
  submitLabel?: string;
  submitLabelLoading?: string;
  rows?: number;
  variant?: 'chat' | 'modal';
  isScrolling?: boolean;
  onFileUploadError?: (message: string) => void;
}

const flattenFileTree = (
  files: FileTreeEntry[],
  basePath = '',
): FlatFile[] => {
  const result: FlatFile[] = [];
  for (const file of files) {
    const currentPath = basePath ? `${basePath}/${file.name}` : file.name;
    if (file.type === 'file') {
      result.push({
        name: file.name,
        path: currentPath,
      });
    } else if (file.type === 'directory' && file.children) {
      result.push(...flattenFileTree(file.children, currentPath));
    }
  }
  return result;
};

const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
];

const MessageInput = memo(function MessageInput({
  input,
  setInput,
  handleSubmit,
  isConnected,
  isSending,
  isStreaming,
  selectedProject,
  permissionMode = 'bypassPermissions',
  onModeChange,
  contextUsage,
  onContextClick,
  slashCommands = [],
  showCommandMenu,
  onToggleCommandMenu,
  isUserScrolledUp,
  onScrollToBottom,
  onSlashDetected,
  textareaRef: externalTextareaRef,
  selectedCommandIndex = -1,
  filteredCommands = [],
  onCommandSelect,
  onCloseCommandMenu,
  showTokenUsage = true,
  showConnectionWarning = true,
  submitLabel = 'Send',
  submitLabelLoading = 'Responding...',
  rows = 5,
  variant = 'chat',
  isScrolling = false,
  onFileUploadError,
}: MessageInputProps) {
  
  const { connectionState, manualReconnect } = useWebSocket();
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [, setIsFocused] = useState(false);
  const collapseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const justCollapsedByScrollRef = useRef(false);
  const justFocusedRef = useRef(false);
  const interactionLockRef = useRef(false);
  
  const [fileList, setFileList] = useState<FlatFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<FlatFile[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef: RefObject<HTMLTextAreaElement> = externalTextareaRef || internalTextareaRef;
  
  // FIX: Removed `| null` from the type argument to create a proper React RefObject
  const containerRef = useRef<HTMLDivElement>(null);

  const lockInteraction = useCallback(() => {
    interactionLockRef.current = true;
    setTimeout(() => {
      interactionLockRef.current = false;
    }, 500);
  }, []);

  useEffect(() => {
    if (isStreaming) return;
    if (isScrolling && !isCollapsed) {
      if (justFocusedRef.current) return;
      if (containerRef.current?.contains(document.activeElement)) return;
      if (interactionLockRef.current) return;

      justCollapsedByScrollRef.current = true;
      setIsCollapsed(true);
      setIsFocused(false);

      if (textareaRef.current) {
        textareaRef.current.blur();
      }

      setTimeout(() => {
        justCollapsedByScrollRef.current = false;
      }, 300);
    }
  }, [isScrolling, isCollapsed, isStreaming, textareaRef]);

  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, []);

  const handleFocus = useCallback(() => {
    if (justCollapsedByScrollRef.current) return;
    if (collapseTimeoutRef.current) clearTimeout(collapseTimeoutRef.current);

    justFocusedRef.current = true;
    setTimeout(() => {
      justFocusedRef.current = false;
    }, 300);

    setIsFocused(true);
    setIsCollapsed(false);
  }, []);

  const handleBlur = useCallback(
    (e: FocusEvent<HTMLTextAreaElement>) => {
      setIsFocused(false);
      const relatedTarget = e?.relatedTarget;
      if (relatedTarget instanceof Node && containerRef.current?.contains(relatedTarget)) {
        return;
      }
      if (interactionLockRef.current) return;

      if (!input.trim()) {
        collapseTimeoutRef.current = setTimeout(() => {
          if (containerRef.current?.contains(document.activeElement)) return;
          if (interactionLockRef.current) return;
          setIsCollapsed(true);
        }, 150);
      }
    },
    [input],
  );

  useEffect(() => {
    const fetchProjectFiles = async () => {
      if (!selectedProject?.id) {
        setFileList([]);
        return;
      }
      try {
        const response = await api.getFiles(selectedProject.id);
        if (response.ok) {
          const files = await response.json();
          const flatFiles = flattenFileTree(files);
          setFileList(flatFiles);
        }
      } catch (error) {
        console.error('Error fetching files:', error);
      }
    };
    void fetchProjectFiles();
  }, [selectedProject?.id]);

  useEffect(() => {
    const effectiveCursorPos = cursorPosition > 0 ? cursorPosition : input.length;
    const textBeforeCursor = input.slice(0, effectiveCursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);

      if (!textAfterAt.includes(' ')) {
        setAtSymbolPosition(lastAtIndex);
        setShowFileDropdown(true);
        const searchText = textAfterAt.toLowerCase();
        
        // FIX: Explicitly typed file parameter to resolve strict function implicit any
        const filtered = fileList
          .filter((file: FlatFile) =>
              file.name.toLowerCase().includes(searchText) ||
              file.path.toLowerCase().includes(searchText),
          )
          .slice(0, 10);

        setFilteredFiles(filtered);
        setSelectedFileIndex(-1);
      } else {
        setShowFileDropdown(false);
        setAtSymbolPosition(-1);
      }
    } else {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
    }
  }, [input, cursorPosition, fileList]);

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPos = e.target.selectionStart;

      setInput(newValue);
      setCursorPosition(cursorPos);

      if (onSlashDetected) {
        if (!newValue.trim()) {
          onSlashDetected(-1, '');
          return;
        }

        const textBeforeCursor = newValue.slice(0, cursorPos);
        const backticksBefore = (textBeforeCursor.match(/```/g) || []).length;
        const inCodeBlock = backticksBefore % 2 === 1;

        if (inCodeBlock) {
          onSlashDetected(-1, '');
          return;
        }

        const slashPattern = /(^|\s)\/(\S*)$/;
        const match = textBeforeCursor.match(slashPattern);

        if (match?.[1] !== undefined && match.index !== undefined) {
          const slashPos = match.index + match[1].length;
          const query = match[2] ?? '';
          onSlashDetected(slashPos, query);
        } else {
          onSlashDetected(-1, '');
        }
      }
    },
    [setInput, onSlashDetected],
  );

  const handleKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      setCursorPosition(e.currentTarget.selectionStart);
    },
    [],
  );

  const selectFile = useCallback(
    (file: FlatFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = textBeforeAt + '@' + file.path + ' ' + textAfterQuery;
      const newCursorPos = textBeforeAt.length + 1 + file.path.length + 1;

      setInput(newInput);
      setCursorPosition(newCursorPos);
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, setInput, textareaRef],
  );

  const handleFileUploaded = useCallback(
    (relativePath: string) => {
      // FIX: Explicitly cast prev to string
      setInput((prev: string) => {
        if (!prev.trim()) return relativePath + ' ';
        return prev.trimEnd() + ' ' + relativePath + ' ';
      });
      requestAnimationFrame(() => {
        if (textareaRef.current) textareaRef.current.focus();
      });
    },
    [setInput, textareaRef],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (showCommandMenu && filteredCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const newIndex = selectedCommandIndex < filteredCommands.length - 1 ? selectedCommandIndex + 1 : 0;
          onCommandSelect?.(filteredCommands[newIndex]!, newIndex, true);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const newIndex = selectedCommandIndex > 0 ? selectedCommandIndex - 1 : filteredCommands.length - 1;
          onCommandSelect?.(filteredCommands[newIndex]!, newIndex, true);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && selectedCommandIndex !== -1)) {
           e.preventDefault();
          const commandToSelect = selectedCommandIndex !== -1 ? filteredCommands[selectedCommandIndex] : filteredCommands[0];
          if (commandToSelect) {
            onCommandSelect?.(commandToSelect, selectedCommandIndex, false);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          onCloseCommandMenu?.();
          return;
        }
      }

      if (showFileDropdown && filteredFiles.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          // FIX: Explicitly cast prev to number
          setSelectedFileIndex((prev: number) => prev < filteredFiles.length - 1 ? prev + 1 : 0);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          // FIX: Explicitly cast prev to number
          setSelectedFileIndex((prev: number) => prev > 0 ? prev - 1 : filteredFiles.length - 1);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && selectedFileIndex !== -1)) {
          e.preventDefault();
          const fileToSelect = selectedFileIndex !== -1 ? filteredFiles[selectedFileIndex] : filteredFiles[0];
          if (fileToSelect) {
            selectFile(fileToSelect);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowFileDropdown(false);
          return;
        }
      }

      if (e.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        e.preventDefault();
        const currentIndex = PERMISSION_MODES.indexOf(permissionMode);
        const nextIndex = (currentIndex + 1) % PERMISSION_MODES.length;
        onModeChange?.(PERMISSION_MODES[nextIndex]!);
        return;
      }
    },
    [
      showFileDropdown,
      filteredFiles,
      selectedFileIndex,
      selectFile,
      permissionMode,
      onModeChange,
      showCommandMenu,
      filteredCommands,
      selectedCommandIndex,
      onCommandSelect,
      onCloseCommandMenu,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={
        variant === 'modal'
          ? ''
          : `flex-shrink-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-all duration-200 ease-in-out ${isCollapsed ? 'p-2' : 'p-4'}`
      }
    >
      {/* Control bar */}
      <div className={`flex items-center justify-center gap-3 transition-all duration-200 ease-in-out overflow-hidden ${isCollapsed ? 'max-h-0 opacity-0 mb-0' : 'max-h-20 opacity-100 mb-3'}`}>
        {/* Permission Mode Button */}
        <button
          type="button"
          onMouseDown={lockInteraction}
          onTouchStart={lockInteraction}
          onClick={() => {
            const currentIndex = PERMISSION_MODES.indexOf(permissionMode);
            const nextIndex = (currentIndex + 1) % PERMISSION_MODES.length;
            onModeChange?.(PERMISSION_MODES[nextIndex]!);
          }}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200 ${
            permissionMode === 'default'
              ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'
              : permissionMode === 'acceptEdits'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-300 dark:border-green-600 hover:bg-green-100 dark:hover:bg-green-900/30'
                : permissionMode === 'bypassPermissions'
                  ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-600 hover:bg-orange-100 dark:hover:bg-orange-900/30'
                  : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-600 hover:bg-blue-100 dark:hover:bg-blue-900/30'
          }`}
          title="Click to change permission mode (or press Tab in input)"
        >
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                permissionMode === 'default'
                  ? 'bg-gray-500'
                  : permissionMode === 'acceptEdits'
                    ? 'bg-green-500'
                    : permissionMode === 'bypassPermissions'
                      ? 'bg-orange-500'
                      : 'bg-blue-500'
              }`}
            />
            <span>
              {permissionMode === 'default' && 'Default Mode'}
              {permissionMode === 'acceptEdits' && 'Accept Edits'}
              {permissionMode === 'bypassPermissions' && 'Bypass Permissions'}
              {permissionMode === 'plan' && 'Plan Mode'}
            </span>
          </div>
        </button>

        {showTokenUsage && contextUsage && (
          <TokenUsagePie
            used={contextUsage.totalTokens || 0}
            total={contextUsage.maxTokens || 0}
            onClick={onContextClick}
          />
        )}

        {/* Slash Commands Button */}
        <button
          type="button"
          onMouseDown={lockInteraction}
          onTouchStart={lockInteraction}
          onClick={onToggleCommandMenu}
          className="relative w-8 h-8 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-full flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          title="Show commands"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20L17 4" />
          </svg>
          {slashCommands.length > 0 && (
            <span
              className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center"
              style={{ fontSize: '10px' }}
            >
              {slashCommands.length}
            </span>
          )}
        </button>

        {input.trim() && (
          <button
            type="button"
            onMouseDown={lockInteraction}
            onTouchStart={lockInteraction}
            onClick={() => setInput('')}
            className="w-8 h-8 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-full flex items-center justify-center transition-all shadow-sm"
            title="Clear input"
          >
            <svg className="w-4 h-4 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        {selectedProject?.id && (
          <FileUploadButton
            projectId={selectedProject.id}
            onUploadComplete={handleFileUploaded}
            onError={onFileUploadError}
            disabled={isStreaming || isSending}
          />
        )}

        {isUserScrolledUp && onScrollToBottom && (
          <button
            type="button"
            onMouseDown={lockInteraction}
            onTouchStart={lockInteraction}
            onClick={onScrollToBottom}
            className="w-8 h-8 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all"
            title="Scroll to bottom"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="relative">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`px-4 py-3 cursor-pointer border-b border-gray-100 dark:border-gray-700 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  selectFile(file);
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <div className="font-medium text-sm text-gray-900 dark:text-white">
                  {file.name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {file.path}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onClick={(e) => {
              setCursorPosition(e.currentTarget.selectionStart);
              handleFocus();
            }}
            onSelect={(e) => setCursorPosition(e.currentTarget.selectionStart)}
            placeholder={isCollapsed ? 'Tap to type a message...' : 'Type / for commands, @ for files, or ask the AI anything...'}
            className="w-full sm:flex-1 resize-none rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 ease-in-out"
            rows={isCollapsed ? 1 : rows}
          />
          <div className={`flex items-center gap-3 justify-end transition-all duration-200 ${isCollapsed ? 'gap-2' : 'gap-3'}`}>
            <div
              className={`transition-all duration-200 ${isCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'w-auto opacity-100'}`}
              onMouseDown={lockInteraction}
              onTouchStart={lockInteraction}
            >
              <MicButton
                onTranscript={(transcript) => {
                  // FIX: Explicitly cast prev to string
                  setInput((prev: string) => {
                    if (!prev.trim()) return transcript;
                    return prev.trimEnd() + ' ' + transcript;
                  });
                  if (!isCoarsePointer()) {
                    requestAnimationFrame(() => {
                      if (textareaRef.current) textareaRef.current.focus();
                    });
                  }
                }}
              />
            </div>
            <button
              type="submit"
              disabled={!input.trim() || !isConnected || isSending || isStreaming}
              className={`bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 ${isCollapsed ? 'px-3 py-1.5 text-sm' : 'px-4 py-2'}`}
              data-testid="message-submit-button"
            >
              {isSending || isStreaming ? submitLabelLoading : submitLabel}
            </button>
          </div>
        </div>
      </form>

      <div className={`transition-all duration-200 overflow-hidden ${isCollapsed ? 'max-h-0 opacity-0' : 'max-h-10 opacity-100'}`}>
        {showConnectionWarning && !isConnected && (
          <div className="text-xs mt-2">
            {connectionState === 'failed' ? (
              <p className="text-red-600 dark:text-red-500 flex items-center gap-2">
                <span>Connection failed.</span>
                <button
                  type="button"
                  onClick={manualReconnect}
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                  Reconnect
                </button>
              </p>
            ) : connectionState === 'reconnecting' ? (
              <p className="text-yellow-600 dark:text-yellow-500 flex items-center">
                <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full animate-pulse mr-2"></span>
                Reconnecting...
              </p>
            ) : (
              <p className="text-yellow-600 dark:text-yellow-500">
                Connecting to server...
              </p>
            )}
          </div>
        )}
        {isStreaming && (
          <p className="text-xs text-blue-500 dark:text-blue-400 mt-2 flex items-center">
            <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse mr-2"></span>
            AI is responding...
          </p>
        )}
      </div>
    </div>
  );
});

MessageInput.displayName = 'MessageInput';

export default MessageInput;