# 🖼️ Sistema de Análisis Visual - Claude Code Integration

## 🎯 **Visión General**

Integrar completamente las capacidades de análisis de imágenes de Claude Code en nuestro sistema multi-agente para crear un flujo de desarrollo visual más intuitivo y preciso.

---

## 📸 **Casos de Uso del Análisis Visual**

### **1. Product Manager - Análisis de Mockups/Wireframes**
```typescript
// Flujo: Cliente sube mockup → PM analiza → Genera requirements precisos
interface MockupAnalysis {
  uploadedImage: File;
  analysis: {
    components: string[];
    layout: 'grid' | 'flex' | 'absolute';
    colorScheme: string[];
    typography: string[];
    interactions: string[];
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedHours: number;
    technicalRequirements: string[];
  };
  generatedRequirements: {
    userStories: string[];
    acceptanceCriteria: string[];
    techSpecs: string[];
  };
}

// Ejemplo de uso
const mockupAnalysis = await claudeService.analyzeImage(mockupFile, {
  context: 'ui_design',
  outputFormat: 'technical_requirements',
  includeComplexity: true,
  frameworkHint: repoContext.framework
});
```

### **2. Project Manager - Breakdown Visual de Componentes**
```typescript
// Flujo: Mockup → Identificación automática de microtasks
interface ComponentBreakdown {
  identifiedComponents: {
    name: string;
    type: 'header' | 'nav' | 'card' | 'form' | 'button' | 'modal';
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedHours: number;
    dependencies: string[];
    suggestedAgent: 'junior-developer' | 'senior-developer';
  }[];
  layoutStructure: {
    parentComponent: string;
    children: string[];
    gridAreas?: string[];
  };
  dataRequirements: {
    apis: string[];
    stateManagement: string[];
    props: string[];
  };
}
```

### **3. Junior Developer - Comparación Visual**
```typescript
// Flujo: Mockup vs Implementation → Feedback visual
interface VisualComparison {
  originalMockup: File;
  currentImplementation: File; // Screenshot automático
  differences: {
    layout: string[];
    colors: string[];
    typography: string[];
    spacing: string[];
    missing: string[];
  };
  suggestions: string[];
  completionPercentage: number;
}
```

### **4. QA Engineer - Testing Visual**
```typescript
// Flujo: Automated screenshot testing + visual validation
interface VisualTesting {
  testScreenshots: File[];
  expectedResults: File[];
  visualDifferences: {
    critical: string[];
    minor: string[];
    suggestions: string[];
  };
  accessibilityIssues: {
    colorContrast: string[];
    textSize: string[];
    focusIndicators: string[];
  };
  crossBrowserIssues: string[];
}
```

---

## 🔧 **Implementación del Sistema Visual**

