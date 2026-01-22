/**
 * MCP Tools Documentation Sections
 *
 * These constant strings document the MCP tools available to different agent types.
 * Extracted from AgentDefinitions.ts for better maintainability.
 */

/**
 * MCP Tools Section for Developer agents
 * Full toolset for implementation work
 */
export const MCP_TOOLS_SECTION_DEVELOPER = `
## 🔧 HERRAMIENTAS MCP DISPONIBLES

Además de las herramientas SDK nativas (Read, Write, Edit, Bash, Grep, Glob), tienes acceso a herramientas MCP avanzadas:

### 🧠 Razonamiento y Planificación
- **think**: Scratchpad para razonamiento explícito antes de decisiones críticas
  \`think({ reasoning: "...", conclusion: "...", confidence: 8 })\`
- **todo_write**: Gestión de lista de tareas
  \`todo_write({ todos: [{ content: "Task", status: "in_progress", activeForm: "Doing task" }] })\`
- **update_plan**: Actualizar plan dinámicamente (Windsurf pattern)
  \`update_plan({ currentStep: 2, totalSteps: 5, stepDescription: "...", status: "in_progress" })\`

### 🔍 Búsqueda y Navegación
- **semantic_search**: Buscar código por significado, no texto exacto
  \`semantic_search({ query: "How does authentication work?", projectPath: "..." })\`
- **codebase_retrieval**: Búsqueda semántica antes de editar
  \`codebase_retrieval({ query: "user validation", projectPath: "..." })\`
- **go_to_definition**: Encontrar definición de símbolo (LSP)
  \`go_to_definition({ symbol: "UserService", projectPath: "..." })\`
- **go_to_references**: Encontrar todas las referencias de un símbolo
  \`go_to_references({ symbol: "handleLogin", projectPath: "..." })\`
- **hover_symbol**: Obtener información de tipos
  \`hover_symbol({ symbol: "IUser", filePath: "..." })\`

### 📦 Gestión de Dependencias
- **package_manager**: Instalar/desinstalar paquetes (NUNCA editar package.json manualmente)
  \`package_manager({ action: "install", packages: ["axios"], packageManager: "npm", workingDir: "..." })\`

### ✏️ Refactoring
- **find_and_edit**: Aplicar mismo cambio en múltiples archivos
  \`find_and_edit({ directory: "src", regex: "oldName", replacement: "newName", dryRun: true })\`
- **undo_edit**: Revertir último cambio en un archivo
  \`undo_edit({ filePath: "src/file.ts" })\`

### 🧪 Verificación
- **read_lints**: Obtener errores ESLint
  \`read_lints({ projectPath: "...", paths: ["src/modified.ts"] })\`
- **report_environment_issue**: Reportar problemas de entorno
  \`report_environment_issue({ issue: "...", severity: "blocker" })\`

### 📚 Conocimiento
- **knowledge_base**: Acceder a best practices
  \`knowledge_base({ topic: "typescript", category: "patterns" })\`
- **git_commit_retrieval**: Buscar en historial git
  \`git_commit_retrieval({ query: "similar change", repoPath: "...", maxResults: 5 })\`

### 🌐 Web y Preview
- **web_search**: Buscar en la web
- **web_fetch**: Obtener contenido de URL
- **browser_preview**: Abrir preview del servidor
  \`browser_preview({ url: "http://localhost:3000", projectPath: "..." })\`
- **expose_port**: Exponer puerto públicamente
  \`expose_port({ port: 3000, projectPath: "..." })\`

### ⏳ Control de Flujo
- **wait**: Esperar N segundos
  \`wait({ seconds: 5, reason: "Waiting for server to start" })\`

### 🚀 Deployment
- **deployment_config**: Configurar deployment
  \`deployment_config({ action: "set", buildCommand: "npm run build", runCommand: "npm start", port: 3000, projectPath: "..." })\`

### 🧠 MEMORIA PERSISTENTE (Windsurf Pattern - CRÍTICO)
- **memory_recall**: AL INICIO de cada tarea, buscar memorias relevantes
  \`memory_recall({ projectId: "<id>", query: "patrones de autenticación", types: ["codebase_pattern", "error_resolution"] })\`
- **memory_remember**: Guardar aprendizajes LIBREMENTE sin pedir permiso
  \`memory_remember({ projectId: "<id>", type: "codebase_pattern", title: "...", content: "...", importance: "high" })\`
- **memory_feedback**: Indicar si una memoria fue útil
  \`memory_feedback({ memoryId: "<id>", wasUseful: true })\`

### 📸 Visual Testing
- **screenshot_capture**: Capturar screenshot de la aplicación
  \`screenshot_capture({ url: "http://localhost:3000", fullPage: true })\`
- **inspect_site**: Analizar estructura y tecnologías de un sitio
  \`inspect_site({ url: "https://example.com", aspects: ["structure", "technologies"] })\`

### 🚀 EJECUCIÓN AUTÓNOMA (BACKGROUND TASKS)
**USA ESTO para operaciones largas sin bloquear tu trabajo:**
- **run_build_background**: Ejecutar build sin bloquear
  \`run_build_background({ taskId: "<task_id>", cwd: "/path/to/project", command: "npm run build" })\`
- **run_tests_background**: Ejecutar tests sin bloquear
  \`run_tests_background({ taskId: "<task_id>", cwd: "/path/to/project", pattern: "*.test.ts" })\`
- **check_background_task**: Verificar estado de tarea background
  \`check_background_task({ backgroundTaskId: "bg-xxx", outputLines: 20 })\`
- **wait_for_background_task**: Esperar a que termine una tarea
  \`wait_for_background_task({ backgroundTaskId: "bg-xxx", timeoutMs: 300000 })\`

### ⚡ SLASH COMMANDS (OPERACIONES ESPECIALIZADAS)
- **execute_slash_command**: Ejecutar comando especializado
  \`execute_slash_command({ command: "/test src/*.ts", taskId: "<task_id>" })\`
  Comandos disponibles: /test, /review, /security, /refactor, /architect, /fix, /optimize
- **list_slash_commands**: Ver todos los comandos disponibles
  \`list_slash_commands({})\`

### 📝 DECISIONES AUTÓNOMAS (AUDIT TRAIL)
- **log_autonomous_decision**: Registrar decisiones tomadas autónomamente
  \`log_autonomous_decision({ taskId: "<task_id>", decision: "Elegí X sobre Y", reasoning: "Porque...", alternatives: ["Y", "Z"], confidence: 0.8 })\`

### 💾 SESIÓN Y CONTEXTO
- **save_session_context**: Guardar contexto para continuar después
  \`save_session_context({ sessionId: "<session_id>", context: { learnings: [...], state: "..." } })\`
- **get_session_messages**: Recuperar historial de conversación
  \`get_session_messages({ sessionId: "<session_id>", maxTokens: 50000 })\`

⚠️ **USA run_build_background/run_tests_background** para builds y tests largos - NO bloquees esperando.
⚠️ **USA log_autonomous_decision** cuando tomes decisiones importantes sin consultar.
⚠️ **USA execute_slash_command** para tareas especializadas (/test, /review, /security).
⚠️ **SIEMPRE llama memory_recall al inicio** para aprender de sesiones anteriores.
`;

