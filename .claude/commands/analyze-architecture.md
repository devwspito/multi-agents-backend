# /analyze-architecture Command

Performs comprehensive architecture analysis of the current project.

## Usage
```
/analyze-architecture [path]
```

## Parameters
- `path` (optional): Specific directory to analyze. Defaults to current directory.

## Process
1. **Scan Project**: Identifies all source files
2. **Extract Components**: Finds classes, functions, modules
3. **Map Dependencies**: Analyzes imports and relationships  
4. **Detect Patterns**: Identifies design patterns
5. **Generate Report**: Creates detailed analysis report

## Example Output
- Component inventory
- Dependency graph
- Design patterns found
- Coupling analysis
- Architecture recommendations

## Agent Used
This command uses the `architecture-analyst` agent with Claude 3 Opus for comprehensive analysis.

## Files Created
- `architecture-report.md` - Detailed analysis report
- `architecture-diagram.mermaid` - Visual representation (if applicable)