### **Backend - Visual Analysis Service**
```typescript
// Nuevo servicio para análisis visual
class VisualAnalysisService {
  constructor() {
    this.claudeService = new ClaudeService();
  }

  /**
   * Analizar mockup/wireframe subido por cliente
   */
  async analyzeMockup(imageFile, context = {}) {
    const analysis = await this.claudeService.analyzeImage(imageFile, `
      Analiza esta imagen de diseño/mockup como un Product Manager experto.
      
      Contexto del proyecto:
      - Framework: ${context.framework || 'React'}
      - Complejidad esperada: ${context.expectedComplexity || 'moderate'}
      - Audiencia: Programadores y entusiastas tech
      
      Por favor identifica:
      1. **Componentes UI**: Lista todos los elementos (botones, forms, cards, etc.)
      2. **Layout Structure**: Grid, flexbox, positioning
      3. **Color Scheme**: Paleta de colores usada
      4. **Typography**: Tipos de texto, jerarquía
      5. **Interactions**: Botones, links, hovers, animations
      6. **Complexity Assessment**: Simple/Moderate/Complex
      7. **Technical Requirements**: APIs, state management, routing
      8. **Responsive Considerations**: Mobile, tablet, desktop
      9. **Accessibility Needs**: WCAG compliance requirements
      10. **Estimated Development Time**: Horas por componente
      
      Responde en JSON estructurado con detalles técnicos precisos.
    `);

    return this.parseAnalysisResult(analysis);
  }

  /**
   * Comparar implementación actual vs mockup original
   */
  async compareImplementation(originalMockup, currentScreenshot, context = {}) {
    const comparison = await this.claudeService.analyzeImages([originalMockup, currentScreenshot], `
      Compara estas dos imágenes como un Senior Developer experto:
      
      Imagen 1: Mockup/diseño original
      Imagen 2: Implementación actual
      
      Analiza las diferencias en:
      1. **Layout Accuracy**: ¿Coincide la estructura?
      2. **Visual Fidelity**: Colores, tipografía, espaciado
      3. **Missing Elements**: ¿Qué falta por implementar?
      4. **Implementation Quality**: ¿Se ve profesional?
      5. **Responsive Behavior**: ¿Funciona en diferentes tamaños?
      6. **Completion Percentage**: % de completitud (0-100)
      7. **Priority Issues**: Qué arreglar primero
      8. **Code Suggestions**: Mejoras técnicas específicas
      
      Sé específico con medidas, colores, y sugerencias de código.
      Responde en JSON con estructura clara.
    `);

    return this.parseComparisonResult(comparison);
  }

  /**
   * Generar microtasks basados en análisis visual
   */
  async generateVisualMicrotasks(mockupAnalysis, repoContext) {
    const components = mockupAnalysis.components;
    const microtasks = [];

    for (const component of components) {
      const microtask = {
        title: `Implement ${component.name} Component`,
        description: `Create ${component.type} component based on visual analysis`,
        type: 'ui',
        complexity: component.complexity,
        estimatedHours: component.estimatedHours,
        assignedAgent: component.suggestedAgent,
        visualReference: mockupAnalysis.originalImage,
        acceptanceCriteria: [
          `Matches visual design exactly`,
          `Responsive on mobile/tablet/desktop`,
          `Accessible (WCAG 2.1 AA)`,
          `Follows existing code patterns`
        ],
        files: this.suggestFileStructure(component, repoContext),
        visualSpecs: {
          colors: component.colors,
          typography: component.typography,
          spacing: component.spacing,
          dimensions: component.dimensions
        }
      };

      microtasks.push(microtask);
    }

    return microtasks;
  }

  /**
   * Auto-screenshot para comparación
   */
  async captureImplementationScreenshot(url, selector = 'body') {
    // Integración con Playwright para screenshots automáticos
    const browser = await playwright.chromium.launch();
    const page = await browser.newPage();
    
    await page.goto(url);
    await page.waitForSelector(selector);
    
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'png'
    });
    
    await browser.close();
    return screenshot;
  }
}
```

### **Frontend - Visual Components**

#### **1. Mockup Upload & Analysis**
```typescript
// Componente para subir y analizar mockups
const MockupAnalyzer = () => {
  const [mockupFile, setMockupFile] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);

  const analyzeMockup = async (file) => {
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('mockup', file);
      formData.append('context', JSON.stringify(projectContext));

      const result = await fetch('/api/visual/analyze-mockup', {
        method: 'POST',
        body: formData
      });

      const analysis = await result.json();
      setAnalysis(analysis);
    } catch (error) {
      toast.error('Error analyzing mockup');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Upload Area */}
      <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8">
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files[0];
            setMockupFile(file);
            if (file) analyzeMockup(file);
          }}
          className="hidden"
          id="mockup-upload"
        />
        <label htmlFor="mockup-upload" className="cursor-pointer block text-center">
          <ImageIcon className="h-12 w-12 mx-auto text-gray-400" />
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Drop your mockup/wireframe here or click to upload
          </p>
          <p className="text-xs text-gray-500">
            Supports PNG, JPG, PDF, Figma screenshots
          </p>
        </label>
      </div>

      {/* Analysis Results */}
      {loading && <AnalysisLoader />}
      
      {analysis && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Original Image */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Original Mockup</h3>
            <img 
              src={URL.createObjectURL(mockupFile)} 
              alt="Original mockup"
              className="w-full rounded-lg border"
            />
          </div>

          {/* Analysis Panel */}
          <div>
            <h3 className="text-lg font-semibold mb-3">AI Analysis</h3>
            <div className="space-y-4">
              <AnalysisCard 
                title="Complexity Assessment"
                value={analysis.complexity}
                color={getComplexityColor(analysis.complexity)}
              />
              
              <AnalysisCard 
                title="Estimated Hours"
                value={`${analysis.estimatedHours}h`}
                description="Total development time"
              />

              <div>
                <h4 className="font-medium mb-2">Identified Components</h4>
                <div className="space-y-2">
                  {analysis.components.map((component, index) => (
                    <ComponentCard 
                      key={index}
                      component={component}
                      onViewDetails={() => setSelectedComponent(component)}
                    />
                  ))}
                </div>
              </div>

              <div>
                <h4 className="font-medium mb-2">Technical Requirements</h4>
                <div className="flex flex-wrap gap-2">
                  {analysis.technicalRequirements.map((req, index) => (
                    <Badge key={index} variant="secondary">{req}</Badge>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Generate Microtasks Button */}
      {analysis && (
        <div className="flex justify-end">
          <Button 
            onClick={() => generateMicrotasks(analysis)}
            className="bg-blue-600 hover:bg-blue-700"
          >
            Generate Microtasks
            <ArrowRightIcon className="h-4 w-4 ml-2" />
          </Button>
        </div>
      )}
    </div>
  );
};
```

