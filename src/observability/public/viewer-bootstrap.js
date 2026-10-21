import { start, loadText } from "./vendor/trace-waterfall-viewer/src/ui.js"
import { loadSelectedTrace } from "./viewer-adapter.js"

void loadSelectedTrace({ document, search: location.search, fetch, start, loadText })
