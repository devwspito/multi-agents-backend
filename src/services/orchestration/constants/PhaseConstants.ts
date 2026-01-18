/**
 * Phase Constants - Single source of truth for phase naming and mappings
 *
 * Consolidates scattered phase mappings from:
 * - OrchestrationCoordinator.ts (mapPhaseToEnum, phaseFieldMap)
 * - ApprovalPhase.ts (normalizePhase, getPhaseName)
 *
 * Each phase has multiple representations:
 * - pascalCase: Internal class name (PlanningPhase, TechLeadPhase)
 * - kebabCase: API/URL format (planning, tech-lead)
 * - camelCase: Database field format (planning, techLead)
 * - displayName: Human-readable name for UI
 * - dbField: Full MongoDB path (orchestration.planning)
 */

export interface PhaseDefinition {
  /** Internal name (PascalCase) - matches class name */
  pascalCase: string;
  /** API/URL format (kebab-case) */
  kebabCase: string;
  /** Database field name (camelCase) */
  camelCase: string;
  /** Full MongoDB path */
  dbField: string;
  /** Human-readable display name */
  displayName: string;
  /** Order in execution sequence (1-based) */
  order: number;
  /** Whether this phase can be skipped */
  skippable: boolean;
}

/**
 * All phase definitions - THE SINGLE SOURCE OF TRUTH
 */
export const PHASE_DEFINITIONS: Record<string, PhaseDefinition> = {
  Planning: {
    pascalCase: 'Planning',
    kebabCase: 'planning',
    camelCase: 'planning',
    dbField: 'orchestration.planning',
    displayName: 'Planning (Analysis + Epics)',
    order: 1,
    skippable: true,
  },
  TechLead: {
    pascalCase: 'TechLead',
    kebabCase: 'tech-lead',
    camelCase: 'techLead',
    dbField: 'orchestration.techLead',
    displayName: 'Tech Lead (Architecture)',
    order: 2,
    skippable: true,
  },
  TeamOrchestration: {
    pascalCase: 'TeamOrchestration',
    kebabCase: 'team-orchestration',
    camelCase: 'teamOrchestration',
    dbField: 'orchestration.teamOrchestration',
    displayName: 'Team Orchestration',
    order: 3,
    skippable: true,
  },
  Developers: {
    pascalCase: 'Developers',
    kebabCase: 'developers',
    camelCase: 'developers',
    dbField: 'orchestration.developers',
    displayName: 'Development Team',
    order: 4,
    skippable: true,
  },
  Judge: {
    pascalCase: 'Judge',
    kebabCase: 'judge',
    camelCase: 'judge',
    dbField: 'orchestration.judge',
    displayName: 'Code Review (Judge)',
    order: 5,
    skippable: true,
  },
  Verification: {
    pascalCase: 'Verification',
    kebabCase: 'verification',
    camelCase: 'verification',
    dbField: 'orchestration.verification',
    displayName: 'Verification',
    order: 6,
    skippable: true,
  },
  Approval: {
    pascalCase: 'Approval',
    kebabCase: 'approval',
    camelCase: 'approval',
    dbField: 'orchestration.approval',
    displayName: 'Human Approval',
    order: 7,
    skippable: false,
  },
  AutoMerge: {
    pascalCase: 'AutoMerge',
    kebabCase: 'auto-merge',
    camelCase: 'autoMerge',
    dbField: 'orchestration.autoMerge',
    displayName: 'Auto Merge',
    order: 8,
    skippable: true,
  },
} as const;

/**
 * Phase execution order (for iteration)
 */
export const PHASE_ORDER: string[] = Object.values(PHASE_DEFINITIONS)
  .sort((a, b) => a.order - b.order)
  .map(p => p.pascalCase);

/**
 * Get phase definition by any name format
 */
export function getPhaseDefinition(name: string): PhaseDefinition | undefined {
  // Try direct lookup
  if (PHASE_DEFINITIONS[name]) {
    return PHASE_DEFINITIONS[name];
  }

  // Search by other formats
  return Object.values(PHASE_DEFINITIONS).find(
    p =>
      p.pascalCase.toLowerCase() === name.toLowerCase() ||
      p.kebabCase === name.toLowerCase() ||
      p.camelCase === name.toLowerCase()
  );
}

/**
 * Convert any phase name to PascalCase (internal format)
 */
export function toPascalCase(name: string): string {
  return getPhaseDefinition(name)?.pascalCase || name;
}

/**
 * Convert any phase name to kebab-case (API format)
 */
export function toKebabCase(name: string): string {
  return getPhaseDefinition(name)?.kebabCase || name.toLowerCase();
}

/**
 * Convert any phase name to camelCase (DB format)
 */
export function toCamelCase(name: string): string {
  return getPhaseDefinition(name)?.camelCase || name;
}

/**
 * Get MongoDB field path for a phase
 */
export function getDbField(name: string): string {
  return getPhaseDefinition(name)?.dbField || `orchestration.${name.toLowerCase()}`;
}

/**
 * Get human-readable display name
 */
export function getDisplayName(name: string): string {
  return getPhaseDefinition(name)?.displayName || name;
}

/**
 * Check if a phase name is valid
 */
export function isValidPhase(name: string): boolean {
  return !!getPhaseDefinition(name);
}

/**
 * Get all phase names in a specific format
 */
export function getAllPhaseNames(format: 'pascalCase' | 'kebabCase' | 'camelCase' = 'pascalCase'): string[] {
  return Object.values(PHASE_DEFINITIONS).map(p => p[format]);
}