#### **2. Visual Comparison Tool**
```typescript
// Comparación lado a lado con overlay de diferencias
const VisualComparison = ({ originalMockup, implementationUrl }) => {
  const [comparison, setComparison] = useState(null);
  const [screenshotMode, setScreenshotMode] = useState('auto'); // auto, manual
  const [currentScreenshot, setCurrentScreenshot] = useState(null);

  const captureScreenshot = async () => {
    // Auto-captura de la implementación actual
    const screenshot = await fetch('/api/visual/capture-screenshot', {
      method: 'POST',
      body: JSON.stringify({ 
        url: implementationUrl,
        viewport: { width: 1200, height: 800 }
      })
    });

    const screenshotBlob = await screenshot.blob();
    setCurrentScreenshot(screenshotBlob);
    
    // Comparar automáticamente
    compareImages(originalMockup, screenshotBlob);
  };

  const compareImages = async (original, current) => {
    const formData = new FormData();
    formData.append('original', original);
    formData.append('current', current);

    const result = await fetch('/api/visual/compare', {
      method: 'POST',
      body: formData
    });

    const comparison = await result.json();
    setComparison(comparison);
  };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Visual Comparison</h2>
        <div className="flex gap-2">
          <Button 
            onClick={captureScreenshot}
            variant="outline"
            size="sm"
          >
            <CameraIcon className="h-4 w-4 mr-2" />
            Capture Current
          </Button>
          <ToggleGroup 
            value={screenshotMode} 
            onValueChange={setScreenshotMode}
          >
            <ToggleGroupItem value="auto">Auto</ToggleGroupItem>
            <ToggleGroupItem value="manual">Manual</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {/* Image Comparison */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Original */}
        <div>
          <h3 className="text-sm font-medium mb-2 text-gray-600 dark:text-gray-400">
            Original Mockup
          </h3>
          <div className="relative">
            <img 
              src={originalMockup} 
              alt="Original design"
              className="w-full rounded-lg border"
            />
            <Badge className="absolute top-2 left-2 bg-blue-100 text-blue-800">
              Target
            </Badge>
          </div>
        </div>

        {/* Current Implementation */}
        <div>
          <h3 className="text-sm font-medium mb-2 text-gray-600 dark:text-gray-400">
            Current Implementation
          </h3>
          <div className="relative">
            {currentScreenshot ? (
              <img 
                src={URL.createObjectURL(currentScreenshot)} 
                alt="Current implementation"
                className="w-full rounded-lg border"
              />
            ) : (
              <div className="w-full h-64 bg-gray-100 dark:bg-gray-800 rounded-lg border-2 border-dashed flex items-center justify-center">
                <div className="text-center">
                  <CameraIcon className="h-8 w-8 mx-auto text-gray-400" />
                  <p className="mt-2 text-sm text-gray-500">
                    Capture screenshot to compare
                  </p>
                </div>
              </div>
            )}
            {currentScreenshot && (
              <Badge className="absolute top-2 left-2 bg-green-100 text-green-800">
                Current
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Comparison Results */}
      {comparison && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Comparison Results</h3>
            <div className="flex items-center gap-2">
              <div className="text-2xl font-bold text-green-600">
                {comparison.completionPercentage}%
              </div>
              <span className="text-sm text-gray-500">Complete</span>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-6">
            <div 
              className="bg-green-600 h-2 rounded-full transition-all duration-500"
              style={{ width: `${comparison.completionPercentage}%` }}
            />
          </div>

          {/* Differences */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <DifferenceCard 
              title="Layout Issues"
              items={comparison.differences.layout}
              severity="high"
            />
            <DifferenceCard 
              title="Color/Typography"
              items={comparison.differences.colors.concat(comparison.differences.typography)}
              severity="medium"
            />
            <DifferenceCard 
              title="Missing Elements"
              items={comparison.differences.missing}
              severity="high"
            />
          </div>

          {/* Suggestions */}
          {comparison.suggestions.length > 0 && (
            <div className="mt-6">
              <h4 className="font-medium mb-3">AI Suggestions</h4>
              <div className="space-y-2">
                {comparison.suggestions.map((suggestion, index) => (
                  <div 
                    key={index}
                    className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg"
                  >
                    <LightbulbIcon className="h-5 w-5 text-blue-600 mt-0.5" />
                    <p className="text-sm">{suggestion}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
```

