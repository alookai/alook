CREATE TABLE batches (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  signal TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  records INTEGER NOT NULL,
  raw TEXT NOT NULL
);
CREATE TABLE spans (
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  resource_index INTEGER NOT NULL,
  scope_index INTEGER NOT NULL,
  record_index INTEGER NOT NULL,
  page_instance_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT NOT NULL,
  name TEXT NOT NULL,
  service TEXT NOT NULL,
  start_nano TEXT NOT NULL,
  end_nano TEXT NOT NULL,
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX spans_batch ON spans(batch_id);
CREATE INDEX spans_time ON spans(start_nano);
CREATE INDEX spans_page ON spans(page_instance_id);
CREATE INDEX spans_session ON spans(session_id);
CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  resource_index INTEGER NOT NULL,
  scope_index INTEGER NOT NULL,
  record_index INTEGER NOT NULL,
  page_instance_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  custom_trace_id TEXT NOT NULL,
  time_nano TEXT NOT NULL,
  event_name TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX logs_batch ON logs(batch_id);
CREATE INDEX logs_time ON logs(time_nano);
CREATE INDEX logs_trace ON logs(trace_id);
CREATE INDEX logs_custom_trace ON logs(custom_trace_id);
CREATE INDEX logs_page ON logs(page_instance_id);
CREATE INDEX logs_session ON logs(session_id);
