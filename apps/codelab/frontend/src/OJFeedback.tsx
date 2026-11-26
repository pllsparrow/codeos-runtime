import { Check, CircleAlert, LoaderCircle } from 'lucide-react'

export type ExecutionResult = {
  ok: boolean; timed_out?: boolean; stdout?: string; stderr?: string; language?: string; language_profile?: string;
  error?: { type?: string; line?: number; message?: string; hint?: string };
  passed?: number; total?: number;
  first_failure?: { case: number; stdin: string; expected: string; actual: string };
}
export type ExecutionSnapshot = { source: string; stdin: string; submit: boolean; elapsed: number; submissionId?: number; language?: 'python' | 'go' }

export function resultLabel(result: ExecutionResult): string {
  if (result.timed_out) return 'Time limit exceeded'
  if (result.error) return result.error.type || 'Runtime error'
  if (result.passed !== undefined && result.total !== undefined) return result.ok ? 'Accepted' : 'Wrong answer'
  return result.ok ? 'Run complete' : 'Run failed'
}

function Output({ label, value }: { label: string; value?: string }) {
  return <div className="oj-output-block"><strong>{label}</strong><pre>{value || '(empty)'}</pre></div>
}

export default function OJFeedback({ busy, phase, result, snapshot, changed, actionError, onRetry }: {
  busy: boolean; phase: string; result?: ExecutionResult; snapshot?: ExecutionSnapshot; changed: boolean; actionError: string; onRetry: () => void
}) {
  if (busy) return <div className="oj-feedback-loading" role="status"><LoaderCircle className="oj-spinner" size={22} /><strong>{phase}</strong><p>You can keep editing. This action uses the code captured when it started.</p></div>
  if (actionError) return <div className="oj-feedback-error" role="alert"><CircleAlert size={22} /><strong>Unable to complete this action</strong><p>{actionError}</p><button type="button" onClick={onRetry}>Retry the same request</button></div>
  if (!result) return <div className="oj-feedback-empty"><strong>Ready when you are</strong><p>Run your input to inspect output, or Submit to judge the fixed test cases.</p><small>Ctrl/Cmd + Enter · Run &nbsp; Shift + Ctrl/Cmd + Enter · Submit</small></div>
  return <div className="oj-feedback-result">
    <header className={`oj-verdict ${result.ok ? 'accepted' : 'failed'}`} role="status">{result.ok ? <Check size={20} /> : <CircleAlert size={20} />}<strong>{resultLabel(result)}</strong><span>{result.passed !== undefined && result.total !== undefined ? `${result.passed} / ${result.total} cases passed` : snapshot?.submit ? 'Submission' : 'Custom input run'}</span>{snapshot?.language && <small>{snapshot.language === 'go' ? 'Go' : 'Python'}</small>}{snapshot?.submit && snapshot.submissionId && <small>Submission #{snapshot.submissionId}</small>}{snapshot && <small>{(snapshot.elapsed / 1000).toFixed(2)} s round trip</small>}</header>
    {changed && <p className="oj-snapshot-notice">Code or input changed after this action started. This result belongs to the earlier snapshot.</p>}
    {result.error && <div className="oj-runtime-error"><strong>{result.error.type || 'Error'}{result.error.line ? ` · line ${result.error.line}` : ''}</strong><pre>{result.error.message || 'Execution failed'}</pre>{result.error.hint && <p>{result.error.hint}</p>}</div>}
    {result.first_failure ? <><p className="oj-failed-case">First failing case · #{result.first_failure.case}</p><Output label="Input" value={result.first_failure.stdin} /><div className="oj-output-comparison"><Output label="Expected output" value={result.first_failure.expected} /><Output label="Your output" value={result.first_failure.actual} /></div></> : <>{!snapshot?.submit && <Output label="Input" value={snapshot?.stdin} />}{snapshot?.submit && result.ok && <p className="oj-failed-case">All fixed test cases passed.</p>}{(!snapshot?.submit || result.stdout) && <Output label="Output" value={result.stdout} />}</>}
  </div>
}
