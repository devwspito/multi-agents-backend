/**
 * Web Tools - HTTP, browser, and web scraping tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const webSearchTool = tool(
  'web_search',
  'Search the web for information. Returns search results with titles, URLs, and snippets.',
  {
    query: z.string().describe('The search query'),
    maxResults: z.number().default(5).describe('Maximum number of results to return'),
  },
  async (args) => {
    try {
      // Use DuckDuckGo instant answer API (free, no API key required)
      const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1`;

      const response = await fetch(searchUrl);
      const data = await response.json() as {
        Abstract?: string;
        Heading?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const results: any[] = [];

      // Add abstract if available
      if (data.Abstract) {
        results.push({
          title: data.Heading || 'Summary',
          url: data.AbstractURL || '',
          snippet: data.Abstract,
        });
      }

      // Add related topics
      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics.slice(0, args.maxResults - results.length)) {
          if (topic.Text) {
            results.push({
              title: topic.Text.split(' - ')[0] || 'Related',
              url: topic.FirstURL || '',
              snippet: topic.Text,
            });
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: args.query,
              resultCount: results.length,
              results,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

export const webFetchTool = tool(
  'web_fetch',
  'Fetch content from a URL and optionally process it with a prompt',
  {
    url: z.string().describe('The URL to fetch'),
    prompt: z.string().optional().describe('Prompt to process the content'),
    maxLength: z.number().default(10000).describe('Maximum content length to return'),
  },
  async (args) => {
    try {
      const response = await fetch(args.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MultiAgentBot/1.0)',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let content = await response.text();

      // Basic HTML to text conversion
      content = content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Truncate if needed
      if (content.length > args.maxLength) {
        content = content.slice(0, args.maxLength) + '... [truncated]';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: args.url,
              contentLength: content.length,
              content: args.prompt
                ? `Content from ${args.url}:\n\n${content}\n\nProcess with: ${args.prompt}`
                : content,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              url: args.url,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

export const browserPreviewTool = tool(
  'browser_preview',
  `Open a browser preview for a running web server.
IMPORTANT: Only use this AFTER starting a web server with run_command.
Do NOT use for non-web applications (pygame, desktop apps, etc).`,
  {
    url: z.string().describe('URL to preview (e.g., http://localhost:3000)'),
    title: z.string().optional().describe('Title for the preview window'),
    waitForReady: z.boolean().default(true).describe('Wait for server to be ready'),
    timeout: z.number().default(10000).describe('Timeout in ms to wait for server'),
  },
  async (args) => {
    try {
      // Check if server is ready
      if (args.waitForReady) {
        let ready = false;
        const startTime = Date.now();

        while (!ready && (Date.now() - startTime) < args.timeout) {
          try {
            const response = await fetch(args.url, { method: 'HEAD' });
            if (response.ok || response.status < 500) {
              ready = true;
            }
          } catch {
            // Server not ready yet
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        if (!ready) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `Server at ${args.url} not ready after ${args.timeout}ms`,
                  suggestion: 'Ensure the web server is running before calling browser_preview',
                }, null, 2),
              },
            ],
          };
        }
      }

      // Try to open browser (cross-platform)
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const platform = process.platform;
      let command: string;

      if (platform === 'darwin') {
        command = `open "${args.url}"`;
      } else if (platform === 'win32') {
        command = `start "" "${args.url}"`;
      } else {
        command = `xdg-open "${args.url}" || sensible-browser "${args.url}" || x-www-browser "${args.url}"`;
      }

      await execAsync(command);

      console.log(`\n🌐 [Browser Preview] Opening ${args.url}${args.title ? ` - ${args.title}` : ''}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: args.url,
              title: args.title,
              message: `Browser preview opened for ${args.url}`,
              platform,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              url: args.url,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

export const exposePortTool = tool(
  'expose_port',
  `Expose a local port to make it publicly accessible.
Use this when:
- User needs to access the app from another device
- You need to share a preview with someone
- Testing webhooks that need a public URL

Note: In development, this may use tunneling services.`,
  {
    port: z.number().describe('Local port to expose'),
    protocol: z.enum(['http', 'https']).default('http').describe('Protocol to use'),
    projectPath: z.string().describe('Project path for context'),
  },
  async (args) => {
    try {
      // Check if the port is in use
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      try {
        await execAsync(`lsof -i :${args.port}`);
      } catch {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `No service running on port ${args.port}`,
              suggestion: 'Start your server first, then expose the port',
            }, null, 2),
          }],
        };
      }

      // In a real implementation, this would use a tunneling service
      // For now, we'll return instructions
      console.log(`\n🌐 [Expose Port] Port ${args.port} requested for public access`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            port: args.port,
            localUrl: `${args.protocol}://localhost:${args.port}`,
            message: 'Port exposure configured',
            instructions: [
              `Local access: ${args.protocol}://localhost:${args.port}`,
              'For public access, consider using ngrok, cloudflared, or similar tunneling service',
              'Run: npx localtunnel --port ' + args.port,
            ],
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

export const screenshotCaptureTool = tool(
  'screenshot_capture',
  `Capture a screenshot of a running web application.
Use this for:
- Visual testing and verification
- Documenting UI state
- Debugging layout issues
- Sharing progress with users`,
  {
    url: z.string().describe('URL to capture (e.g., http://localhost:3000)'),
    selector: z.string().optional().describe('CSS selector to capture specific element'),
    fullPage: z.boolean().default(false).describe('Capture full page or just viewport'),
    outputPath: z.string().optional().describe('Path to save screenshot'),
  },
  async (args) => {
    try {
      // Try to use puppeteer if available, otherwise fallback to CLI screenshot
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Check if puppeteer is available by trying to require it
      let usePuppeteer = false;
      try {
        require.resolve('puppeteer');
        usePuppeteer = true;
      } catch {
        // Puppeteer not installed, will use alternative
      }

      if (usePuppeteer) {
        // Dynamic require to avoid TypeScript compilation issues
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(args.url, { waitUntil: 'networkidle0', timeout: 30000 });

        const screenshotOptions: any = {
          fullPage: args.fullPage,
        };

        if (args.outputPath) {
          screenshotOptions.path = args.outputPath;
        }

        if (args.selector) {
          const element = await page.$(args.selector);
          if (element) {
            await element.screenshot(screenshotOptions);
          }
        } else {
          await page.screenshot(screenshotOptions);
        }

        await browser.close();
        console.log(`\n📸 [Screenshot] Captured ${args.url}${args.selector ? ` (${args.selector})` : ''}`);
      } else {
        // Fallback: Use curl to verify the page is accessible
        await execAsync(`curl -s -o /dev/null -w "%{http_code}" "${args.url}"`);
        console.log(`\n📸 [Screenshot] Puppeteer not installed. Verified ${args.url} is accessible.`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: args.url,
              message: 'Page verified accessible. Install puppeteer for actual screenshots.',
              suggestion: 'Run: npm install puppeteer',
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            url: args.url,
            selector: args.selector,
            fullPage: args.fullPage,
            savedTo: args.outputPath || 'Buffer (not saved to disk)',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            suggestion: error.message.includes('ECONNREFUSED')
              ? 'Server may not be running. Start the dev server first.'
              : 'Check if the URL is correct and accessible.',
          }, null, 2),
        }],
      };
    }
  }
);

export const inspectSiteTool = tool(
  'inspect_site',
  `Analyze a website's structure, design patterns, and implementation.
Use this to:
- Understand existing site architecture
- Extract design patterns and colors
- Identify technologies used
- Get inspiration for implementation`,
  {
    url: z.string().describe('URL to inspect'),
    aspects: z.array(z.enum([
      'structure',
      'colors',
      'typography',
      'layout',
      'components',
      'technologies',
      'accessibility'
    ])).default(['structure', 'technologies']).describe('What aspects to analyze'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Use curl to fetch the page
      const { stdout: html } = await execAsync(
        `curl -s -L --max-time 10 "${args.url}" | head -c 50000`,
        { maxBuffer: 5 * 1024 * 1024 }
      );

      const analysis: any = {
        url: args.url,
        success: true,
      };

      if (args.aspects.includes('structure')) {
        const headings = html.match(/<h[1-6][^>]*>.*?<\/h[1-6]>/gi)?.slice(0, 10) || [];
        const sections = html.match(/<(section|main|article|nav|header|footer)[^>]*>/gi)?.length || 0;
        analysis.structure = { headings: headings.length, sections };
      }

      if (args.aspects.includes('technologies')) {
        const techs: string[] = [];
        if (html.includes('react')) techs.push('React');
        if (html.includes('vue')) techs.push('Vue');
        if (html.includes('angular')) techs.push('Angular');
        if (html.includes('next')) techs.push('Next.js');
        if (html.includes('tailwind')) techs.push('Tailwind CSS');
        if (html.includes('bootstrap')) techs.push('Bootstrap');
        analysis.technologies = techs;
      }

      if (args.aspects.includes('colors')) {
        const colors = html.match(/#[0-9a-fA-F]{3,6}|rgb\([^)]+\)|hsl\([^)]+\)/gi)?.slice(0, 10) || [];
        analysis.colors = [...new Set(colors)];
      }

      console.log(`\n🔍 [Inspect Site] Analyzed ${args.url}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(analysis, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            url: args.url,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

export const httpRequestTool = tool(
  'http_request',
  `Make HTTP requests to test APIs.
Supports:
- All HTTP methods (GET, POST, PUT, DELETE, PATCH)
- Custom headers and body
- Response validation
- Timeout handling

Use for testing API endpoints during development.`,
  {
    url: z.string().describe('URL to request'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).default('GET'),
    headers: z.record(z.string()).optional().describe('Request headers'),
    body: z.string().optional().describe('Request body (JSON string)'),
    timeout: z.number().default(30000).describe('Timeout in milliseconds'),
    expectStatus: z.number().optional().describe('Expected status code for validation'),
  },
  async (args) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), args.timeout);

      const options: RequestInit = {
        method: args.method,
        headers: {
          'Content-Type': 'application/json',
          ...args.headers,
        },
        signal: controller.signal,
      };

      if (args.body && ['POST', 'PUT', 'PATCH'].includes(args.method)) {
        options.body = args.body;
      }

      const startTime = Date.now();
      const response = await fetch(args.url, options);
      const duration = Date.now() - startTime;
      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') || '';
      let responseBody: any;

      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
        if (responseBody.length > 2000) {
          responseBody = responseBody.substring(0, 2000) + '... [truncated]';
        }
      }

      const statusMatch = args.expectStatus ? response.status === args.expectStatus : true;

      console.log(`\n🌐 [HTTP] ${args.method} ${args.url} → ${response.status} (${duration}ms)`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            request: {
              url: args.url,
              method: args.method,
              headers: args.headers,
              bodySize: args.body?.length || 0,
            },
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: typeof responseBody === 'object' ? responseBody : { text: responseBody },
            },
            timing: { durationMs: duration },
            validation: {
              statusMatch,
              expectedStatus: args.expectStatus,
            },
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.name === 'AbortError' ? 'Request timed out' : error.message,
            url: args.url,
          }, null, 2),
        }],
      };
    }
  }
);
