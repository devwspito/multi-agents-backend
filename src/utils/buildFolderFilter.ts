/**
 * Build Folder Filter - Prevents Developers from editing build/deploy artifacts
 *
 * USER REQUEST: "hacer que no trabajemos en las carpetas de build de ningun proyecto.
 * Osea, nosotros si podemos hacer build para test pero no editar archivos de carpetas
 * de deploy o build"
 *
 * CRITICAL: Developers must NEVER edit files in build output directories
 * - They CAN run build commands (npm run build, npm run deploy)
 * - They CANNOT edit files in dist/, build/, .next/, out/, node_modules/, etc.
 */

/**
 * List of build/deploy folder patterns to exclude from Developer stories
 * These folders contain generated artifacts and should NEVER be edited by Developers
 */
const BUILD_FOLDER_PATTERNS = [
  // JavaScript/TypeScript build outputs
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',

  // Dependencies (never edit)
  'node_modules/',
  'vendor/',
  'bower_components/',

  // Coverage and test outputs
  'coverage/',
  '.nyc_output/',

  // Cache directories
  '.cache/',
  '.parcel-cache/',
  '.turbo/',

  // Deploy directories
  'public/build/',
  'static/build/',
  '.output/',

  // Compiled assets
  'compiled/',
  'bundles/',
];

/**
 * Check if a file path is in a build/deploy directory
 *
 * @param filePath - File path to check (e.g., "dist/index.js", "src/app.ts")
 * @returns true if file is in a build directory (should be excluded)
 *
 * @example
 * ```typescript
 * isInBuildFolder('dist/main.js')        // → true (BUILD OUTPUT)
 * isInBuildFolder('src/components/App.tsx')  // → false (SOURCE CODE)
 * isInBuildFolder('node_modules/react/index.js') // → true (DEPENDENCY)
 * ```
 */
