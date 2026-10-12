import { SpanKind, type Context, type HrTime } from "@opentelemetry/api"
import { BatchSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-web"
import { FaroMetaAttributesSpanProcessor, FaroTraceExporter, TracingInstrumentation, type TracingInstrumentationOptions } from "@grafana/faro-web-tracing"
import { observationTime, transportClockStart, transportClockEnd } from "./clock"

function nativeHttp(span: ReadableSpan) {
  return span.kind === SpanKind.CLIENT && ["@opentelemetry/instrumentation-fetch", "@opentelemetry/instrumentation-xml-http-request"].includes(span.instrumentationScope.name)
}

export class ObservationClockProcessor implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context) {
    if (nativeHttp(span)) span.setAttribute(transportClockStart, performance.now())
    this.next.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan) {
    const start = span.attributes[transportClockStart], end = span.attributes[transportClockEnd]
    if (!nativeHttp(span) || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      this.next.onEnd(span)
      return
    }
    const startTime = observationTime(start), endTime = observationTime(end)
    const duration: HrTime = [endTime[0] - startTime[0], endTime[1] - startTime[1]]
    if (duration[1] < 0) { duration[0]--; duration[1] += 1e9 }
    const projected: ReadableSpan = {
      name: span.name, kind: span.kind, spanContext: () => span.spanContext(), parentSpanContext: span.parentSpanContext,
      startTime, endTime, duration, status: span.status, attributes: span.attributes, links: span.links, events: span.events,
      ended: span.ended, resource: span.resource, instrumentationScope: span.instrumentationScope,
      droppedAttributesCount: span.droppedAttributesCount, droppedEventsCount: span.droppedEventsCount, droppedLinksCount: span.droppedLinksCount,
    }
    this.next.onEnd(projected)
  }

  forceFlush() { return this.next.forceFlush() }
  shutdown() { return this.next.shutdown() }
}

export class ObservationTracingInstrumentation extends TracingInstrumentation {
  private readonly nativeOptions: TracingInstrumentationOptions

  constructor(options: Omit<TracingInstrumentationOptions, "spanProcessor">) {
    const nativeOptions: TracingInstrumentationOptions = { ...options }
    super(nativeOptions)
    this.nativeOptions = nativeOptions
  }

  override initialize() {
    this.nativeOptions.spanProcessor = new FaroMetaAttributesSpanProcessor(new ObservationClockProcessor(new BatchSpanProcessor(new FaroTraceExporter({ api: this.api }), {
      scheduledDelayMillis: TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS, maxExportBatchSize: 30,
    })), this.metas)
    super.initialize()
  }
}
