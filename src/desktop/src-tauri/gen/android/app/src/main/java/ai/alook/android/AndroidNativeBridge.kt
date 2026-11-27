package ai.alook.android

object AndroidNativeBridge {
    const val BRIDGE_NAME = "alookNativeBridge"
    const val DEFAULT_KEYBOARD_EASING = "cubic-bezier(0.2, 0, 0, 1)"
    const val LEGACY_RESIZE_KEYBOARD_JSON = "{\"resizesViewport\":true}"
    private const val MAX_KEYBOARD_DURATION_MS = 1000L

    data class KeyboardOverlayPacket(
        val targetInset: Int,
        val viewportWidth: Int,
        val durationMs: Long,
        val easing: String = DEFAULT_KEYBOARD_EASING,
        val phase: String,
        val sequence: Long,
    ) {
        fun toJson(): String {
            val safeInset = targetInset.coerceAtLeast(0)
            val safeWidth = viewportWidth.coerceAtLeast(0)
            val safeDuration = durationMs.coerceIn(0L, MAX_KEYBOARD_DURATION_MS)
            val safePhase = if (phase == "animating") "animating" else "settled"
            val safeEasing = easing.ifBlank { DEFAULT_KEYBOARD_EASING }
            val safeSequence = sequence.coerceAtLeast(0L)
            return "{\"mode\":\"overlay-gpu\",\"targetInset\":$safeInset,\"viewportWidth\":$safeWidth,\"durationMs\":$safeDuration,\"easing\":\"$safeEasing\",\"phase\":\"$safePhase\",\"sequence\":$safeSequence}"
        }
    }

    fun settledOverlayKeyboardJson(targetInset: Int, viewportWidth: Int, sequence: Long): String =
        KeyboardOverlayPacket(
            targetInset = targetInset,
            viewportWidth = viewportWidth,
            durationMs = 0L,
            easing = DEFAULT_KEYBOARD_EASING,
            phase = "settled",
            sequence = sequence,
        ).toJson()

    fun resolveImeAnimationTargetInset(
        currentAppliedImeBottom: Int,
        preAnimationImeInset: Int,
        upperBoundBottom: Int,
    ): Int {
        val applied = currentAppliedImeBottom.coerceAtLeast(0)
        val previous = preAnimationImeInset.coerceAtLeast(0)
        if (applied != previous) return applied
        return if (previous == 0) upperBoundBottom.coerceAtLeast(0) else 0
    }

    class ImeAnimationTracker<T : Any> {
        private val active = LinkedHashSet<T>()
        private val preAnimationInsets = HashMap<T, Int>()

        val isActive: Boolean
            get() = active.isNotEmpty()

        fun onPrepare(animation: T, currentAppliedImeBottom: Int) {
            active.add(animation)
            preAnimationInsets[animation] = currentAppliedImeBottom.coerceAtLeast(0)
        }

        fun onStart(
            animation: T,
            currentAppliedImeBottom: Int,
            upperBoundBottom: Int,
        ): Int {
            active.add(animation)
            val previous = preAnimationInsets[animation] ?: currentAppliedImeBottom.coerceAtLeast(0)
            return resolveImeAnimationTargetInset(currentAppliedImeBottom, previous, upperBoundBottom)
        }

        fun onEnd(animation: T): Boolean {
            val removed = active.remove(animation)
            preAnimationInsets.remove(animation)
            return removed && active.isEmpty()
        }

        fun clear() {
            active.clear()
            preAnimationInsets.clear()
        }
    }

    private val PRODUCTION_ORIGINS = setOf(
        "https://alook.ai",
        "http://alook-recovery.localhost",
    )

    private val DEBUG_ORIGINS = PRODUCTION_ORIGINS + "http://localhost:3000"

    private val HEX_COLOR_REGEX = Regex("^#[0-9a-fA-F]{6}$")
    private val TYPE_FIELD_REGEX = Regex("\"type\"\\s*:\\s*\"([a-zA-Z0-9_-]+)\"")
    private val DARK_FIELD_REGEX = Regex("\"dark\"\\s*:\\s*(true|false)")
    private val BACKGROUND_FIELD_REGEX = Regex("\"background\"\\s*:\\s*(null|\"([^\"]*)\")")

    sealed class BridgeMessage {
        data object Bootstrap : BridgeMessage()
        data class Theme(val dark: Boolean, val backgroundHex: String?) : BridgeMessage()
    }

    fun allowedOriginRules(isDebug: Boolean): Set<String> =
        if (isDebug) DEBUG_ORIGINS else PRODUCTION_ORIGINS

    fun isAllowedOrigin(origin: String?, isDebug: Boolean): Boolean {
        if (origin.isNullOrBlank()) return false
        val normalized = origin.trim().trimEnd('/').lowercase()
        return normalized in allowedOriginRules(isDebug)
    }