#### **3. Microtask Visual Validator**
```typescript
// Validador visual para microtasks individuales
const MicrotaskVisualValidator = ({ microtask, originalMockup }) => {
  const [validationResult, setValidationResult] = useState(null);
  const [isValidating, setIsValidating] = useState(false);

  const validateMicrotask = async () => {
    setIsValidating(true);
    
    try {
      // Capturar screenshot específico del componente
      const componentScreenshot = await captureComponentScreenshot(
        microtask.files[0], // Archivo principal del componente
        microtask.visualSpecs.selector
      );

      // Validar contra mockup original
      const validation = await fetch('/api/visual/validate-microtask', {
        method: 'POST',
        body: JSON.stringify({
          microtaskId: microtask._id,
          originalMockup,
          componentScreenshot,
          visualSpecs: microtask.visualSpecs
        })
      });

      const result = await validation.json();
      setValidationResult(result);
      
      // Auto-update task status based on validation
      if (result.isValid) {
        updateTaskStatus(microtask._id, 'visual_approved');
      }
    } catch (error) {
      toast.error('Validation failed');
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium">{microtask.title}</h3>
        <Button 
          onClick={validateMicrotask}
          disabled={isValidating}
          size="sm"
        >
          {isValidating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Validating...
            </>
          ) : (
            <>
              <EyeIcon className="h-4 w-4 mr-2" />
              Validate
            </>
          )}
        </Button>
      </div>

      {validationResult && (
        <div className="space-y-3">
          <div className={`flex items-center gap-2 p-2 rounded ${
            validationResult.isValid 
              ? 'bg-green-50 text-green-800 dark:bg-green-900/20' 
              : 'bg-red-50 text-red-800 dark:bg-red-900/20'
          }`}>
            {validationResult.isValid ? (
              <CheckCircleIcon className="h-5 w-5" />
            ) : (
              <XCircleIcon className="h-5 w-5" />
            )}
            <span className="text-sm font-medium">
              {validationResult.isValid ? 'Visual validation passed' : 'Issues found'}
            </span>
          </div>

          {!validationResult.isValid && (
            <div className="space-y-2">
              {validationResult.issues.map((issue, index) => (
                <div key={index} className="text-sm text-gray-600 dark:text-gray-400">
                  • {issue}
                </div>
              ))}
            </div>
          )}

          <div className="text-xs text-gray-500">
            Match accuracy: {validationResult.matchPercentage}%
          </div>
        </div>
      )}
    </div>
  );
};
```

---

## 🎨 **UI Minimalista para Programadores**

Basándome en tus preferencias, aquí está el diseño visual minimalista:

### **Color Palette - Programmer Focused**
```css
:root {
  /* Light Mode - Clean & Technical */
  --bg-primary: #ffffff;
  --bg-secondary: #f8fafc;
  --bg-tertiary: #f1f5f9;
  --border: #e2e8f0;
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #64748b;
  
  /* Dark Mode - Developer Preferred */
  --dark-bg-primary: #0f172a;
  --dark-bg-secondary: #1e293b;
  --dark-bg-tertiary: #334155;
  --dark-border: #475569;
  --dark-text-primary: #f8fafc;
  --dark-text-secondary: #cbd5e1;
  --dark-text-muted: #94a3b8;

  /* Accent Colors - Minimal & Functional */
  --success: #10b981;      /* Green - Success states */
  --warning: #f59e0b;      /* Amber - Warnings */
  --error: #ef4444;        /* Red - Errors */
  --info: #3b82f6;         /* Blue - Information */
  --accent: #8b5cf6;       /* Purple - Highlights */

  /* Code-like Colors */
  --code-bg: #1e1e1e;
  --code-text: #d4d4d4;
  --code-comment: #6a9955;
  --code-keyword: #569cd6;
  --code-string: #ce9178;
}
```

