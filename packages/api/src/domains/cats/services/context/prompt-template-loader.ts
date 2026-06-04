/**
 * Prompt Template Loader (F219 Checkpoint B)
 *
 * Loads prompt injection segments from external template files in
 * assets/prompt-templates/ instead of inline TypeScript constants.
 *
 * Templates support simple {{VAR}} placeholder substitution.
 * Loaded synchronously at module init (same pattern as governance-l0).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';

// ── Path resolution ──────────────────────────────────────────

const TEMPLATES_DIR = join(findMonorepoRoot(), 'assets', 'prompt-templates');

function templatePath(filename: string): string {
  return join(TEMPLATES_DIR, filename);
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
function stripComments(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('<!--'))
    .join('\n')
    .trim();
}

// ── S6: Workflow Triggers ────────────────────────────────────

/**
 * Load per-breed workflow triggers from YAML.
 * Returns Record<string, string> keyed by breedId, matching the
 * original WORKFLOW_TRIGGERS constant shape.
 */
export function loadWorkflowTriggers(): Record<string, string> {
  const filePath = templatePath('workflow-triggers.yaml');
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

// ── S13: MCP Tools Section ───────────────────────────────────

/**
 * Load MCP tools section markdown template.
 * Caller provides RICH_BLOCK_SHORT for substitution.
 */
export function loadMcpToolsSection(vars: { RICH_BLOCK_SHORT: string }): string {
  const filePath = templatePath('mcp-tools.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] mcp-tools.md not found, returning empty');
    return '';
  }
  const raw = readFileSync(filePath, 'utf-8');
  return renderTemplate(stripComments(raw), vars);
}

// ── D8: A2A Ball Check ───────────────────────────────────────

/**
 * Load A2A ball ownership check prompt (no variables).
 */
export function loadA2aBallCheck(): string {
  const filePath = templatePath('a2a-ball-check.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] a2a-ball-check.md not found, returning empty');
    return '';
  }
  return stripComments(readFileSync(filePath, 'utf-8'));
}

// ── D21: Handoff Decision Tree ───────────────────────────────

/**
 * Load handoff decision tree template.
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