    fun parseMessage(raw: String?): BridgeMessage? {
        if (raw.isNullOrBlank()) return null
        val type = TYPE_FIELD_REGEX.find(raw)?.groupValues?.get(1) ?: return null
        return when (type) {
            "bootstrap" -> BridgeMessage.Bootstrap
            "theme" -> {
                val darkValue = DARK_FIELD_REGEX.find(raw)?.groupValues?.get(1) ?: return null
                val dark = darkValue == "true"
                val backgroundMatch = BACKGROUND_FIELD_REGEX.find(raw)
                val background = backgroundMatch?.groupValues?.get(2)?.takeIf {
                    it.isNotEmpty() && HEX_COLOR_REGEX.matches(it)
                }
                BridgeMessage.Theme(dark, background)
            }
            else -> null
        }
    }

    fun buildSnapshotPayload(
        geometryJson: String,
        systemGestureRegionJson: String,
        keyboardJson: String = LEGACY_RESIZE_KEYBOARD_JSON,
    ): String =
        "{\"geometry\":$geometryJson,\"keyboard\":$keyboardJson,\"systemGestureRegion\":$systemGestureRegionJson}"

    const val BRIDGE_AND_THEME_SCRIPT = """
        (function() {
            if (window.top !== window) return;
            var channel = window.alookNativeBridge;
            if (!channel || typeof channel.postMessage !== 'function') return;

            if (!Object.prototype.hasOwnProperty.call(window, '__alookNativeBridge')) {
                var state = {
                    geometry: null,
                    keyboard: null,
                    systemGestureRegion: null
                };
                var lastGeometrySerialized = 'null';
                var lastKeyboardSerialized = 'null';
                channel.onmessage = function(event) {
                    if (!event || typeof event.data !== 'string') return;
                    var packet;
                    try {
                        packet = JSON.parse(event.data);
                    } catch (e) {
                        return;
                    }
                    if (!packet || typeof packet !== 'object') return;
                    if (Object.prototype.hasOwnProperty.call(packet, 'geometry')) {
                        state.geometry = packet.geometry && typeof packet.geometry === 'object'
                            ? Object.freeze(packet.geometry)
                            : null;
                        var serialized = JSON.stringify(state.geometry);
                        if (serialized !== lastGeometrySerialized) {
                            lastGeometrySerialized = serialized;
                            window.dispatchEvent(new Event('alook:geometry-change'));
                        }
                    }
                    if (Object.prototype.hasOwnProperty.call(packet, 'keyboard') && packet.keyboard && typeof packet.keyboard === 'object') {
                        state.keyboard = Object.freeze(packet.keyboard);
                        var kbSerialized = JSON.stringify(state.keyboard);
                        if (kbSerialized !== lastKeyboardSerialized) {
                            lastKeyboardSerialized = kbSerialized;
                            window.dispatchEvent(new CustomEvent('alook:keyboard-change', { detail: state.keyboard }));
                        }
                    }
                    if (Object.prototype.hasOwnProperty.call(packet, 'systemGestureRegion')) {
                        state.systemGestureRegion = packet.systemGestureRegion && typeof packet.systemGestureRegion === 'object'
                            ? Object.freeze(packet.systemGestureRegion)
                            : null;
                    }
                };
                Object.defineProperty(window, '__alookNativeBridge', {
                    value: Object.freeze({
                        getGeometrySnapshot: function() { return state.geometry; },
                        getKeyboardSnapshot: function() { return state.keyboard; },
                        getSystemGestureRegion: function() { return state.systemGestureRegion; }
                    }),
                    writable: false,
                    enumerable: false,
                    configurable: false
                });
                channel.postMessage('{"type":"bootstrap"}');
            }

            if (window.__alookThemeObserverInstalled) return;
            window.__alookThemeObserverInstalled = true;
            function background() {
                if (!document.body || !document.body.style) return null;
                var published = document.body.style.getPropertyValue('--app-edge-fade-color').trim();
                if (!published) return null;
                var canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                var context = canvas.getContext('2d');
                if (!context) return null;
                context.fillStyle = 'transparent';
                context.fillStyle = published;
                context.fillRect(0, 0, 1, 1);
                var pixels = context.getImageData(0, 0, 1, 1).data;
                if (pixels[3] !== 255) return null;
                return '#' + Array.from(pixels).slice(0, 3).map(function(value) {
                    return value.toString(16).padStart(2, '0');
                }).join('');
            }
            function sync() {
                var root = document.documentElement;
                if (!root) return;
                var dark = root.classList.contains('dark');
                if (!dark && !root.classList.contains('light')) return;
                var color = background();
                channel.postMessage(JSON.stringify({
                    type: 'theme',
                    dark: dark,
                    background: color
                }));
            }
            document.addEventListener('DOMContentLoaded', sync);
            window.addEventListener('load', sync);
            window.addEventListener('alook:theme-color-change', sync);
            sync();
            if (document.documentElement) {
                new MutationObserver(sync).observe(document.documentElement, {
                    attributes: true, attributeFilter: ['class', 'data-tn-mode']
                });
            }
        })();
    """
}
