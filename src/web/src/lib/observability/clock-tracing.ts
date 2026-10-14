import { SpanKind, type Context, type HrTime } from "@opentelemetry/api"
import { BatchSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-web"
import { FaroMetaAttributesSpanProcessor, FaroTraceExporter, TracingInstrumentation, type TracingInstrumentationOptions } from "@grafana/faro-web-tracing"
import { observationTime, observationOrigin, transportClockStart, transportClockEnd, transportClockOrigin, observationOwnerGeneration, retireObservationSpan } from "./clock"
import { telemetryGeneration } from "./telemetry"
import { projectResource } from "./resource"

function nativeHttp(span: ReadableSpan) {
  return span.kind === SpanKind.CLIENT && ["@opentelemetry/instrumentation-fetch", "@opentelemetry/instrumentation-xml-http-request"].includes(span.instrumentationScope.name)
}

export class ObservationClockProcessor implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context) {
    if (nativeHttp(span)) {
      const owner = parentContext.getValue(observationOwnerGeneration)
      if (typeof owner === "number" && owner !== telemetryGeneration()) retireObservationSpan(span)
      const now = performance.now()
      span.setAttribute(transportClockStart, now)
      span.setAttribute(transportClockOrigin, observationOrigin(now))
    }
    this.next.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan) {
    const start = span.attributes[transportClockStart], end = span.attributes[transportClockEnd], origin = span.attributes[transportClockOrigin]
    if (!nativeHttp(span) || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      this.next.onEnd(span)
      return
    }
    if (typeof origin !== "number" || !Number.isFinite(origin)) { this.next.onEnd(span); return }
    const startTime = observationTime(start, origin), endTime = observationTime(end, origin)
    const resource = projectResource(span, origin)
    const duration: HrTime = [endTime[0] - startTime[0], endTime[1] - startTime[1]]
    if (duration[1] < 0) { duration[0]--; duration[1] += 1e9 }
    const projected: ReadableSpan = {
      name: span.name, kind: span.kind, spanContext: () => span.spanContext(), parentSpanContext: span.parentSpanContext,
      startTime, endTime, duration, status: span.status, attributes: { ...resource.attributes, clock_source: "operation_monotonic", clock_domain: "browser", clock_alignment: "unverified", clock_skew_ms: Math.abs(observationOrigin() - origin) }, links: span.links, events: resource.events,
      ended: span.ended, resource: span.resource, instrumentationScope: span.instrumentationScope,
      droppedAttributesCount: span.droppedAttributesCount, droppedEventsCount: span.droppedEventsCount + resource.discarded, droppedLinksCount: span.droppedLinksCount,
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