/**
 * MCP Tools Section for Planning agents
 * Read-only exploration and analysis tools
 */
export const MCP_TOOLS_SECTION_PLANNING = `
## 🔧 HERRAMIENTAS MCP DISPONIBLES

Además de las herramientas SDK nativas, tienes acceso a:

### 🧠 Razonamiento
- **think**: Scratchpad para razonamiento explícito
  \`think({ reasoning: "Analyzing options...", conclusion: "Best approach is X" })\`

### 🔍 Búsqueda
- **semantic_search**: Buscar código por significado
  \`semantic_search({ query: "How does X work?", projectPath: "..." })\`
- **codebase_retrieval**: Búsqueda semántica profunda
  \`codebase_retrieval({ query: "authentication flow", projectPath: "..." })\`
- **go_to_definition**: Encontrar definiciones de símbolos
- **go_to_references**: Encontrar usos de símbolos

### 📚 Conocimiento
- **knowledge_base**: Best practices por tecnología
  \`knowledge_base({ topic: "react", category: "patterns" })\`
- **git_commit_retrieval**: Buscar cambios similares en historial
  \`git_commit_retrieval({ query: "similar feature", repoPath: "..." })\`

### 🌐 Web
- **web_search**: Buscar documentación actualizada
- **web_fetch**: Obtener contenido de URLs

### 🧠 MEMORIA PERSISTENTE
- **memory_recall**: AL INICIO, buscar decisiones arquitectónicas anteriores
  \`memory_recall({ projectId: "<id>", query: "decisiones arquitectónicas", types: ["architecture_decision"] })\`
- **memory_remember**: Guardar decisiones importantes
  \`memory_remember({ projectId: "<id>", type: "architecture_decision", title: "...", content: "...", importance: "high" })\`

⚠️ **USA semantic_search y codebase_retrieval** para entender el codebase antes de planificar.
⚠️ **SIEMPRE llama memory_recall al inicio** para recordar decisiones anteriores.
`;

/**
 * MCP Tools Section for Judge agents
 * Code review and verification tools
 */
export const MCP_TOOLS_SECTION_JUDGE = `
## 🔧 HERRAMIENTAS MCP DISPONIBLES

Para revisión de código tienes acceso a:

### 🔍 Análisis
- **semantic_search**: Buscar patrones similares en el codebase
- **codebase_retrieval**: Verificar que el código sigue patrones existentes
- **go_to_definition**: Verificar implementaciones
- **go_to_references**: Ver todos los usos de una función

### 🧪 Verificación
- **read_lints**: Obtener errores ESLint del código modificado
  \`read_lints({ projectPath: "...", paths: ["src/changed.ts"] })\`

### 📚 Conocimiento
- **knowledge_base**: Verificar contra best practices
  \`knowledge_base({ topic: "typescript", category: "security" })\`

### 🧠 MEMORIA
- **memory_recall**: Buscar errores comunes anteriores
  \`memory_recall({ projectId: "<id>", query: "errores comunes", types: ["error_resolution"] })\`
- **memory_remember**: Guardar patrones de errores encontrados
  \`memory_remember({ projectId: "<id>", type: "error_resolution", title: "...", content: "...", importance: "high" })\`

⚠️ **USA read_lints** para verificar que el código pasa linting.
⚠️ **USA semantic_search** para verificar consistencia con el codebase.
`;
