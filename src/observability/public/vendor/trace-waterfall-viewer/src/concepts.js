// Short explanations shown in the "?" popovers, each with one link to a longer
// write-up. Kept in one place so the UI never hard-codes prose or URLs.

const BASE = 'https://www.distributed-tracing.com/';

export const CONCEPTS = {
  'span-kind': {
    title: 'What is a span kind?',
    body:
      'Span kind records a span\'s role in a request: server and consumer spans handle ' +
      'incoming work, client and producer spans represent outgoing calls, and internal ' +
      'spans are in-process work. A client span and the server span it triggers are ' +
      'normally a matching pair — a client span with no server child usually means the ' +
      'callee is not instrumented or the context was not propagated.',
    linkText: 'Span lifecycle and parent-child relationships',
    href: BASE + 'distributed-tracing-fundamentals-architecture/span-lifecycle-and-parent-child-relationships/',
  },
  orphan: {
    title: 'Why is this span orphaned?',
    body:
      'An orphaned span names a parent span id that is not present in this export. ' +
      'Common causes: the parent was dropped by head-based sampling, the export was ' +
      'truncated, or trace context was lost crossing an async boundary such as a queue ' +
      'or a thread pool. The viewer keeps orphans and renders them as extra roots so you ' +
      'can still see what happened.',
    linkText: 'Debugging orphaned spans in async workflows',
    href:
      BASE +
      'distributed-tracing-fundamentals-architecture/span-lifecycle-and-parent-child-relationships/debugging-orphaned-spans-in-async-workflows/',
  },
  'critical-path': {
    title: 'What is the critical path?',
    body:
      'The critical path is the chain of work that actually determined the trace duration. ' +
      'Walking backwards from the root\'s end, only the child the parent was waiting on at ' +
      'each moment lands on the path; concurrent work that finished earlier does not. ' +
      'Optimising a span that is off the critical path changes nothing.',
    linkText: 'Finding latency bottlenecks with critical path analysis',
    href:
      BASE +
      'trace-debugging-and-signal-correlation/finding-latency-bottlenecks-with-critical-path-analysis/',
  },
  'self-time': {
    title: 'Total time vs self time',
    body:
      'Total time is the span\'s wall-clock duration. Self time subtracts the union of its ' +
      'children\'s intervals, so it is the time the span spent doing its own work rather ' +
      'than waiting on callees. Sorting by self time is usually how you find the service ' +
      'that is genuinely slow, rather than the one that merely contains the slow one.',
    linkText: 'Identifying slow database queries in traces',
    href:
      BASE +
      'trace-debugging-and-signal-correlation/finding-latency-bottlenecks-with-critical-path-analysis/identifying-slow-database-queries-in-traces/',
  },
  'span-links': {
    title: 'What are span links?',
    body:
      'Links connect a span to spans in other traces, or to causally related spans that ' +
      'are not its parent — batch consumers linking back to each producer, for example. ' +
      'Unlike a parent reference, a link does not affect where the span sits in this tree.',
    linkText: 'Span lifecycle and parent-child relationships',
    href:
      BASE + 'distributed-tracing-fundamentals-architecture/span-lifecycle-and-parent-child-relationships/',
  },
  sampling: {
    title: 'Why are spans missing?',
    body:
      'Gaps and missing parents are frequently a sampling artefact rather than a bug in ' +
      'your instrumentation. Head-based sampling decides at the root and can lose later ' +
      'context if a downstream service samples independently; tail-based sampling keeps ' +
      'whole traces but buffers them first.',
    linkText: 'Choosing between head-based and tail-based sampling',
    href:
      BASE +
      'distributed-tracing-fundamentals-architecture/choosing-between-head-based-and-tail-based-sampling/',
  },
  'trace-id': {
    title: 'What is a trace id good for?',
    body:
      'The trace id is the join key between your signals. If your application logs carry ' +
      'it, you can go from a slow span here straight to the log lines that service wrote ' +
      'while the span was open.',
    linkText: 'Adding trace ids to application logs',
    href:
      BASE +
      'trace-debugging-and-signal-correlation/correlating-logs-metrics-and-traces/adding-trace-ids-to-application-logs/',
  },
};

export function conceptById(id) {
  return CONCEPTS[id] || null;
}
