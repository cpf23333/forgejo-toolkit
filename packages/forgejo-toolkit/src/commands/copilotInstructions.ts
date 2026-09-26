import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigManager } from '../config';
import { detectLinkedRepositories } from '../worktree/gitOperations';
import { stripUrlUserinfo } from '../utils/redactUrlUserinfo';
import { writeFileAtomically } from '../utils/atomicWrite';
import { logger, showErrorWithLog } from '../logger';
import { userFacingErrorMessage } from '../api/errors';

/**
 * The `forgejoToolkit.writeCopilotInstructions` command: writes a short,
 * delimited snippet into the linked repository's
 * `.github/copilot-instructions.md`, telling any agent that reads the file
 * which Forgejo repository this workspace maps to and that the read-only
 * `forgejo-toolkit` MCP tools cover it.
 *
 * Why a command and not an MCP tool: it writes to the user's checkout, and the
 * whole MCP surface is read-only on purpose. A command runs because the user
 * asked for it, in the window whose workspace it describes.
 *
 * The repository is resolved through the same detection the
 * `get_workspace_repository` tool's state file and Copy Permalink use, so the
 * file names the repository the editor context is actually attributed to.
 */

/** Contribution id; must match contributes.commands in package.json. */
export const COMMAND_WRITE_COPILOT_INSTRUCTIONS = 'forgejoToolkit.writeCopilotInstructions';

/** The file GitHub Copilot reads for repository-wide instructions. */
export const COPILOT_INSTRUCTIONS_RELATIVE_PATH = path.join('.github', 'copilot-instructions.md');

/**
 * The section's delimiters. Namespaced HTML comments: invisible in the rendered
 * Markdown, and specific enough that a hand-written file cannot accidentally
 * contain them — which is what makes "find our own section" reliable.
 */
export const COPILOT_SECTION_START = '<!-- forgejo-toolkit:copilot-instructions:start -->';
export const COPILOT_SECTION_END = '<!-- forgejo-toolkit:copilot-instructions:end -->';

export type CopilotInstructionsAction = 'created' | 'appended' | 'updated' | 'unchanged';

/**
 * The result of merging the generated section into the file's current content.
 *
 * `content` is the complete file to write, never just the section: the
 * function only ever inserts, replaces or appends its own delimited range, and
 * everything outside it survives byte for byte.
 *
 * `ambiguous` carries no content: the file mentions one of the delimiters but
 * not as exactly one well-formed pair (a half-deleted section, or a duplicated
 * one). Both writing paths would risk destroying text the user wrote, so the
 * command reports it and changes nothing.
 */
export type CopilotInstructionsMerge = { action: CopilotInstructionsAction; content: string } | { action: 'ambiguous' };

/**
 * The snippet itself. Short on purpose — it goes into a file the agent reads on
 * every request — and true on purpose: the MCP tools are read-only, so the text
 * promises reading only, and it says the tools come from a running extension
 * rather than being available unconditionally.
 */
export function buildCopilotSection(instanceUrl: string, owner: string, repo: string): string {
  return [
    COPILOT_SECTION_START,
    '## Forgejo',
    '',
    `This workspace is linked to the Forgejo repository \`${instanceUrl}/${owner}/${repo}\`.`,
    '',
    'While the Forgejo Toolkit extension is running, a read-only MCP server named `forgejo-toolkit` exposes that repository (issues, pull requests, Actions runs, file contents). Prefer those tools over guessing; they cannot write to the instance, so ask the user before proposing changes that need write access.',
    COPILOT_SECTION_END,
  ].join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Merges `section` into `existing` (`undefined` = the file does not exist).
 *
 * The user's text is never truncated or reordered: a file without the section
 * gets it appended after a blank line, a file with it gets that exact range
 * replaced (or left alone when it already matches), and anything unexpected
 * around the delimiters makes the whole operation a no-op.
 */
export function mergeCopilotInstructions(existing: string | undefined, section: string): CopilotInstructionsMerge {
  if (existing === undefined || existing.trim() === '') {
    return { action: 'created', content: `${section}\n` };
  }
  const starts = countOccurrences(existing, COPILOT_SECTION_START);
  const ends = countOccurrences(existing, COPILOT_SECTION_END);
  if (starts === 0 && ends === 0) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    return { action: 'appended', content: `${existing}${separator}${section}\n` };
  }
  if (starts !== 1 || ends !== 1) {
    return { action: 'ambiguous' };
  }
  const startIndex = existing.indexOf(COPILOT_SECTION_START);
  const endIndex = existing.indexOf(COPILOT_SECTION_END);
  const sectionEnd = endIndex + COPILOT_SECTION_END.length;
  if (endIndex < startIndex) {
    return { action: 'ambiguous' };
  }
  if (existing.slice(startIndex, sectionEnd) === section) {
    return { action: 'unchanged', content: existing };
  }
  return {
    action: 'updated',
    content: `${existing.slice(0, startIndex)}${section}${existing.slice(sectionEnd)}`,
  };
}

