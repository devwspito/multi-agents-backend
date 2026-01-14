/**
 * MultimodalService - Image and PDF Processing
 *
 * Enables agents to process visual content:
 * - Read and analyze images (screenshots, diagrams, UI mockups)
 * - Extract text from PDFs
 * - Process Jupyter notebooks with visualizations
 * - Analyze charts and graphs
 *
 * Like Claude Code's image/PDF reading capability.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Anthropic } from '@anthropic-ai/sdk';

export interface ImageAnalysis {
  success: boolean;
  filePath: string;
  mimeType: string;
  description?: string;
  extractedText?: string;
  elements?: string[];
  colors?: string[];
  error?: string;
}

export interface PDFExtraction {
  success: boolean;
  filePath: string;
  pageCount?: number;
  textContent?: string;
  hasImages?: boolean;
  error?: string;
}

class MultimodalServiceClass {
  private anthropic: Anthropic | null = null;

  constructor() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }
  }

  /**
   * Read and analyze an image file
   */
  async analyzeImage(
    filePath: string,
    prompt?: string
  ): Promise<ImageAnalysis> {
    try {
      // Verify file exists
      await fs.access(filePath);

      // Get file extension and determine mime type
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };

      const mimeType = mimeTypes[ext];
      if (!mimeType) {
        return {
          success: false,
          filePath,
          mimeType: 'unknown',
          error: `Unsupported image format: ${ext}. Supported: ${Object.keys(mimeTypes).join(', ')}`,
        };
      }

      // Read file as base64
      const imageBuffer = await fs.readFile(filePath);
      const base64Data = imageBuffer.toString('base64');

      // If we have Anthropic API, use vision capabilities
      if (this.anthropic) {
        const analysisPrompt = prompt ||
          'Analyze this image. Describe what you see, including any text, UI elements, diagrams, or other notable content. Be specific and detailed.';

        const response = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                    data: base64Data,
                  },
                },
                {
                  type: 'text',
                  text: analysisPrompt,
                },
              ],
            },
          ],
        });

        const textContent = response.content.find(c => c.type === 'text');
        const description = textContent && 'text' in textContent ? textContent.text : undefined;

        console.log(`\n🖼️ [Multimodal] Analyzed image: ${path.basename(filePath)}`);

        return {
          success: true,
          filePath,
          mimeType,
          description,
        };
      } else {
        // Fallback: Return basic file info without AI analysis
        const stats = await fs.stat(filePath);

        return {
          success: true,
          filePath,
          mimeType,
          description: `Image file: ${path.basename(filePath)} (${Math.round(stats.size / 1024)}KB). AI analysis requires ANTHROPIC_API_KEY.`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        filePath,
        mimeType: 'unknown',
        error: error.message,
      };
    }
  }

  /**
   * Extract text from a PDF file
   * Uses pdf-parse if available, falls back to basic info
   */
  async extractPDF(filePath: string): Promise<PDFExtraction> {
    try {
      await fs.access(filePath);

      // Check file extension
      if (!filePath.toLowerCase().endsWith('.pdf')) {
        return {
          success: false,
          filePath,
          error: 'File is not a PDF',
        };
      }

      // Try to use pdf-parse if available
      try {
        const pdfParse = require('pdf-parse');
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdfParse(dataBuffer);

        console.log(`\n📄 [Multimodal] Extracted PDF: ${path.basename(filePath)} (${data.numpages} pages)`);

        return {
          success: true,
          filePath,
          pageCount: data.numpages,
          textContent: data.text.substring(0, 50000), // Limit text content
          hasImages: data.text.includes('[image]') || data.info?.IsAcroFormPresent,
        };
      } catch {
        // pdf-parse not available, return basic info
        const stats = await fs.stat(filePath);

        return {
          success: true,
          filePath,
          textContent: `PDF file: ${path.basename(filePath)} (${Math.round(stats.size / 1024)}KB). Install pdf-parse for text extraction: npm install pdf-parse`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        filePath,
        error: error.message,
      };
    }
  }

  /**
   * Analyze a screenshot with specific focus
   */
  async analyzeScreenshot(
    filePath: string,
    focus: 'ui' | 'text' | 'errors' | 'layout' | 'general' = 'general'
  ): Promise<ImageAnalysis> {
    const prompts: Record<string, string> = {
      ui: 'Analyze this UI screenshot. Identify and describe all interactive elements (buttons, inputs, links), their layout, and the overall user interface design.',
      text: 'Extract and transcribe all visible text from this image, maintaining the structure and hierarchy as much as possible.',
      errors: 'Look for any error messages, warnings, or issues visible in this screenshot. Describe what went wrong and any error codes or messages shown.',
      layout: 'Analyze the layout and structure of this interface. Describe the grid system, spacing, alignment, and overall visual hierarchy.',
      general: 'Analyze this screenshot in detail. Describe what you see, including UI elements, text content, and any notable features.',
    };

    return this.analyzeImage(filePath, prompts[focus]);
  }

  /**
   * Compare two images (before/after)
   */
  async compareImages(
    image1Path: string,
    image2Path: string
  ): Promise<{
    success: boolean;
    comparison?: string;
    differences?: string[];
    error?: string;
  }> {
    try {
      if (!this.anthropic) {
        return {
          success: false,
          error: 'Image comparison requires ANTHROPIC_API_KEY',
        };
      }

      // Read both images
      const [image1, image2] = await Promise.all([
        fs.readFile(image1Path),
        fs.readFile(image2Path),
      ]);

      const ext1 = path.extname(image1Path).toLowerCase();
      const ext2 = path.extname(image2Path).toLowerCase();

      const getMimeType = (ext: string) => {
        const types: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
        };
        return types[ext] || 'image/png';
      };

      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Compare these two images. The first is the "before" and the second is the "after". Describe the differences you see. List specific changes in a bullet point format.',
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: getMimeType(ext1) as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: image1.toString('base64'),
                },
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: getMimeType(ext2) as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: image2.toString('base64'),
                },
              },
            ],
          },
        ],
      });

      const textContent = response.content.find(c => c.type === 'text');
      const comparison = textContent && 'text' in textContent ? textContent.text : undefined;

      // Extract bullet points as differences
      const differences = comparison
        ?.split('\n')
        .filter(line => line.trim().startsWith('-') || line.trim().startsWith('•'))
        .map(line => line.replace(/^[-•]\s*/, '').trim());

      console.log(`\n🔄 [Multimodal] Compared images: ${path.basename(image1Path)} vs ${path.basename(image2Path)}`);

      return {
        success: true,
        comparison,
        differences,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Read a Jupyter notebook and extract content
   */
  async readNotebook(filePath: string): Promise<{
    success: boolean;
    cells?: Array<{
      type: 'code' | 'markdown';
      source: string;
      outputs?: string[];
    }>;
    error?: string;
  }> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const notebook = JSON.parse(content);

      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        return {
          success: false,
          error: 'Invalid notebook format',
        };
      }

      const cells = notebook.cells.map((cell: any) => {
        const source = Array.isArray(cell.source)
          ? cell.source.join('')
          : cell.source;

        const outputs = cell.outputs?.map((output: any) => {
          if (output.text) {
            return Array.isArray(output.text) ? output.text.join('') : output.text;
          }
          if (output.data?.['text/plain']) {
            return Array.isArray(output.data['text/plain'])
              ? output.data['text/plain'].join('')
              : output.data['text/plain'];
          }
          if (output.ename) {
            return `Error: ${output.ename}: ${output.evalue}`;
          }
          return '[output]';
        });

        return {
          type: cell.cell_type as 'code' | 'markdown',
          source,
          outputs,
        };
      });

      console.log(`\n📓 [Multimodal] Read notebook: ${path.basename(filePath)} (${cells.length} cells)`);

      return {
        success: true,
        cells,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if multimodal capabilities are fully available
   */
  isFullyAvailable(): boolean {
    return this.anthropic !== null;
  }
}

// Singleton instance
export const MultimodalService = new MultimodalServiceClass();
