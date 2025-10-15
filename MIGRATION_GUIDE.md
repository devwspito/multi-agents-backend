# Migration Guide: Pipeline Architecture

## 🎯 Overview

The TeamOrchestrator now uses **Pipeline Architecture exclusively**.

**Pipeline Architecture** is the new modular orchestration system with:
- Phase-based execution
- Better error handling
- Improved extensibility
- Cleaner separation of concerns

**Legacy Architecture** is kept in the codebase for backward compatibility but is no longer used by default.

## ✅ Current Status

**Pipeline Architecture is ALWAYS enabled** - no configuration needed.

The system automatically uses the superior Pipeline implementation for all new tasks.

## ✅ Verification

### Confirm Pipeline Mode is Active

Look for log messages with `[Pipeline]` prefixes:
- `🚀 [Pipeline] Starting orchestration for task: ...`
- `📍 [Pipeline] Phase X/Y: Phase Name`
- `✅ [Pipeline] Phase "Phase Name" completed in Xms`
- `✅ [Pipeline] Orchestration complete`

### Test the Pipeline

1. Start server:
   ```bash
   npm start
   ```

2. Create a test task via API

3. Monitor logs for pipeline-specific messages:
   - `[Pipeline]` prefixes indicate modular phase execution
   - Phase execution logs show progress through each phase
   - Pipeline metrics show duration and success rates

## 📊 Pipeline Architecture Benefits

| Feature | Benefit |
|---------|---------|
| **Architecture** | Modular phases with clean separation of concerns |
| **Logging** | Enhanced with `[Pipeline]` prefixes and phase tracking |
| **Error Handling** | Centralized in pipeline with better error context |
| **Extensibility** | Easy to add new phases without modifying core logic |
| **Testability** | Test phases independently for better reliability |
| **Performance** | Minimal overhead with improved monitoring |
| **Backward Compatibility** | Full compatibility with existing task data |

## 🐛 Troubleshooting

### TypeScript Compilation Errors

Run type check:
```bash
npm run typecheck
```

### Server Won't Start

1. Check logs for syntax errors in console
2. Verify all imports are correct
3. Ensure MongoDB connection string is valid
4. Check ANTHROPIC_API_KEY is set

### Phase Execution Fails

1. Check phase implementation in console logs
2. Verify executeAgent and executeDeveloper bindings
3. Check OrchestrationContext data
4. Review phase logs with `[Pipeline]` prefix
5. Check if repositories were cloned successfully

## 📈 Monitoring

### Key Metrics to Track

**Performance:**
- Total orchestration duration
- Per-phase duration (new in pipeline mode)
- Memory usage
- CPU usage

**Success Rate:**
- Completed tasks
- Failed tasks
- Phase-specific failures (pipeline mode)

**Quality:**
- Code quality scores (Judge evaluations)
- Verification pass rates
- Auto-healing success rates

### Log Analysis

**Pipeline Logs Example:**
```
🚀 [Pipeline] Starting orchestration with 5 phases
📍 [Pipeline] Phase 1/5: Product Manager
✅ [Pipeline] Phase "Product Manager" completed in 2500ms
📍 [Pipeline] Phase 2/5: Tech Lead
✅ [Pipeline] Phase "Tech Lead" completed in 3200ms
📍 [Pipeline] Phase 3/5: Developers
✅ [Pipeline] Phase "Developers" completed in 8500ms
📍 [Pipeline] Phase 4/5: QA Engineer
✅ [Pipeline] Phase "QA Engineer" completed in 4100ms
📍 [Pipeline] Phase 5/5: Merge Coordinator
✅ [Pipeline] Phase "Merge Coordinator" completed in 2300ms
✅ [Pipeline] Orchestration complete
  Completed: 5/5 phases
  Duration: 20.6s
  Success: ✅
```

## 🔧 Configuration

### Pipeline Options

Configure pipeline behavior in `TeamOrchestrator.ts`:

```typescript
const pipeline = new OrchestrationPipeline([...phases], {
  stopOnFailure: true,        // Stop on first failure (default)
  continueOnWarning: true,    // Continue if warnings (default)
});
```

### Phase Customization

Add custom phases:

```typescript
import { BasePhase, OrchestrationContext, PhaseResult } from './orchestration/Phase';

class CustomPhase extends BasePhase {
  readonly name = 'Custom Phase';
  readonly description = 'My custom orchestration phase';

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    // Your custom logic here
    return { success: true };
  }
}

// Add to pipeline
const pipeline = new OrchestrationPipeline([
  new ProductManagerPhase(executeAgentFn),
  new TechLeadPhase(executeAgentFn),
  new CustomPhase(),  // Your custom phase
  new DevelopersPhase(executeAgentFn, executeDeveloperFn),
  new QAPhase(executeAgentFn, githubService, prManagementService),
  new MergePhase(mergeCoordinatorService),
]);
```

## 🎯 Migration Checklist

- [ ] Review new architecture documentation (`REFACTORING_SUMMARY.md`)
- [ ] Enable pipeline mode in development
- [ ] Test full orchestration flow
- [ ] Verify all WebSocket notifications work
- [ ] Check PR creation after QA phase
- [ ] Test auto-healing scenarios
- [ ] Monitor memory and performance
- [ ] Run regression tests
- [ ] Deploy to staging with pipeline enabled
- [ ] Run full test suite in staging
- [ ] Enable in production (10% traffic)
- [ ] Monitor metrics for 24 hours
- [ ] Gradually increase to 100%
- [ ] Remove legacy code (optional)

## 🆘 Emergency Rollback

If critical issues arise in production:

1. **Immediate rollback**:
   ```bash
   # On server
   export USE_PIPELINE_ARCHITECTURE=false
   pm2 restart all  # or your process manager
   ```

2. **Verify rollback**:
   - Check logs for legacy mode messages
   - Verify tasks complete successfully
   - Monitor error rates

3. **Investigate**:
   - Review error logs
   - Check failed tasks
   - Identify root cause

4. **Fix and re-deploy**:
   - Fix identified issues
   - Test in development
   - Deploy fix with pipeline enabled

## 📚 Additional Resources

- **Architecture Documentation**: `REFACTORING_SUMMARY.md`
- **Service Documentation**: See individual service files
- **Phase Documentation**: See `src/services/orchestration/Phase.ts`
- **Pipeline Documentation**: See `src/services/orchestration/OrchestrationPipeline.ts`

---

**Questions or Issues?**

Create an issue or contact the development team.

**Status**: ✅ Ready for testing

**Last Updated**: 2025-10-11
