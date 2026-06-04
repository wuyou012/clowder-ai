/**
 * Prompt Template Loader (F219 Checkpoint B+C)
 *
 * Loads prompt injection segments from external template files in
 * assets/prompt-templates/ instead of inline TypeScript constants.
 *
 * Templates support:
 * - Simple {{VAR}} placeholder substitution
 * - .local overlay files for user customization (Checkpoint C)
 *
 * Overlay priority: {id}.local.{ext} > {id}.{ext} (base)
 * Only segments with allowLocalOverride: true support overlays.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';

// ── Path resolution ──────────────────────────────────────────

export const TEMPLATES_DIR = join(findMonorepoRoot(), 'assets', 'prompt-templates');

function templatePath(filename: string): string {
  return join(TEMPLATES_DIR, filename);
}

/**
 * Resolve the effective file for a template, checking for .local overlay first.
 * Returns { path, isOverride } so callers can badge "customized" vs "default".
 */
function resolveWithOverlay(base: string, localSuffix: string): { path: string; isOverride: boolean } {
  const localPath = templatePath(localSuffix);
  if (existsSync(localPath)) {
    return { path: localPath, isOverride: true };
  }
  return { path: templatePath(base), isOverride: false };
}

// ── Template rendering ───────────────────────────────────────

/**
 * Replace `{{KEY}}` placeholders in a template string.
 * Unresolved placeholders are left as-is (loud failure in prompt).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}

/**
 * Strip HTML comment lines (<!-- ... -->) from markdown templates.
 * These are authoring-only annotations, not injected into prompts.
 */
export function stripComments(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('<!--'))
    .join('\n')
    .trim();
}

// ── S6: Workflow Triggers (allowLocalOverride: true) ─────────

/**
 * Load per-breed workflow triggers from YAML.
 * Checks for workflow-triggers.local.yaml overlay first.
 * Returns Record<string, string> keyed by breedId.
 */
export function loadWorkflowTriggers(): Record<string, string> {
  const { path: filePath } = resolveWithOverlay('workflow-triggers.yaml', 'workflow-triggers.local.yaml');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] workflow-triggers.yaml not found, using empty map');
    return {};
  }
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(raw) as Record<string, string>;

  // YAML block scalars have trailing newline — trim to match original .join('\n') output
  const result: Record<string, string> = {};
  for (const [breed, content] of Object.entries(parsed)) {
    if (typeof content === 'string') {
      result[breed] = content.trimEnd();
    }
  }
  return result;
}

// ── S13: MCP Tools Section (allowLocalOverride: true) ────────

/**
 * Load MCP tools section markdown template.
 * Checks for mcp-tools.local.md overlay first.
 * Caller provides RICH_BLOCK_SHORT for substitution.
 */
export function loadMcpToolsSection(vars: { RICH_BLOCK_SHORT: string }): string {
  const { path: filePath } = resolveWithOverlay('mcp-tools.md', 'mcp-tools.local.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] mcp-tools.md not found, returning empty');
    return '';
  }
  const raw = readFileSync(filePath, 'utf-8');
  return renderTemplate(stripComments(raw), vars);
}

// ── D8: A2A Ball Check (allowLocalOverride: false — no overlay) ──

/**
 * Load A2A ball ownership check prompt (no variables, no overlay).
 */
export function loadA2aBallCheck(): string {
  const filePath = templatePath('a2a-ball-check.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] a2a-ball-check.md not found, returning empty');
    return '';
  }
  return stripComments(readFileSync(filePath, 'utf-8'));
}

// ── D21: Handoff Decision Tree (allowLocalOverride: false — no overlay) ──

/**
 * Load handoff decision tree template (no overlay).
 * Caller provides CC_MENTION (co-creator mention pattern).
 */
export function loadHandoffDecisionTree(vars: { CC_MENTION: string }): string {
  const filePath = templatePath('handoff-decision-tree.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] handoff-decision-tree.md not found, returning empty');
    return '';
  }
  const raw = readFileSync(filePath, 'utf-8');
  return renderTemplate(stripComments(raw), vars);
}

// ── Override status query (for Console UI badges) ────────────

export interface OverrideStatus {
  segmentId: string;
  hasOverride: boolean;
  basePath: string;
  overridePath: string | null;
}

/** Known template-backed segments and their file mappings */
const TEMPLATE_FILES: Record<string, { base: string; local: string }> = {
  S6: { base: 'workflow-triggers.yaml', local: 'workflow-triggers.local.yaml' },
  S13: { base: 'mcp-tools.md', local: 'mcp-tools.local.md' },
  D8: { base: 'a2a-ball-check.md', local: '' },
  D21: { base: 'handoff-decision-tree.md', local: '' },
};

/**
 * Check override status for a template-backed segment.
 * Returns null if the segment is not template-backed.
 */
export function getOverrideStatus(segmentId: string): OverrideStatus | null {
  const entry = TEMPLATE_FILES[segmentId];
  if (!entry) return null;
  const basePath = templatePath(entry.base);
  if (!entry.local) {
    return { segmentId, hasOverride: false, basePath, overridePath: null };
  }
  const localPath = templatePath(entry.local);
  return {
    segmentId,
    hasOverride: existsSync(localPath),
    basePath,
    overridePath: entry.local ? localPath : null,
  };
}

/**
 * Get the raw content of a template file (base or override).
 * For Console display — returns unrendered template with {{VAR}} placeholders.
 */
export function getTemplateRawContent(segmentId: string, useOverride: boolean): string | null {
  const entry = TEMPLATE_FILES[segmentId];
  if (!entry) return null;

  if (useOverride && entry.local) {
    const localPath = templatePath(entry.local);
    if (existsSync(localPath)) {
      return readFileSync(localPath, 'utf-8');
    }
  }

  const basePath = templatePath(entry.base);
  if (!existsSync(basePath)) return null;
  return readFileSync(basePath, 'utf-8');
}

/** Get the base filename for a template-backed segment */
export function getTemplateFileInfo(segmentId: string): { base: string; local: string } | null {
  return TEMPLATE_FILES[segmentId] ?? null;
}