export function isInBuildFolder(filePath: string): boolean {
  if (!filePath) return false;

  // Normalize path separators (Windows vs Unix)
  const normalized = filePath.replace(/\\/g, '/');

  // Check if path starts with or contains any build folder pattern
  for (const pattern of BUILD_FOLDER_PATTERNS) {
    // Match at start: "dist/file.js"
    if (normalized.startsWith(pattern)) {
      return true;
    }

    // Match in middle: "frontend/dist/file.js"
    if (normalized.includes(`/${pattern}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Filter out build/deploy files from a file list
 *
 * @param files - Array of file paths
 * @returns Filtered array without build folder files + list of excluded files
 *
 * @example
 * ```typescript
 * const result = filterBuildFiles([
 *   'src/app.ts',
 *   'dist/main.js',        // ← excluded
 *   'node_modules/x.js',   // ← excluded
 *   'src/components/X.tsx'
 * ]);
 * // result.filtered = ['src/app.ts', 'src/components/X.tsx']
 * // result.excluded = ['dist/main.js', 'node_modules/x.js']
 * ```
 */
export function filterBuildFiles(files: string[]): {
  filtered: string[];
  excluded: string[];
} {
  const filtered: string[] = [];
  const excluded: string[] = [];

  for (const file of files) {
    if (isInBuildFolder(file)) {
      excluded.push(file);
    } else {
      filtered.push(file);
    }
  }

  return { filtered, excluded };
}

/**
 * Filter build folders from a story object
 * Removes files from filesToRead, filesToModify, filesToCreate
 *
 * @param story - Story object with file arrays
 * @returns Filtered story + statistics about exclusions
 *
 * @example
 * ```typescript
 * const result = filterStoryBuildFiles({
 *   id: 'story-1',
 *   filesToModify: ['src/app.ts', 'dist/main.js'],
 *   filesToCreate: ['dist/bundle.js', 'src/new.ts']
 * });
 * // result.story.filesToModify = ['src/app.ts']
 * // result.story.filesToCreate = ['src/new.ts']
 * // result.totalExcluded = 2
 * ```
 */
export function filterStoryBuildFiles(story: any): {
  story: any;
  totalExcluded: number;
  excludedByType: {
    filesToRead: string[];
    filesToModify: string[];
    filesToCreate: string[];
  };
} {
  const excludedByType = {
    filesToRead: [] as string[],
    filesToModify: [] as string[],
    filesToCreate: [] as string[],
  };

  // Filter filesToRead
  if (story.filesToRead && Array.isArray(story.filesToRead)) {
    const result = filterBuildFiles(story.filesToRead);
    story.filesToRead = result.filtered;
    excludedByType.filesToRead = result.excluded;
  }

  // Filter filesToModify
  if (story.filesToModify && Array.isArray(story.filesToModify)) {
    const result = filterBuildFiles(story.filesToModify);
    story.filesToModify = result.filtered;
    excludedByType.filesToModify = result.excluded;
  }

  // Filter filesToCreate
  if (story.filesToCreate && Array.isArray(story.filesToCreate)) {
    const result = filterBuildFiles(story.filesToCreate);
    story.filesToCreate = result.filtered;
    excludedByType.filesToCreate = result.excluded;
  }

  const totalExcluded =
    excludedByType.filesToRead.length +
    excludedByType.filesToModify.length +
    excludedByType.filesToCreate.length;

  return {
    story,
    totalExcluded,
    excludedByType,
  };
}

/**
 * Filter build folders from all stories in an epic
 *
 * @param epic - Epic object with stories array
 * @returns Filtered epic + exclusion statistics
 */
export function filterEpicBuildFiles(epic: any): {
  epic: any;
  totalStoriesAffected: number;
  totalFilesExcluded: number;
  details: Array<{
    storyId: string;
    filesExcluded: number;
    excludedFiles: string[];
  }>;
} {
  const details: Array<{
    storyId: string;
    filesExcluded: number;
    excludedFiles: string[];
  }> = [];

  let totalStoriesAffected = 0;
  let totalFilesExcluded = 0;

  if (epic.stories && Array.isArray(epic.stories)) {
    for (const story of epic.stories) {
      const result = filterStoryBuildFiles(story);

      if (result.totalExcluded > 0) {
        totalStoriesAffected++;
        totalFilesExcluded += result.totalExcluded;

        const allExcluded = [
          ...result.excludedByType.filesToRead,
          ...result.excludedByType.filesToModify,
          ...result.excludedByType.filesToCreate,
        ];

        details.push({
          storyId: story.id,
          filesExcluded: result.totalExcluded,
          excludedFiles: allExcluded,
        });
      }
    }
  }

  return {
    epic,
    totalStoriesAffected,
    totalFilesExcluded,
    details,
  };
}

/**
 * Filter build folders from all epics in a Tech Lead response
 *
 * @param techLeadResponse - Parsed Tech Lead response with epics array
 * @returns Filtered response + comprehensive statistics
 */
export function filterTechLeadBuildFiles(techLeadResponse: any): {
  response: any;
  totalEpicsAffected: number;
  totalStoriesAffected: number;
  totalFilesExcluded: number;
  details: Array<{
    epicId: string;
    storiesAffected: number;
    filesExcluded: number;
    storyDetails: Array<{
      storyId: string;
      excludedFiles: string[];
    }>;
  }>;
} {
  const details: Array<{
    epicId: string;
    storiesAffected: number;
    filesExcluded: number;
    storyDetails: Array<{
      storyId: string;
      excludedFiles: string[];
    }>;
  }> = [];

  let totalEpicsAffected = 0;
  let totalStoriesAffected = 0;
  let totalFilesExcluded = 0;

  if (techLeadResponse.epics && Array.isArray(techLeadResponse.epics)) {
    for (const epic of techLeadResponse.epics) {
      const result = filterEpicBuildFiles(epic);

      if (result.totalStoriesAffected > 0) {
        totalEpicsAffected++;
        totalStoriesAffected += result.totalStoriesAffected;
        totalFilesExcluded += result.totalFilesExcluded;

        details.push({
          epicId: epic.id,
          storiesAffected: result.totalStoriesAffected,
          filesExcluded: result.totalFilesExcluded,
          storyDetails: result.details.map((d) => ({
            storyId: d.storyId,
            excludedFiles: d.excludedFiles,
          })),
        });
      }
    }
  }

  return {
    response: techLeadResponse,
    totalEpicsAffected,
    totalStoriesAffected,
    totalFilesExcluded,
    details,
  };
}
