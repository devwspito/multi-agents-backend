/**
 * Developer Agent Specializations
 *
 * Repository-type specific knowledge injected into developer agent prompts.
 * Extracted from AgentDefinitions.ts for better maintainability.
 */

export type RepositoryType = 'frontend' | 'backend' | 'mobile' | 'fullstack' | 'library' | 'unknown';

/**
 * Specialization prompts for different repository types.
 * These are appended to the base developer prompt.
 */
export const DEVELOPER_SPECIALIZATIONS: Record<string, string> = {
  frontend: `

## 🎯 FRONTEND SPECIALIZATION

You are working on a **React frontend application**. Apply these frontend-specific best practices:

### Focus Areas
- **React architecture**: Hooks, context, custom hooks, performance optimization
- **Responsive design**: Mobile-first, Tailwind CSS, CSS-in-JS, Flexbox/Grid
- **State management**: Context API, React Query, local state patterns
- **Performance**: Lazy loading, code splitting, memoization (useMemo, useCallback)
- **Accessibility**: WCAG 2.1 AA compliance, ARIA labels, keyboard navigation, semantic HTML

### Performance Targets
- First Contentful Paint (FCP): < 1.8 seconds
- Largest Contentful Paint (LCP): < 2.5 seconds
- Time to Interactive (TTI): < 3.8 seconds
- Cumulative Layout Shift (CLS): < 0.1
- Bundle size per route: < 200KB gzipped

### Performance Implementation
1. **Code splitting**: \`React.lazy(() => import('./Component'))\` for routes
2. **Image optimization**: WebP format, lazy loading, srcset for responsive
3. **Memoization**: \`useMemo\` for expensive calculations, \`useCallback\` for handlers
4. **Virtual lists**: Use react-window for lists > 100 items
5. **Debounce inputs**: Debounce search/filter inputs (300ms)

### Component Architecture
1. **Atomic design**: Build small, reusable components (Button, Input, Card, etc.)
2. **Composition over inheritance**: Use props.children and composition patterns
3. **Controlled components**: Always use controlled inputs with state
4. **TypeScript interfaces**: Define clear prop types for all components

### Accessibility Checklist
- Semantic HTML: \`<button>\`, \`<nav>\`, \`<main>\`, \`<article>\`
- ARIA labels: \`aria-label\`, \`aria-describedby\`, \`role\`
- Keyboard navigation: \`tabIndex\`, focus states, Enter/Space handlers
- Color contrast: Ensure 4.5:1 ratio for normal text
- Screen reader text: Hidden labels for icon-only buttons

---

## ⚠️ FRONTEND COMPLETION CHECKLIST

### Component Layer
- Component created in correct directory (src/components/*)
- Component has PropTypes or TypeScript interface
- Component handles loading, error, and empty states
- Component is responsive (test mobile viewport)

### Service Integration
- API calls use service layer (NOT direct fetch in component)
- Service method exists in services/*.js
- Error responses are handled in UI

### Component Registration
- Component exported from barrel index.js (if using)
- Component imported where needed
- Route added to router config (if page component)

### Verification Commands
\`\`\`bash
# Build (produces static assets)
Bash("<TechLead's Build Command> 2>&1")

# Run tests
Bash("<TechLead's Test Command> 2>&1")

# Lint check
Bash("<TechLead's Lint Command> 2>&1")
\`\`\`

**Priority**: Working, accessible, performant code. Test on mobile first.`,

  backend: `

## 🎯 BACKEND SPECIALIZATION

You are working on a **Node.js/TypeScript backend application**. Apply these backend-specific best practices:

### Focus Areas
- **API design**: RESTful conventions, versioning (\`/api/v1/\`), proper HTTP status codes
- **Data validation**: Zod schemas, input sanitization, error handling
- **Database**: Mongoose/Prisma schemas, indexes, query optimization
- **Security**: Authentication (JWT), authorization (RBAC), rate limiting, input validation
- **Performance**: Caching (Redis), database connection pooling, async operations

### Performance Targets
- API response time (p95): < 200ms for simple queries
- API response time (p95): < 500ms for complex queries
- Database query time: < 100ms per query
- Memory usage: < 512MB for typical workload
- Concurrent connections: Handle 100+ simultaneous requests

### Performance Implementation
1. **Database indexes**: Add indexes on ALL fields used in WHERE, ORDER BY, JOIN
2. **Query optimization**: Use \`.lean()\` (50% faster), \`.select()\` only needed fields
3. **Connection pooling**: Configure pool size based on expected load
4. **Caching**: Cache frequently accessed data (user sessions, config)
5. **Async everywhere**: Never use sync operations in request handlers

### API Architecture
1. **RESTful conventions**:
   - GET /api/resource → List
   - GET /api/resource/:id → Get one
   - POST /api/resource → Create
   - PUT /api/resource/:id → Update
   - DELETE /api/resource/:id → Delete
2. **Proper status codes**: 200, 201, 400, 401, 403, 404, 500
3. **Consistent responses**: \`{ success: boolean, data?: any, error?: string }\`

### Security Checklist
- **Input validation**: Validate ALL user input
- **Authentication**: JWT with expiration
- **Authorization**: Check permissions
- **Rate limiting**: Prevent brute force
- **Secrets**: Never commit API keys

---

## ⚠️ BACKEND COMPLETION CHECKLIST

### Controller Layer
- Controller method created in controllers/*.js
- Method has try/catch error handling
- Input validation present (req.body, req.params)
- Response follows consistent format { success, data/error }
- Proper HTTP status codes used

### Route Layer
- Route defined in routes/*.js
- Route uses correct HTTP method (GET/POST/PUT/DELETE)
- Route has appropriate middleware (auth, validation)
- Route path follows RESTful conventions

### Route Registration (CRITICAL!)
- Route file is IMPORTED in app.js or index.js
- Route is REGISTERED with app.use('/api/...', routeFile)
- If new route file: export added to routes/index.js (if using barrel)

### Database Layer (if applicable)
- Model/schema defined if new entity
- Indexes added for query fields
- Relationships defined correctly

### Verification Commands
\`\`\`bash
# Type-check / compile
Bash("<TechLead's Build Command> 2>&1")

# Run tests
Bash("<TechLead's Test Command> 2>&1")

# Lint check
Bash("<TechLead's Lint Command> 2>&1")
\`\`\`

**Priority**: Secure, validated, registered APIs. ALWAYS verify route registration!`,
};

/**
 * Get specialization prompt for a repository type.
 * Returns empty string if no specialization exists.
 */
export function getSpecialization(repoType: RepositoryType): string {
  if (!repoType || repoType === 'unknown') {
    return '';
  }
  return DEVELOPER_SPECIALIZATIONS[repoType] || '';
}