/**
 * Writes the section for the workspace's linked repository, or explains why
 * nothing was written. Every outcome is reported: the user asked for a file to
 * appear (or not) and needs to know where it went and what happened to the
 * content that was already there.
 */
export async function writeCopilotInstructions(config: ConfigManager): Promise<void> {
  const instances = config.getInstances();
  // Same attribution path as the MCP workspace state file and Copy Permalink:
  // the repository the editor context points at, resolved through the shared
  // scan cache, so this costs no extra git runs.
  const detected = await detectLinkedRepositories(instances);
  const linked = detected.linked;
  if (!linked) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('No linked Forgejo repository found for the current workspace'),
    );
    return;
  }
  const instance = instances.find((candidate) => candidate.id === linked.instanceId);
  if (!instance) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Forgejo instance not found'));
    return;
  }
  // The instance URL goes in without its userinfo: the file lands in a git
  // checkout and is meant to be committed, so a credential that happens to sit
  // in the configured URL must never travel with it (same rule as the permalink
  // command, which also trims the trailing slash the stripping helper adds).
  const instanceUrl = stripUrlUserinfo(instance.url).replace(/\/+$/, '');
  const section = buildCopilotSection(instanceUrl, linked.owner, linked.repo);
  // The repository root detection attributed, not the first workspace folder: a
  // nested checkout gets its own instructions file next to its own code.
  const targetPath = path.join(linked.localPath, COPILOT_INSTRUCTIONS_RELATIVE_PATH);
  const existing = await fs.promises.readFile(targetPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  const merged = mergeCopilotInstructions(existing, section);
  if (merged.action === 'ambiguous') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        '{0} contains an incomplete or duplicated forgejo-toolkit section marker; nothing was written',
        targetPath,
      ),
    );
    return;
  }
  if (merged.action === 'unchanged') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        '{0} already contains the Forgejo Toolkit MCP section for {1}/{2}; nothing changed',
        targetPath,
        linked.owner,
        linked.repo,
      ),
    );
    return;
  }
  // `.github` may not exist yet; the write itself goes through a temporary
  // sibling, so an interrupted write cannot leave a half-written instructions
  // file behind (and never truncates the existing one).
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await writeFileAtomically(targetPath, merged.content);
  if (merged.action === 'created') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Created {0} with the Forgejo Toolkit MCP section for {1}/{2}',
        targetPath,
        linked.owner,
        linked.repo,
      ),
    );
    return;
  }
  if (merged.action === 'appended') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Appended the Forgejo Toolkit MCP section for {0}/{1} to the existing {2}',
        linked.owner,
        linked.repo,
        targetPath,
      ),
    );
    return;
  }
  void vscode.window.showInformationMessage(
    vscode.l10n.t('Updated the Forgejo Toolkit MCP section in {0} for {1}/{2}', targetPath, linked.owner, linked.repo),
  );
}

/** Registers the contributed command; see src/extension.ts for the call site. */
export function registerWriteCopilotInstructionsCommand(context: vscode.ExtensionContext, config: ConfigManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_WRITE_COPILOT_INSTRUCTIONS, () => {
      writeCopilotInstructions(config).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[writeCopilotInstructions] ${err}`);
        void showErrorWithLog(vscode.l10n.t('Failed to write the Copilot instructions: {0}', err));
      });
    }),
  );
}
