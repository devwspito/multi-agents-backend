/**
 * Documentation Tools - JSDoc, API docs, and design tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const generateDesignInspirationTool = tool(
  'generate_design_inspiration',
  'Generate design inspiration for UI/UX work.',
  {
    goal: z.string().describe('Product/feature goal'),
    style: z.enum(['minimal', 'modern', 'playful', 'corporate', 'bold', 'elegant']).optional(),
  },
  async (args) => {
    const styles: Record<string, any> = {
      minimal: { colors: ['#FFFFFF', '#F5F5F5', '#333333'], fonts: ['Inter', 'SF Pro'], patterns: ['Whitespace', 'Simple borders'] },
      modern: { colors: ['#0070F3', '#FFFFFF', '#171717'], fonts: ['Geist', 'Inter'], patterns: ['Gradients', 'Glassmorphism'] },
      playful: { colors: ['#FF6B6B', '#4ECDC4', '#FFE66D'], fonts: ['Poppins', 'Nunito'], patterns: ['Illustrations', 'Animations'] },
      corporate: { colors: ['#1E3A8A', '#FFFFFF', '#64748B'], fonts: ['IBM Plex Sans'], patterns: ['Professional grids'] },
      bold: { colors: ['#000000', '#FFFFFF', '#FF0000'], fonts: ['Bebas Neue', 'Oswald'], patterns: ['High contrast', 'Large type'] },
      elegant: { colors: ['#1A1A2E', '#F0E6D3', '#C9A959'], fonts: ['Playfair Display'], patterns: ['Serif typography', 'Premium feel'] },
    };

    const style = args.style || 'modern';
    console.log(`\n🎨 [Design] Generated ${style} inspiration for: ${args.goal}`);

    return { content: [{ type: 'text', text: JSON.stringify({ success: true, goal: args.goal, style, inspiration: styles[style] }, null, 2) }] };
  }
);

export const generateJsdocTool = tool(
  'generate_jsdoc',
  `Generate JSDoc comments for a function or class.
Creates:
- @param tags with types
- @returns tag
- @throws if applicable
- @example placeholder

Use to document code quickly.`,
  {
    filePath: z.string().describe('File path'),
    symbolName: z.string().describe('Function or class name'),
    includeExample: z.boolean().default(true).describe('Include @example'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');

      const content = await fs.readFile(args.filePath, 'utf-8');

      // Find the function/class
      const funcPattern = new RegExp(`(async\\s+)?function\\s+${args.symbolName}\\s*(<[^>]*>)?\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{]+))?`, 'm');
      const arrowPattern = new RegExp(`(?:const|let)\\s+${args.symbolName}\\s*=\\s*(async\\s*)?\\(([^)]*)\\)\\s*(?::\\s*([^=]+))?\\s*=>`, 'm');
      const classPattern = new RegExp(`class\\s+${args.symbolName}`, 'm');

      let jsdoc = '';
      let match = content.match(funcPattern) || content.match(arrowPattern);

      if (match) {
        const params = (match[3] || match[2] || '').split(',').filter(Boolean).map(p => {
          const parts = p.trim().split(':');
          return { name: parts[0]?.trim(), type: parts[1]?.trim() || 'any' };
        });

        const returnType = match[4] || match[3] || 'void';
        const isAsync = !!match[1];

        jsdoc = `/**
 * ${args.symbolName}
 *
${params.map(p => ` * @param {${p.type}} ${p.name} - Description`).join('\n')}
 * @returns {${isAsync ? 'Promise<' : ''}${returnType.trim()}${isAsync && !returnType.includes('Promise') ? '>' : ''}} Description
${args.includeExample ? ` * @example
 * ${args.symbolName}(${params.map(p => p.name).join(', ')})` : ''}
 */`;
      } else if (content.match(classPattern)) {
        jsdoc = `/**
 * ${args.symbolName}
 *
 * @class
 * @classdesc Description of ${args.symbolName}
${args.includeExample ? ` * @example
 * const instance = new ${args.symbolName}();` : ''}
 */`;
      } else {
        throw new Error(`Symbol "${args.symbolName}" not found`);
      }

      console.log(`\n📝 [Generate JSDoc] Created docs for ${args.symbolName}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            symbol: args.symbolName,
            jsdoc,
            message: 'Copy this JSDoc above the function/class declaration',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const extractApiDocsTool = tool(
  'extract_api_docs',
  `Extract API documentation from source code to markdown.
Extracts:
- Route handlers (Express, Fastify, etc.)
- Request/response types
- JSDoc comments
- OpenAPI-style annotations

Use to generate API documentation.`,
  {
    directory: z.string().describe('Directory containing API routes'),
    outputPath: z.string().describe('Output markdown file path'),
    framework: z.enum(['express', 'fastify', 'koa', 'generic']).default('express'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Find route files
      const { stdout: filesOutput } = await execAsync(
        `find "${args.directory}" -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v dist`,
        { maxBuffer: 5 * 1024 * 1024 }
      );
      const files = filesOutput.trim().split('\n').filter(Boolean);

      const routes: Array<{
        method: string;
        path: string;
        file: string;
        description?: string;
      }> = [];

      const routePatterns = {
        express: /\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        fastify: /\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        koa: /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        generic: /(GET|POST|PUT|DELETE|PATCH)\s+['"`]?([/\w:-]+)['"`]?/gi,
      };

      const pattern = routePatterns[args.framework] || routePatterns.generic;

      for (const file of files) {
        try {
          const content = await fs.readFile(file, 'utf-8');
          let match;
          const regex = new RegExp(pattern.source, pattern.flags);

          while ((match = regex.exec(content)) !== null) {
            routes.push({
              method: match[1].toUpperCase(),
              path: match[2],
              file: path.relative(args.directory, file),
            });
          }
        } catch { continue; }
      }

      // Generate markdown
      const grouped: Record<string, typeof routes> = {};
      for (const route of routes) {
        const base = route.path.split('/')[1] || 'root';
        if (!grouped[base]) grouped[base] = [];
        grouped[base].push(route);
      }

      let markdown = `# API Documentation

Generated from: \`${args.directory}\`
Framework: ${args.framework}
Routes found: ${routes.length}

---

`;

      for (const [group, groupRoutes] of Object.entries(grouped)) {
        markdown += `## ${group.charAt(0).toUpperCase() + group.slice(1)}\n\n`;

        for (const route of groupRoutes) {
          markdown += `### \`${route.method}\` ${route.path}\n\n`;
          markdown += `- **File**: \`${route.file}\`\n`;
          markdown += `- **Description**: TODO\n\n`;
          markdown += `#### Request\n\n\`\`\`json\n{\n  // Request body\n}\n\`\`\`\n\n`;
          markdown += `#### Response\n\n\`\`\`json\n{\n  // Response body\n}\n\`\`\`\n\n---\n\n`;
        }
      }

      await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
      await fs.writeFile(args.outputPath, markdown);

      console.log(`\n📄 [Extract API Docs] Generated docs with ${routes.length} routes`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            outputPath: args.outputPath,
            routesDocumented: routes.length,
            groups: Object.keys(grouped),
            message: 'API documentation generated. Review and add descriptions.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);