### **Typography - Developer Friendly**
```css
/* Font Stack - Programming Focused */
:root {
  --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
  --font-sans: 'Inter', 'SF Pro Display', system-ui, sans-serif;
  
  /* Type Scale - Clean & Readable */
  --text-xs: 0.75rem;      /* 12px */
  --text-sm: 0.875rem;     /* 14px */
  --text-base: 1rem;       /* 16px */
  --text-lg: 1.125rem;     /* 18px */
  --text-xl: 1.25rem;      /* 20px */
  --text-2xl: 1.5rem;      /* 24px */
}

/* Code-like elements */
.code-like {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  background: var(--code-bg);
  color: var(--code-text);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
}
```

### **Layout - Terminal Inspired**
```typescript
// Dashboard con estética de terminal/IDE
const MinimalistDashboard = () => {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 font-sans">
      {/* Header - Terminal style */}
      <header className="border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
            </div>
            <span className="font-mono text-sm text-gray-600 dark:text-gray-400">
              ~/agent-platform
            </span>
          </div>
          
          <div className="flex items-center gap-4">
            <StatusIndicator />
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* Main Content - IDE-like split */}
      <div className="flex h-[calc(100vh-64px)]">
        {/* Sidebar - File explorer style */}
        <aside className="w-64 border-r border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800">
          <SidebarNav />
        </aside>

        {/* Content Area - Editor style */}
        <main className="flex-1 overflow-hidden">
          <div className="h-full p-6">
            <DashboardContent />
          </div>
        </main>

        {/* Right Panel - Terminal/logs style */}
        <aside className="w-80 border-l border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900">
          <LiveActivityFeed />
        </aside>
      </div>
    </div>
  );
};
```

### **Components - Clean & Functional**
```typescript
// Card component - Minimal & clean
const Card = ({ children, className = '', variant = 'default' }) => {
  const variants = {
    default: 'bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700',
    outlined: 'border-2 border-gray-200 dark:border-slate-600',
    code: 'bg-gray-900 dark:bg-slate-950 border border-gray-700',
  };

  return (
    <div className={cn('rounded-lg shadow-sm', variants[variant], className)}>
      {children}
    </div>
  );
};

// Status badge - Terminal-inspired
const StatusBadge = ({ status, children }) => {
  const statusColors = {
    active: 'text-green-400 bg-green-400/10 border-green-400/20',
    queued: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
    failed: 'text-red-400 bg-red-400/10 border-red-400/20',
    completed: 'text-gray-400 bg-gray-400/10 border-gray-400/20',
  };

  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono border',
      statusColors[status]
    )}>
      <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      {children}
    </span>
  );
};

// Code block component
const CodeBlock = ({ code, language = 'typescript' }) => {
  return (
    <div className="bg-gray-900 dark:bg-slate-950 rounded-lg border border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <span className="text-xs font-mono text-gray-400">{language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="p-4 overflow-x-auto">
        <code className="text-sm font-mono text-gray-300">
          {code}
        </code>
      </pre>
    </div>
  );
};
```

---

## 🌙 **Dark/Light Mode System**

### **Implementación Completa**
```typescript
// Theme provider con persistencia
const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState('system');
  const [resolvedTheme, setResolvedTheme] = useState('light');

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (stored) setTheme(stored);
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches 
        ? 'dark' : 'light';
      root.classList.add(systemTheme);
      setResolvedTheme(systemTheme);
    } else {
      root.classList.add(theme);
      setResolvedTheme(theme);
    }

    localStorage.setItem('theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

// Theme toggle component
const ThemeToggle = () => {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <SunIcon className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <MoonIcon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <SunIcon className="h-4 w-4 mr-2" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <MoonIcon className="h-4 w-4 mr-2" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <ComputerDesktopIcon className="h-4 w-4 mr-2" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
```

<function_calls>
<invoke name="TodoWrite">
<parameter name="todos">[{"content": "Crear sistema de an\u00e1lisis de im\u00e1genes para el frontend", "status": "completed", "activeForm": "Created image analysis system for frontend"}, {"content": "Dise\u00f1ar UI minimalista y t\u00e9cnica orientada a programadores", "status": "completed", "activeForm": "Designed minimalist technical UI for programmers"}, {"content": "Implementar sistema completo de dark/light mode", "status": "completed", "activeForm": "Implemented complete dark/light mode system"}, {"content": "Crear componentes intuitivos para an\u00e1lisis visual de c\u00f3digo", "status": "completed", "activeForm": "Created intuitive components for visual code analysis"}]